// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { lockKey, pairTableBuilds, tablesKey, transitionsFor } from '../src/reco/aggregates.js';
import { contextFor, deviceMixes } from '../src/reco/context.js';
import type { SourceName } from '../src/reco/candidates.js';
import { recommend } from '../src/reco/recommend.js';
import { indexLoads, resetIndexCache } from '../src/reco/vectors.js';
import { recoCoefficients, SURFACES, type Surface } from '../src/reco/weights.js';
import { encrypt } from '../src/crypto.js';
import type { Ctx } from '../src/ctx.js';
import { buildIndex, DAY, dto, engineCtx, fakeJf, H, keysOf, NOW, seedProfiles, type Seeded } from './reco-fixture.js';
import { makeEnv, type TestEnv } from './helpers.js';

// R3: co-occurrence and transition candidates (opt-in, support), the friends signal, trending (capped), fresh labels, explanations,
// kids restrictions. The engine runs on the real database with the fixture library of reco-fixture.ts.
let env: TestEnv;
let s: Seeded;
let n = 0;
beforeAll(async () => { env = await makeEnv(); s = await seedProfiles(env); await buildIndex(env); });
afterAll(() => env.close());
beforeEach(async () => {
  for (const t of ['thumbs', 'watchlist', 'dropped', 'ratings', 'play_seconds', 'recommendations', 'leaving_soon', 'hygiene_items']) await env.pool.query(`delete from ${t}`);
  await env.pool.query("delete from users where authentik_sub like 'sub-friend-%'");
  for (const p of ['reco:', 'trend:', 'fresh:']) for (const k of await env.kv.keys(p)) await env.kv.del(k);
  resetIndexCache(env.ctx);
});

/** another account of the instance; `share` = the shareHistory / shareRatings opt-ins (absent = the default) */
async function friend(name: string, share: { history?: boolean; ratings?: boolean } = {}): Promise<string> {
  const id = (await env.pool.query<{ id: string }>(
    "insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), $1, $2, $3, 'friend', $4, $3, $5) returning id",
    [`sub-friend-${++n}`, `f${n}@example.com`, name, `jf-friend-${n}`, encrypt(env.ctx.encKey, 'pw')])).rows[0]!.id;
  await env.pool.query('insert into user_prefs(user_id, data) values ($1, $2)', [id, JSON.stringify({ ...(share.history !== undefined ? { shareHistory: share.history } : {}), ...(share.ratings !== undefined ? { shareRatings: share.ratings } : {}) })]);
  return id;
}
/** a viewing: `ago` days back, `secs` seconds of an item (fixture key or raw id) */
const play = (user: string, item: string, ago: number, secs = 6600, type = 'Movie') =>
  env.pool.query("insert into play_seconds(user_id, item_id, day, seconds, item_name, item_type) values ($1, $2, current_date - $3::int, $4, 'x', $5)", [user, item.length === 32 ? item : H(item), ago, secs, type]);
const rate = (user: string, key: string, stars: number) => env.pool.query("insert into ratings(user_id, item_id, item_name, stars) values ($1,$2,'x',$3)", [user, H(key), stars]);

type Run = Awaited<ReturnType<typeof run>>;
async function run(o: { profile?: 'owner' | 'kids'; surface: Surface; seed?: string; limit?: number; cfg?: object; f?: ReturnType<typeof fakeJf>; hour?: number; db?: Ctx['db'] }) {
  const f = o.f ?? fakeJf();
  const base = engineCtx(env, f.jf, (o.cfg ?? {}) as never);
  const ctx = o.db ? { ...base, db: o.db } : base;
  const kids = o.profile === 'kids';
  const r = await recommend(ctx, kids ? s.kidsUser : s.user, kids ? s.kids : s.owner, { surface: o.surface, ...(o.seed ? { seed: H(o.seed) } : {}), limit: o.limit ?? 30, now: NOW, context: { hour: o.hour ?? 12 } });
  return { f, r, ctx };
}
const pick = (r: Run['r'], key: string) => r.items.find((i) => i.item.id === H(key));
const rank = (r: Run['r'], key: string) => keysOf(r.items.map((i) => i.item)).indexOf(key);
const SOCIAL: SourceName[] = ['cooccurrence', 'transition', 'friends', 'trending'];

/**
 * Five accounts that finished noir1; two went on to heist2, two to cops (a series), one to rom1. So after noir1: heist2 and cops have a
 * support of 2, rom1 of 1. 5 finishers: the transition share is 2 / (5 + 1).
 */
async function crowd(optIn = true) {
  const [a, b, c, d, e] = await Promise.all(['Ann', 'Ben', 'Cy', 'Di', 'Eli'].map((nm) => friend(nm, { history: optIn })));
  for (const [u, nxt, secs] of [[a, 'heist2', 6000], [b, 'heist2', 6000], [c, 'rom1', 5800], [d, 'cops', 1800], [e, 'cops', 1800]] as const) {
    await play(u!, 'noir1', 12);
    await play(u!, nxt, 10, secs);
  }
  return { a: a!, b: b!, c: c!, d: d!, e: e! };
}

describe('transition and co-occurrence candidates', () => {
  it('post-play: what accounts started right after finishing the seed, with the share of finishers as the signal', async () => {
    await crowd();
    const { r } = await run({ surface: 'postplay', seed: 'noir1' });
    for (const k of ['heist2', 'cops']) {
      const x = pick(r, k)!;
      expect(x.sources, k).toContain('transition');
      expect(x.sources, k).toContain('cooccurrence');
      expect(x.parts.transition, k).toBeCloseTo(2 / 6, 6);
      expect(x.parts.cooccurrence, k).toBeCloseTo(2 / Math.sqrt(5 * 2), 6);
      expect(x.reason.seed?.id, k).toBe(H('noir1'));
      expect(x.reason.traits, k).toContain('next');
    }
    // one account only (rom1): below the minimum support of 2 distinct accounts, no candidate from the crowd
    expect(pick(r, 'rom1')?.sources ?? []).not.toContain('transition');
    expect(pick(r, 'rom1')?.sources ?? []).not.toContain('cooccurrence');
  });

  it('the surface weight decides how far they move a title', async () => {
    await crowd();
    const on = await run({ surface: 'postplay', seed: 'noir1' });
    const off = await run({ surface: 'postplay', seed: 'noir1', cfg: { RECO_COEFFS: '{"surface.postplay.transition":0}' } });
    expect(pick(off.r, 'heist2')!.score).toBeLessThan(pick(on.r, 'heist2')!.score);
    expect(pick(off.r, 'heist2')!.sources).not.toContain('transition'); // a surface that gives a signal no weight does not even ask for it
    expect(rank(on.r, 'heist2')).toBeLessThan(rank(off.r, 'heist2'));
    // the because surface has no transition weight: transitions are for post-play
    const because = await run({ surface: 'because', seed: 'noir1' });
    expect(because.r.items.every((i) => !i.sources.includes('transition'))).toBe(true);
    expect(pick(because.r, 'heist2')!.sources).toContain('cooccurrence');
  });

  it('only accounts with shareHistory feed it: without the opt-in nothing is learned, and nobody is counted twice', async () => {
    await crowd(false);
    const { r } = await run({ surface: 'postplay', seed: 'noir1' });
    expect(r.items.every((i) => !i.sources.includes('transition') && !i.sources.includes('cooccurrence'))).toBe(true);
    // mixed: only the opted-in ones count (two accounts finished noir1 and went on to heist2, a third is opted out)
    const a = await friend('P', { history: true }), b = await friend('Q', { history: true }), z = await friend('Z', { history: false });
    for (const u of [a, b, z]) { await play(u, 'noir1', 9); await play(u, 'heist2', 8); }
    for (const k of await env.kv.keys('reco:pairs:')) await env.kv.del(k); // the aggregate is cached for 15 minutes
    const mixed = await run({ surface: 'postplay', seed: 'noir1' });
    expect(pick(mixed.r, 'heist2')!.parts.transition).toBeCloseTo(2 / 3, 6); // 2 of 2 finishers + 1 smoothing; the third account is invisible
  });

  it('a pair seen by a single account is not used', async () => {
    const a = await friend('P', { history: true });
    await play(a, 'noir1', 9);
    await play(a, 'heist2', 8);
    const { r } = await run({ surface: 'postplay', seed: 'noir1' });
    expect(pick(r, 'heist2')?.sources ?? []).not.toContain('transition');
  });

  it('the cached aggregate holds counts of titles and no account', async () => {
    const ids = Object.values(await crowd());
    await run({ surface: 'postplay', seed: 'noir1' });
    const keys = await env.kv.keys('reco:pairs:');
    expect(keys).toHaveLength(1);
    const text = (await env.kv.get(keys[0]!))!;
    for (const id of ids) expect(text).not.toContain(id);
    expect(text).not.toMatch(/Ann|Ben|Cy|Di|Eli/);
  });

  it('seedless surfaces co-occur from the profile\'s strongest titles (anchors)', async () => {
    await crowd();
    await env.pool.query("insert into thumbs(user_id,item_id,value,item_name,profile_id) values ($1,$2,2,'x',$1)", [s.owner.id, H('noir1')]);
    const { r } = await run({ surface: 'taste' });
    const x = pick(r, 'heist2')!;
    expect(x.sources).toContain('cooccurrence');
    expect(x.sources).not.toContain('transition'); // no seed, no finished title
    expect(x.reason.seed?.id).toBe(H('noir1'));
  });

  it('episodes are rolled up into their series (episode rows of the hygiene scan)', async () => {
    const [a, b] = [await friend('P', { history: true }), await friend('Q', { history: true })];
    const eps = ['ep-1', 'ep-2', 'ep-3'].map((k) => H(`cops-${k}`));
    for (const e of eps) await env.pool.query("insert into hygiene_items(item_id, type, name, series_id, facts) values ($1,'Episode','x',$2,'{}')", [e, H('cops')]);
    for (const u of [a, b]) {
      await play(u, 'noir1', 15);
      for (const e of eps) await play(u, e, 12, 1700, 'Episode'); // 3 x 28 min = 5100 s of a 48-minute series: three episodes' worth
    }
    const { r } = await run({ surface: 'postplay', seed: 'noir1' });
    const cops = pick(r, 'cops')!;
    expect(cops.sources).toContain('cooccurrence');
    expect(cops.sources).toContain('transition');
  });

  it('transitionsFor(ctx, itemId, viewer): the post-play helper, resolved with the viewer token, minus thumbs-down and played', async () => {
    await crowd();
    const f = fakeJf();
    const ctx = engineCtx(env, f.jf);
    const out = await transitionsFor(ctx, H('noir1'), { user: s.user, profile: s.owner }, { now: NOW });
    expect(keysOf(out.map((t) => t.item)).sort()).toEqual(['cops', 'heist2']);
    expect(out.every((t) => t.support === 2 && Math.abs(t.share - 2 / 6) < 1e-3)).toBe(true);
    expect(f.calls.every((c) => c.user.jellyfin_user_id === 'jfreco')).toBe(true);
    // an episode of the finished series counts as the series
    const g = fakeJf();
    const spy = g.jf.item.bind(g.jf);
    g.jf.item = async (u, id) => (id === H('noir1-e1') ? { ...dto('noir1'), id, type: 'Episode', seriesId: H('noir1') } : spy(u, id));
    expect(keysOf((await transitionsFor(engineCtx(env, g.jf), H('noir1-e1'), { user: s.user, profile: s.owner }, { now: NOW })).map((t) => t.item)).sort()).toEqual(['cops', 'heist2']);
    // thumbs-down is removed
    await env.pool.query("insert into thumbs(user_id,item_id,value,item_name,profile_id) values ($1,$2,-1,'x',$1)", [s.owner.id, H('cops')]);
    expect(keysOf((await transitionsFor(ctx, H('noir1'), { user: s.user, profile: s.owner }, { now: NOW })).map((t) => t.item))).toEqual(['heist2']);
    // an item the viewer cannot see reveals nothing
    f.state.hidden.add(H('noir1'));
    expect(await transitionsFor(ctx, H('noir1'), { user: s.user, profile: s.owner }, { now: NOW })).toEqual([]);
  });
});

describe('performance under v2: one load, one build, bounded search (I1)', () => {
  it('concurrent recommend() calls on a cold cache load the item vectors once and build the pair tables once', async () => {
    await crowd();
    const f = fakeJf();
    const ctx = engineCtx(env, f.jf);
    const loads = indexLoads(), builds = pairTableBuilds();
    const seeds = ['noir1', 'noir2', 'saga1', 'mars', 'doc1', 'noir1', 'rom1'];
    const out = await Promise.all(seeds.map((seed) => recommend(ctx, s.user, s.owner, { surface: 'postplay', seed: H(seed), limit: 20, now: NOW, context: { hour: 12 } })));
    expect(out.every((r) => r.items.length > 0)).toBe(true);
    expect(indexLoads() - loads).toBe(1);
    expect(pairTableBuilds() - builds).toBe(1);
    // and the next round is served from the caches
    await Promise.all(seeds.map((seed) => recommend(ctx, s.user, s.owner, { surface: 'postplay', seed: H(seed), limit: 20, now: NOW, context: { hour: 12 } })));
    expect(indexLoads() - loads).toBe(1);
    expect(pairTableBuilds() - builds).toBe(1);
  });

  it('a finished index pass (a new lastDone stamp in kv) invalidates the cached vectors on every replica', async () => {
    const ctx = engineCtx(env, fakeJf().jf);
    const loads = indexLoads();
    await recommend(ctx, s.user, s.owner, { surface: 'taste', limit: 5, now: NOW });
    await recommend(ctx, s.user, s.owner, { surface: 'taste', limit: 5, now: NOW });
    expect(indexLoads() - loads).toBe(1);
    await env.kv.set('reco:idx:lastDone', new Date().toISOString() + Math.random(), 60);
    await recommend(ctx, s.user, s.owner, { surface: 'taste', limit: 5, now: NOW });
    expect(indexLoads() - loads).toBe(2);
  });

  it('while another replica holds the build lock no request builds; a stale table is served and rebuilt by one builder', async () => {
    await crowd();
    const c = recoCoefficients(env.ctx.cfg);
    await env.kv.set(lockKey(c), 'other-replica', 60);
    const builds = pairTableBuilds();
    const cold = await run({ surface: 'postplay', seed: 'noir1' });
    expect(cold.r.items.every((i) => !i.sources.includes('transition'))).toBe(true); // nothing yet, and no build of its own
    expect(pairTableBuilds()).toBe(builds);
    await env.kv.del(lockKey(c));
    const warm = await run({ surface: 'postplay', seed: 'noir1' });
    expect(pick(warm.r, 'heist2')!.sources).toContain('transition');
    expect(pairTableBuilds()).toBe(builds + 1);
    // stale: answered at once from the old copy, one background rebuild replaces it
    const t = JSON.parse((await env.kv.get(tablesKey(c)))!);
    await env.kv.set(tablesKey(c), JSON.stringify({ ...t, builtAt: Date.now() - 3600_000 }), 600);
    const stale = await run({ surface: 'postplay', seed: 'noir1' });
    expect(pick(stale.r, 'heist2')!.sources).toContain('transition');
    await vi.waitFor(async () => expect(JSON.parse((await env.kv.get(tablesKey(c)))!).builtAt).toBeGreaterThan(Date.now() - 60_000));
    expect(pairTableBuilds()).toBe(builds + 2);
    expect(await env.kv.get(lockKey(c))).toBeNull();
  });
});

describe('aggregates are library-level and exclude the viewer (M1, M4)', () => {
  it('the tables are built without any viewer token: episodes map through the admin-side libraryRoots hook', async () => {
    const [a, b] = [await friend('P', { history: true }), await friend('Q', { history: true })];
    const eps = ['e1', 'e2', 'e3'].map((k) => H(`cops-x-${k}`));
    for (const u of [a, b]) {
      await play(u, 'noir1', 15);
      for (const e of eps) await play(u, e, 12, 1700, 'Episode');
    }
    const f = fakeJf();
    const asked: string[][] = [];
    (f.jf as { libraryRoots?: unknown }).libraryRoots = async (ids: string[]) => { asked.push(ids); return new Map(ids.filter((i) => eps.includes(i)).map((i) => [i, H('cops')])); };
    // the viewer's items() knows no episodes at all (a viewer-scoped lookup would map nothing): the tables must not care
    const ctx = engineCtx(env, f.jf);
    const before = f.calls.length;
    await transitionsFor(ctx, H('noir1'), { user: s.user, profile: s.owner }, { now: NOW });
    expect(asked.flat().sort()).toEqual([...eps].sort());
    const t = JSON.parse((await env.kv.get(tablesKey(recoCoefficients(env.ctx.cfg))))!);
    expect(t.trans[H('noir1')]).toEqual([[H('cops'), 2]]);
    // the viewer's token was used only for the viewer's own lookups (the title and resolving what to show), never for the build
    expect(f.calls.slice(before).filter((c) => c.fn === 'items').length).toBeLessThanOrEqual(1);
    expect(await env.kv.get(`reco:root:${eps[0]}`)).toBe(H('cops'));
  });

  it('a viewer who is one of only 2 accounts behind a transition does not see it; with 2 other accounts it shows', async () => {
    await env.pool.query("insert into user_prefs(user_id, data) values ($1, '{\"shareHistory\": true}') on conflict (user_id) do update set data = excluded.data", [s.user.id]);
    try {
      const other = await friend('P', { history: true });
      for (const u of [s.user.id, other]) { await play(u, 'noir2', 12); await play(u, 'heist2', 10); }
      const ctx = engineCtx(env, fakeJf().jf);
      // the table counts 2 accounts (the viewer and one other) ...
      const r1 = await transitionsFor(ctx, H('noir2'), { user: s.user, profile: s.owner }, { now: NOW });
      expect(r1).toEqual([]);
      const t = JSON.parse((await env.kv.get(tablesKey(recoCoefficients(env.ctx.cfg))))!);
      expect(t.trans[H('noir2')]).toEqual([[H('heist2'), 2]]);
      // ... and neither the transition nor the co-occurrence candidate reaches the viewer
      const { r } = await run({ surface: 'postplay', seed: 'noir2' });
      expect(pick(r, 'heist2')?.sources ?? []).not.toContain('transition');
      expect(pick(r, 'heist2')?.sources ?? []).not.toContain('cooccurrence');
      // a second other account: support 2 from others alone (the viewer's own play is still left out of the count)
      const third = await friend('Q', { history: true });
      await play(third, 'noir2', 12);
      await play(third, 'heist2', 10);
      for (const k of await env.kv.keys('reco:pairs:')) await env.kv.del(k);
      const r2 = await transitionsFor(ctx, H('noir2'), { user: s.user, profile: s.owner }, { now: NOW });
      expect(r2.map((x) => [keysOf([x.item])[0], x.support])).toEqual([['heist2', 2]]);
      // another viewer, who contributed nothing, sees all 3 accounts
      const out = await run({ surface: 'postplay', seed: 'noir2' });
      expect(pick(out.r, 'heist2')!.sources).toContain('transition');
    } finally {
      await env.pool.query('delete from user_prefs where user_id = $1', [s.user.id]);
    }
  });
});

describe('friends signal', () => {
  it('friends\' ratings (4 stars or more) lift a title, with the friend named in the explanation', async () => {
    const zed = await friend('Zed');
    await rate(zed, 'orbit', 5);
    await rate(zed, 'mars', 4);
    const { r } = await run({ surface: 'taste' });
    const orbit = pick(r, 'orbit')!;
    expect(orbit.sources).toContain('friends');
    expect(orbit.parts.friends).toBeCloseTo(1, 6); // 5 stars
    expect(pick(r, 'mars')!.parts.friends).toBeCloseTo(0.5, 6); // 4 stars
    expect(orbit.reason.traits[0]).toBe('friends:Zed');
  });

  it('a friend who switched shareRatings off is neither used nor named', async () => {
    const zed = await friend('Zed', { ratings: false });
    await rate(zed, 'orbit', 5);
    const { r } = await run({ surface: 'taste' });
    expect(pick(r, 'orbit')?.sources ?? []).not.toContain('friends');
    expect(JSON.stringify(r.items.map((i) => i.reason))).not.toContain('Zed');
  });

  it('a title a friend recommended to this user counts fully, with the sender named', async () => {
    const yan = await friend('Yan');
    await env.pool.query("insert into recommendations(from_user, to_user, item_id, item_name, note) values ($1,$2,$3,'x','watch it')", [yan, s.owner.user_id, H('mars')]);
    const { r } = await run({ surface: 'home_rows' });
    const mars = pick(r, 'mars')!;
    expect(mars.parts.friends).toBe(1);
    expect(mars.reason.traits).toContain('friends:Yan');
    expect(JSON.stringify(mars.reason)).not.toContain('watch it'); // the note stays out of the explanation
  });

  it('what the viewer thumbed down never comes back through friends', async () => {
    const zed = await friend('Zed');
    await rate(zed, 'orbit', 5);
    await env.pool.query("insert into thumbs(user_id,item_id,value,item_name,profile_id) values ($1,$2,-1,'x',$1)", [s.owner.id, H('orbit')]);
    const { r } = await run({ surface: 'taste' });
    expect(pick(r, 'orbit')).toBeUndefined();
  });
});

describe('trending (capped at 10 % of the score on every surface)', () => {
  const watchedByTwo = async () => {
    const [a, b] = [await friend('P', { history: true }), await friend('Q', { history: true })];
    for (const u of [a, b]) await play(u, 'doc3', 1, 3600);
  };

  it('what two opted-in accounts watched this week is a candidate; one account alone is not', async () => {
    await watchedByTwo();
    const one = await friend('R', { history: true });
    await play(one, 'doc2', 1, 3600);
    const { r } = await run({ surface: 'home_rows' });
    expect(pick(r, 'doc3')!.sources).toContain('trending');
    expect(pick(r, 'doc3')!.parts.trending).toBeGreaterThan(0);
    expect(pick(r, 'doc2')?.sources ?? []).not.toContain('trending');
  });

  it('trending never exceeds 10 % of the score before penalties, on any surface, even with a huge weight', async () => {
    await watchedByTwo();
    const coeffs = JSON.stringify(Object.fromEntries(SURFACES.map((sf) => [`surface.${sf}.trending`, 50])));
    let bound = 0;
    for (const surface of SURFACES) {
      const { r } = await run({ surface, ...(surface === 'taste' || surface === 'home_rows' ? {} : { seed: 'noir1' }), cfg: { RECO_COEFFS: coeffs } });
      for (const i of r.items) {
        const pen = i.parts.penalties.played + i.parts.penalties.dropped + i.parts.penalties.watchlist;
        const total = i.score + pen;
        if (i.parts.trending > 0) {
          expect(i.parts.trending / total, `${surface} ${keysOf([i.item])[0]}`).toBeLessThanOrEqual(0.1 + 1e-9);
          bound = Math.max(bound, i.parts.trending / total);
        }
      }
    }
    expect(bound).toBeGreaterThan(0.099); // the cap really bound somewhere (the test is not vacuous)
  });

  it('the default weights stay under the cap as well, and detail_similar ignores trending', async () => {
    await watchedByTwo();
    for (const surface of SURFACES) {
      const { r } = await run({ surface, ...(surface === 'taste' || surface === 'home_rows' ? {} : { seed: 'noir1' }) });
      for (const i of r.items) expect(i.parts.trending / (i.score + i.parts.penalties.played + i.parts.penalties.dropped + i.parts.penalties.watchlist || 1)).toBeLessThanOrEqual(0.1 + 1e-9);
      if (surface === 'detail_similar') expect(r.items.every((i) => !i.sources.includes('trending'))).toBe(true);
    }
  });
});

describe('fresh titles (labels of fresh.ts)', () => {
  it('new films and new series the media server lists are candidates and count as fresh', async () => {
    const f = fakeJf();
    f.state.recent = ['hype', 'pups', 'rom2'];
    const { r } = await run({ surface: 'home_rows', f });
    const hype = pick(r, 'hype')!, pups = pick(r, 'pups')!;
    expect(hype.sources).toContain('fresh');
    expect(pups.sources).toContain('fresh');
    expect(hype.parts.fresh).toBeGreaterThanOrEqual(0.8);
    expect(pups.parts.fresh).toBeGreaterThanOrEqual(0.8);
    expect(pick(r, 'rom2')?.sources ?? []).not.toContain('fresh'); // added 450 days ago: no label
  });

  it('works for kids too, within the age cap', async () => {
    const f = fakeJf();
    f.state.caps['jfkid'] = 6;
    f.state.recent = ['hype', 'pups'];
    const { r } = await run({ surface: 'home_rows', f, profile: 'kids' });
    expect(keysOf(r.items.map((i) => i.item))).toContain('pups'); // FSK 0
    expect(keysOf(r.items.map((i) => i.item))).not.toContain('hype'); // FSK 12
  });
});

describe('kids profiles', () => {
  it('never get the social, co-watch or transition sources, always the age cap, always their own token', async () => {
    await crowd();
    const zed = await friend('Zed', { history: true });
    await rate(zed, 'rom1', 5);
    await rate(zed, 'noir1', 5);
    await env.pool.query("insert into recommendations(from_user, to_user, item_id, item_name) values ($1,$2,$3,'x')", [zed, s.owner.user_id, H('rom2')]);
    for (const u of [zed, await friend('Yan', { history: true })]) { await play(u, 'rom1', 1, 3600); await play(u, 'cops', 1, 3600); }
    const f = fakeJf();
    f.state.caps['jfkid'] = 6;
    f.state.recent = ['pups'];
    const sqls: string[] = [];
    const db = { query: (q: string, p?: unknown[]) => { sqls.push(q); return env.ctx.db.query(q, p as never); } } as unknown as Ctx['db'];
    for (const surface of SURFACES) {
      const { r } = await run({ surface, profile: 'kids', ...(surface === 'taste' || surface === 'home_rows' ? {} : { seed: 'rom1' }), f, db, cfg: { RECO_COEFFS: '{"surface.postplay.trending":9,"surface.postplay.friends":9}' } });
      expect(r.items.length, surface).toBeGreaterThan(0);
      for (const i of r.items) {
        for (const src of SOCIAL) expect(i.sources, `${surface} ${src}`).not.toContain(src);
        expect(i.parts.cooccurrence + i.parts.transition + i.parts.friends + i.parts.trending, surface).toBe(0);
        expect(i.reason.traits.some((t) => /^(friends|next|together)/.test(t)), surface).toBe(false);
        expect(['FSK 0', 'FSK 6'], keysOf([i.item])[0]).toContain(i.item.rating);
      }
    }
    expect(f.calls.every((c) => c.user.jellyfin_user_id === 'jfkid')).toBe(true);
    // no query for another account's data at all: no viewing aggregates, no friends' ratings, no recommendations
    expect(sqls.filter((q) => /play_seconds|from ratings r|recommendations/.test(q))).toEqual([]);
  });

  it('transitionsFor gives a kids profile nothing, and does not read the aggregate', async () => {
    await crowd();
    const f = fakeJf();
    expect(await transitionsFor(engineCtx(env, f.jf), H('noir1'), { user: s.kidsUser, profile: s.kids }, { now: NOW })).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(await env.kv.keys('reco:pairs:')).toEqual([]);
  });
});

describe('explanations: the seed that contributed most plus up to 2 shared traits', () => {
  const credits = (f: ReturnType<typeof fakeJf>) => {
    f.state.credits[H('saga2')] = { people: [{ id: H('dir-vale'), name: 'Vale', type: 'Director' }, { id: H('act-kim'), name: 'Kim', type: 'Actor' }] };
  };

  it('same universe first, then the director by name', async () => {
    const f = fakeJf();
    credits(f);
    const { r } = await run({ surface: 'because', seed: 'saga2', f });
    const saga3 = pick(r, 'saga3')!;
    expect(saga3.reason).toEqual({ seed: { id: H('saga2'), name: 'SAGA2' }, traits: ['universe', 'director:Vale'] });
  });

  it('never more than two traits, each of a different kind; the seed is the explicit one on seeded surfaces', async () => {
    const f = fakeJf();
    credits(f);
    f.state.similar[H('saga2')] = ['saga1', 'saga3', 'mars', 'orbit', 'robot', 'signal', 'noir1', 'doc3'];
    const { r } = await run({ surface: 'detail_similar', seed: 'saga2', f });
    expect(r.items.length).toBeGreaterThan(5);
    for (const i of r.items) {
      expect(i.reason.seed?.id).toBe(H('saga2'));
      expect(i.reason.traits.length).toBeLessThanOrEqual(2);
      const kinds = i.reason.traits.map((t) => t.split(':')[0]);
      expect(new Set(kinds).size).toBe(kinds.length);
    }
    // a title that shares only a genre and a studio says so
    const orbit = pick(r, 'orbit')?.reason.traits ?? [];
    expect(orbit.every((t) => /^(genre|studio|actor|director)/.test(t))).toBe(true);
  });

  it('without the credits hook the person traits carry the kind only', async () => {
    const f = fakeJf();
    delete (f.jf as { credits?: unknown }).credits;
    const { r } = await run({ surface: 'because', seed: 'saga2', f });
    expect(pick(r, 'saga3')!.reason.traits).toEqual(['universe', 'director']);
  });

  it('seedless surfaces name the profile title that explains the pick; a cold profile has no seed', async () => {
    await env.pool.query("insert into thumbs(user_id,item_id,value,item_name,profile_id) select $1, id, 2, 'x', $1 from unnest($2::text[]) id", [s.owner.id, ['saga1', 'saga2', 'mars', 'orbit', 'noir1'].map(H)]);
    const hot = await run({ surface: 'taste' });
    const named = hot.r.items.filter((i) => i.reason.seed);
    expect(named.length).toBeGreaterThan(3);
    expect(named.every((i) => ['SAGA1', 'SAGA2', 'MARS', 'ORBIT', 'NOIR1'].includes(i.reason.seed!.name))).toBe(true);
    await env.pool.query('delete from thumbs');
    await (await import('../src/homegen.js')).bumpHome(env.ctx, s.owner.id);
    const cold = await run({ surface: 'taste' });
    expect(cold.r.cold).toBe(true);
    expect(cold.r.items.every((i) => i.reason.seed === null)).toBe(true);
  });
});

describe('context in the engine', () => {
  it('a long film late at night is nudged down but stays a candidate', async () => {
    const f = fakeJf();
    f.state.similar[H('saga2')] = ['doc3', 'orbit', 'saga3'];
    const day = await run({ surface: 'because', seed: 'saga2', f, hour: 12 });
    const night = await run({ surface: 'because', seed: 'saga2', f, hour: 23 });
    const d = pick(day.r, 'doc3')!, nn = pick(night.r, 'doc3')!;
    expect(d.parts.context).toBe(1);
    expect(nn.parts.context).toBeLessThan(1);
    expect(nn.parts.context).toBeGreaterThanOrEqual(0.75);
    expect(nn.score).toBeLessThan(d.score);
    expect(pick(night.r, 'doc3')).toBeDefined(); // never a filter
    expect(night.r.items.length).toBe(day.r.items.length);
  });

  it('without a context given the engine derives one (hour, language, device mix) and does not fail', async () => {
    const f = fakeJf();
    const r = await recommend(engineCtx(env, f.jf), s.user, s.owner, { surface: 'taste', limit: 5, now: NOW });
    expect(r.items.length).toBe(5);
    expect(r.items.every((i) => i.parts.context >= 0.75 && i.parts.context <= 1.2)).toBe(true);
  });
});

describe('device mix (playback_timings, anonymous and aggregated)', () => {
  const timing = (device: string, hourUtc: number, count: number) =>
    env.pool.query("insert into playback_timings(home, device, created_at) select true, $1, date_trunc('day', now() - interval '1 day') + make_interval(hours => $2) from generate_series(1, $3)", [device, hourUtc, count]);
  it('share of playback starts per device class and time bucket; too few starts give no signal', async () => {
    await env.pool.query('delete from playback_timings');
    for (const k of await env.kv.keys('reco:devmix')) await env.kv.del(k);
    await timing('tv', 20, 30);
    await timing('phone', 21, 10);
    await timing('phone', 8, 5); // 5 starts in the morning: below the minimum of 30
    const mix = await deviceMixes(env.ctx, 'UTC');
    expect(mix.evening).toEqual({ phone: 0.25, pc: 0, tv: 0.75 });
    expect(mix.morning).toBeNull();
    expect(mix.night).toBeNull();
    await env.pool.query('delete from playback_timings');
  });
  it('contextFor: hour in the instance zone, the profile\'s UI language, the mix of this time of day, the caller\'s device', async () => {
    await env.pool.query('delete from playback_timings');
    for (const k of await env.kv.keys('reco:devmix')) await env.kv.del(k);
    await env.pool.query("insert into profile_prefs(profile_id, data) values ($1, '{\"language\":\"fr\"}') on conflict (profile_id) do update set data = excluded.data", [s.owner.id]);
    const x = await contextFor(env.ctx, s.owner, Date.UTC(2026, 9, 1, 12, 0), 'tv');
    expect(x).toMatchObject({ device: 'tv', uiLanguage: 'fr', deviceMix: null });
    expect(typeof x.hour).toBe('number');
  });
});

void DAY;
