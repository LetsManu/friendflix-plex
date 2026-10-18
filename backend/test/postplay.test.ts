// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { JellyfinClient } from '../src/jellyfin/client.js';
import { JellyfinService } from '../src/jellyfin/service.js';
import { MemoryKV } from '../src/kv.js';
import { bumpHome } from '../src/homegen.js';
import { MediaError, type ItemDto, type MediaCollection, type SeriesStatus } from '../src/media/types.js';
import { registry } from '../src/metrics.js';
import { balanceSeason, CURRENT_SEASON_DAYS, isCurrentSeason, nextPart, pickHero, ROW_KINDS, ROW_SOURCES } from '../src/postplay.js';
import { cfg, ENC_KEY, fakeHttp, makeEnv, type Call, type TestEnv } from './helpers.js';

// 1.1 A1+A2: the "caught-up" post-play screen (spec §3). A small fake library is patched onto ctx.jf (the viewer's identity decides
// what is visible: a kids profile's media-server user only sees titles up to FSK 12).

type Sess = { cookies: Record<string, string>; csrf: string };
const DAY = 86_400_000;
const NOW = Date.now();
const iso = (days: number) => new Date(NOW + days * DAY).toISOString();
const hex = (n: number) => n.toString(16).padStart(32, '0');

const base = (o: Partial<ItemDto> & { id: string; name: string; type: string }): ItemDto & { adult?: boolean } => ({
  genres: ['Drama'], image: true, backdrop: true, logo: false, trailers: 0, played: false, favorite: false, positionTicks: 0, premiereDate: iso(-2000), ...o,
});

// ---- films: a two-part collection, a stand-alone film, recommendations (one adult-only, two from the current season)
const DUNE1 = hex(1), DUNE2 = hex(2), SOLO = hex(3), ADULT = hex(4), CURSEASON1 = hex(5), CURSEASON2 = hex(6), DROPPED = hex(7), DOWNED = hex(8), WATCHED = hex(9);
const RECS = Array.from({ length: 12 }, (_, i) => hex(20 + i));
// ---- series
const S_END = hex(100), S_CONT = hex(101), S_UNK = hex(102), S_GAP = hex(103), S_NEXT = hex(104), S_SEQUEL = hex(105), S_WATCHED = hex(106);
const ep = (series: string, n: number) => hex(Number.parseInt(series, 16) * 100 + n);
const ANNOUNCED = ep(S_CONT, 9);

const lib = new Map<string, ItemDto & { adult?: boolean }>();
const add = (i: ItemDto & { adult?: boolean }) => lib.set(i.id, i);
add(base({ id: DUNE1, name: 'Dune Part One', type: 'Movie' }));
add(base({ id: DUNE2, name: 'Dune Part Two', type: 'Movie' }));
add(base({ id: SOLO, name: 'Solo Film', type: 'Movie', genres: ['Thriller'] }));
add({ ...base({ id: ADULT, name: 'Adult Only', type: 'Movie' }), adult: true });
add(base({ id: CURSEASON1, name: 'Simulcast A', type: 'Series', premiereDate: iso(-10) }));
add(base({ id: CURSEASON2, name: 'Simulcast B', type: 'Series', premiereDate: iso(-20) }));
add(base({ id: DROPPED, name: 'Dropped Film', type: 'Movie' }));
add(base({ id: DOWNED, name: 'Thumbs Down Film', type: 'Movie' }));
add(base({ id: WATCHED, name: 'Seen Film', type: 'Movie', played: true }));
RECS.forEach((id, i) => add(base({ id, name: `Rec ${i}`, type: 'Movie', backdrop: i % 2 === 0 })));
for (const [id, name] of [[S_END, 'Ended Show'], [S_CONT, 'Running Show'], [S_UNK, 'Mystery Show'], [S_GAP, 'Gap Show'], [S_NEXT, 'Next Show'], [S_SEQUEL, 'Sequel Show']] as const) add(base({ id, name, type: 'Series', childCount: 1 }));
add(base({ id: S_WATCHED, name: 'Seen Show', type: 'Series', played: true, unplayedCount: 0, childCount: 1 }));
/** three real episodes per series; Running Show has an announced fourth (not available yet); Gap Show's episode 1 is unwatched */
const episodes = new Map<string, ItemDto[]>();
const virtual = new Set<string>([ANNOUNCED]);
for (const s of [S_END, S_CONT, S_UNK, S_GAP, S_NEXT]) {
  const list = [1, 2, 3].map((n) => base({ id: ep(s, n), name: `Episode ${n}`, type: 'Episode', seriesId: s, seriesName: lib.get(s)!.name, parentIndexNumber: 1, indexNumber: n, played: s !== S_GAP || n !== 1, overview: `Secret plot ${n}` }));
  if (s === S_CONT) list.push(base({ id: ANNOUNCED, name: 'Episode 4', type: 'Episode', seriesId: s, seriesName: 'Running Show', parentIndexNumber: 1, indexNumber: 4, premiereDate: iso(6), overview: 'Secret plot 4' }));
  if (s === S_NEXT) list[2]!.played = false; // Next Show: episode 3 still to come
  episodes.set(s, list);
  list.forEach(add);
}
const status: Record<string, SeriesStatus> = { [S_END]: 'ended', [S_CONT]: 'continuing', [S_UNK]: null, [S_GAP]: 'continuing', [S_NEXT]: 'continuing' };
const collections: MediaCollection[] = [
  { id: hex(500), name: 'Dune Collection', parts: [{ item: lib.get(DUNE1)! }, { item: lib.get(DUNE2)! }] },
  { id: hex(501), name: 'Ended Universe', parts: [{ item: lib.get(S_END)! }, { item: lib.get(S_SEQUEL)! }] },
];
/** similar(): the ones every seed gets, plus per-seed extras (the taste seeds pick different heroes) */
const COMMON = [WATCHED, S_WATCHED, DROPPED, DOWNED, ADULT, CURSEASON1, CURSEASON2, ...RECS.slice(0, 8)];
const similarOf: Record<string, string[]> = { [RECS[8]!]: [RECS[0]!, RECS[9]!], [RECS[9]!]: [RECS[1]!, RECS[10]!], [RECS[10]!]: [RECS[2]!, RECS[11]!] };

let env: TestEnv;
const kidsJf = new Set<string>();
let owner: Sess;
let ownerId = '';
const visible = (u: { jellyfin_user_id: string }, i: (ItemDto & { adult?: boolean }) | undefined) => Boolean(i) && !(kidsJf.has(u.jellyfin_user_id) && i!.adult);
const strip = ({ adult: _a, ...i }: ItemDto & { adult?: boolean }): ItemDto => ({ ...i });
let calls: string[] = [];

function patchJf() {
  const jf = env.ctx.jf;
  Object.assign(jf, {
    item: async (u: any, id: string) => { calls.push('item'); const i = lib.get(id); if (!visible(u, i)) throw new MediaError(404, 'not visible'); return strip(i!); },
    items: async (u: any, q: { ids?: string[] }) => { const out = (q.ids ?? []).map((id) => lib.get(id)).filter((i) => visible(u, i)).map((i) => strip(i!)); return { items: out, total: out.length }; },
    nextEpisode: async (_u: any, s: string, id: string) => { const l = episodes.get(s) ?? []; const at = l.findIndex((e) => e.id === id); return at >= 0 && l[at + 1] ? strip(l[at + 1]!) : null; },
    nextUp: async (_u: any, s: string) => (episodes.get(s) ?? []).filter((e) => !e.played && !virtual.has(e.id)).slice(0, 1).map(strip),
    episodes: async (_u: any, s: string) => (episodes.get(s) ?? []).map(strip),
    availableEpisodes: async (_u: any, ids: string[]) => new Set(ids.filter((i) => !virtual.has(i))),
    seriesStatus: async (_u: any, s: string) => status[s] ?? null,
    libraryContinuingSeriesIds: async () => [] as string[], // nothing from the library-wide list: Mystery Show stays unknown
    upcoming: async () => [strip(lib.get(ANNOUNCED)!)],
    itemCollections: async (u: any, id: string) => collections.filter((c) => c.parts.some((p) => p.item.id === id)).map((c) => ({ ...c, parts: c.parts.filter((p) => visible(u, p.item)) })),
    itemAbout: async () => ({ type: 'Series', providerIds: { tmdb: '77' }, countries: [], studios: [], tags: [] }),
    similar: async (u: any, id: string) => (similarOf[id] ?? COMMON).map((x) => lib.get(x)).filter((i) => visible(u, i)).map((i) => strip(i!)),
    userDataVersion: async () => '1',
    lastWatched: async () => null,
    history: async () => [],
  });
}

const call = (s: Sess, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
const pp = async (s: Sess, id: string) => {
  const r = await call(s, 'GET', `/api/items/${id}/postplay`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { state: string; current: ItemDto; next: ItemDto | null; nextAirDate: string | null; sequel: ItemDto | null; canWish: boolean; remind: { episodeId: string } | null; rows: Array<{ kind: string; title: string; reason: { seed?: { id: string; name: string }; traits?: string[] }; items: ItemDto[]; wish?: { tmdbId: number; quota: { limit: number | null } } }>; hero: ItemDto | null; suggestions: boolean };
};
const allIds = (b: Awaited<ReturnType<typeof pp>>) => b.rows.flatMap((r) => r.items.map((i) => i.id));
async function profile(s: Sess, body: Record<string, unknown>): Promise<{ id: string; sess: Sess }> {
  const r = await call(s, 'POST', '/api/profiles', body);
  expect(r.statusCode, r.body).toBe(201);
  const id = r.json().profile.id as string;
  const sel = await call(s, 'POST', `/api/profiles/${id}/select`, {});
  expect(sel.statusCode, sel.body).toBe(200);
  return { id, sess: { cookies: { ff_sid: sel.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: s.csrf } };
}
const backToOwner = async (s: Sess): Promise<Sess> => {
  const sel = await call(s, 'POST', `/api/profiles/${ownerId}/select`, {});
  return { cookies: { ff_sid: sel.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: s.csrf };
};

beforeAll(async () => {
  env = await makeEnv({}, { seerr: { 'GET .*/tv/77': () => ({ json: { id: 77, name: 'Ended Show', mediaInfo: { status: 4 } } }) } });
  patchJf();
  owner = await env.login();
  ownerId = (await call(owner, 'GET', '/api/me')).json().profile.id;
  await env.pool.query('insert into dropped(profile_id, item_id) values ($1, $2)', [ownerId, DROPPED]);
  const uid = (await env.pool.query<{ id: string }>("select id from users where authentik_sub='sub-admin'")).rows[0]!.id;
  await env.pool.query("insert into thumbs(profile_id, user_id, item_id, value, item_name) values ($1, $2, $3, -1, 'x')", [ownerId, uid, DOWNED]);
  // a friend who shares ratings and loved two titles
  await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-b','b@example.com','Bea','friend','jfbea','Bea',$1)", [encrypt(env.ctx.encKey, 'pw')]);
  const bea = (await env.pool.query<{ id: string }>("select id from users where authentik_sub='sub-b'")).rows[0]!.id;
  await env.pool.query("insert into ratings(user_id, item_id, item_name, stars) values ($1, $2, 'x', 5), ($1, $3, 'x', 5)", [bea, RECS[11], SOLO]);
});
afterAll(() => env?.close());
beforeEach(async () => { calls = []; env.ctx.cfg = { ...cfg }; await bumpHome(env.ctx, ownerId); });

describe('pure rules', () => {
  const mk = (id: string, days: number) => base({ id, name: id, type: 'Movie', premiereDate: iso(days) });
  it('current season = premiered within the last ~3 months (not in the future)', () => {
    expect(isCurrentSeason(mk('a', -5), NOW)).toBe(true);
    expect(isCurrentSeason(mk('a', -CURRENT_SEASON_DAYS - 2), NOW)).toBe(false);
    expect(isCurrentSeason(mk('a', 30), NOW)).toBe(false);
    expect(isCurrentSeason({}, NOW)).toBe(false);
  });
  it('anti-pattern: at most 1 in 3 items of a row from the current season, on every third slot', () => {
    const cur = Array.from({ length: 6 }, (_, i) => mk(`c${i}`, -i - 1));
    const back = Array.from({ length: 6 }, (_, i) => mk(`b${i}`, -1000));
    const out = balanceSeason([...cur, ...back], NOW);
    const n = out.filter((i) => isCurrentSeason(i, NOW)).length;
    expect(n * 3).toBeLessThanOrEqual(out.length);
    expect(out.map((i) => i.id)).toEqual(['b0', 'b1', 'c0', 'b2', 'b3', 'c1', 'b4', 'b5', 'c2']);
    expect(balanceSeason(cur, NOW)).toEqual([]); // only current-season titles: none of them may fill a row
    for (let size = 0; size < 12; size++) {
      const mixed = Array.from({ length: size }, (_, i) => mk(`m${i}`, i % 2 ? -3 : -900));
      const r = balanceSeason(mixed, NOW);
      expect(r.filter((i) => isCurrentSeason(i, NOW)).length * 3).toBeLessThanOrEqual(r.length);
    }
  });
  it('next part: the first unwatched later part of a collection', () => {
    const a = mk('a', -900), b = { ...mk('b', -800), played: true }, c = mk('c', -700);
    const col = [{ id: 'x', name: 'X', parts: [{ item: a }, { item: b }, { item: c }] }];
    expect(nextPart(col, 'a')?.item.id).toBe('c');
    expect(nextPart(col, 'c')).toBeNull();
    expect(nextPart(col, 'zz')).toBeNull();
  });
  it('hero: taste overlap first, then a stable per-profile order (not the same pick for everybody)', () => {
    const cands = Array.from({ length: 8 }, (_, i) => mk(`h${i}`, -900));
    expect(pickHero(cands, new Set(['h5']), 'p1')!.id).toBe('h5');
    const picks = new Set(Array.from({ length: 12 }, (_, i) => pickHero(cands, new Set(), `profile-${i}`)!.id));
    expect(picks.size).toBeGreaterThan(1);
    expect(pickHero(cands, new Set(), 'p1')!.id).toBe(pickHero(cands, new Set(), 'p1')!.id); // stable
    expect(pickHero([], new Set(), 'p1')).toBeNull();
  });
  it('rows come in the spec order; the transition source (RECO_ENGINE=v2, R4) is grown-ups only', () => {
    expect(ROW_KINDS).toEqual(['continuation', 'transition', 'universe', 'because', 'friends', 'taste']);
    expect(ROW_SOURCES.map((r) => r.kind)).toEqual(['continuation', 'transition', 'universe', 'because', 'friends', 'taste']);
    expect(ROW_SOURCES.find((r) => r.kind === 'friends')!.grownUp).toBe(true);
    expect(ROW_SOURCES.find((r) => r.kind === 'transition')!.grownUp).toBe(true);
  });
});

describe('GET /api/items/:id/postplay: states', () => {
  it('movie in a collection: next = the next part, which is also the hero and the continuation row', async () => {
    const b = await pp(owner, DUNE1);
    expect(b.state).toBe('next');
    expect(b.next?.id).toBe(DUNE2);
    expect(b.hero?.id).toBe(DUNE2);
    expect(b.rows[0]).toMatchObject({ kind: 'continuation', title: 'Dune Collection', reason: { traits: ['collection:Dune Collection'] } });
    expect(b.rows[0]!.items.map((i) => i.id)).toEqual([DUNE2]);
  });

  it('movie without a later part: movie_end, recommendations only, every row carries a reason', async () => {
    const b = await pp(owner, SOLO);
    expect(b.state).toBe('movie_end');
    expect(b.next).toBeNull();
    expect(b.rows.map((r) => r.kind)).not.toContain('continuation');
    const because = b.rows.find((r) => r.kind === 'because')!;
    expect(because.reason.seed).toEqual({ id: SOLO, name: 'Solo Film' }); // seeded with the title just finished
    expect(because.reason.traits).toEqual(['genre:Thriller']);
    for (const r of b.rows) expect(r.reason).toBeTypeOf('object');
    expect(b.hero).not.toBeNull();
    // the last part of the collection: no later part, the first part is the "same universe"
    const d2 = await pp(owner, DUNE2);
    expect(d2.state).toBe('movie_end');
  });

  it('last episode of an ENDED series: series_finished, sequel from the collection first', async () => {
    const b = await pp(owner, ep(S_END, 3));
    expect(b.state).toBe('series_finished');
    expect(b.sequel?.id).toBe(S_SEQUEL);
    expect(b.hero?.id).toBe(S_SEQUEL);
    expect(b.rows[0]).toMatchObject({ kind: 'continuation' });
    expect(b.rows[0]!.items[0]!.id).toBe(S_SEQUEL);
  });

  it('series_finished without a sequel offers a wish for the missing season (with the monthly limit)', async () => {
    const keep = collections[1]!.parts;
    collections[1]!.parts = [keep[0]!];
    try {
      const b = await pp(owner, ep(S_END, 3));
      expect(b.state).toBe('series_finished');
      expect(b.sequel).toBeNull();
      expect(b.canWish).toBe(true);
      const c = b.rows.find((r) => r.kind === 'continuation')!;
      expect(c.items).toEqual([]);
      expect(c.wish).toMatchObject({ mediaType: 'tv', tmdbId: 77, quota: expect.objectContaining({ used: 0 }) });
    } finally { collections[1]!.parts = keep; }
  });

  it('last available episode of a CONTINUING series: caught_up with the next air date and a reminder target', async () => {
    const b = await pp(owner, ep(S_CONT, 3));
    expect(b.state).toBe('caught_up');
    expect(b.next).toBeNull();
    expect(b.nextAirDate).toBe(iso(6).slice(0, 10));
    expect(b.remind).toEqual({ episodeId: ANNOUNCED });
  });

  it('unknown status is never called finished (fresh.ts rule): caught_up', async () => {
    const b = await pp(owner, ep(S_UNK, 3));
    expect(b.state).toBe('caught_up');
    expect(b.state).not.toBe('series_finished');
    expect(b.nextAirDate).toBeNull();
    // also without the media hook at all, and when the hook fails
    const hook = env.ctx.jf.seriesStatus;
    try {
      (env.ctx.jf as { seriesStatus?: unknown }).seriesStatus = undefined;
      await bumpHome(env.ctx, ownerId);
      expect((await pp(owner, ep(S_END, 3))).state).toBe('caught_up');
      (env.ctx.jf as { seriesStatus?: unknown }).seriesStatus = async () => { throw new MediaError(500, 'x'); };
      await bumpHome(env.ctx, ownerId);
      expect((await pp(owner, ep(S_END, 3))).state).toBe('caught_up');
    } finally { env.ctx.jf.seriesStatus = hook; }
  });

  it('caught up but an earlier episode is unwatched: gap, jump back first (no autoplay of anything)', async () => {
    const b = await pp(owner, ep(S_GAP, 3));
    expect(b.state).toBe('gap');
    expect(b.next?.id).toBe(ep(S_GAP, 1));
    expect(b.rows[0]!.kind).toBe('continuation');
    expect(b.rows[0]!.items[0]!.id).toBe(ep(S_GAP, 1));
    expect(b.hero?.type).not.toBe('Episode'); // never an unwatched episode as the hero
  });

  it('next episode available: state next (the player keeps its countdown)', async () => {
    const b = await pp(owner, ep(S_NEXT, 2));
    expect(b.state).toBe('next');
    expect(b.next?.id).toBe(ep(S_NEXT, 3));
  });

  it('spoiler protection hides the description of the unwatched episode', async () => {
    await call(owner, 'PUT', '/api/prefs', { spoilerProtection: true });
    try {
      const b = await pp(owner, ep(S_GAP, 3));
      expect(b.next?.overview).toBeUndefined();
      expect(b.rows[0]!.items[0]!.overview).toBeUndefined();
    } finally { await call(owner, 'PUT', '/api/prefs', { spoilerProtection: false }); }
    expect((await pp(owner, ep(S_GAP, 3))).next?.overview).toBe('Secret plot 1');
  });
});

describe('GET /api/items/:id/postplay: rows and anti-patterns', () => {
  it('rows in the spec order; dropped, thumbs-down, played and already-watched series never appear', async () => {
    const b = await pp(owner, ep(S_END, 3));
    const order = b.rows.map((r) => r.kind);
    expect(order).toEqual([...order].sort((x, y) => ROW_KINDS.indexOf(x as never) - ROW_KINDS.indexOf(y as never)));
    expect(order).toEqual(expect.arrayContaining(['continuation', 'because', 'friends']));
    const ids = allIds(b);
    for (const bad of [DROPPED, DOWNED, WATCHED, S_WATCHED, S_END, ep(S_END, 3)]) expect(ids, bad).not.toContain(bad);
    expect(new Set(ids).size).toBe(ids.length); // no title twice
    for (const r of b.rows) for (const i of r.items) { expect(i.played).toBe(false); if (i.type === 'Series') expect(i.unplayedCount).not.toBe(0); }
  });

  it('at most 1 in 3 items per row from the current season', async () => {
    const b = await pp(owner, SOLO);
    for (const r of b.rows) expect(r.items.filter((i) => isCurrentSeason(i, NOW)).length * 3, r.kind).toBeLessThanOrEqual(r.items.length);
    expect(allIds(b)).toContain(CURSEASON1); // still there, just balanced
  });

  it('a new thumbs-down drops the cached answer at once (bumpHome)', async () => {
    const first = await pp(owner, SOLO);
    const victim = first.rows.find((r) => r.kind === 'because')!.items[0]!.id;
    expect((await call(owner, 'PUT', `/api/items/${victim}/thumb`, { value: -1 })).statusCode).toBe(200);
    expect(allIds(await pp(owner, SOLO))).not.toContain(victim);
    await call(owner, 'PUT', `/api/items/${victim}/thumb`, { value: 0 });
  });

  it('cached for 60 s per profile + item + user-data version', async () => {
    await pp(owner, SOLO);
    const cached = (await env.kv.keys('postplay:')).filter((k) => k.includes(SOLO));
    calls = [];
    await pp(owner, SOLO);
    expect(calls).toEqual(['item']); // second answer from the cache: only the visibility check reaches the media server
    expect((await env.kv.keys('postplay:')).filter((k) => k.includes(SOLO))).toEqual(cached);
    env.ctx.jf.userDataVersion = async () => '2';
    try {
      await pp(owner, SOLO);
      expect((await env.kv.keys('postplay:')).filter((k) => k.includes(SOLO) && k.includes(':2:'))).toHaveLength(1); // a new version: built again
    } finally { env.ctx.jf.userDataVersion = async () => '1'; }
  });

  it('the same hero is not shown to every profile (different tastes, different picks)', async () => {
    const heroes = new Set<string>();
    let s = owner;
    for (const [n, liked] of [RECS[8], RECS[9], RECS[10]].entries()) {
      const p = await profile(s, { name: `Fan ${n}` });
      const pid = p.id;
      const uid = (await env.pool.query<{ id: string }>("select id from users where authentik_sub='sub-admin'")).rows[0]!.id;
      await env.pool.query("insert into thumbs(profile_id, user_id, item_id, value, item_name) values ($1, $2, $3, 1, 'x')", [pid, uid, liked]);
      heroes.add((await pp(p.sess, SOLO)).hero!.id);
      s = await backToOwner(p.sess);
    }
    owner = s;
    expect(heroes).toEqual(new Set([RECS[0], RECS[1], RECS[2]])); // each profile gets the pick that fits its own taste
  });

  it('kids profile: no friends row, only age-allowed titles, no reminder target', async () => {
    const kid = await profile(owner, { name: 'Mia', kids: true, maxRating: 12 });
    const jf = (await env.pool.query<{ j: string }>('select jellyfin_user_id j from profiles where id=$1', [kid.id])).rows[0]!.j;
    kidsJf.add(jf);
    try {
      const b = await pp(kid.sess, ep(S_CONT, 3));
      expect(b.rows.map((r) => r.kind)).not.toContain('friends');
      expect(allIds(b)).not.toContain(ADULT);
      expect(b.remind).toBeNull();
      const movie = await pp(kid.sess, SOLO);
      expect(movie.rows.map((r) => r.kind)).not.toContain('friends');
      expect((await call(kid.sess, 'GET', `/api/items/${ADULT}/postplay`)).statusCode).toBe(404); // not visible to the kid
    } finally { kidsJf.delete(jf); owner = await backToOwner(kid.sess); }
    // the grown-up sees the friends row (Bea shares her ratings)
    expect((await pp(owner, SOLO)).rows.map((r) => r.kind)).toContain('friends');
  });

  it('"Show suggestions after the last episode" off: only the continuation row, no hero pick', async () => {
    await call(owner, 'PUT', '/api/prefs', { postplay: false });
    try {
      const b = await pp(owner, ep(S_GAP, 3));
      expect(b.suggestions).toBe(false);
      expect(b.rows.map((r) => r.kind)).toEqual(['continuation']);
      expect(b.hero).toBeNull();
      expect((await pp(owner, SOLO)).rows).toEqual([]);
    } finally { await call(owner, 'PUT', '/api/prefs', { postplay: true }); }
    expect((await call(owner, 'GET', '/api/prefs')).json().prefs.postplay).toBe(true);
  });
});

describe('GET /api/items/:id/postplay: access', () => {
  it('needs a session; 404 for invisible or unknown items; bad ids 400', async () => {
    expect((await env.app.inject({ url: `/api/items/${SOLO}/postplay` })).statusCode).toBe(401);
    expect((await call(owner, 'GET', `/api/items/${hex(999)}/postplay`)).statusCode).toBe(404);
    expect((await call(owner, 'GET', '/api/items/nope/postplay')).statusCode).toBe(400);
  });
  it('a warm cache never answers for a title that is no longer visible: 404 (visibility is checked before the cache)', async () => {
    expect((await call(owner, 'GET', `/api/items/${ADULT}/postplay`)).statusCode).toBe(200); // warms the 60 s cache
    expect((await env.kv.keys('postplay:')).some((k) => k.includes(ADULT))).toBe(true);
    const jf = (env.ctx.jf as unknown as { item: (u: any, id: string) => Promise<ItemDto> });
    const real = jf.item;
    jf.item = async (u, id) => { if (id === ADULT) throw new MediaError(404, 'not visible'); return real(u, id); }; // e.g. the admin narrowed the libraries
    try {
      expect((await call(owner, 'GET', `/api/items/${ADULT}/postplay`)).statusCode).toBe(404);
    } finally { jf.item = real; }
    expect((await call(owner, 'GET', `/api/items/${ADULT}/postplay`)).statusCode).toBe(200);
  });
  it('POSTPLAY_ENABLED=false: 404 disabled, and /api/me says so', async () => {
    env.ctx.cfg = { ...cfg, POSTPLAY_ENABLED: 'false' };
    expect((await call(owner, 'GET', `/api/items/${SOLO}/postplay`)).json()).toEqual({ error: 'disabled' });
    expect((await call(owner, 'GET', '/api/me')).json().features).toMatchObject({ postplay: false });
    env.ctx.cfg = { ...cfg };
    expect((await call(owner, 'GET', '/api/me')).json().features).toMatchObject({ postplay: true });
  });
});

describe('POST /api/postplay/event: aggregate counters with bounded labels', () => {
  const value = async (name: string, labels: Record<string, string> = {}) => {
    const m = (await registry.getMetricsAsJSON()).find((x) => x.name === name);
    return (m?.values as Array<{ value: number; labels: Record<string, string> }> | undefined)?.find((v) => Object.entries(labels).every(([k, x]) => v.labels[k] === x))?.value ?? 0;
  };
  it('counts shown / click / play / dismiss; unknown labels are refused (no title, no free text)', async () => {
    const shown = await value('friendflix_postplay_shown_total', { state: 'caught_up' });
    expect((await call(owner, 'POST', '/api/postplay/event', { type: 'shown', state: 'caught_up' })).statusCode).toBe(204);
    expect(await value('friendflix_postplay_shown_total', { state: 'caught_up' })).toBe(shown + 1);
    const click = await value('friendflix_postplay_click_total', { row_kind: 'because' });
    await call(owner, 'POST', '/api/postplay/event', { type: 'click', row: 'because' });
    expect(await value('friendflix_postplay_click_total', { row_kind: 'because' })).toBe(click + 1);
    const play = await value('friendflix_postplay_play_total', { row_kind: 'continuation' });
    await call(owner, 'POST', '/api/postplay/event', { type: 'play', row: 'continuation' });
    expect(await value('friendflix_postplay_play_total', { row_kind: 'continuation' })).toBe(play + 1);
    const dis = await value('friendflix_postplay_dismiss_total');
    await call(owner, 'POST', '/api/postplay/event', { type: 'dismiss' });
    expect(await value('friendflix_postplay_dismiss_total')).toBe(dis + 1);
    for (const bad of [{ type: 'click', row: 'Dune Part One' }, { type: 'shown', state: 'whatever' }, { type: 'x' }, {}]) {
      expect((await call(owner, 'POST', '/api/postplay/event', bad)).statusCode).toBe(400);
    }
    const text = await registry.metrics();
    expect(text).not.toMatch(/Dune|Solo Film|sub-admin/);
    expect((await env.app.inject({ method: 'POST', url: '/api/postplay/event', payload: { type: 'dismiss' } })).statusCode).toBe(401);
  });
});

describe('Jellyfin seriesStatus hook (optional MediaServer method)', () => {
  it('maps Continuing / Ended, anything else is unknown; asks as the viewer; 404 when not visible', async () => {
    const key = keyFromBase64(ENC_KEY);
    const calls: Call[] = [];
    const st: Record<string, string | undefined> = { [hex(1)]: 'Continuing', [hex(2)]: 'Ended', [hex(3)]: undefined, [hex(4)]: 'Pilot' };
    const svc = new JellyfinService(new JellyfinClient('http://jf.test:8096', 'adminkey', fakeHttp({
      'POST /Users/AuthenticateByName': (_u, _i, b) => ({ json: { AccessToken: `tok-${b.Username}`, User: { Id: 'x', Name: b.Username } } }),
      'GET /Items': (u) => { const id = u.searchParams.get('ids')!; return { json: { Items: id in st ? [{ Id: id, Type: 'Series', Status: st[id] }] : [] } }; },
    }, calls)), new MemoryKV(), key);
    const bob = { id: 'u1', jellyfin_user_id: 'jfbob', jellyfin_username: 'bob', jellyfin_pw_enc: encrypt(key, 'pw') } as never;
    expect(await svc.seriesStatus(bob, hex(1))).toBe('continuing');
    expect(await svc.seriesStatus(bob, hex(2))).toBe('ended');
    expect(await svc.seriesStatus(bob, hex(3))).toBeNull();
    expect(await svc.seriesStatus(bob, hex(4))).toBeNull();
    await expect(svc.seriesStatus(bob, hex(5))).rejects.toMatchObject({ status: 404 });
    const last = calls.filter((c) => c.path === '/Items').at(-1)!;
    expect(last.auth).toContain('Token="tok-bob"');
    expect(last.search).toContain('userId=jfbob');
  });
});
