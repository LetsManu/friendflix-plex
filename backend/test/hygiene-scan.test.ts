// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listErrors } from '../src/errorlog.js';
import { hygieneDue, hygieneState, hygieneTick, householdLanguages, startHygieneScan, hygieneIdle } from '../src/hygiene/scan.js';
import { dispatchMediaEvent } from '../src/media/events.js';
import type { HygieneFacts } from '../src/media/types.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

// Block 22 Task 5: incremental + full library hygiene scan into hygiene_items.
type T = HygieneFacts['type'];
type Page = { start: number; limit: number; savedSince?: string };
let env: TestEnv;
const hex = (n: number, p = 'a') => (p + n.toString(16)).padStart(32, '0');
const OLD = '2020-01-01T00:00:00.000Z';

/** fake library: items per type with a "saved" date; the scan pages through it like the seam does */
let lib: Record<T, Array<HygieneFacts & { saved?: string }>> = { Movie: [], Series: [], Episode: [] };
let calls: Array<{ type: T } & Page> = [];
let failAt: { type: T; start: number } | null = null;
let gen: ((type: T, page: Page) => HygieneFacts[]) | null = null;

const movie = (n: number, o: Partial<HygieneFacts & { saved: string }> = {}): HygieneFacts & { saved?: string } => ({
  id: hex(n), type: 'Movie', name: `Film ${n}`, year: 2000 + (n % 20), overview: true, poster: true, backdrop: true,
  providerIds: { tmdb: String(1000 + n) }, runtimeTicks: 6e10, virtual: false, saved: OLD,
  sources: [{ container: 'mkv', bitrate: 8e6, sizeBytes: 4e9, runtimeTicks: 6e10, video: [{ codec: 'h264', bitDepth: 8, height: 1080 }], audio: [{ codec: 'aac', lang: 'deu' }], subtitles: [] }],
  ...o,
});
const episode = (n: number, o: Partial<HygieneFacts> = {}) =>
  movie(n, { type: 'Episode', id: hex(n, 'e'), name: `Folge ${n}`, seriesId: hex(1, 's'), seriesName: 'Serie', season: 1, episode: n, providerIds: {}, year: undefined, ...o });

async function fakeLibraryHygiene(type: T, page: Page): Promise<HygieneFacts[]> {
  calls.push({ type, ...page });
  if (failAt && failAt.type === type && failAt.start === page.start) throw new Error('fetch failed http://jellyfin:8096/Items?api_key=secret');
  if (gen) return gen(type, page);
  const all = lib[type].filter((i) => !page.savedSince || (i.saved ?? OLD) >= page.savedSince);
  return all.slice(page.start, page.start + page.limit).map(({ saved: _s, ...f }) => f);
}

const rows = async () => (await env.pool.query<{ item_id: string; issues: string[] }>('select item_id, issues from hygiene_items order by item_id')).rows;
const issuesOf = async (id: string) => (await env.pool.query<{ issues: string[] }>('select issues from hygiene_items where item_id=$1', [id])).rows[0]?.issues;
const tick = (o: { full?: boolean; now?: Date } = {}) => hygieneTick(env.ctx, { pauseMs: 0, ...o });

beforeAll(async () => {
  env = await makeEnv();
  (env.ctx.jf as { libraryHygiene?: unknown }).libraryHygiene = fakeLibraryHygiene;
});
afterAll(() => env.close());
beforeEach(async () => {
  lib = { Movie: [], Series: [], Episode: [] };
  calls = [];
  failAt = null;
  gen = null;
  await env.pool.query('delete from hygiene_items');
  for (const k of await env.kv.keys('hygiene:')) await env.kv.del(k);
});

describe('hygiene scan', () => {
  it('first run is full: rows for all items, issues set, lastFull stored', async () => {
    lib.Movie = [movie(1), movie(2, { poster: false })];
    lib.Series = [movie(3, { type: 'Series', sources: [], runtimeTicks: undefined, overview: false })];
    lib.Episode = [episode(1), episode(2, { sources: [] })];
    await tick();
    expect((await rows()).length).toBe(5);
    expect(await issuesOf(hex(1))).toEqual([]);
    expect(await issuesOf(hex(2))).toEqual(['no_poster']);
    expect(await issuesOf(hex(3))).toEqual(['no_overview']);
    expect(await issuesOf(hex(2, 'e'))).toEqual(['no_source']);
    expect(calls.every((c) => c.savedSince === undefined)).toBe(true);
    expect(new Set(calls.map((c) => c.type))).toEqual(new Set(['Movie', 'Series', 'Episode']));
    expect(await env.kv.get('hygiene:lastFull')).toBeTruthy();
    const ep = (await env.pool.query('select type, name, series_id, series_name, year, episode_key from hygiene_items where item_id=$1', [hex(1, 'e')])).rows[0];
    expect(ep).toMatchObject({ type: 'Episode', name: 'Folge 1', series_id: hex(1, 's'), series_name: 'Serie', year: null, episode_key: `${hex(1, 's')}:1:1` });
    const st = await hygieneState(env.ctx);
    expect(st).toMatchObject({ supported: true, running: false });
    expect(st.lastDone).toBeTruthy();
    expect(st.lastFull).toBeTruthy();
  });

  it('second run within 7 days is incremental and passes savedSince = lastStart − 5 min', async () => {
    lib.Movie = [movie(1)];
    await tick();
    const lastStart = (await env.kv.get('hygiene:lastStart'))!;
    calls = [];
    lib.Movie.push(movie(2, { saved: new Date().toISOString(), backdrop: false }));
    await tick();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.savedSince === new Date(Date.parse(lastStart) - 300_000).toISOString())).toBe(true);
    expect(await issuesOf(hex(2))).toEqual(['no_backdrop']);
    // 8 days later the next run is a full sweep again
    calls = [];
    await tick({ now: new Date(Date.now() + 8 * 86400_000) });
    expect(calls.every((c) => c.savedSince === undefined)).toBe(true);
  });

  it('duplicates: two movies with tmdb 603 → both dup_ids; same series/season/episode → dup_episode; after one is removed and a full run → neither', async () => {
    lib.Movie = [movie(1, { providerIds: { tmdb: '603' } }), movie(2, { providerIds: { tmdb: '603' } }), movie(3, { name: 'Amélie', year: 2001 }), movie(4, { name: 'amelie', year: 2001 })];
    lib.Episode = [episode(1), episode(2, { episode: 1 })];
    await tick();
    expect(await issuesOf(hex(1))).toEqual(['dup_ids']);
    expect(await issuesOf(hex(2))).toEqual(['dup_ids']);
    expect(await issuesOf(hex(3))).toEqual(['dup_title']);
    expect(await issuesOf(hex(1, 'e'))).toEqual(['dup_episode']);
    expect(await issuesOf(hex(2, 'e'))).toEqual(['dup_episode']);
    lib.Movie = lib.Movie.filter((m) => m.id !== hex(2) && m.id !== hex(4));
    lib.Episode = [episode(1)];
    await tick({ full: true });
    expect(await issuesOf(hex(2))).toBeUndefined();
    expect(await issuesOf(hex(1))).toEqual([]);
    expect(await issuesOf(hex(3))).toEqual([]);
    expect(await issuesOf(hex(1, 'e'))).toEqual([]);
  });

  it('incremental run does not delete untouched rows; full run that fails on page 3 deletes nothing', async () => {
    lib.Movie = Array.from({ length: 500 }, (_, i) => movie(i + 1));
    await tick();
    expect((await rows()).length).toBe(500);
    lib.Movie = lib.Movie.slice(0, 450);
    await tick(); // incremental: nothing saved since, nothing deleted
    expect((await rows()).length).toBe(500);
    const lastFull = await env.kv.get('hygiene:lastFull');
    failAt = { type: 'Movie', start: 400 };
    await tick({ full: true });
    expect(calls.some((c) => c.start === 400 && c.savedSince === undefined)).toBe(true);
    expect((await rows()).length).toBe(500);
    expect(await env.kv.get('hygiene:lastFull')).toBe(lastFull);
    const errs = await listErrors(env.ctx, { source: 'job' });
    expect(errs.entries.some((e) => e.code === 'hygiene')).toBe(true);
    expect(JSON.stringify(errs)).not.toContain('api_key');
    failAt = null;
    await tick({ full: true });
    expect((await rows()).length).toBe(450);
  });

  it('itemRemoved event deletes the row; itemAdded schedules one early tick for 5 events within 2 min', async () => {
    lib.Movie = [movie(1), movie(2)];
    await tick();
    await dispatchMediaEvent(env.ctx, { type: 'itemRemoved', itemId: hex(2), itemType: 'Movie' });
    expect(await issuesOf(hex(2))).toBeUndefined();
    expect(await issuesOf(hex(1))).toEqual([]);
    calls = [];
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) await dispatchMediaEvent(env.ctx, { type: 'itemAdded', itemId: hex(10 + i), itemType: 'Movie' });
    expect(await hygieneDue(env.ctx, { now: t0 + 60_000, pauseMs: 0 })).toBe(false);
    expect(calls.length).toBe(0);
    expect(await hygieneDue(env.ctx, { now: t0 + 121_000, pauseMs: 0 })).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(await hygieneDue(env.ctx, { now: t0 + 122_000, pauseMs: 0 })).toBe(false);
    // the regular cadence: 30 min after the last try
    expect(await hygieneDue(env.ctx, { now: t0 + 33 * 60_000, pauseMs: 0 })).toBe(true);
  });

  it('profile pref subtitleLang "tur" added → next tick recomputes language issues without asking the server for that item', async () => {
    lib.Movie = [movie(1, { sources: [{ ...movie(1).sources[0]!, audio: [{ codec: 'aac', lang: 'tur' }] }] })];
    await tick();
    expect(await issuesOf(hex(1))).toEqual(['foreign_no_subs']);
    expect(await householdLanguages(env.ctx)).toEqual(new Set(['deu']));
    const owner = (await env.pool.query("select p.id from profiles p join users u on u.id = p.user_id where u.authentik_sub = 'sub-admin'")).rows[0]
      ?? (await env.login(ADMIN), (await env.pool.query("select p.id from profiles p join users u on u.id = p.user_id where u.authentik_sub = 'sub-admin'")).rows[0]);
    await env.pool.query(`insert into profile_prefs(profile_id, data) values ($1, '{"subtitleLang":"tur","language":"en"}')
      on conflict (profile_id) do update set data = profile_prefs.data || excluded.data`, [owner.id]);
    expect(await householdLanguages(env.ctx)).toEqual(new Set(['deu', 'tur', 'eng']));
    calls = [];
    await tick();
    expect(calls.every((c) => c.savedSince !== undefined)).toBe(true); // incremental: the film itself was not listed again
    expect(await issuesOf(hex(1))).toEqual([]);
    await env.pool.query("update profile_prefs set data = data - 'subtitleLang' - 'language' where profile_id = $1", [owner.id]);
  });

  it('server without libraryHygiene → no calls, hygieneState.supported false', async () => {
    const fn = env.ctx.jf.libraryHygiene;
    (env.ctx.jf as { libraryHygiene?: unknown }).libraryHygiene = undefined;
    try {
      lib.Movie = [movie(1)];
      await tick();
      expect(calls.length).toBe(0);
      expect((await rows()).length).toBe(0);
      expect((await hygieneState(env.ctx)).supported).toBe(false);
      expect(startHygieneScan(env.ctx)).toBe(false);
    } finally {
      (env.ctx.jf as { libraryHygiene?: unknown }).libraryHygiene = fn;
    }
  });

  it('the running flag has a short TTL while scanning and is cleared when the scan throws', async () => {
    lib.Movie = [movie(1)];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = env.ctx.jf.libraryHygiene;
    (env.ctx.jf as { libraryHygiene?: unknown }).libraryHygiene = async () => { await gate; throw new Error('boom'); };
    try {
      const run = tick();
      await new Promise((r) => setTimeout(r, 10));
      const exp = (env.kv as unknown as { m: Map<string, { exp: number }> }).m.get('hygiene:running')!.exp;
      expect((exp - Date.now()) / 1000).toBeLessThanOrEqual(300);
      release();
      await run;
      expect(await env.kv.get('hygiene:running')).toBeNull();
      expect((await hygieneState(env.ctx)).running).toBe(false);
    } finally {
      (env.ctx.jf as { libraryHygiene?: unknown }).libraryHygiene = slow;
    }
  });

  it('a scan running elsewhere (flag held by another replica) → no second scan, the flag stays', async () => {
    lib.Movie = [movie(1)];
    await env.kv.set('hygiene:running', 'other-replica', 300);
    await tick({ full: true });
    expect(calls).toEqual([]);
    expect(await env.kv.get('hygiene:running')).toBe('other-replica');
    expect(await rows()).toEqual([]);
  });

  it('startHygieneScan starts one full sweep in the background; false while it runs', async () => {
    lib.Movie = [movie(1)];
    await tick();
    calls = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = env.ctx.jf.libraryHygiene;
    (env.ctx.jf as { libraryHygiene?: unknown }).libraryHygiene = async (type: T, page: Page) => { await gate; return slow!(type, page); };
    try {
      expect(startHygieneScan(env.ctx)).toBe(true);
      expect(startHygieneScan(env.ctx)).toBe(false);
      expect((await hygieneState(env.ctx)).running).toBe(true);
      release();
      await hygieneIdle();
      expect(calls.every((c) => c.savedSince === undefined)).toBe(true);
      expect((await hygieneState(env.ctx)).running).toBe(false);
    } finally {
      (env.ctx.jf as { libraryHygiene?: unknown }).libraryHygiene = slow;
    }
  });

  it('50 000 fake items (250 pages): completes, rows 50 000, bounded heap, and a concurrent admin request to /api/admin/health answers < 200 ms', async () => {
    const MOVIES = 10_000, EPISODES = 40_000;
    gen = (type, page) => {
      const n = type === 'Movie' ? MOVIES : type === 'Episode' ? EPISODES : 0;
      const out: HygieneFacts[] = [];
      for (let i = page.start; i < Math.min(n, page.start + page.limit); i++) {
        out.push(type === 'Movie' ? movie(i + 1) : episode(i + 1, { season: Math.floor(i / 100) + 1, episode: i % 100 }));
      }
      return out;
    };
    const admin = await env.login(ADMIN);
    await env.kv.set('health:snap', JSON.stringify({ at: new Date().toISOString(), services: [], disks: [], errors: { level: 'ok', server15: 0, client15: 0, playback60: 0 }, issues: [], worst: 'ok' }), 300);
    const heap0 = process.memoryUsage().heapUsed;
    let peak = heap0;
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 20);
    const started = Date.now();
    const run = tick();
    while ((await env.pool.query('select count(*)::int n from hygiene_items')).rows[0].n < 5000) await new Promise((r) => setTimeout(r, 20));
    const t = performance.now();
    const res = await env.app.inject({ url: '/api/admin/health', cookies: admin.cookies });
    const ms = performance.now() - t;
    await run;
    clearInterval(sampler);
    expect(res.statusCode).toBe(200);
    expect(ms).toBeLessThan(200);
    expect((await env.pool.query('select count(*)::int n from hygiene_items')).rows[0].n).toBe(MOVIES + EPISODES);
    expect(calls.filter((c) => c.type !== 'Series').length).toBe(MOVIES / 200 + 1 + EPISODES / 200 + 1);
    expect(peak - heap0).toBeLessThan(50 * 1024 * 1024);
    console.info(`hygiene 50k full sweep: ${Date.now() - started} ms, heap peak delta ${Math.round((peak - heap0) / 1048576)} MB, health ${ms.toFixed(1)} ms`);
  }, 180_000);
});
