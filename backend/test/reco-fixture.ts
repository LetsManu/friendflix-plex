// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { MediaError, type ItemDto, type ItemFeatures } from '../src/media/types.js';
import { ratingAge } from '../src/reco/score.js';
import type { RecoProfile } from '../src/reco/profile.js';
import type { Ctx } from '../src/ctx.js';
import type { JfUser } from '../src/types.js';
import type { Config } from '../src/config.js';
import { recoIndexTick } from '../src/reco/indexJob.js';
import { encrypt } from '../src/crypto.js';
import type { TestEnv } from './helpers.js';

/** Fixed "now" of the reco tests (so freshness and decay are exact). */
export const NOW = Date.parse('2026-10-01T12:00:00Z');
export const DAY = 86_400_000;
/** 32 hex chars from a short key: ids in tests read like names */
export const H = (key: string): string => createHash('md5').update(key).digest('hex');

interface Spec {
  key: string; type?: 'Movie' | 'Series'; genres: string[]; tags?: string[]; studios?: string[]; people?: string[]; year: number; runtime: number;
  rating: number; critic?: number; collection?: string; overview: string; fsk?: string | null; addedDaysAgo?: number; status?: 'continuing' | 'ended';
}

/** Five small worlds: a space saga (collection of 3) plus space films, crime with one recurring director, romcoms, kids animation, documentaries. */
export const SPECS: Spec[] = [
  { key: 'saga1', genres: ['Science Fiction', 'Adventure'], tags: ['space'], studios: ['Orbit Pictures'], people: ['dir-vale', 'act-kim'], year: 1999, runtime: 125, rating: 8.1, collection: 'saga', overview: 'A smuggler joins rebels against an empire among the stars', fsk: 'FSK 12', addedDaysAgo: 900 },
  { key: 'saga2', genres: ['Science Fiction', 'Adventure'], tags: ['space'], studios: ['Orbit Pictures'], people: ['dir-vale', 'act-kim'], year: 2002, runtime: 130, rating: 8.3, collection: 'saga', overview: 'The rebels flee the empire across the stars while the smuggler hides', fsk: 'FSK 12', addedDaysAgo: 880 },
  { key: 'saga3', genres: ['Science Fiction', 'Adventure'], tags: ['space'], studios: ['Orbit Pictures'], people: ['dir-vale', 'act-kim'], year: 2005, runtime: 135, rating: 7.9, collection: 'saga', overview: 'The final battle of the rebels and the empire among the stars', fsk: 'FSK 12', addedDaysAgo: 860 },
  { key: 'orbit', genres: ['Science Fiction', 'Drama'], tags: ['space'], studios: ['Deep Field'], people: ['dir-ross', 'act-lee'], year: 2014, runtime: 118, rating: 7.8, overview: 'An astronaut stranded near a dying star records a message home', fsk: 'FSK 12', addedDaysAgo: 400 },
  { key: 'mars', genres: ['Science Fiction', 'Adventure'], tags: ['space'], studios: ['Deep Field'], people: ['dir-ross', 'act-ray'], year: 2015, runtime: 144, rating: 8, overview: 'A botanist stranded on Mars grows potatoes and waits for a rescue crew', fsk: 'FSK 12', addedDaysAgo: 380 },
  { key: 'signal', type: 'Series', genres: ['Science Fiction', 'Mystery'], tags: ['space', 'conspiracy'], studios: ['Deep Field'], people: ['dir-ross'], year: 2020, runtime: 52, rating: 7.6, overview: 'Scientists decode a signal from a distant star and a conspiracy follows', fsk: 'FSK 16', addedDaysAgo: 20, status: 'continuing' },
  { key: 'noir1', genres: ['Crime', 'Drama'], tags: ['detective'], studios: ['Harbor Films'], people: ['dir-moro', 'act-ng'], year: 2008, runtime: 110, rating: 7.7, overview: 'A detective follows a murder through the harbour district', fsk: 'FSK 16', addedDaysAgo: 700 },
  { key: 'noir2', genres: ['Crime', 'Thriller'], tags: ['detective'], studios: ['Harbor Films'], people: ['dir-moro', 'act-ray'], year: 2011, runtime: 117, rating: 7.4, overview: 'The detective returns to a harbour murder and a corrupt police captain', fsk: 'FSK 16', addedDaysAgo: 650 },
  { key: 'noir3', genres: ['Crime', 'Thriller'], tags: ['heist'], studios: ['Harbor Films'], people: ['dir-moro'], year: 2016, runtime: 123, rating: 7.9, overview: 'A crew plans a heist on the harbour bank vault', fsk: 'FSK 16', addedDaysAgo: 300 },
  { key: 'cops', type: 'Series', genres: ['Crime', 'Drama'], tags: ['police'], studios: ['Northern TV'], people: ['act-ng', 'act-lee'], year: 2018, runtime: 48, rating: 8.4, overview: 'A police unit solves murders in a northern city', fsk: 'FSK 16', addedDaysAgo: 150, status: 'continuing' },
  { key: 'heist2', genres: ['Crime', 'Comedy'], tags: ['heist'], studios: ['Northern TV'], people: ['act-lee'], year: 2019, runtime: 101, rating: 6.8, overview: 'Clumsy thieves plan a heist on a city casino', fsk: 'FSK 12', addedDaysAgo: 120 },
  { key: 'rom1', genres: ['Romance', 'Comedy'], tags: ['wedding'], studios: ['Sunny Lane'], people: ['dir-berg', 'act-kim'], year: 2010, runtime: 98, rating: 6.5, overview: 'Two rivals fall in love while planning a wedding', fsk: 'FSK 6', addedDaysAgo: 500 },
  { key: 'rom2', genres: ['Romance', 'Comedy'], tags: ['wedding'], studios: ['Sunny Lane'], people: ['dir-berg'], year: 2013, runtime: 96, rating: 6.9, overview: 'A wedding planner falls for the groom brother', fsk: 'FSK 6', addedDaysAgo: 450 },
  { key: 'rom3', genres: ['Romance', 'Drama'], tags: ['holiday'], studios: ['Sunny Lane'], people: ['act-ng'], year: 2017, runtime: 104, rating: 7.1, overview: 'Strangers meet on a holiday island and fall in love', fsk: 'FSK 6', addedDaysAgo: 250 },
  { key: 'bear1', genres: ['Animation', 'Family'], tags: ['animals'], studios: ['Pixel Meadow'], people: ['dir-oak'], year: 2012, runtime: 82, rating: 7.2, overview: 'Three bears learn to share their forest home', fsk: 'FSK 0', addedDaysAgo: 600 },
  { key: 'bear2', genres: ['Animation', 'Family'], tags: ['animals'], studios: ['Pixel Meadow'], people: ['dir-oak'], year: 2015, runtime: 85, rating: 7.4, overview: 'The bears build a treehouse and welcome a lost fox', fsk: 'FSK 0', addedDaysAgo: 500 },
  { key: 'robot', genres: ['Animation', 'Science Fiction'], tags: ['robots'], studios: ['Pixel Meadow'], people: ['dir-oak'], year: 2018, runtime: 90, rating: 7.8, overview: 'A lonely robot repairs a space station and befriends a kitten', fsk: 'FSK 6', addedDaysAgo: 100 },
  { key: 'pups', type: 'Series', genres: ['Animation', 'Family'], tags: ['animals'], studios: ['Pixel Meadow'], people: [], year: 2021, runtime: 22, rating: 7, overview: 'A team of puppies rescues the town every day', fsk: 'FSK 0', addedDaysAgo: 10, status: 'continuing' },
  { key: 'doc1', genres: ['Documentary'], tags: ['nature'], studios: ['Blue Planet Co'], people: ['dir-ash'], year: 2016, runtime: 95, rating: 8.5, overview: 'A journey through the deep ocean and its strange creatures', fsk: 'FSK 6', addedDaysAgo: 350 },
  { key: 'doc2', genres: ['Documentary'], tags: ['nature'], studios: ['Blue Planet Co'], people: ['dir-ash'], year: 2019, runtime: 92, rating: 8.2, overview: 'The hidden life of forests and the creatures beneath the trees', fsk: 'FSK 0', addedDaysAgo: 200 },
  { key: 'doc3', genres: ['Documentary', 'History'], tags: ['war'], studios: ['Archive House'], people: [], year: 2012, runtime: 150, rating: 8.8, overview: 'Archive footage tells the story of a long war', fsk: 'FSK 16', addedDaysAgo: 800 },
  { key: 'unrated', genres: ['Drama'], tags: [], studios: [], people: [], year: 2009, runtime: 100, rating: 6, overview: 'A quiet drama without a rating label', fsk: null, addedDaysAgo: 700 },
  { key: 'hype', genres: ['Drama'], tags: [], studios: [], people: [], year: 2021, runtime: 100, rating: 10, overview: 'A film with a perfect score from two voters', fsk: 'FSK 12', addedDaysAgo: 5 },
];

export const spec = (key: string): Spec => SPECS.find((s) => s.key === key)!;
export const features = (): ItemFeatures[] => SPECS.map((s) => ({
  id: H(s.key), type: s.type ?? 'Movie', genres: s.genres, tags: s.tags ?? [], studios: s.studios ?? [], people: (s.people ?? []).map((p) => H(p)), countries: [],
  year: s.year, runtimeMin: s.runtime, communityRating: s.rating, ...(s.critic !== undefined ? { criticRating: s.critic } : {}),
  ...(s.collection ? { collectionId: H(`col-${s.collection}`) } : {}), ...(s.status ? { seriesStatus: s.status } : {}), overview: s.overview,
}));

export function dto(key: string, o: Partial<ItemDto> = {}): ItemDto {
  const s = spec(key);
  return {
    id: H(key), name: s.key.toUpperCase(), type: s.type ?? 'Movie', year: s.year, genres: s.genres, ...(s.fsk === null ? {} : { rating: s.fsk ?? 'FSK 12' }),
    communityRating: s.rating, runtimeTicks: s.runtime * 60 * 1e7, image: false, backdrop: false, logo: false, trailers: 0, played: false, favorite: false, positionTicks: 0,
    dateCreated: new Date(NOW - (s.addedDaysAgo ?? 365) * DAY).toISOString(), ...o,
  };
}
export const ids = (keys: string[]) => keys.map(H);
export const keyOf = (id: string): string => SPECS.find((s) => H(s.key) === id)?.key ?? id;
export const keysOf = (list: Array<{ id: string } | string>) => list.map((x) => keyOf(typeof x === 'string' ? x : x.id));

// ------------------------------------------------------------------------------------------------------------------- fake media server

export interface FakeState {
  history: ItemDto[]; favorites: ItemDto[]; similar: Record<string, string[]>; version: string;
  /** Jellyfin user id -> parental cap (the server hides everything above it, unrated included) */
  caps: Record<string, number>;
  /** hide these ids from everyone (not in the library any more) */
  hidden: Set<string>;
  /** Series ItemDto overrides (unplayedCount) */
  unplayed: Record<string, number>;
  fail: Set<string>;
  /** R3: what the media server lists as recently added (fixture keys), in this order; answered to every items() call that sorts */
  recent: string[];
  /** R3: credits per item id (names of people for the explanations); absent = none */
  credits: Record<string, { people: Array<{ id: string; name: string; type: string }> }>;
}
export interface FakeCall { fn: string; user: JfUser }

export function fakeJf(): { jf: Ctx['jf']; state: FakeState; calls: FakeCall[] } {
  const state: FakeState = { history: [], favorites: [], similar: {}, version: '1', caps: {}, hidden: new Set(), unplayed: {}, fail: new Set(), recent: [], credits: {} };
  const calls: FakeCall[] = [];
  const visible = (u: JfUser, i: ItemDto) => {
    if (state.hidden.has(i.id)) return false;
    const cap = state.caps[u.jellyfin_user_id];
    if (cap === undefined) return true;
    const age = ratingAge(i.rating);
    return age !== null && age <= cap;
  };
  const withUnplayed = (i: ItemDto): ItemDto => (state.unplayed[i.id] !== undefined ? { ...i, unplayedCount: state.unplayed[i.id]! } : i);
  const find = (id: string) => SPECS.find((s) => H(s.key) === id);
  const jf = {
    async item(u: JfUser, id: string) { calls.push({ fn: 'item', user: u }); const s = find(id); if (!s || !visible(u, dto(s.key))) throw new MediaError(404, 'x'); return dto(s.key); },
    async items(u: JfUser, q: { ids?: string[]; filter?: string; sort?: string }) {
      calls.push({ fn: 'items', user: u });
      if (state.fail.has('items')) throw new MediaError(500, 'x');
      if (q.sort) { const out = state.recent.map((k) => dto(k)).filter((i) => visible(u, i)); return { items: out, total: out.length }; }
      if (q.filter === 'favorites') return { items: state.favorites.filter((i) => visible(u, i)), total: state.favorites.length };
      const out = (q.ids ?? []).map((id) => find(id)).filter((s): s is Spec => Boolean(s)).map((s) => withUnplayed(dto(s.key))).filter((i) => visible(u, i));
      return { items: out, total: out.length };
    },
    async history(u: JfUser) { calls.push({ fn: 'history', user: u }); if (state.fail.has('history')) throw new MediaError(500, 'x'); return state.history.filter((i) => visible(u, i)); },
    async similar(u: JfUser, id: string, limit = 24) {
      calls.push({ fn: 'similar', user: u });
      return (state.similar[id] ?? []).map((k) => dto(k)).filter((i) => visible(u, i)).slice(0, limit);
    },
    async lastWatched(u: JfUser) { calls.push({ fn: 'lastWatched', user: u }); return state.history.find((i) => i.played) ?? null; },
    async userDataVersion() { return state.version; },
    // fresh labels (fresh.ts) look at the episodes of a series: the fixture's series have none, so the library date decides
    async episodes() { return []; },
    async availableEpisodes() { return new Set<string>(); },
    async continuingSeries() { return []; },
    async credits(u: JfUser, id: string) { calls.push({ fn: 'credits', user: u }); const c = state.credits[id]; return { people: (c?.people ?? []).map((p) => ({ ...p, image: false })), studios: [], tags: [] }; },
    capabilities: { libraryFeatures: true },
    libraryFeatures: async (start: number, limit: number) => features().slice(start, start + limit),
  };
  return { jf: jf as unknown as Ctx['jf'], state, calls };
}

// -------------------------------------------------------------------------------------------------------------------------- database

export interface Seeded { user: JfUser; owner: RecoProfile; kids: RecoProfile; kidsUser: JfUser }

/** One account with its owner profile and a kids profile (cap FSK 6), and the viewer identities for both. */
export async function seedProfiles(env: TestEnv, kidsCap = 6): Promise<Seeded> {
  const uid = (await env.pool.query<{ id: string }>(
    "insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-reco','r@example.com','Reco','friend','jfreco','Reco',$1) returning id", [encrypt(env.ctx.encKey, 'pw')])).rows[0]!.id;
  await env.pool.query("insert into profiles(id, user_id, name, is_owner) values ($1,$1,'Reco',true)", [uid]);
  const kid = (await env.pool.query<{ id: string }>(
    "insert into profiles(id, user_id, name, is_owner, kids, kids_max_rating, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),$1,'Kind',false,true,$2,'jfkid','Kind',$3) returning id", [uid, kidsCap, encrypt(env.ctx.encKey, 'pw')])).rows[0]!.id;
  const user: JfUser = { id: uid, jellyfin_user_id: 'jfreco', jellyfin_username: 'Reco', jellyfin_pw_enc: 'x' };
  return {
    user, owner: { id: uid, user_id: uid, is_owner: true, kids: false, kids_max_rating: 12 },
    kids: { id: kid, user_id: uid, is_owner: false, kids: true, kids_max_rating: kidsCap },
    kidsUser: { id: kid, jellyfin_user_id: 'jfkid', jellyfin_username: 'Kind', jellyfin_pw_enc: 'x' },
  };
}

/** Builds the item index from the fixture library with the real index job. */
export async function buildIndex(env: TestEnv): Promise<void> {
  (env.ctx.jf as { libraryFeatures?: unknown }).libraryFeatures = async (start: number, limit: number) => features().slice(start, start + limit);
  await env.pool.query('delete from item_features');
  await recoIndexTick(env.ctx, { full: true, pauseMs: 0 });
}

/** A ctx for the engine: the real database and kv of the env, the fake media server, the config with overrides. */
export function engineCtx(env: TestEnv, jf: Ctx['jf'], cfg: Partial<Config> = {}): Pick<Ctx, 'cfg' | 'db' | 'kv' | 'jf'> {
  return { cfg: { ...env.ctx.cfg, ...cfg }, db: env.ctx.db, kv: env.kv, jf };
}
