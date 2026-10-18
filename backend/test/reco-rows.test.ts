// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configSchema } from '../src/config.js';
import { registry } from '../src/metrics.js';
import { explore, seededRng } from '../src/reco/explore.js';
import { recommend } from '../src/reco/recommend.js';
import { isCurrentSeason, loadRowStats, rankRows, recordRowStats, ROW_KINDS, rowRate, type RowIn, type RowItem, type RowKind } from '../src/reco/rows.js';
import { tasteProfile } from '../src/reco/profile.js';
import { loadIndex, resetIndexCache } from '../src/reco/vectors.js';
import { DEFAULT_RECO_COEFFICIENTS, recoCoefficients, recoExplore, recoWeights } from '../src/reco/weights.js';
import type { ItemDto } from '../src/media/types.js';
import { buildIndex, DAY, dto, engineCtx, fakeJf, H, keysOf, NOW, seedProfiles, SPECS, type Seeded } from './reco-fixture.js';
import { makeEnv, type TestEnv } from './helpers.js';

// R3b: the row ranker, per-profile row statistics, exploration with logged propensities.
const c = recoCoefficients();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const mk = (id: string, o: Partial<ItemDto> = {}): ItemDto => ({ id, name: id, type: 'Movie', genres: [], image: false, backdrop: false, logo: false, trailers: 0, played: false, favorite: false, positionTicks: 0, ...o });
const items = (prefix: string, n: number, o: Partial<ItemDto> = {}): RowItem[] => Array.from({ length: n }, (_, i) => ({ item: mk(`${prefix}${i}`, o) }));
const row = (kind: RowKind, its: RowItem[], key?: string): RowIn => ({ kind, items: its, ...(key ? { key } : {}) });
const rank = (rows: RowIn[], o: Partial<Parameters<typeof rankRows>[1]> = {}) => rankRows(rows, { c, stats: {}, seen: new Set(), kids: false, now: NOW, ...o });
const kinds = (r: ReturnType<typeof rank>) => r.map((x) => x.key);

describe('row ranker', () => {
  const rows = (): RowIn[] => [
    row('because', items('b', 6)), row('top_picks', items('t', 6)), row('friends', items('f', 6)), row('popular', items('p', 6)),
    row('new', items('n', 5)), row('continue', items('c', 3)),
  ];

  it('continue watching first, one fixed slot for new / leaving soon, the rest by input order without history', () => {
    expect(kinds(rank(rows()))).toEqual(['continue', 'because', 'new', 'top_picks', 'friends', 'popular']);
    // leaving soon takes the slot before new; new then competes like any other row
    const both = kinds(rank([...rows(), row('leaving', items('l', 4))]));
    expect(both[2]).toBe('leaving');
    expect(both).toContain('new');
    expect(both.indexOf('new')).not.toBe(2);
    // the slot position follows the coefficient; short lists put it last
    expect(kinds(rankRows(rows(), { c: recoCoefficients({ RECO_COEFFS: '{"rows.fixedSlot":0}' }), stats: {}, seen: new Set(), kids: false, now: NOW }))[0]).toBe('new');
    expect(kinds(rank([row('new', items('n', 4))]))).toEqual(['new']);
  });

  it('rows follow the profile\'s past click / play rate per kind; a kind without history keeps its place', () => {
    const stats = { friends: [100, 40, 10, 0], because: [100, 5, 0, 0], popular: [3, 3, 0, 0] } as never;
    // friends: (40 + 2*10 + 2) / 120 = 0.52; because: (5 + 2) / 120 = 0.058; top_picks: prior 0.1; popular: 3 shown only: shrunk to (3 + 2) / 23
    const got = kinds(rank(rows(), { stats }));
    expect(got).toEqual(['continue', 'friends', 'new', 'popular', 'top_picks', 'because']);
    expect(rowRate(undefined, c)).toBeCloseTo(c.rows.priorRate, 10);
    expect(rowRate([0, 0, 0, 0], c)).toBeCloseTo(c.rows.priorRate, 10);
    expect(rowRate([20, 0, 0, 5], c)).toBeLessThan(c.rows.priorRate); // dismisses count against a kind
    expect(rowRate([10, 5, 5, 0], c)).toBeGreaterThan(rowRate([10, 5, 0, 0], c)); // a play counts more than a click
  });

  it('a minimum row size: short rows are dropped, continue watching needs one title', () => {
    const got = kinds(rank([row('continue', items('c', 1)), row('because', items('b', 3)), row('top_picks', items('t', 4))]));
    expect(got).toEqual(['continue', 'top_picks']);
    expect(kinds(rank([row('because', items('b', 6))], { c: recoCoefficients({ RECO_COEFFS: '{"rows.minSize":7}' }) }))).toEqual([]);
  });

  it('each kind has its own minimum: universe 1, transition 2, the rest rows.minSize (post-play shows what v1 shows)', () => {
    const got = kinds(rank([row('transition', items('x', 2)), row('universe', items('u', 1)), row('postplay', items('b', 3)), row('top_picks', items('t', 4))]));
    expect(got).toEqual(['transition', 'universe', 'top_picks']);
    expect(kinds(rank([row('transition', items('x', 1))]))).toEqual([]);
    expect(kinds(rank([row('universe', items('u', 1))], { c: recoCoefficients({ RECO_COEFFS: '{"rows.minSize":7}' }) }))).toEqual(['universe']);
  });

  it('a title appears in one row only; a row that shrinks below the minimum is dropped', () => {
    const shared = items('s', 4);
    const got = rank([row('because', [...shared, ...items('b', 2)]), row('top_picks', [...shared, ...items('t', 3)]), row('popular', items('p', 4))]);
    expect(kinds(got)).toEqual(['because', 'popular']); // top_picks keeps 3 after the shared titles went to the first row
    const ids = got.flatMap((r) => r.items.map((x) => x.item.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('kids profiles never get friends, popular or transition rows', () => {
    const got = kinds(rank([...rows(), row('transition', items('x', 5))], { kids: true }));
    expect(got).toEqual(['continue', 'because', 'new', 'top_picks']);
    expect(kinds(rank([...rows(), row('transition', items('x', 5))])).length).toBeGreaterThan(got.length);
  });

  it('no already-watched series in any row; the exception is a new season in the "new" slot; films and continue watching are untouched', () => {
    const seen = new Set(['S1', 'S2', 'S3', 'F1']);
    const series = (id: string): RowItem => ({ item: mk(id, { type: 'Series' }) });
    const got = rank([
      row('continue', [series('S1'), { item: mk('M0') }]),
      row('because', [series('S1'), series('S2'), series('S4'), { item: mk('F1') }, ...items('b', 4)]),
      row('new', [{ item: mk('S3', { type: 'Series' }), fresh: 'newSeason' }, { item: mk('S2', { type: 'Series' }), fresh: 'newEpisode' }, { item: mk('S5', { type: 'Series' }), fresh: 'newSeries' }, ...items('n', 3)]),
    ], { seen });
    const byKey = Object.fromEntries(got.map((r) => [r.key, r.items.map((x) => x.item.id)]));
    expect(byKey.continue).toContain('S1');
    expect(byKey.because).not.toContain('S1');
    expect(byKey.because).not.toContain('S2');
    expect(byKey.because).toContain('S4'); // unseen
    expect(byKey.because).toContain('F1'); // films are not series
    expect(byKey.new).toContain('S3'); // new season of a series you watch
    expect(byKey.new).not.toContain('S2'); // only "new episode"
    const watchedElsewhere = got.filter((r) => r.kind !== 'continue' && r.kind !== 'new').flatMap((r) => r.items.map((x) => x.item.id));
    for (const id of seen) if (id.startsWith('S')) expect(watchedElsewhere).not.toContain(id);
  });

  it('no row of current-season titles only: at most 1 in 3 are airing now, the "new" slot excepted', () => {
    const cur = (prefix: string, n: number): RowItem[] => Array.from({ length: n }, (_, i) => ({ item: mk(`${prefix}${i}`, { type: 'Series', lastAdded: iso(3) }) }));
    expect(isCurrentSeason({ item: mk('a', { type: 'Series', lastAdded: iso(3) }) }, NOW, c)).toBe(true);
    expect(isCurrentSeason({ item: mk('a', { type: 'Series', premiereDate: iso(400), lastAdded: iso(300) }) }, NOW, c)).toBe(false);
    expect(isCurrentSeason({ item: mk('a', { type: 'Series', premiereDate: iso(400) }), fresh: 'newEpisode' }, NOW, c)).toBe(true);
    expect(isCurrentSeason({ item: mk('a', { lastAdded: iso(3) }) }, NOW, c)).toBe(false); // a film is never "current season"
    const only = rank([row('because', cur('c', 9))]);
    expect(only).toEqual([]); // 9 current titles and no back catalog: none may stay
    const mixed = rank([row('because', [...cur('c', 9), ...items('back', 6)])]);
    expect(mixed).toHaveLength(1);
    const list = mixed[0]!.items;
    expect(list.filter((x) => isCurrentSeason(x, NOW, c)).length).toBeLessThanOrEqual(Math.floor(list.length / 3));
    expect(list.some((x) => !isCurrentSeason(x, NOW, c))).toBe(true);
    // the best-ranked current titles stay (order is kept)
    expect(list.slice(0, 3).map((x) => x.item.id)).toEqual(['c0', 'c1', 'c2']);
    // the "new" slot is allowed to be all current season
    expect(kinds(rank([row('new', cur('c', 5))]))).toEqual(['new']);
    // no row of the result is made only of current-season titles
    for (const r of rank([row('because', [...cur('c', 4), ...items('b', 8)]), row('top_picks', [...cur('d', 6), ...items('t', 2)])])) {
      expect(r.items.every((x) => isCurrentSeason(x, NOW, c))).toBe(false);
    }
  });
});

describe('row statistics (per profile, bounded, counts only)', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv(); });
  afterAll(() => env.close());
  beforeEach(async () => { for (const k of await env.kv.keys('reco:rows:')) await env.kv.del(k); });

  it('adds up per row kind, stores nothing but four numbers per kind and forgets after a cap', async () => {
    await recordRowStats(env.ctx, 'prof-1', [{ row: 'because', impressions: 4, clicks: 1 }, { row: 'friends', impressions: 2, dismisses: 1 }], c);
    await recordRowStats(env.ctx, 'prof-1', [{ row: 'because', impressions: 1, plays: 1 }], c);
    expect(await loadRowStats(env.ctx, 'prof-1')).toEqual({ because: [5, 1, 1, 0], friends: [2, 0, 0, 1] });
    expect(await loadRowStats(env.ctx, 'prof-2')).toEqual({});
    const raw = (await env.kv.get('reco:rows:prof-1'))!;
    expect(raw).toBe('{"because":[5,1,1,0],"friends":[2,0,0,1]}');
    // halved when a kind passes the cap of 500 impressions; the object never has more than one entry per kind
    await recordRowStats(env.ctx, 'prof-1', [{ row: 'because', impressions: 600, clicks: 100 }], c);
    expect(await loadRowStats(env.ctx, 'prof-1')).toEqual({ because: [303, 51, 1, 0], friends: [1, 0, 0, 1] });
    for (let i = 0; i < 40; i++) await recordRowStats(env.ctx, 'prof-1', ROW_KINDS.map((row) => ({ row, impressions: 50, clicks: 3 })), c);
    expect(Object.keys(await loadRowStats(env.ctx, 'prof-1')).length).toBeLessThanOrEqual(ROW_KINDS.length);
    expect((await env.kv.get('reco:rows:prof-1'))!.length).toBeLessThan(600);
  });

  it('garbage in the store is ignored', async () => {
    await env.kv.set('reco:rows:p', '{"because":[1,2,"x",4],"bogus":[1,1,1,1],"friends":[-1,0,0,0],"new":[3,1,0,0]}', 60);
    expect(await loadRowStats(env.ctx, 'p')).toEqual({ new: [3, 1, 0, 0] });
    await env.kv.set('reco:rows:p', 'not json', 60);
    expect(await loadRowStats(env.ctx, 'p')).toEqual({});
  });
});

describe('POST /api/reco/events feeds the profile\'s row statistics', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv(); });
  afterAll(() => env.close());
  it('counts for the active profile, with the same bounded row names', async () => {
    const s = await env.login();
    const post = (payload: unknown) => env.app.inject({ method: 'POST', url: '/api/reco/events', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: payload as object });
    expect((await post({ events: [{ row: 'because', engine: 'v2', impressions: 3, clicks: 1 }, { row: 'new', engine: 'v1', impressions: 2 }] })).statusCode).toBe(204);
    const keys = await env.kv.keys('reco:rows:');
    expect(keys).toHaveLength(1);
    expect(JSON.parse((await env.kv.get(keys[0]!))!)).toEqual({ because: [3, 1, 0, 0], new: [2, 0, 0, 0] });
    expect((await post({ events: [{ row: 'The Matrix', engine: 'v1', impressions: 1 }] })).statusCode).toBe(400);
  });
});

// ------------------------------------------------------------------------------------------------------------------- exploration

describe('exploration is off by default', () => {
  it('RECO_EXPLORE defaults to 0 in the configuration and the coefficient reader', () => {
    const base = { DATABASE_URL: 'x', REDIS_URL: 'x', APP_ENC_KEY: 'a'.repeat(43), INTERNAL_SECRET: 'i'.repeat(16) };
    expect(configSchema.shape.RECO_EXPLORE.parse(undefined)).toBe(0);
    expect(configSchema.shape.RECO_EXPLORE.parse('')).toBe(0);
    expect(configSchema.shape.RECO_EXPLORE.parse('0.1')).toBe(0.1);
    expect(() => configSchema.shape.RECO_EXPLORE.parse('0.9')).toThrow();
    void base;
    expect(recoExplore({})).toBe(0);
    expect(recoExplore({ RECO_EXPLORE: 0 })).toBe(0);
    expect(recoExplore({ RECO_EXPLORE: 0.1 })).toBe(0.1);
    expect(recoExplore({ RECO_EXPLORE: 7 })).toBe(0.5);
    expect(recoExplore({ RECO_EXPLORE: -1 })).toBe(0);
    expect(recoExplore({ RECO_EXPLORE: Number.NaN })).toBe(0);
  });
});

describe('explore(): medium-score candidates in about 1 slot of 10, with the propensity of each slot', () => {
  const pool = Array.from({ length: 40 }, (_, i) => ({ id: `i${String(i).padStart(2, '0')}`, score: 40 - i }));
  const chosen = pool.slice(0, 10);
  const cc = recoCoefficients();

  it('rate 0 changes nothing and draws no random number', () => {
    let draws = 0;
    const r = explore(chosen, pool, 0, cc, () => { draws++; return 0; });
    expect(r.items).toEqual(chosen);
    expect(r.slots).toEqual([]);
    expect(draws).toBe(0);
  });

  it('never touches the best 3, draws from the 25 %-60 % band of the pool only, logs exploit 1 - rate and explore rate / band size', () => {
    const r = explore(chosen, pool, 1, cc, seededRng(5)); // rate 1: every eligible slot is explored
    expect(r.items.slice(0, 3)).toEqual(chosen.slice(0, 3));
    const band = new Set(pool.slice(10, 24).map((x) => x.id)); // 25 % of 40 = 10 ... 60 % = 24
    for (const [n, it] of r.items.entries()) if (n >= 3) expect(band.has(it.id), it.id).toBe(true);
    expect(new Set(r.items.map((x) => x.id)).size).toBe(10);
    expect(r.slots).toHaveLength(7);
    for (const sl of r.slots) { expect(sl.arm).toBe('explore'); expect(sl.propensity).toBeGreaterThan(0.03); expect(sl.propensity).toBeLessThanOrEqual(0.2); }
    const some = explore(chosen, pool, 0.1, cc, seededRng(3));
    for (const sl of some.slots) if (sl.arm === 'exploit') expect(sl.propensity).toBeCloseTo(0.9, 10);
    for (const sl of some.slots) if (sl.arm === 'explore') expect(sl.propensity).toBeCloseTo(0.1 / 14, 2);
  });

  it('about one slot in ten over many rows (the rate), reproducible with a seed', () => {
    const rng = seededRng(42);
    let explored = 0, slots = 0;
    for (let i = 0; i < 400; i++) {
      const r = explore(chosen, pool, 0.1, cc, rng);
      explored += r.slots.filter((x) => x.arm === 'explore').length;
      slots += r.slots.length;
    }
    expect(explored / slots).toBeGreaterThan(0.08);
    expect(explored / slots).toBeLessThan(0.12);
    expect(explore(chosen, pool, 0.1, cc, seededRng(9))).toEqual(explore(chosen, pool, 0.1, cc, seededRng(9)));
  });

  it('keeps the caller\'s caps and does nothing when the band offers no title', () => {
    const none = explore(chosen, pool, 1, cc, seededRng(1), () => false);
    expect(none.items).toEqual(chosen);
    expect(none.slots.every((x) => x.arm === 'exploit' && x.propensity === 1)).toBe(true);
    expect(explore(chosen, pool.filter((x) => x.score > 35), 1, cc, seededRng(1)).slots.every((x) => x.arm === 'exploit')).toBe(true); // pool too small: no band
    expect(explore([], pool, 1, cc, seededRng(1))).toEqual({ items: [], slots: [] });
    expect(explore(chosen, pool.map((x) => ({ ...x, score: 0 })), 1, cc, seededRng(1)).items).toEqual(chosen); // medium band needs a positive score
  });
});

describe('exploration in recommend()', () => {
  let env: TestEnv;
  let s: Seeded;
  beforeAll(async () => { env = await makeEnv(); s = await seedProfiles(env); await buildIndex(env); });
  afterAll(() => env.close());
  beforeEach(async () => {
    for (const t of ['thumbs', 'watchlist', 'dropped', 'ratings', 'play_seconds']) await env.pool.query(`delete from ${t}`);
    for (const k of await env.kv.keys('reco:')) await env.kv.del(k);
    resetIndexCache(env.ctx);
  });
  const slotCounts = async () => {
    const out: Record<string, number> = {};
    for (const name of ['friendflix_reco_explore_slots_total', 'friendflix_reco_explore_propensity_total']) {
      const m = (await registry.getMetricsAsJSON()).find((x) => x.name === name);
      for (const v of m?.values ?? []) out[`${name}|${v.labels.row}|${v.labels.arm}`] = v.value;
    }
    return out;
  };
  const f0 = () => { const f = fakeJf(); f.state.similar[H('saga2')] = ['saga1', 'saga3', 'mars', 'orbit', 'robot', 'signal', 'noir1', 'doc3', 'cops', 'heist2', 'rom3', 'doc2']; return f; };
  const base = (cfg: object, f = f0()) => ({ ctx: engineCtx(env, f.jf, cfg as never), f });
  const go = (cfg: object, rng?: () => number, profile: 'owner' | 'kids' = 'owner', extra: object = {}) => {
    const { ctx } = base(cfg);
    const kids = profile === 'kids';
    return recommend(ctx, kids ? s.kidsUser : s.user, kids ? s.kids : s.owner, { surface: 'because', seed: H('saga2'), limit: 6, now: NOW, context: { hour: 12 }, ...(rng ? { rng } : {}), ...extra });
  };

  it('off by default: same list on every call, no random number drawn, no counter moves', async () => {
    const before = await slotCounts();
    let draws = 0;
    const a = await go({}, () => { draws++; return 0; });
    const b = await go({});
    expect(keysOf(a.items.map((i) => i.item))).toEqual(keysOf(b.items.map((i) => i.item)));
    expect(draws).toBe(0);
    expect(a.items.every((i) => !i.explored)).toBe(true);
    expect(await slotCounts()).toEqual(before);
  });

  it('on: swaps medium-score candidates into slots after the best 3 and counts slots and propensities by row kind and arm only', async () => {
    const off = await go({});
    let n = 0;
    const on = await go({ RECO_EXPLORE: 0.5 }, () => [0.1, 0.0, 0.9, 0.2, 0.7][n++ % 5]!, 'owner', { row: 'because' }); // slot 4 explored, slot 5 not, slot 6 explored ...
    const offK = keysOf(off.items.map((i) => i.item)), onK = keysOf(on.items.map((i) => i.item));
    expect(onK.slice(0, 3)).toEqual(offK.slice(0, 3));
    const swapped = on.items.filter((i) => i.explored);
    expect(swapped.length).toBeGreaterThan(0);
    for (const i of swapped) {
      expect(offK).not.toContain(keysOf([i.item])[0]); // a candidate that was not in the ranked row
      expect(i.propensity).toBeGreaterThan(0);
      expect(i.propensity).toBeLessThan(0.5);
    }
    expect(new Set(onK).size).toBe(onK.length);
    expect(on.items.every((i) => i.reason.traits.length <= 2)).toBe(true);
    const counts = await slotCounts();
    const keys = Object.keys(counts);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k).toMatch(/^friendflix_reco_explore_(slots|propensity)_total\|because\|(exploit|explore)$/);
    expect(counts['friendflix_reco_explore_slots_total|because|explore']).toBe(swapped.length);
    expect((counts['friendflix_reco_explore_slots_total|because|exploit'] ?? 0) + swapped.length).toBe(3); // the 3 eligible slots of a row of 6
    const text = await registry.metrics();
    expect(text).not.toMatch(/SAGA|NOIR|MARS/);
  });

  it('a kids profile explores inside the age cap, with its own token', async () => {
    const f = f0();
    f.state.caps['jfkid'] = 6;
    f.state.similar[H('rom1')] = ['rom2', 'rom3', 'bear1', 'bear2', 'robot', 'pups', 'doc2', 'saga1', 'noir1', 'doc1', 'orbit', 'mars'];
    const ctx = engineCtx(env, f.jf, { RECO_EXPLORE: 0.5 } as never);
    for (let n = 0; n < 5; n++) {
      const r = await recommend(ctx, s.kidsUser, s.kids, { surface: 'because', seed: H('rom1'), limit: 6, now: NOW, context: { hour: 12 }, rng: seededRng(n + 1) });
      for (const i of r.items) expect(['FSK 0', 'FSK 6']).toContain(i.item.rating);
    }
    expect(f.calls.every((x) => x.user.jellyfin_user_id === 'jfkid')).toBe(true);
  });

  it('shadow comparisons never explore', async () => {
    const before = await slotCounts();
    const ctx = engineCtx(env, f0().jf, { RECO_EXPLORE: 0.5, RECO_ENGINE: 'shadow' } as never);
    const { shadowCompare, shadowIdle } = await import('../src/reco/recommend.js');
    await shadowCompare(ctx, s.user, s.owner, { seed: H('saga2'), surface: 'because', v1: [H('saga1')], guardKey: 'x-explore' });
    await shadowIdle();
    expect(await slotCounts()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------- the engine's rows through the ranker

describe('engine output through the row ranker', () => {
  let env: TestEnv;
  let s: Seeded;
  beforeAll(async () => { env = await makeEnv(); s = await seedProfiles(env); await buildIndex(env); });
  afterAll(() => env.close());

  it('no already-watched series reaches a row, and no row consists of current-season titles only', async () => {
    const f = fakeJf();
    f.state.history = [
      dto('cops', { played: false, playedPercentage: 40, lastPlayedDate: iso(3) }), dto('signal', { played: true, lastPlayedDate: iso(8) }),
      dto('saga1', { played: true, lastPlayedDate: iso(30) }), dto('saga2', { played: true, lastPlayedDate: iso(20) }), dto('mars', { played: true, lastPlayedDate: iso(10) }),
    ];
    f.state.similar[H('saga2')] = SPECS.map((x) => x.key).filter((k) => k !== 'saga2');
    const ctx = engineCtx(env, f.jf);
    const index = await loadIndex(ctx, recoWeights(ctx.cfg), NOW);
    const taste = await tasteProfile(ctx, s.user, s.owner, index, recoCoefficients(), recoWeights(ctx.cfg), NOW);
    expect(taste.seen.has(H('cops'))).toBe(true);
    expect(taste.seen.has(H('signal'))).toBe(true);
    const run = async (surface: 'because' | 'taste' | 'home_rows') =>
      (await recommend(ctx, s.user, s.owner, { surface, ...(surface === 'because' ? { seed: H('saga2') } : {}), limit: 20, now: NOW, context: { hour: 12 } })).items.map((i): RowItem => ({ item: i.item }));
    // the engine itself only penalises watched series (a rewatch-friendly profile may still see them); the ranker removes them
    const raw = await run('taste');
    const given: RowIn[] = [row('because', await run('because')), row('top_picks', raw), row('new', [{ item: dto('pups', { lastAdded: iso(1) }), fresh: 'newSeries' }, ...items('z', 3)])];
    const out = rankRows(given, { c, stats: {}, seen: taste.seen, kids: false, now: NOW });
    expect(out.length).toBeGreaterThan(0);
    for (const r of out) {
      for (const x of r.items) {
        if (x.item.type === 'Series') expect(taste.seen.has(x.item.id), `${r.key}: ${x.item.name}`).toBe(false);
      }
      if (r.kind !== 'new') expect(r.items.some((x) => !isCurrentSeason(x, NOW, c)), r.key).toBe(true);
    }
    void DEFAULT_RECO_COEFFICIENTS;
  });
});
