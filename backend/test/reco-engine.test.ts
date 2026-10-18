// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { recoShadowOverlap, recoShadowRuns, recoShadowScoreDelta } from '../src/metrics.js';
import { gatherCandidates, SOURCES, type CandidateSource, type SourceInput } from '../src/reco/candidates.js';
import type { Taste } from '../src/reco/profile.js';
import { overlap, recommend, scoreDelta, shadowIdle } from '../src/reco/recommend.js';
import { buildPostings, dot, loadIndex, nearest, NN_MAX_SCAN, POSTING_CAP, resetIndexCache, type SparseVec } from '../src/reco/vectors.js';
import { recoCoefficients, recoWeights } from '../src/reco/weights.js';
import { libraryBecause } from '../src/routes/discover.js';
import type { Ctx } from '../src/ctx.js';
import { buildIndex, dto, engineCtx, fakeJf, H, keysOf, NOW, DAY, seedProfiles, type Seeded } from './reco-fixture.js';
import { makeEnv, type TestEnv } from './helpers.js';

// R2: candidates, recommend() end to end (fixture ordering, kids, viewer token), RECO_ENGINE shadow mode.
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

/** the profile of the fixture tests: a space fan with one thumbs-up, one thumbs-down, a favorite, a watchlist title and a dropped one */
async function spaceFan(f: ReturnType<typeof fakeJf>) {
  f.state.history = [
    dto('saga2', { played: true, lastPlayedDate: iso(10) }),
    dto('saga1', { played: true, lastPlayedDate: iso(40) }),
    dto('noir1', { played: true, lastPlayedDate: iso(20) }),
    dto('mars', { played: true, lastPlayedDate: iso(5) }),
    dto('rom1', { played: false, playedPercentage: 5, lastPlayedDate: iso(30) }),
  ];
  f.state.similar[H('saga2')] = ['saga1', 'saga3', 'mars', 'orbit', 'robot', 'bear1', 'signal'];
  await env.pool.query("insert into thumbs(user_id,item_id,value,item_name,profile_id,created_at) values ($1,$2,2,'x',$1,$4),($1,$3,-1,'x',$1,$4)", [s.owner.id, H('saga2'), H('bear1'), iso(10)]);
}

describe('fixture: the default ordering is locked', () => {
  it('because / taste / home_rows / detail_similar / postplay for the space fan', async () => {
    const f = fakeJf();
    await spaceFan(f);
    const ctx = engineCtx(env, f.jf);
    const run = async (surface: Parameters<typeof recommend>[3]['surface']) =>
      keysOf((await recommend(ctx, s.user, s.owner, { surface, ...(surface === 'taste' || surface === 'home_rows' ? {} : { seed: H('saga2') }), limit: 10, now: NOW })).items.map((i) => i.item));
    // If this fails after a coefficient change, the new order must be reviewed and the expectation updated on purpose.
    expect(await run('because')).toEqual(['saga3', 'orbit', 'noir3', 'doc3', 'robot', 'rom3', 'cops', 'hype', 'signal', 'heist2']);
    expect(await run('taste')).toEqual(['saga3', 'signal', 'hype', 'noir2', 'orbit', 'doc3', 'heist2', 'cops', 'robot', 'noir3']);
    expect(await run('home_rows')).toEqual(['saga3', 'signal', 'hype', 'noir3', 'orbit', 'doc3', 'cops', 'robot', 'noir2', 'rom3']);
    expect(await run('detail_similar')).toEqual(['saga3', 'orbit', 'robot', 'noir3', 'doc3', 'rom3', 'cops', 'signal', 'hype', 'heist2']);
    expect(await run('postplay')).toEqual(['saga3', 'orbit', 'noir3', 'doc3', 'robot', 'rom3', 'cops', 'signal', 'hype', 'heist2']);
  });

  it('the thumbed-down title never appears, played titles sink, the seed is never recommended', async () => {
    const f = fakeJf();
    await spaceFan(f);
    const r = await recommend(engineCtx(env, f.jf), s.user, s.owner, { surface: 'because', seed: H('saga2'), limit: 30, now: NOW });
    const k = keysOf(r.items.map((i) => i.item));
    expect(k).not.toContain('bear1');
    expect(k).not.toContain('saga2');
    expect(r.pool.has(H('bear1'))).toBe(false);
    // played titles come last of the pool: saga1, mars and noir1 were watched
    const order = k.filter((x) => ['saga1', 'mars', 'noir1'].includes(x));
    expect(k.indexOf(order[0]!)).toBeGreaterThan(k.indexOf('saga3'));
    // the seed's franchise is capped at 2 per row: saga1 + saga3 are the other two of the collection, so at most two of them appear
    expect(k.filter((x) => x.startsWith('saga')).length).toBeLessThanOrEqual(2);
  });

  it('every item carries its sources and the score parts', async () => {
    const f = fakeJf();
    await spaceFan(f);
    const r = await recommend(engineCtx(env, f.jf), s.user, s.owner, { surface: 'because', seed: H('saga2'), limit: 5, now: NOW });
    const saga3 = r.items.find((i) => keysOf([i.item])[0] === 'saga3')!;
    expect(saga3.sources.sort()).toEqual(['similar', 'taste_nn', 'universe']);
    expect(saga3.parts.seed).toBeGreaterThan(0.5);
    expect(r.items.every((i) => i.sources.length > 0)).toBe(true);
    expect(r.cold).toBe(false);
  });

  it('the episode of a seed is rolled up to its series', async () => {
    const f = fakeJf();
    await spaceFan(f);
    const spy = f.jf.item.bind(f.jf);
    f.jf.item = async (u, id) => (id === H('cops-e1') ? { ...dto('cops'), id, type: 'Episode', seriesId: H('cops') } : spy(u, id));
    f.state.similar[H('cops')] = ['noir1', 'noir2'];
    const r = await recommend(engineCtx(env, f.jf), s.user, s.owner, { surface: 'postplay', seed: H('cops-e1'), limit: 5, now: NOW });
    expect(f.calls.some((x) => x.fn === 'similar')).toBe(true);
    expect(keysOf(r.items.map((i) => i.item))).not.toContain('cops');
    expect(r.items.find((i) => i.item.id === H('noir2'))!.sources).toContain('similar');
  });
});

describe('cold start', () => {
  it('a profile without interactions gets the quality prior, flagged cold, and no neighbours', async () => {
    const f = fakeJf();
    const r = await recommend(engineCtx(env, f.jf), s.user, s.owner, { surface: 'taste', limit: 8, now: NOW });
    expect(r.cold).toBe(true);
    expect(r.items).toHaveLength(8);
    expect(r.items.every((i) => i.sources.join() === 'prior')).toBe(true);
    expect(r.items.every((i) => i.parts.affinity === 0)).toBe(true);
  });
  it('4 interactions are still cold, the 5th ends it', async () => {
    const f = fakeJf();
    await env.pool.query("insert into thumbs(user_id,item_id,value,item_name,profile_id) select $1, id, 1, 'x', $1 from unnest($2::text[]) id", [s.owner.id, ['saga1', 'saga2', 'mars', 'orbit'].map(H)]);
    expect((await recommend(engineCtx(env, f.jf), s.user, s.owner, { surface: 'taste', limit: 5, now: NOW })).cold).toBe(true);
    await env.pool.query("insert into thumbs(user_id,item_id,value,item_name,profile_id) values ($1,$2,1,'x',$1)", [s.owner.id, H('signal')]);
    await (await import('../src/homegen.js')).bumpHome(env.ctx, s.owner.id);
    const r = await recommend(engineCtx(env, f.jf), s.user, s.owner, { surface: 'taste', limit: 5, now: NOW });
    expect(r.cold).toBe(false);
    expect(r.items.some((i) => i.sources.includes('taste_nn'))).toBe(true);
  });
});

describe('candidates', () => {
  const inputFor = async (seedKey: string | undefined, o: Partial<SourceInput> = {}, cfg = {}): Promise<SourceInput> => {
    const f = fakeJf();
    f.state.similar[H('saga1')] = ['saga2', 'orbit', 'rom1'];
    const ctx = engineCtx(env, f.jf, cfg);
    const index = await loadIndex(ctx, recoWeights(ctx.cfg), NOW);
    const pos: SparseVec = new Map(index.vecs.get(H('saga1'))!);
    const taste: Taste = { pos, neg: new Map(), weighted: 9, cold: false, seen: new Set([H('saga1')]), prefs: { animeShare: 0, runtimeBand: null, genres: {}, rewatchShare: 0 } };
    return { ctx, user: s.user, profile: s.owner, taste, index, c: recoCoefficients(ctx.cfg), surface: 'because', ...(seedKey ? { seed: dto(seedKey) } : {}), ...o };
  };

  it('sources 1-3 are tagged: similar(), same collection or creator, nearest neighbours of the profile', async () => {
    const got = await gatherCandidates(await inputFor('saga1'));
    const src = (k: string) => [...(got.get(H(k))?.sources ?? [])].sort();
    expect(src('saga2')).toEqual(['similar', 'taste_nn', 'universe']);
    expect(src('saga3')).toEqual(['taste_nn', 'universe']); // collection mate the media server did not list
    expect(src('orbit')).toEqual(['similar', 'taste_nn']);
    expect(src('rom1')).toEqual(['similar', 'taste_nn', 'universe']); // shares the lead actor (act-kim) with the seed
    expect(got.get(H('saga2'))!.jfRank).toBe(1);
    expect(got.get(H('rom1'))!.jfRank).toBe(0);
    expect(got.has(H('saga1'))).toBe(false); // neither the seed ...
    expect([...got.values()].every((x) => x.sources.size > 0)).toBe(true);
  });

  it('a shared creator (one of the first people of the index row) is a universe candidate', async () => {
    const got = await gatherCandidates(await inputFor('noir1'));
    // dir-moro directed noir1..noir3 (first slot); act-ng (second slot) also plays in cops and rom3
    expect([...got.keys()].filter((id) => got.get(id)!.sources.has('universe')).map((id) => id).sort()).toEqual(
      ['noir2', 'noir3', 'cops', 'rom3'].map(H).sort());
  });

  it('nearest neighbours: top RECO knn by cosine, never what the profile has seen', async () => {
    const got = await gatherCandidates(await inputFor(undefined, {}, { RECO_COEFFS: '{"candidates.knn":3}' }));
    const nn = [...got.values()].filter((x) => x.sources.has('taste_nn')).map((x) => x.id);
    expect(nn).toHaveLength(3);
    expect(nn).not.toContain(H('saga1'));
    expect(nn.map((id) => keysOf([id])[0]).sort()).toEqual(['saga2', 'saga3', 'mars'].sort());
    // the default is 200: the whole fixture library fits
    const all = await gatherCandidates(await inputFor(undefined));
    expect([...all.values()].filter((x) => x.sources.has('taste_nn')).length).toBeGreaterThan(10);
  });

  it('a failing source contributes nothing; a source for R3 plugs in with numeric signals', async () => {
    const boom: CandidateSource = { name: 'cooccurrence', social: true, run: async () => { throw new Error('x'); } };
    const ok: CandidateSource = { name: 'transition', social: true, run: async () => [{ id: H('mars'), signals: { transition: 0.8 } }] };
    const got = await gatherCandidates(await inputFor('saga1'), [...SOURCES, boom, ok]);
    expect(got.get(H('mars'))!.signals.transition).toBe(0.8);
    expect([...got.get(H('mars'))!.sources]).toContain('transition');
    expect(got.has(H('saga2'))).toBe(true);
  });

  it('kids profiles never get social sources, by flag or by name', async () => {
    let ran = 0;
    const social: CandidateSource = { name: 'friends', social: true, run: async () => { ran++; return [{ id: H('rom1') }]; } };
    const sneaky: CandidateSource = { name: 'transition', social: false, run: async () => { ran++; return [{ id: H('rom2') }]; } };
    const kidsIn = await inputFor('rom1', { profile: s.kids, user: s.kidsUser });
    const k = await gatherCandidates(kidsIn, [...SOURCES, social, sneaky]);
    expect(ran).toBe(0);
    expect([...k.values()].flatMap((x) => [...x.sources]).filter((x) => ['friends', 'transition', 'cooccurrence', 'trending'].includes(x))).toEqual([]);
    const g = await gatherCandidates(await inputFor('rom1'), [...SOURCES, social, sneaky]);
    expect(ran).toBe(2);
    expect(g.get(H('rom2'))!.sources.has('transition')).toBe(true);
  });
});

describe('kids and the viewer token', () => {
  it('the kids profile gets only titles within its cap, even when the media server leaks others', async () => {
    const f = fakeJf(); // no server-side cap: this is our own filter
    f.state.similar[H('rom1')] = ['rom2', 'noir1', 'saga1', 'unrated', 'bear1', 'doc1', 'cops'];
    f.state.history = ['rom1', 'rom2', 'rom3', 'bear1', 'pups', 'robot'].map((k) => dto(k, { played: true, lastPlayedDate: iso(9) }));
    for (const surface of ['because', 'taste', 'home_rows'] as const) {
      const r = await recommend(engineCtx(env, f.jf), s.kidsUser, s.kids, { surface, seed: surface === 'because' ? H('rom1') : undefined, limit: 30, now: NOW });
      expect(r.items.length).toBeGreaterThan(0);
      for (const i of r.items) expect(['FSK 0', 'FSK 6'], keysOf([i.item])[0]).toContain(i.item.rating);
      expect(keysOf(r.items.map((i) => i.item))).not.toContain('unrated');
    }
  });

  it('with the server enforcing the cap on the kids identity, nothing above it is even resolved', async () => {
    const f = fakeJf();
    f.state.caps.jfkid = 6;
    f.state.history = ['rom1', 'rom2', 'rom3', 'bear1', 'pups', 'robot'].map((k) => dto(k, { played: true, lastPlayedDate: iso(9) }));
    const r = await recommend(engineCtx(env, f.jf), s.kidsUser, s.kids, { surface: 'taste', limit: 30, now: NOW });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => (i.item.rating ?? '') <= 'FSK 6')).toBe(true);
  });

  it('every media server call acts as the viewer: the owner as the account, kids as the kids identity', async () => {
    const f = fakeJf();
    await spaceFan(f);
    await recommend(engineCtx(env, f.jf), s.user, s.owner, { surface: 'because', seed: H('saga2'), limit: 5, now: NOW });
    expect(f.calls.length).toBeGreaterThan(3);
    expect(f.calls.every((x) => x.user === s.user)).toBe(true);
    f.calls.length = 0;
    await recommend(engineCtx(env, f.jf), s.kidsUser, s.kids, { surface: 'because', seed: H('rom1'), limit: 5, now: NOW });
    expect(f.calls.length).toBeGreaterThan(3);
    expect(f.calls.every((x) => x.user === s.kidsUser)).toBe(true);
    expect(new Set(f.calls.map((x) => x.fn))).toEqual(new Set(['item', 'items', 'history', 'similar', 'credits']));
  });

  it('titles the viewer cannot see are dropped, not shown', async () => {
    const f = fakeJf();
    await spaceFan(f);
    f.state.hidden.add(H('saga3'));
    const r = await recommend(engineCtx(env, f.jf), s.user, s.owner, { surface: 'because', seed: H('saga2'), limit: 30, now: NOW });
    expect(keysOf(r.items.map((i) => i.item))).not.toContain('saga3');
  });
});

describe('RECO_ENGINE', () => {
  const metric = async (m: { get(): Promise<{ values: Array<{ value: number; labels: Record<string, unknown>; metricName?: string }> }> }, filter: (l: Record<string, unknown>, n?: string) => boolean = () => true) =>
    (await m.get()).values.filter((v) => filter(v.labels, v.metricName)).reduce((a, v) => a + v.value, 0);
  const runs = (result: string) => metric(recoShadowRuns, (l) => l.result === result);
  const hist = (h: typeof recoShadowOverlap) => metric(h, (_l, n) => n?.endsWith('_count') ?? false);
  // libraryBecause() calls recommend() without `now`, so the engine reads the clock: pin it to the fixture's NOW
  // (only Date is faked; timers stay real for the shadow runs)
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  async function because(cfg: Partial<Ctx['cfg']>, f: ReturnType<typeof fakeJf>) {
    const ctx = engineCtx(env, f.jf, cfg) as Ctx;
    const r = await libraryBecause(ctx, s.user, s.owner.id);
    await shadowIdle();
    return r;
  }

  it('default v1: Jellyfin similar() order minus thumbs-down, no v2 work, no metrics', async () => {
    const f = fakeJf();
    await spaceFan(f);
    const before = [await runs('ok'), await runs('error')];
    const r = await because({}, f);
    expect(keysOf(r.items)).toEqual(['saga1', 'saga3', 'mars', 'orbit', 'robot', 'signal']);
    expect([await runs('ok'), await runs('error')]).toEqual(before);
    expect(await env.kv.keys('reco:')).toEqual([]);
  });

  it('shadow: returns exactly the v1 answer, computes v2 beside it, emits overlap and score-delta metrics', async () => {
    const f = fakeJf();
    await spaceFan(f);
    const v1 = await because({}, f);
    for (const k of await env.kv.keys('reco:')) await env.kv.del(k);
    const before = { ok: await runs('ok'), ov: await hist(recoShadowOverlap), sd: await hist(recoShadowScoreDelta) };
    const r = await because({ RECO_ENGINE: 'shadow' }, f);
    expect(r).toEqual(v1);
    expect(await runs('ok')).toBe(before.ok + 1);
    expect(await hist(recoShadowOverlap)).toBe(before.ov + 1);
    expect(await hist(recoShadowScoreDelta)).toBe(before.sd + 1);
    // the same profile, version and seed are compared once per 10 minutes, not on every request
    await because({ RECO_ENGINE: 'shadow' }, f);
    expect(await runs('ok')).toBe(before.ok + 1);
  });

  it('shadow metrics carry bounded labels only: no titles, ids or users', async () => {
    const f = fakeJf();
    await spaceFan(f);
    await because({ RECO_ENGINE: 'shadow' }, f);
    const text = [recoShadowRuns, recoShadowOverlap, recoShadowScoreDelta];
    for (const m of text) {
      for (const v of (await m.get()).values) {
        expect(Object.keys(v.labels).every((k) => ['surface', 'result', 'le'].includes(k))).toBe(true);
        expect(JSON.stringify(v.labels)).not.toMatch(/SAGA|saga|[0-9a-f]{32}|jfreco/i);
      }
    }
  });

  it('shadow: a failing v2 counts an error and still returns v1', async () => {
    const f = fakeJf();
    await spaceFan(f);
    const v1 = await because({}, f);
    for (const k of await env.kv.keys('reco:')) await env.kv.del(k);
    const bad = engineCtx(env, f.jf, { RECO_ENGINE: 'shadow' });
    (bad as { db: unknown }).db = new Proxy(env.ctx.db, { get: (t, p, r) => (p === 'query' ? async (q: string, a?: unknown[]) => { if (/item_features/.test(q)) throw new Error('index gone'); return t.query(q, a as never); } : Reflect.get(t, p, r)) });
    const before = await runs('error');
    const r = await libraryBecause(bad as Ctx, s.user, s.owner.id);
    await shadowIdle();
    expect(r).toEqual(v1);
    expect(await runs('error')).toBe(before + 1);
  });

  it('v2 answers with the v2 order (the seed row stays the same), and falls back to v1 when v2 fails', async () => {
    const f = fakeJf();
    await spaceFan(f);
    const v1 = await because({}, f);
    const v2 = await because({ RECO_ENGINE: 'v2' }, f);
    expect(v2.because).toEqual(v1.because);
    expect(keysOf(v2.items).slice(0, 10)).toEqual(['saga3', 'orbit', 'noir3', 'doc3', 'robot', 'rom3', 'cops', 'hype', 'signal', 'heist2']);
    expect(keysOf(v2.items)).not.toContain('bear1');
    const broken = engineCtx(env, f.jf, { RECO_ENGINE: 'v2' });
    (broken as { db: unknown }).db = new Proxy(env.ctx.db, { get: (t, p, r) => (p === 'query' ? async (q: string, a?: unknown[]) => { if (/item_features/.test(q)) throw new Error('x'); return t.query(q, a as never); } : Reflect.get(t, p, r)) });
    // the v2 row is cached for BECAUSE_TTL: a second call is served from it, without recommend()
    expect(keysOf((await libraryBecause(broken as Ctx, s.user, s.owner.id)).items)).toEqual(keysOf(v2.items));
    for (const pre of ['reco:', 'because:v2:']) for (const k of await env.kv.keys(pre)) await env.kv.del(k);
    expect(keysOf((await libraryBecause(broken as Ctx, s.user, s.owner.id)).items)).toEqual(keysOf(v1.items));
  });

  it('overlap and score delta maths', () => {
    expect(overlap(['a', 'b', 'c', 'd'], ['b', 'c', 'x', 'y'])).toBe(0.5);
    expect(overlap([], ['a'])).toBe(0);
    expect(overlap(Array.from({ length: 20 }, (_, n) => `a${n}`), Array.from({ length: 20 }, (_, n) => `a${n}`))).toBe(1); // top 10 only
    const reason = { seed: null, traits: [] };
    const items = [{ item: dto('saga1'), score: 0.8, sources: [], parts: {} as never, reason }, { item: dto('saga2'), score: 0.6, sources: [], parts: {} as never, reason }];
    expect(scoreDelta(['a', 'b', 'zz'], items, new Map([['a', 0.5], ['b', 0.3]]))).toBeCloseTo(0.3, 10);
    expect(scoreDelta(['zz'], items, new Map())).toBeNull();
  });
});

describe('nearest-neighbour search is bounded (I1)', () => {
  const vec = (o: Record<string, number>): SparseVec => new Map(Object.entries(o));
  const full = (vecs: Map<string, SparseVec>, q: SparseVec, k: number) =>
    [...vecs].map(([id, v]) => [id, dot(q, v)] as [string, number]).filter(([, x]) => x > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, k);

  it('on a small library it equals a full scan (signed dimensions included)', () => {
    const vecs = new Map<string, SparseVec>([
      ['a', vec({ 'g:sf': 0.8, 'n:year': -0.2 })], ['b', vec({ 'g:crime': 0.9, 'n:year': -0.4 })], ['c', vec({ 'g:sf': 0.3, 't:space': 0.9 })],
      ['d', vec({ 'g:romance': 1 })], ['e', vec({ 'n:year': 0.5, 'g:crime': 0.5 })],
    ]);
    const index = { vecs, postings: buildPostings(vecs) };
    const q = vec({ 'g:sf': 0.7, 't:space': 0.5, 'n:year': -0.3 });
    expect(nearest(index, q, 10)).toEqual(full(vecs, q, 10));
    expect(nearest(index, q, 10, (id) => id === 'c').map(([id]) => id)).not.toContain('c');
  });

  it('a large library: one call scores a bounded pool, never every vector, and still finds the strongest matches', () => {
    const vecs = new Map<string, SparseVec>();
    // 30 000 titles share the genre; 30 000 more share nothing with the query
    for (let i = 0; i < 30_000; i++) vecs.set(`g${i}`, vec({ 'g:drama': 0.1 + (i % 100) / 1000, [`t:x${i % 500}`]: 0.5 }));
    for (let i = 0; i < 30_000; i++) vecs.set(`o${i}`, vec({ 'g:other': 1 }));
    vecs.set('best', vec({ 'g:drama': 0.6, 't:space': 0.8 }));
    const index = { vecs, postings: buildPostings(vecs) };
    expect(Math.max(...[...index.postings.values()].map((l) => l.length))).toBeLessThanOrEqual(POSTING_CAP);
    const stats = { scanned: 0 };
    const out = nearest(index, vec({ 'g:drama': 0.6, 't:space': 0.8 }), 20, () => false, stats);
    expect(out[0]![0]).toBe('best');
    expect(stats.scanned).toBeLessThanOrEqual(NN_MAX_SCAN + POSTING_CAP);
    expect(stats.scanned).toBeLessThan(vecs.size / 50);
  });
});
