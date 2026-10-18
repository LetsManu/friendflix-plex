// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listErrors } from '../src/errorlog.js';
import { dispatchMediaEvent } from '../src/media/events.js';
import type { ItemFeatures } from '../src/media/types.js';
import {
  recoIndexDue, recoIndexIdle, recoIndexPending, recoIndexState, recoIndexTick, resetRecoIndex, startRecoIndexListener,
} from '../src/reco/indexJob.js';
import { DEFAULT_RECO_WEIGHTS, recoWeights } from '../src/reco/weights.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

// R1: the item feature index job (full + incremental passes, locking, backoff), against a fake MediaServer.libraryFeatures.
type Opts = { ids?: string[]; savedSince?: string };
let env: TestEnv;
const hex = (n: number, p = 'a') => (p + n.toString(16)).padStart(32, '0');
const S1 = hex(1, 'c');

const film = (n: number, o: Partial<ItemFeatures> = {}): ItemFeatures => ({
  id: hex(n), type: 'Movie', genres: ['Drama'], tags: [], studios: [], people: [], countries: [], year: 2000 + (n % 20), runtimeMin: 90 + n,
  communityRating: 6 + (n % 4), overview: `Film ${n} about a quiet harbour town`, ...o,
});

let lib: ItemFeatures[] = [];
let calls: Array<{ start: number; limit: number; opts?: Opts }> = [];
let failAt: number | null = null;
async function fake(start: number, limit: number, opts?: Opts): Promise<ItemFeatures[]> {
  calls.push({ start, limit, ...(opts ? { opts } : {}) });
  if (failAt !== null && start === failAt) throw new Error('fetch failed http://jellyfin:8096/Items?api_key=secret');
  const all = opts?.ids ? lib.filter((i) => opts.ids!.includes(i.id)) : lib;
  return all.slice(start, start + limit);
}

const rows = async () => (await env.pool.query<Record<string, any>>('select * from item_features order by item_id')).rows;
const row = async (id: string): Promise<Record<string, any>> => (await env.pool.query<Record<string, any>>('select * from item_features where item_id=$1', [id])).rows[0] ?? {};
const idfOf = async (kind: string, value: string) => (await env.pool.query<{ df: number; idf: number }>('select df, idf from item_feature_idf where kind=$1 and value=$2', [kind, value])).rows[0];
const full = (o: { now?: Date } = {}) => recoIndexTick(env.ctx, { full: true, pauseMs: 0, ...o });
const AT = 1_800_000_000_000; // a fixed "now" for the schedule

beforeAll(async () => {
  env = await makeEnv();
  (env.ctx.jf as { libraryFeatures?: unknown }).libraryFeatures = fake;
});
afterAll(() => env.close());
beforeEach(async () => {
  lib = [];
  calls = [];
  failAt = null;
  resetRecoIndex();
  await recoIndexIdle();
  await env.pool.query('delete from item_features');
  await env.pool.query('delete from item_feature_idf');
  await env.pool.query('delete from item_feature_stats');
  for (const k of await env.kv.keys('reco:')) await env.kv.del(k);
});

describe('full pass', () => {
  it('pages the library, stores normalised features, IDF, terms and statistics', async () => {
    lib = [
      film(1, { genres: ['Drama', 'Crime'], tags: ['Heist ', 'heist'], studios: ['North Pictures'], people: [hex(7, 'd'), hex(8, 'd'), 'bad id!'], countries: ['Iceland'], collectionId: hex(1, 'b') }),
      film(2, { genres: ['drama'], people: [hex(7, 'd')], overview: 'A quiet harbour', tagline: 'Never leave' }),
      film(3, { genres: ['Comedy'], overview: undefined }),
      { id: S1, type: 'Series', genres: ['Drama'], tags: [], studios: [], people: [], countries: [], seriesStatus: 'continuing', overview: 'Neighbours at the harbour' },
    ];
    await full();
    expect(calls).toEqual([{ start: 0, limit: 200 }]); // one short page
    expect((await rows()).map((r) => r.item_id)).toEqual([hex(1), hex(2), hex(3), S1]);
    expect(await row(hex(1))).toMatchObject({
      type: 'Movie', genres: ['drama', 'crime'], tags: ['heist'], studios: ['north pictures'], people: [hex(7, 'd'), hex(8, 'd')], countries: ['iceland'],
      collection_id: hex(1, 'b'), year: 2001, runtime_min: 91, series_status: null,
    });
    expect(await row(S1)).toMatchObject({ type: 'Series', series_status: 'continuing', year: null, collection_id: null });
    expect((await row(hex(3))).overview_terms).toEqual({});
    expect(await env.kv.get('reco:idx:lastFull')).toBeTruthy();

    // IDF: Drama is on 3 of 4 items, Crime on 1; a rare director outweighs the genre
    const drama = await idfOf('genre', 'drama'), crime = await idfOf('genre', 'crime');
    expect(drama).toMatchObject({ df: 3 });
    expect(drama!.idf).toBeCloseTo(Math.log(5 / 4) + 1, 4);
    expect(crime!.idf).toBeCloseTo(Math.log(5 / 2) + 1, 4);
    expect(crime!.idf).toBeGreaterThan(drama!.idf);
    expect((await idfOf('person', hex(7, 'd')))).toMatchObject({ df: 2 });
    expect((await idfOf('person', hex(8, 'd')))!.idf).toBeGreaterThan((await idfOf('person', hex(7, 'd')))!.idf);
    expect(await idfOf('tag', 'heist')).toMatchObject({ df: 1 });
    expect(await idfOf('studio', 'north pictures')).toMatchObject({ df: 1 });
    expect(await idfOf('term', 'harbour')).toMatchObject({ df: 3 });

    // TF-IDF terms: stored sparse and L2-normalised; the shared word counts less than a word of one item only
    const terms = (await row(hex(2))).overview_terms as Record<string, number>;
    expect(Object.keys(terms).sort()).toEqual(['harbour', 'leave', 'never', 'quiet']);
    expect(Math.sqrt(Object.values(terms).reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 3);
    expect(terms.never).toBeGreaterThan(terms.harbour!);

    // numeric statistics for z-scores
    const st = await env.pool.query<{ name: string; mean: number; std: number; n: number }>('select * from item_feature_stats order by name');
    expect(st.rows.map((r) => r.name)).toEqual(['community_rating', 'critic_rating', 'runtime_min', 'year']);
    const year = st.rows.find((r) => r.name === 'year')!;
    expect(year.n).toBe(3);
    expect(year.mean).toBeCloseTo((2001 + 2002 + 2003) / 3, 6);
    expect(year.std).toBeCloseTo(1, 6);
    expect(st.rows.find((r) => r.name === 'critic_rating')).toMatchObject({ n: 0, std: 0 });
  });

  it('pages in 200s until a short page and yields the same rows for 450 films', async () => {
    lib = Array.from({ length: 450 }, (_, i) => film(i + 1));
    await full();
    expect(calls.map((c) => c.start)).toEqual([0, 200, 400]);
    expect((await rows()).length).toBe(450);
  });

  it('a second full pass removes vanished items; a pass that fails midway deletes nothing and keeps the old rows', async () => {
    lib = Array.from({ length: 450 }, (_, i) => film(i + 1));
    await full();
    lib = lib.slice(0, 400);
    failAt = 200;
    await full();
    expect((await rows()).length).toBe(450);
    failAt = null;
    await env.kv.del('reco:idx:nextTry');
    await full();
    expect((await rows()).length).toBe(400);
    expect(await idfOf('genre', 'drama')).toMatchObject({ df: 400 });
  });

  it('a title removed mid-pass shifts the later offset pages: the skipped neighbour is re-checked by id and kept (M2)', async () => {
    lib = Array.from({ length: 450 }, (_, i) => film(i + 1));
    await full();
    const orig = env.ctx.jf.libraryFeatures!;
    // while the pass is at the second page, the first title leaves the library: offset 200 now starts one title later
    (env.ctx.jf as { libraryFeatures?: unknown }).libraryFeatures = async (start: number, limit: number, opts?: Opts) => {
      if (start === 200 && !opts?.ids && lib[0]?.id === hex(1)) lib = lib.slice(1);
      return fake(start, limit, opts);
    };
    try { await full(); } finally { (env.ctx.jf as { libraryFeatures?: unknown }).libraryFeatures = orig; }
    const ids = new Set((await rows()).map((r) => r.item_id));
    expect(ids.has(hex(201))).toBe(true); // skipped by the pages, found by the re-check
    expect(ids.size).toBe(450); // the removed title was seen on page 1; its itemRemoved event or the next pass removes it
    await full();
    expect((await rows()).length).toBe(449);
    expect(calls.some((c) => c.opts?.ids?.includes(hex(201)))).toBe(true);
  });

  it('IDF rows of values that no item has any more disappear', async () => {
    lib = [film(1, { genres: ['Western'], tags: ['gunfight'] }), film(2)];
    await full();
    expect(await idfOf('genre', 'western')).toBeTruthy();
    lib = [film(2)];
    await full();
    expect(await idfOf('genre', 'western')).toBeUndefined();
    expect(await idfOf('tag', 'gunfight')).toBeUndefined();
    expect(await idfOf('term', 'about')).toBeUndefined();
  });

  it('skips a film the server reports with a bad id or type', async () => {
    lib = [film(1), { ...film(2), id: 'nope' }, { ...film(3), type: 'Episode' as 'Movie' }];
    await full();
    expect((await rows()).map((r) => r.item_id)).toEqual([hex(1)]);
  });
});

describe('failure, backoff and locking', () => {
  it('a failed pass is recorded by job name only, backs off 5 min and doubles up to 6 h', async () => {
    lib = [film(1)];
    failAt = 0;
    await full();
    const errs = await listErrors(env.ctx, { source: 'job' });
    expect(errs.entries.some((e) => e.code === 'reco-index')).toBe(true);
    expect(JSON.stringify(errs)).not.toContain('api_key');
    expect(await env.kv.get('reco:idx:running')).toBeNull(); // lock released
    const t1 = Number(await env.kv.get('reco:idx:nextTry'));
    expect(t1 - Date.now()).toBeGreaterThan(4.5 * 60_000);
    expect(t1 - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    // due() respects the backoff, and runs again once it is over
    calls = [];
    expect(await recoIndexDue(env.ctx, { now: Date.now() + 60_000, pauseMs: 0 })).toBe(false);
    expect(calls).toHaveLength(0);
    await full();
    expect(Number(await env.kv.get('reco:idx:nextTry')) - Date.now()).toBeGreaterThan(9.5 * 60_000);
    for (let i = 0; i < 12; i++) await full();
    expect(Number(await env.kv.get('reco:idx:nextTry')) - Date.now()).toBeLessThanOrEqual(6 * 3600_000);
    // success clears it
    failAt = null;
    await full();
    expect(await env.kv.get('reco:idx:nextTry')).toBeNull();
    expect(await env.kv.get('reco:idx:fails')).toBeNull();
    expect((await rows()).length).toBe(1);
  });

  it('does nothing while another replica holds the running flag', async () => {
    lib = [film(1)];
    await env.kv.set('reco:idx:running', 'other', 300);
    await full();
    expect(calls).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
    expect(await recoIndexDue(env.ctx, { pauseMs: 0 })).toBe(false);
    expect(await env.kv.get('reco:idx:running')).toBe('other'); // not ours: left alone
  });

  it('the heartbeat renews only its own lock: refreshIfEquals never takes over another replica\'s flag (M10)', async () => {
    await env.kv.set('reco:idx:running', 'other', 300);
    expect(await env.kv.refreshIfEquals('reco:idx:running', 'mine', 300)).toBe(false);
    expect(await env.kv.get('reco:idx:running')).toBe('other');
    expect(await env.kv.refreshIfEquals('reco:idx:running', 'other', 300)).toBe(true);
    await env.kv.del('reco:idx:running');
    expect(await env.kv.refreshIfEquals('reco:idx:running', 'mine', 300)).toBe(false);
    expect(await env.kv.get('reco:idx:running')).toBeNull(); // never resurrected
  });

  it('is idle without the capability or the method', async () => {
    const jf = env.ctx.jf as unknown as { libraryFeatures?: unknown; capabilities: { libraryFeatures?: boolean } };
    const keep = jf.libraryFeatures;
    jf.libraryFeatures = undefined; // (delete would uncover the class method)
    try {
      await full();
      expect(await recoIndexDue(env.ctx)).toBe(false);
      expect(await recoIndexState(env.ctx)).toMatchObject({ supported: false, items: 0, updatedAt: null });
    } finally { jf.libraryFeatures = keep; }
    const cap = (env.ctx.jf as { capabilities: { libraryFeatures?: boolean } }).capabilities;
    const was = cap.libraryFeatures;
    cap.libraryFeatures = false;
    try {
      lib = [film(1)];
      await full();
      expect(calls).toHaveLength(0);
    } finally { cap.libraryFeatures = was; }
  });
});

describe('incremental pass via the media.event bus', () => {
  let off: () => void;
  beforeEach(() => { off = startRecoIndexListener(env.ctx); });
  afterEach(() => off());
  const added = (itemId: string, itemType: string, seriesId?: string) =>
    dispatchMediaEvent(env.ctx, { type: 'itemAdded', itemId, itemType, ...(seriesId ? { seriesId } : {}) });

  it('refreshes just the added film after the settle time; terms use the stored document frequencies', async () => {
    lib = [film(1), film(2)];
    await full();
    calls = [];
    lib.push(film(3, { genres: ['Drama', 'Noir'], overview: 'A quiet harbour with a secret lighthouse' }));
    await added(hex(3), 'Movie');
    expect(recoIndexPending()).toEqual([hex(3)]);
    expect(await recoIndexDue(env.ctx, { now: Date.now() + 5_000, pauseMs: 0 })).toBe(false); // still settling
    expect(await recoIndexDue(env.ctx, { now: Date.now() + 31_000, pauseMs: 0 })).toBe(true);
    expect(calls).toEqual([{ start: 0, limit: 1, opts: { ids: [hex(3)] } }]);
    expect(recoIndexPending()).toEqual([]);
    expect((await row(hex(3))).genres).toEqual(['drama', 'noir']);
    const terms = (await row(hex(3))).overview_terms as Record<string, number>;
    expect(Object.keys(terms).sort()).toEqual(['harbour', 'lighthouse', 'quiet', 'secret']);
    expect(terms.lighthouse).toBeGreaterThan(terms.harbour!); // unseen word beats the shared one
    expect(await idfOf('genre', 'noir')).toMatchObject({ df: 1 });
    expect(await idfOf('genre', 'drama')).toMatchObject({ df: 3 });
    expect((await row(hex(1))).overview_terms).toBeTruthy();
    expect(Object.keys(await row(hex(1)))).toContain('updated_at');
  });

  it('an episode refreshes its series, once; other item types and unknown ids are ignored', async () => {
    lib = [{ id: S1, type: 'Series', genres: ['Comedy'], tags: [], studios: [], people: [], countries: [], overview: 'Neighbours' }];
    await added(hex(9, 'e'), 'Episode', S1);
    await added(hex(10, 'e'), 'Episode', S1);
    await added(hex(11, 'e'), 'Episode'); // no series id
    await added(hex(12), 'Season');
    await added('../etc', 'Movie');
    expect(recoIndexPending()).toEqual([S1]);
    await recoIndexTick(env.ctx, { pauseMs: 0 });
    expect(calls).toEqual([{ start: 0, limit: 1, opts: { ids: [S1] } }]);
    expect((await row(S1)).genres).toEqual(['comedy']);
    expect(calls.some((c) => !c.opts)).toBe(false); // never a whole-library listing
  });

  it('an item that is gone from the server is skipped; a failing pass puts the ids back for the retry', async () => {
    lib = [film(1)];
    await added(hex(1), 'Movie');
    await added(hex(2), 'Movie'); // not in the library
    await recoIndexTick(env.ctx, { pauseMs: 0 });
    expect((await rows()).map((r) => r.item_id)).toEqual([hex(1)]);
    failAt = 0;
    await added(hex(1), 'Movie');
    await recoIndexTick(env.ctx, { pauseMs: 0 });
    expect(recoIndexPending()).toEqual([hex(1)]);
    expect(await env.kv.get('reco:idx:nextTry')).toBeTruthy();
  });

  it('itemRemoved deletes the row at once', async () => {
    lib = [film(1), film(2)];
    await full();
    await dispatchMediaEvent(env.ctx, { type: 'itemRemoved', itemId: hex(1), itemType: 'Movie' });
    await new Promise((r) => setTimeout(r, 50));
    expect((await rows()).map((r) => r.item_id)).toEqual([hex(2)]);
  });
});

describe('schedule (recoIndexDue)', () => {
  it('first run is a full pass; then nothing is due; a full pass is nightly at 3:00 once a day old, or overdue after 36 h', async () => {
    lib = [film(1)];
    expect(await recoIndexDue(env.ctx, { now: AT, pauseMs: 0 })).toBe(true);
    expect(calls.every((c) => !c.opts)).toBe(true);
    const lastFull = Date.parse((await env.kv.get('reco:idx:lastFull'))!);
    calls = [];
    expect(await recoIndexDue(env.ctx, { now: lastFull + 60_000, pauseMs: 0 })).toBe(false);
    // a day old but not 3:00 local: still not due
    const hourOf = (t: number) => new Date(t).getHours();
    let t = lastFull + 24 * 3600_000;
    if (hourOf(t) === 3) t += 3600_000;
    expect(t - lastFull).toBeLessThan(36 * 3600_000);
    expect(await recoIndexDue(env.ctx, { now: t, pauseMs: 0 })).toBe(false);
    // the next 3:00: due
    while (hourOf(t) !== 3) t += 3600_000;
    expect(await recoIndexDue(env.ctx, { now: t, pauseMs: 0 })).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    // overdue at any hour
    calls = [];
    const last2 = Date.parse((await env.kv.get('reco:idx:lastFull'))!);
    let o = last2 + 36 * 3600_000 + 60_000;
    if (hourOf(o) === 3) o += 3600_000;
    expect(await recoIndexDue(env.ctx, { now: o, pauseMs: 0 })).toBe(true);
  });

  it('records the state for the admin page and the metric', async () => {
    lib = [film(1), film(2)];
    expect(await recoIndexState(env.ctx)).toMatchObject({ supported: true, running: false, items: 0, updatedAt: null, lastFull: null });
    await full();
    const st = await recoIndexState(env.ctx);
    expect(st).toMatchObject({ supported: true, running: false, items: 2 });
    expect(Date.now() - Date.parse(st.updatedAt!)).toBeLessThan(60_000);
    expect(st.lastFull).toBeTruthy();
  });
});

describe('visibility', () => {
  it('GET /api/admin/summary reports size and age; /metrics has bounded labels and no item ids or titles', async () => {
    const s = await env.login(ADMIN);
    lib = [film(1), film(2), film(3)];
    await full();
    const sum = (await env.app.inject({ url: '/api/admin/summary', cookies: s.cookies })).json();
    expect(sum.recoIndex).toMatchObject({ supported: true, running: false, items: 3 });
    expect(Date.now() - Date.parse(sum.recoIndex.updatedAt)).toBeLessThan(60_000);
    const m = (await env.app.inject('/metrics')).body;
    expect(m).toMatch(/^friendflix_reco_index_items 3$/m);
    expect(m).toMatch(/^friendflix_reco_index_age_seconds \d+$/m);
    const runs = m.split('\n').filter((l) => l.startsWith('friendflix_reco_index_runs_total{'));
    expect(runs.length).toBeGreaterThan(0);
    for (const l of runs) expect(l).toMatch(/^friendflix_reco_index_runs_total\{mode="(full|incremental)",result="(ok|error)"\} \d+$/);
    expect(m).not.toContain(hex(1));
  });

  it('the admin summary is admin only', async () => {
    expect((await env.app.inject('/api/admin/summary')).statusCode).toBe(401);
  });
});

describe('RECO_W_* in the live settings', () => {
  it('are read from the environment (empty = default) and reach recoWeights', async () => {
    const e = await makeEnv({}, { settingsEnv: { RECO_W_PEOPLE: '2.5', RECO_W_TAGS: '', RECO_W_TEXT: '0' } });
    try {
      expect(recoWeights(e.ctx.cfg)).toEqual({ ...DEFAULT_RECO_WEIGHTS, people: 2.5, text: 0 });
    } finally {
      await e.close();
    }
  });
});
