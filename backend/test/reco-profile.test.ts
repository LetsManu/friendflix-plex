// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bumpHome } from '../src/homegen.js';
import { buildTaste, decayed, gatherSignals, resetTaste, tasteProfile, type Signal, type SignalKind } from '../src/reco/profile.js';
import { norm, resetIndexCache, loadIndex, type FeatureRow, type SparseVec } from '../src/reco/vectors.js';
import { recoCoefficients, recoWeights } from '../src/reco/weights.js';
import { buildIndex, dto, engineCtx, fakeJf, H, NOW, DAY, seedProfiles, type Seeded } from './reco-fixture.js';
import { makeEnv, type TestEnv } from './helpers.js';

// R2: the taste profile (decay, negatives, normalisation, cold start, signals, cache).
const c = recoCoefficients();
const vec = (o: Record<string, number>): SparseVec => new Map(Object.entries(o));
const sig = (item: string, weight: number, ageDays = 0, kind: SignalKind = 'thumbUp1'): Signal => ({ item, kind, weight, at: NOW - ageDays * DAY });
const look = (vs: Record<string, SparseVec>, rows: Record<string, Partial<FeatureRow>> = {}) =>
  ({ vec: (id: string) => vs[id], row: (id: string) => rows[id] as FeatureRow | undefined });

describe('maths', () => {
  it('recency decay: w * 0.5^(age/120)', () => {
    expect(decayed(2, 0, 120)).toBe(2);
    expect(decayed(2, 120, 120)).toBeCloseTo(1, 10);
    expect(decayed(2, 240, 120)).toBeCloseTo(0.5, 10);
    expect(decayed(2, -5, 120)).toBe(2); // the future counts as now
    expect(decayed(2, 30, 30)).toBeCloseTo(1, 10); // RECO_HALF_LIFE_DAYS
  });

  it('old signals weigh less than new ones in the positive vector, and the vector is L2-normalised', () => {
    const t = buildTaste([sig('a', 3), sig('b', 3, 120)], new Set(), look({ a: vec({ x: 1 }), b: vec({ y: 1 }) }), c, NOW);
    expect(t.pos.get('x')! / t.pos.get('y')!).toBeCloseTo(2, 6); // 3 vs 3 * 0.5
    expect(norm(t.pos)).toBeCloseTo(1, 10);
    expect(t.neg.size).toBe(0);
  });

  it('negative signals feed a separate, normalised negative vector and never the positive one', () => {
    const t = buildTaste(
      [sig('a', 3), sig('a2', 1.5), sig('bad', -4, 0, 'thumbDown'), sig('drop', -2, 0, 'dropped')],
      new Set(), look({ a: vec({ x: 1 }), a2: vec({ x: 1 }), bad: vec({ z: 1 }), drop: vec({ w: 1 }) }), c, NOW,
    );
    expect(t.pos.has('z')).toBe(false);
    expect(t.pos.has('w')).toBe(false);
    expect(t.neg.get('z')! / t.neg.get('w')!).toBeCloseTo(2, 6); // 4 vs 2
    expect(norm(t.neg)).toBeCloseTo(1, 10);
  });

  it('signals on one title add up: a like cancelled by "dropped" ends up negative', () => {
    const t = buildTaste([sig('a', 1.5), sig('a', -2, 0, 'dropped')], new Set(), look({ a: vec({ x: 1 }) }), c, NOW);
    expect(t.pos.size).toBe(0);
    expect(t.neg.get('x')).toBeCloseTo(1, 10);
    expect(t.weighted).toBe(1);
  });

  it('cold start: fewer than 5 weighted interactions; zero-weight signals and repeated titles do not count', () => {
    const vs = Object.fromEntries('abcdef'.split('').map((k) => [k, vec({ [k]: 1 })]));
    const four = ['a', 'b', 'c', 'd'].map((k) => sig(k, 1));
    expect(buildTaste(four, new Set(), look(vs), c, NOW)).toMatchObject({ weighted: 4, cold: true });
    expect(buildTaste([...four, sig('a', 1.5)], new Set(), look(vs), c, NOW)).toMatchObject({ weighted: 4, cold: true });
    expect(buildTaste([...four, sig('e', 0, 0, 'star')], new Set(), look(vs), c, NOW)).toMatchObject({ weighted: 4, cold: true }); // a 3-star rating is neutral
    expect(buildTaste([...four, sig('e', 1)], new Set(), look(vs), c, NOW)).toMatchObject({ weighted: 5, cold: false });
    expect(buildTaste([...four, sig('unindexed', 1)], new Set(), look(vs), c, NOW)).toMatchObject({ weighted: 5, cold: false }); // counts, adds nothing
    expect(buildTaste([], new Set(), look({}), c, NOW)).toMatchObject({ weighted: 0, cold: true, prefs: { genres: {}, runtimeBand: null } });
  });

  it('R3: anchors (strongest positive titles), language shares, drop rate and time-of-day mix', () => {
    const R = (type: 'Movie' | 'Series', genres: string[], original_language: string): Partial<FeatureRow> => ({ type, genres, tags: [], original_language });
    const rows = { a: R('Series', ['drama'], 'en'), b: R('Series', ['comedy'], 'en'), d: R('Series', ['drama'], 'ja'), e: R('Series', ['drama'], 'ja'), m: R('Movie', ['comedy'], 'en') };
    const vs = Object.fromEntries(Object.keys(rows).map((k) => [k, vec({ [k]: 1 })]));
    const signals = [sig('a', 3, 0, 'seriesCompletion'), sig('b', 1.5, 0, 'seriesCompletion'), sig('d', -1, 0, 'abandonedEarly'), sig('e', -2, 0, 'dropped'), sig('m', 1, 0, 'finishedMovie')];
    const at = (h: number) => Date.UTC(2026, 8, 20, h);
    const plays = [at(20), at(21), at(22), at(20), at(21), at(9)].map((t, n) => ({ item: ['a', 'b', 'a', 'b', 'm', 'a'][n]!, at: t }));
    const tz = process.env.TZ;
    process.env.TZ = 'UTC'; // the time buckets follow the instance's time zone
    const t = buildTaste(signals, new Set(), look(vs, rows), c, NOW, plays);
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    expect(t.anchors).toEqual([{ id: 'a', w: 1 }, { id: 'b', w: 0.5 }, { id: 'm', w: 0.333 }]); // negatives are no anchors
    expect(t.prefs.languages).toEqual({ en: 1 });
    expect(t.prefs.dropRate).toBeCloseTo(2 / 4, 3); // d and e of the four series started
    expect(t.prefs.timeOfDay!.n).toEqual({ morning: 1, afternoon: 0, evening: 5, night: 0 });
    expect(t.prefs.timeOfDay!.genres.evening.comedy).toBeCloseTo(3 / 5, 3);
    expect(t.prefs.timeOfDay!.overall.drama).toBeCloseTo(3 / 6, 3);
    // fewer than 3 started series: no drop rate
    expect(buildTaste([sig('a', 3, 0, 'seriesCompletion')], new Set(), look(vs, rows), c, NOW).prefs.dropRate).toBeNull();
  });

  it('derived preferences: anime share, runtime band, genre shares, rewatch share', () => {
    const rows = {
      a: { genres: ['anime', 'fantasy'], tags: [], runtime_min: 24 }, b: { genres: ['drama'], tags: ['anime'], runtime_min: 30 }, d: { genres: ['drama'], tags: [], runtime_min: 120 },
    };
    const t = buildTaste([sig('a', 2), sig('b', 2), sig('d', 1), sig('a', 1, 0, 'rewatch')], new Set(['a']), look({}, rows), c, NOW);
    expect(t.prefs.animeShare).toBeCloseTo(5 / 6, 2);
    expect(t.prefs.runtimeBand).toBe('short');
    expect(t.prefs.genres.drama).toBeCloseTo((2 + 1) / 6, 2);
    expect(t.prefs.rewatchShare).toBeCloseTo(1 / 6, 2);
    expect(t.seen.has('a')).toBe(true);
  });
});

describe('signals and cache', () => {
  let env: TestEnv;
  let s: Seeded;
  const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
  beforeAll(async () => { env = await makeEnv(); s = await seedProfiles(env); await buildIndex(env); });
  afterAll(() => env.close());
  beforeEach(async () => {
    for (const t of ['thumbs', 'watchlist', 'dropped', 'ratings', 'play_seconds']) await env.pool.query(`delete from ${t}`);
    for (const k of await env.kv.keys('reco:')) await env.kv.del(k);
    resetIndexCache(env.ctx);
  });
  const get = async (f: ReturnType<typeof fakeJf>, p = s.owner, u = s.user) => gatherSignals(engineCtx(env, f.jf), u, p, c, NOW);
  const byKind = (r: { signals: Signal[] }, k: SignalKind) => r.signals.filter((x) => x.kind === k);

  it('thumbs, stars (owner only), watchlist and dropped carry the spec weights', async () => {
    const f = fakeJf();
    await env.pool.query("insert into thumbs(user_id,item_id,value,item_name,profile_id,created_at) values ($1,$2,2,'x',$1,$5),($1,$3,1,'x',$1,$5),($1,$4,-1,'x',$1,$5)", [s.owner.id, H('saga1'), H('saga2'), H('bear1'), iso(0)]);
    await env.pool.query("insert into ratings(user_id,item_id,item_name,stars) values ($1,$2,'x',5),($1,$3,'x',4),($1,$4,'x',3),($1,$5,'x',2),($1,$6,'x',1)", [s.owner.id, H('mars'), H('orbit'), H('noir1'), H('noir2'), H('noir3')]);
    await env.pool.query("insert into watchlist(user_id,profile_id,item_id) values ($1,$1,$2)", [s.owner.id, H('doc1')]);
    await env.pool.query("insert into dropped(profile_id,item_id) values ($1,$2)", [s.owner.id, H('rom2')]);
    const r = await get(f);
    const w = (k: SignalKind) => byKind(r, k).map((x) => x.weight).sort((a, b) => a - b);
    expect(w('thumbUp2')).toEqual([3]);
    expect(w('thumbUp1')).toEqual([1.5]);
    expect(w('thumbDown')).toEqual([-4]);
    expect(w('star')).toEqual([-2, -1, 0, 1.5, 2.5]);
    expect(w('watchlist')).toEqual([0.5]);
    expect(w('dropped')).toEqual([-2]);
    // stars belong to the account: a second (kids) profile does not inherit them
    const k = await get(f, s.kids, s.kidsUser);
    expect(byKind(k, 'star')).toEqual([]);
    expect(byKind(k, 'thumbDown')).toEqual([]); // thumbs are per profile
  });

  it('finished movie +1.0; series completion +2.0*r from played / (played + unplayed)', async () => {
    const f = fakeJf();
    f.state.history = [
      dto('saga1', { played: true, lastPlayedDate: iso(3) }),
      { ...dto('cops', { played: true, lastPlayedDate: iso(2) }), id: H('cops-e1'), type: 'Episode', seriesId: H('cops') },
      { ...dto('cops', { played: true, lastPlayedDate: iso(1) }), id: H('cops-e2'), type: 'Episode', seriesId: H('cops') },
    ];
    f.state.unplayed[H('cops')] = 6; // 2 played, 6 left: r = 0.25
    const r = await get(f);
    expect(byKind(r, 'finishedMovie')).toEqual([{ item: H('saga1'), kind: 'finishedMovie', weight: 1, at: NOW - 3 * DAY }]);
    const sc = byKind(r, 'seriesCompletion');
    expect(sc).toHaveLength(1);
    expect(sc[0]).toMatchObject({ item: H('cops'), at: NOW - 1 * DAY });
    expect(sc[0]!.weight).toBeCloseTo(0.5, 10);
    expect([...r.seen].sort()).toEqual([H('cops'), H('saga1')].sort()); // episodes roll up
  });

  it('early abandonment: below 15 % and no return for 14 days, and only then', async () => {
    const f = fakeJf();
    f.state.history = [
      dto('rom1', { played: false, playedPercentage: 5, lastPlayedDate: iso(20) }), // abandoned
      dto('rom2', { played: false, playedPercentage: 5, lastPlayedDate: iso(10) }), // may still come back
      dto('rom3', { played: false, playedPercentage: 40, lastPlayedDate: iso(60) }), // got far enough
    ];
    const r = await get(f);
    expect(byKind(r, 'abandonedEarly')).toEqual([{ item: H('rom1'), kind: 'abandonedEarly', weight: -1, at: NOW - 20 * DAY }]);
    expect(byKind(r, 'finishedMovie')).toEqual([]);
  });

  it('rewatch (owner, 2+ days, >= 1.6 runtimes of viewing) and favorites (+1.0)', async () => {
    const f = fakeJf();
    f.state.history = [dto('orbit', { played: true, lastPlayedDate: iso(4) }), dto('mars', { played: true, lastPlayedDate: iso(5) })];
    f.state.favorites = [dto('doc1', { favorite: true })];
    const rt = 118 * 60; // orbit runtime in seconds
    await env.pool.query("insert into play_seconds(user_id,item_id,day,seconds,item_name) values ($1,$2,'2026-09-01',$3,'x'),($1,$2,'2026-09-20',$3,'x'),($1,$4,'2026-09-01',100,'x'),($1,$4,'2026-09-02',100,'x')", [s.owner.id, H('orbit'), rt, H('mars')]);
    const r = await get(f);
    expect(byKind(r, 'rewatch').map((x) => x.item)).toEqual([H('orbit')]);
    expect(byKind(r, 'favorite').map((x) => [x.item, x.weight])).toEqual([[H('doc1'), 1]]);
    expect(byKind(r, 'favorite')[0]!.at).toBe(NOW - 60 * DAY); // favorites carry no date
  });

  it('a failing media server means no watch data, not an error', async () => {
    const f = fakeJf();
    f.state.fail.add('history');
    f.state.fail.add('items');
    await env.pool.query("insert into thumbs(user_id,item_id,value,item_name,profile_id) values ($1,$2,2,'x',$1)", [s.owner.id, H('saga1')]);
    const r = await get(f);
    expect(r.signals.map((x) => x.kind)).toEqual(['thumbUp2']);
  });

  it('tasteProfile is cached by user-data version and home generation, and reset drops the cache', async () => {
    const f = fakeJf();
    const ctx = engineCtx(env, f.jf);
    const w = recoWeights(ctx.cfg);
    const idx = await loadIndex(ctx, w, NOW);
    f.state.history = [dto('saga1', { played: true, lastPlayedDate: iso(3) })];
    const first = await tasteProfile(ctx, s.user, s.owner, idx, c, w, NOW);
    expect(first.pos.size).toBeGreaterThan(0);
    const n = () => f.calls.filter((x) => x.fn === 'history').length;
    expect(n()).toBe(1);
    await tasteProfile(ctx, s.user, s.owner, idx, c, w, NOW);
    expect(n()).toBe(1); // cache hit
    const hit = await tasteProfile(ctx, s.user, s.owner, idx, c, w, NOW);
    expect(hit.weighted).toBe(first.weighted);
    expect([...hit.pos.keys()].sort()).toEqual([...first.pos.keys()].sort());
    expect([...hit.seen]).toEqual([H('saga1')]);
    f.state.version = '2'; // a play happened
    await tasteProfile(ctx, s.user, s.owner, idx, c, w, NOW);
    expect(n()).toBe(2);
    await bumpHome(ctx, s.owner.id); // a thumb, rating, watchlist change
    await tasteProfile(ctx, s.user, s.owner, idx, c, w, NOW);
    expect(n()).toBe(3);
    await resetTaste(ctx, s.owner.id);
    expect(await env.kv.keys(`reco:taste:${s.owner.id}:`)).toEqual([]);
    await tasteProfile(ctx, s.user, s.owner, idx, c, w, NOW);
    expect(n()).toBe(4);
    // the cache holds numbers and ids only: no titles
    const key = (await env.kv.keys('reco:taste:'))[0]!;
    expect(await env.kv.get(key)).not.toMatch(/SAGA|Saga/);
  });
});
