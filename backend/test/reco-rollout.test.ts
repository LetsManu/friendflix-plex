// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cfg, makeEnv, type TestEnv } from './helpers.js';
import { bumpHome } from '../src/homegen.js';
import { recoFallback, recoPlays } from '../src/metrics.js';
import { FALLBACK_SURFACES, recoStats } from '../src/reco/engine.js';
import { loadRowStats } from '../src/reco/rows.js';
import { ratingAge } from '../src/reco/score.js';
import { resetIndexCache } from '../src/reco/vectors.js';
import { buildIndex, dto, fakeJf, H, keysOf, SPECS, type FakeState } from './reco-fixture.js';
import { encrypt } from '../src/crypto.js';

// R4: RECO_ENGINE=v2 on the real routes (home, because-more, post-play), the v1 fallback, "Reset my recommendations", the counters,
// the admin numbers and the kids profile. The fixture library of the reco tests stands in for the media server.

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let owner: Sess, guest: Sess;
let ownerId = '';
let fake: ReturnType<typeof fakeJf>;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const call = (s: Sess, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
const metric = async (m: { get(): Promise<{ values: Array<{ value: number; labels: Record<string, unknown> }> }> }, f: (l: Record<string, unknown>) => boolean = () => true) =>
  (await m.get()).values.filter((v) => f(v.labels)).reduce((a, v) => a + v.value, 0);
const engine = (e: 'v1' | 'v2' | 'shadow') => { env.ctx.cfg = { ...cfg, RECO_ENGINE: e }; };

/** a space fan: finished the saga, one thumbs-up; Jellyfin's similar() lists for the seeds of the home rows */
async function spaceFan(state: FakeState) {
  state.history = [
    dto('saga2', { played: true, lastPlayedDate: iso(10) }), dto('noir1', { played: true, lastPlayedDate: iso(20) }),
    dto('mars', { played: true, lastPlayedDate: iso(5) }), dto('doc1', { played: true, lastPlayedDate: iso(30) }),
  ];
  state.similar[H('saga2')] = ['saga1', 'saga3', 'mars', 'orbit', 'robot', 'bear1', 'signal', 'doc3'];
  state.similar[H('mars')] = ['orbit', 'robot', 'signal', 'saga3', 'doc2', 'cops'];
  state.similar[H('noir1')] = ['noir2', 'noir3', 'cops', 'heist2', 'doc3', 'rom3'];
  state.similar[H('doc1')] = ['doc2', 'doc3', 'orbit', 'noir3', 'cops', 'robot'];
  await env.pool.query('delete from thumbs');
  await env.pool.query("insert into thumbs(user_id,item_id,value,item_name,profile_id,created_at) values ($1,$2,2,'x',$1,$3)", [ownerId, H('saga2'), iso(10)]);
}

/**
 * opted-in accounts that finished the first saga film and then started one of four titles, two accounts each: the transition aggregate
 * needs 2 accounts per pair and the row ranker drops rows under 4 titles
 */
const SUCCESSORS = ['orbit', 'mars', 'noir3', 'robot'];
async function seedTransitions(successors = SUCCESSORS, from = 'saga2') {
  await env.pool.query('delete from play_seconds');
  let n = 0;
  for (const next of successors) {
    for (let k = 0; k < 2; k++, n++) {
      const id = (await env.pool.query<{ id: string }>(
        `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), $1, $2, $3, 'friend', $4, $3, $5)
         on conflict (authentik_sub) do update set name = excluded.name returning id`, [`sub-tr-${n}`, `${n}@tr.example.com`, `Tr${n}`, `jftr${n}`, encrypt(env.ctx.encKey, 'pw')])).rows[0]!.id;
      await env.pool.query("insert into user_prefs(user_id, data) values ($1, '{\"shareHistory\": true}') on conflict (user_id) do update set data = excluded.data", [id]);
      await env.pool.query("insert into play_seconds(user_id, item_id, day, seconds, item_name) values ($1,$2,current_date - 3,8000,'x'), ($1,$3,current_date - 2,6000,'y')", [id, H(from), H(next)]);
    }
  }
  for (const k of await env.kv.keys('reco:pairs')) await env.kv.del(k);
}

beforeAll(async () => {
  env = await makeEnv();
  owner = await env.login();
  await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-guest-r4','g4@example.com','Gast','friend','jfgast4','Gast',$1)", [encrypt(env.ctx.encKey, 'pw')]);
  guest = await env.login({ sub: 'sub-guest-r4', email: 'g4@example.com', name: 'Gast', groups: [] });
  ownerId = (await call(owner, 'GET', '/api/me')).json().profile.id;
  fake = fakeJf();
  Object.assign(env.ctx.jf, fake.jf, {
    // post-play on the media-server seam: nothing special about these titles
    resume: async () => [], nextEpisode: async () => null, nextUp: async () => [], upcoming: async () => [], seriesStatus: async () => null, libraryContinuingSeriesIds: async () => [],
    itemAbout: undefined, itemCollections: undefined,
  });
  await buildIndex(env);
});
afterAll(() => env?.close());
beforeEach(async () => {
  engine('v2');
  fake.state.hidden.clear();
  fake.state.caps = {};
  await spaceFan(fake.state);
  for (const pre of ['reco:', 'home:', 'postplay:', 'because', 'ppsim:']) for (const k of await env.kv.keys(pre)) await env.kv.del(k);
  resetIndexCache(env.ctx);
  await bumpHome(env.ctx, ownerId);
});
afterEach(async () => {
  if (broken) { await env.pool.query('alter table item_features_off rename to item_features'); broken = false; }
  resetIndexCache(env.ctx);
});

/** v2 throws: the item index table cannot be read (restored after the test) */
let broken = false;
async function breakIndex() {
  await env.pool.query('alter table item_features rename to item_features_off');
  broken = true;
  resetIndexCache(env.ctx);
}

describe('RECO_ENGINE=v2: home', () => {
  it('because rows come from recommend() with a reason; the row ranker orders them', async () => {
    const h = (await call(owner, 'GET', '/api/home')).json();
    expect(h.failed).toEqual([]);
    const b = h.parts.because;
    expect(b.engine).toBe('v2');
    expect(b.items.length).toBeGreaterThanOrEqual(4);
    expect(b.items[0].reason).toMatchObject({ seed: { name: 'SAGA2' } });
    expect(b.items.every((i: { reason?: { traits: string[] } }) => Array.isArray(i.reason?.traits) && i.reason!.traits.length <= 2)).toBe(true);
    expect(h.parts.order).toContain('because');
    // order lists only rows that survived (min size) and every listed more:<n> exists
    for (const k of h.parts.order as string[]) if (k.startsWith('more:')) expect(h.parts.because.more[Number(k.slice(5))].items.length).toBeGreaterThanOrEqual(4);
    // a title appears in one row only
    const ids = [...b.items, ...h.parts.because.more.flatMap((r: { items: Array<{ id: string }> }) => r.items)].map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('because-more rows are v2 rows too', async () => {
    const r = (await call(owner, 'GET', '/api/library/because-more')).json();
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(row.engine).toBe('v2');
      expect(row.items[0].reason.seed.id).toBe(row.because.id);
    }
  });

  it('v1 (the default) is unchanged: no reason, no order, engine v1, and no v2 work', async () => {
    engine('v1');
    const h = (await call(owner, 'GET', '/api/home')).json();
    expect(h.parts.order).toBeUndefined();
    expect(h.parts.because.engine).toBe('v1');
    expect(h.parts.because.items.length).toBeGreaterThan(0);
    expect(h.parts.because.items.some((i: { reason?: unknown }) => i.reason !== undefined)).toBe(false);
    expect(keysOf(h.parts.because.items)).toEqual(['saga1', 'saga3', 'mars', 'orbit', 'robot', 'bear1', 'signal', 'doc3']);
    expect(await env.kv.keys('reco:')).toEqual([]);
  });

  it('v2 throwing falls back to v1 for every row and counts it with bounded labels', async () => {
    await breakIndex();
    const before = await metric(recoFallback);
    const h = (await call(owner, 'GET', '/api/home')).json();
    expect(h.failed).toEqual([]);
    expect(h.parts.because.engine).toBe('v1');
    expect(keysOf(h.parts.because.items)[0]).toBe('saga1'); // Jellyfin's similar() order
    expect(h.parts.because.items.some((i: { reason?: unknown }) => i.reason !== undefined)).toBe(false);
    expect(h.parts.because.more.every((r: { engine?: string }) => r.engine === 'v1')).toBe(true);
    expect(h.parts.order).toBeUndefined(); // the ranker failed too: the fixed layout stays
    expect(await metric(recoFallback)).toBeGreaterThan(before);
    for (const v of (await recoFallback.get()).values) {
      expect(Object.keys(v.labels)).toEqual(['surface']);
      expect(FALLBACK_SURFACES as readonly string[]).toContain(v.labels.surface);
    }
  });
});

describe('RECO_ENGINE=v2: post-play', () => {
  it('because / taste rows come from recommend(), the transition row from transitionsFor, ranked by rankRows', async () => {
    await seedTransitions();
    const r = await call(owner, 'GET', `/api/items/${H('saga2')}/postplay`);
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json();
    expect(p.engine).toBe('v2');
    const kinds = p.rows.map((x: { kind: string }) => x.kind);
    expect(kinds).toContain('transition');
    expect(kinds).toContain('because');
    const tr = p.rows.find((x: { kind: string }) => x.kind === 'transition');
    expect(keysOf(tr.items).sort()).toEqual([...SUCCESSORS].sort());
    expect(tr.items[0].reason).toEqual({ seed: { id: H('saga2'), name: 'SAGA2' }, traits: ['next'] });
    expect(tr.recoRow).toBe('transition');
    const because = p.rows.find((x: { kind: string }) => x.kind === 'because');
    expect(because.engine).toBe('v2');
    expect(because.recoRow).toBe('postplay');
    expect(because.items[0].reason.seed).toEqual({ id: H('saga2'), name: 'SAGA2' });
    // a title is in one row only, never the title just watched
    const ids = p.rows.flatMap((x: { items: Array<{ id: string }> }) => x.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(H('saga2'));
  });

  it('a trilogy\'s universe row and a transition row with 2 titles both appear (per-kind minimum sizes)', async () => {
    const saga = { id: H('col-saga'), name: 'Saga', parts: ['saga1', 'saga2', 'saga3'].map((k) => ({ item: dto(k, { played: k === 'saga2' }) })) };
    Object.assign(env.ctx.jf, { itemCollections: async () => [saga] });
    try {
      await seedTransitions(['orbit', 'noir3'], 'saga3');
      const p = (await call(owner, 'GET', `/api/items/${H('saga3')}/postplay`)).json();
      expect(p.engine).toBe('v2');
      const kinds = p.rows.map((x: { kind: string }) => x.kind);
      expect(kinds).toContain('universe');
      expect(kinds).toContain('transition');
      const uni = p.rows.find((x: { kind: string }) => x.kind === 'universe');
      expect(keysOf(uni.items)).toEqual(['saga1']); // saga2 is played; only the first part is left of the trilogy
      const tr = p.rows.find((x: { kind: string }) => x.kind === 'transition');
      expect(keysOf(tr.items).sort()).toEqual(['noir3', 'orbit']);
    } finally {
      Object.assign(env.ctx.jf, { itemCollections: undefined });
    }
  });

  it('default v1: the rows of the post-play screen are as before (no transition row, engine v1)', async () => {
    engine('v1');
    await seedTransitions();
    const p = (await call(owner, 'GET', `/api/items/${H('saga2')}/postplay`)).json();
    expect(p.engine).toBe('v1');
    expect(p.rows.map((x: { kind: string }) => x.kind)).not.toContain('transition');
    expect(p.rows.every((x: { items: Array<{ reason?: unknown }> }) => x.items.every((i) => i.reason === undefined))).toBe(true);
  });

  it('v2 throwing falls back to the v1 rows and counts it', async () => {
    await breakIndex();
    const before = await metric(recoFallback, (l) => l.surface === 'postplay');
    const r = await call(owner, 'GET', `/api/items/${H('saga2')}/postplay`);
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json();
    expect(p.engine).toBe('v1');
    expect(p.rows.length).toBeGreaterThan(0);
    expect(p.rows.every((x: { engine: string }) => x.engine === 'v1')).toBe(true);
    expect(await metric(recoFallback, (l) => l.surface === 'postplay')).toBeGreaterThan(before);
  });
});

describe('kids profiles under v2', () => {
  let kid: Sess, kidJf = '';
  beforeAll(async () => {
    const r = await call(owner, 'POST', '/api/profiles', { name: 'Mia', kids: true, maxRating: 6 });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().profile.id as string;
    const sel = await call(owner, 'POST', `/api/profiles/${id}/select`, {});
    kid = { cookies: { ff_sid: sel.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: owner.csrf };
    kidJf = (await env.pool.query<{ j: string }>('select jellyfin_user_id j from profiles where id=$1', [id])).rows[0]!.j;
  });
  afterAll(async () => {
    // selecting a profile moves the session (and the sid rotates): the owner profile is selected again for the tests that follow
    const back = await call(kid, 'POST', `/api/profiles/${ownerId}/select`, {});
    expect(back.statusCode, back.body).toBe(200);
    owner = { cookies: { ff_sid: back.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: owner.csrf };
  });

  const age = (id: string) => ratingAge(SPECS.map((s) => dto(s.key)).find((d) => d.id === id)?.rating);

  it('post-play: the age cap holds, no friends or transition row, and the transition aggregate is not even read', async () => {
    fake.state.caps[kidJf] = 6;
    await seedTransitions();
    const p = (await call(kid, 'GET', `/api/items/${H('bear1')}/postplay`)).json();
    expect(p.engine).toBeDefined();
    expect(p.rows.map((x: { kind: string }) => x.kind)).not.toContain('transition');
    expect(p.rows.map((x: { kind: string }) => x.kind)).not.toContain('friends');
    const ids: string[] = p.rows.flatMap((x: { items: Array<{ id: string }> }) => x.items.map((i) => i.id));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) { expect(age(id), id).not.toBeNull(); expect(age(id)!, id).toBeLessThanOrEqual(6); }
    expect(await env.kv.keys('reco:pairs')).toEqual([]);
  });

  it('home: no social rows in the order, only age-allowed titles, reasons never name friends', async () => {
    fake.state.caps[kidJf] = 6;
    const h = (await call(kid, 'GET', '/api/home')).json();
    expect(h.parts.recs.friends).toEqual([]);
    expect(h.parts.order ?? []).not.toContain('friends');
    const items = [...h.parts.because.items, ...h.parts.because.more.flatMap((r: { items: unknown[] }) => r.items)] as Array<{ id: string; reason?: { traits: string[] } }>;
    for (const i of items) {
      expect(age(i.id), i.id).toBeLessThanOrEqual(6);
      expect((i.reason?.traits ?? []).some((t) => /^(friends|next|together)/.test(t))).toBe(false);
    }
  });

  it('a kids profile can reset its own recommendations', async () => {
    const r = await call(kid, 'POST', '/api/prefs/reco/reset', {});
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });
});

describe('"Reset my recommendations"', () => {
  it('deletes the cached taste vector and the row statistics of this profile only, keeps thumbs and history', async () => {
    await call(owner, 'GET', '/api/home'); // builds the cached taste
    await call(owner, 'POST', '/api/reco/events', { events: [{ row: 'because', engine: 'v2', impressions: 5, clicks: 2, plays: 1 }] });
    await env.kv.set('reco:rows:someone-else', '{"because":[1,1,1,1]}', 600);
    await env.kv.set('reco:taste:someone-else:1:x:y', '{}', 600);
    expect((await env.kv.keys(`reco:taste:${ownerId}:`)).length).toBeGreaterThan(0);
    expect(Object.keys(await loadRowStats(env.ctx, ownerId))).toEqual(['because']);

    const r = await call(owner, 'POST', '/api/prefs/reco/reset', {});
    expect(r.statusCode).toBe(200);
    expect(await env.kv.keys(`reco:taste:${ownerId}:`)).toEqual([]);
    expect(await loadRowStats(env.ctx, ownerId)).toEqual({});
    expect(await env.kv.get('reco:rows:someone-else')).not.toBeNull();
    expect(await env.kv.get('reco:taste:someone-else:1:x:y')).not.toBeNull();
    expect((await env.pool.query('select count(*)::int n from thumbs where profile_id=$1', [ownerId])).rows[0].n).toBe(1);
    // the next request rebuilds the taste from what remains
    expect((await call(owner, 'GET', '/api/library/because')).statusCode).toBe(200);
    expect((await env.kv.keys(`reco:taste:${ownerId}:`)).length).toBeGreaterThan(0);
  });

  it('drops the home and post-play caches of the profile (the change shows at once)', async () => {
    const a = (await call(owner, 'GET', '/api/home')).json();
    expect((await env.kv.keys(`home:${ownerId}`)).length).toBe(1);
    const old = await env.kv.keys(`home:${ownerId}`);
    await call(owner, 'POST', '/api/prefs/reco/reset', {});
    await call(owner, 'GET', '/api/home');
    const now = await env.kv.keys(`home:${ownerId}`);
    expect(now.filter((k) => !old.includes(k)).length).toBe(1); // a new generation, a new key: the cached answer is not served again
    expect(a.failed).toEqual([]);
  });

  it('needs a session', async () => {
    expect((await env.app.inject({ method: 'POST', url: '/api/prefs/reco/reset', payload: {} })).statusCode).toBe(401);
  });
});

describe('counters and the admin numbers', () => {
  it('plays from a recommendation are counted by row and engine, and feed the profile row statistics', async () => {
    const before = await metric(recoPlays, (l) => l.row === 'because' && l.engine === 'v2');
    const r = await call(owner, 'POST', '/api/reco/events', { events: [{ row: 'because', engine: 'v2', plays: 3 }, { row: 'transition', engine: 'v2', impressions: 1, dismisses: 1 }] });
    expect(r.statusCode).toBe(204);
    expect(await metric(recoPlays, (l) => l.row === 'because' && l.engine === 'v2')).toBe(before + 3);
    expect((await loadRowStats(env.ctx, ownerId)).because?.[2]).toBe(3);
    expect((await call(owner, 'POST', '/api/reco/events', { events: [{ row: 'because', engine: 'v3', plays: 1 }] })).statusCode).toBe(400);
    expect((await call(owner, 'POST', '/api/reco/events', { events: [{ row: 'because', engine: 'v1', plays: 99 }] })).statusCode).toBe(400);
  });

  it('GET /api/admin/reco: CTR and play rate per engine from the counters; admins only', async () => {
    const s0 = await recoStats(cfg);
    await call(owner, 'POST', '/api/reco/events', { events: [{ row: 'because', engine: 'v1', impressions: 40, clicks: 4, plays: 2 }, { row: 'because_more', engine: 'v2', impressions: 20, clicks: 5, plays: 3, dismisses: 1 }] });
    const r = await call(owner, 'GET', '/api/admin/reco');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.engine).toBe('v2');
    expect(b.engines.v1.impressions - s0.engines.v1.impressions).toBe(40);
    expect(b.engines.v2.clicks - s0.engines.v2.clicks).toBe(5);
    expect(b.engines.v2.dismisses - s0.engines.v2.dismisses).toBe(1);
    for (const e of ['v1', 'v2'] as const) {
      const x = b.engines[e];
      expect(x.ctr).toBeCloseTo(x.clicks / x.impressions, 3);
      expect(x.playRate).toBeCloseTo(x.plays / x.impressions, 3);
    }
    expect(typeof b.fallbacks).toBe('number');
    expect(JSON.stringify(b)).not.toMatch(/[0-9a-f]{32}/); // numbers only
    expect((await call(guest, 'GET', '/api/admin/reco')).statusCode).toBe(403);
  });

  it('rates are null (not NaN) without any impression', async () => {
    const s = await recoStats({ RECO_ENGINE: 'v1' });
    for (const e of Object.values(s.engines)) if (e.impressions === 0) { expect(e.ctr).toBeNull(); expect(e.playRate).toBeNull(); }
  });
});
