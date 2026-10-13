/**
 * Block 21 on Plex (fork): itemAbout / itemCollections of PlexMediaServer (mirror -> neutral DTOs) and GET /api/items/:id/about,
 * the Data sources admin API and the TMDB / OMDb clients (mocked) behind the real routes with MEDIA_SERVER=plex.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaUser } from '../../src/media/types.js';
import { plexRatings, providerIdsOf, tmdbIdOf, toPlexAbout } from '../../src/plex/about.js';
import { DEFAULT_ROLES } from '../../src/roles.js';
import { guidsOf } from '../../src/plex/mirror.js';
import { removeSourceKey, resetSourceState, setSourceKey } from '../../src/sources/keys.js';
import { fakeHttp, makeEnv, type Call, type Handler, type TestEnv } from '../helpers.js';
import { PLEX_TOKEN, PLEX_URL, PlexFake } from '../plexfake.js';
import { identity, item, kids, plexEnv, section, type PlexEnv } from './setup.js';

// ---------------------------------------------------------------- pure mappers

describe('providerIdsOf (Guid parsing)', () => {
  it('new-agent Guid entries', () => {
    expect(providerIdsOf(['imdb://tt0133093', 'tmdb://603', 'tvdb://169'])).toEqual({ imdb: 'tt0133093', tmdb: '603', tvdb: '169' });
  });
  it('missing ids: nothing, empty, null, plex:// / local:// only', () => {
    expect(providerIdsOf([])).toEqual({});
    expect(providerIdsOf(null)).toEqual({});
    expect(providerIdsOf(undefined)).toEqual({});
    expect(providerIdsOf(['plex://movie/5d776826880197001ec967e7', 'local://42', 'collection://abc'])).toEqual({});
    expect(providerIdsOf(['tmdb://603'])).toEqual({ tmdb: '603' });
  });
  it('legacy agent guids (com.plexapp.agents.*), query string dropped', () => {
    expect(providerIdsOf(['com.plexapp.agents.imdb://tt0133093?lang=en'])).toEqual({ imdb: 'tt0133093' });
    expect(providerIdsOf(['com.plexapp.agents.themoviedb://603?lang=de'])).toEqual({ tmdb: '603' });
    expect(providerIdsOf(['com.plexapp.agents.thetvdb://81189?lang=en'])).toEqual({ tvdb: '81189' });
  });
  it('a legacy guid with a path (episode named by its series) is not the item\'s own id', () => {
    expect(providerIdsOf(['com.plexapp.agents.thetvdb://81189/1/2?lang=en'])).toEqual({});
    expect(providerIdsOf(['com.plexapp.agents.themoviedb://1396/1/1'])).toEqual({});
  });
  it('new-agent ids win over a legacy guid; first one of a kind wins', () => {
    expect(providerIdsOf(['com.plexapp.agents.imdb://tt0000001', 'imdb://tt0133093'])).toEqual({ imdb: 'tt0133093' });
    expect(providerIdsOf(['tmdb://1', 'tmdb://2'])).toEqual({ tmdb: '1' });
  });
  it('malformed values and other agents are dropped; case is normalised for IMDb', () => {
    expect(providerIdsOf(['imdb://', 'imdb://abc', 'imdb://tt', 'tmdb://12a', 'tvdb://-1', 'tmdb://1 2', 'imdb://tt12;x'])).toEqual({});
    expect(providerIdsOf(['com.plexapp.agents.hama://anidb-123', 'com.plexapp.agents.none://abc', 'anidb://123'])).toEqual({});
    expect(providerIdsOf(['IMDB://TT0133093'])).toEqual({ imdb: 'tt0133093' });
    expect(providerIdsOf([42 as unknown as string, 'tmdb://603'])).toEqual({ tmdb: '603' });
  });
  it('tmdbIdOf reads new and legacy guids', () => {
    expect(tmdbIdOf(['tmdb://603'])).toBe(603);
    expect(tmdbIdOf(['com.plexapp.agents.themoviedb://604?lang=en'])).toBe(604);
    expect(tmdbIdOf(['imdb://tt0133093'])).toBeUndefined();
  });
});

describe('guidsOf (mirror)', () => {
  it('keeps Guid entries and a legacy agent guid (query dropped); never the plex:// or local:// own guid', () => {
    expect(guidsOf({ guid: 'plex://movie/5d77', Guid: [{ id: 'imdb://tt0133093' }, { id: 'tmdb://603' }] })).toEqual(['imdb://tt0133093', 'tmdb://603']);
    expect(guidsOf({ guid: 'com.plexapp.agents.imdb://tt0133093?lang=en' })).toEqual(['com.plexapp.agents.imdb://tt0133093']);
    expect(guidsOf({ guid: 'com.plexapp.agents.thetvdb://81189/1/2?lang=en' })).toEqual(['com.plexapp.agents.thetvdb://81189/1/2']);
    expect(guidsOf({ guid: 'com.plexapp.agents.hama://anidb-1?lang=en' })).toEqual([]);
    expect(guidsOf({ guid: 'local://1' })).toEqual([]);
    expect(guidsOf({})).toEqual([]);
  });
});

describe('plexRatings', () => {
  const r = (audience: number | null, rating: number | null, img: string | null) => plexRatings({ audience_rating: audience, critic_rating: rating, rating_image: img });
  it('Rotten Tomatoes: audience = community, critics x10 = critic', () => {
    expect(r(7.9, 8.8, 'rottentomatoes://image.rating.ripe')).toEqual({ communityRating: 7.9, criticRating: 88 });
    expect(r(null, 3.1, 'rottentomatoes://image.rating.rotten')).toEqual({ criticRating: 31 });
  });
  it('IMDb / TMDB image or legacy agent without image: rating is a community score (audience wins)', () => {
    expect(r(null, 7.42, 'imdb://image.rating')).toEqual({ communityRating: 7.4 });
    expect(r(null, 6.5, null)).toEqual({ communityRating: 6.5 });
    expect(r(8.1, 6.5, 'themoviedb://image.rating')).toEqual({ communityRating: 8.1 });
  });
  it('nothing / out of range', () => {
    expect(r(null, null, null)).toEqual({});
    expect(r(11, -1, 'rottentomatoes://image.rating.ripe')).toEqual({});
  });
  it('toPlexAbout: types, studios deduped, labels as tags, no genres', () => {
    const a = toPlexAbout({ type: 'show', guids: ['tvdb://370160'], tagline: null, original_title: null, originally_available: '2019-10-01', studio: 'HBO', audience_rating: null, critic_rating: null, rating_image: null, audience_rating_image: null },
      [{ kind: 'studio', tag: 'HBO' }, { kind: 'studio', tag: 'Other' }, { kind: 'label', tag: 'Fav' }, { kind: 'genre', tag: 'Drama' }, { kind: 'country', tag: 'Norway' }]);
    expect(a).toEqual({ type: 'Series', providerIds: { tvdb: '370160' }, premiereDate: '2019-10-01', countries: ['Norway'], studios: ['HBO', 'Other'], tags: ['Fav'] });
  });
});

// ---------------------------------------------------------------- library used by the service and route tests

const lib: Record<string, string> = {};
function seed(f: PlexFake) {
  lib.ash = f.addMovie({ title: 'Ashfall', rating: 'PG', year: 1986, guids: ['imdb://tt0078748', 'tmdb://348', 'tvdb://77'], labels: ['space', 'Alien'], studio: 'Brandywine', audienceRating: 7.9 });
  Object.assign(f.items.get(lib.ash)!, {
    tagline: 'In space no one hears', originalTitle: 'Cendres', originallyAvailableAt: '1986-07-18', rating: 8.8,
    ratingImage: 'rottentomatoes://image.rating.ripe', audienceRatingImage: 'rottentomatoes://image.rating.upright', Country: [{ id: 91, tag: 'United States of America' }],
  });
  lib.eins = f.addMovie({ title: 'Eins', rating: 'PG', year: 1979, guids: ['tmdb://100'] });
  f.items.get(lib.eins)!.originallyAvailableAt = '1979-05-25';
  lib.drei = f.addMovie({ title: 'Drei', rating: 'R', year: 1997, guids: ['tmdb://300'] }); // above a kids cap of 12
  f.items.get(lib.drei)!.originallyAvailableAt = '1997-11-26';
  lib.undated = f.addMovie({ title: 'Ohne Datum', rating: 'PG', year: 1990 }); // no premiere date, no ids
  const priv = f.addSection('Private', 'movie');
  lib.priv = f.addMovie({ title: 'Privat', rating: 'PG', year: 1980, sectionId: priv, guids: ['tmdb://150'] });
  f.items.get(lib.priv)!.originallyAvailableAt = '1980-01-01';
  // Plex's own collection order is not the release order
  lib.coll = f.addCollection('Ashfall Sammlung', [lib.drei, lib.undated, lib.ash, lib.priv, lib.eins]);
  lib.onlyDrei = f.addCollection('Nur Drei', [lib.drei]);
  // legacy agent: the ids live in the item's own guid, the rating has no image
  lib.legacy = f.addMovie({ title: 'Altbestand', rating: 'PG', year: 1985 });
  Object.assign(f.items.get(lib.legacy)!, { guid: 'com.plexapp.agents.imdb://tt0090605?lang=en', rating: 7.4 });
  lib.legacyTmdb = f.addMovie({ title: 'Legacy Teil', rating: 'PG', year: 1999 });
  f.items.get(lib.legacyTmdb)!.guid = 'com.plexapp.agents.themoviedb://555?lang=de';
  lib.bare = f.addMovie({ title: 'Ohne Ids', rating: 'PG', year: 2001 });
}

describe('PlexMediaServer.itemAbout / itemCollections', () => {
  let e: PlexEnv;
  let admin: MediaUser, kid: MediaUser, moviesOnly: MediaUser;
  beforeAll(async () => {
    e = await plexEnv(seed);
    admin = await identity(e.ms, 'admin');
    kid = await identity(e.ms, 'admin', kids(12));
    moviesOnly = await identity(e.ms, { ...DEFAULT_ROLES.friend!, libraries: ['Movies'] });
  });
  afterAll(() => e.close());

  it('itemAbout: tagline, original title, premiere, countries, studios, labels, provider ids, RT critic + audience', async () => {
    expect(await e.ms.itemAbout(admin, item(lib.ash!))).toEqual({
      type: 'Movie', providerIds: { imdb: 'tt0078748', tmdb: '348', tvdb: '77' }, tagline: 'In space no one hears', originalTitle: 'Cendres',
      premiereDate: '1986-07-18', countries: ['United States of America'], studios: ['Brandywine'], tags: ['space', 'Alien'], communityRating: 7.9, criticRating: 88,
    });
  });

  it('itemAbout: legacy agent guid -> ids; rating without image -> community; missing ids -> {}', async () => {
    expect(await e.ms.itemAbout(admin, item(lib.legacy!))).toMatchObject({ providerIds: { imdb: 'tt0090605' }, communityRating: 7.4 });
    expect((await e.ms.itemAbout(admin, item(lib.legacy!))).criticRating).toBeUndefined();
    expect((await e.ms.itemAbout(admin, item(lib.legacyTmdb!))).providerIds).toEqual({ tmdb: '555' });
    expect((await e.ms.itemAbout(admin, item(lib.bare!))).providerIds).toEqual({});
    expect((await e.ms.itemAbout(admin, item(3))).type).toBe('Series');
  });

  it('itemAbout: 404 for hidden (age cap, library), unknown and non-item ids', async () => {
    for (const [u, id] of [[kid, item(lib.drei!)], [moviesOnly, item(lib.priv!)], [admin, item(424242)], [admin, section(1)]] as const) {
      await expect(e.ms.itemAbout(u, id)).rejects.toMatchObject({ status: 404 });
    }
  });

  it('itemCollections: release order (premiere date, year, title), tmdb ids, the collection id and name', async () => {
    const c = await e.ms.itemCollections(admin, item(lib.ash!));
    expect(c.map((x) => x.name)).toEqual(['Ashfall Sammlung']);
    expect(c[0]!.id).toBe(item(lib.coll!));
    expect(c[0]!.parts.map((p) => [p.item.name, p.tmdbId])).toEqual([['Eins', '100'], ['Privat', '150'], ['Ashfall', '348'], ['Drei', '300'], ['Ohne Datum', undefined]]);
    expect(c[0]!.parts.every((p) => !('tmdbId' in p) || typeof p.tmdbId === 'string')).toBe(true);
    expect((await e.ms.itemCollections(admin, item(lib.drei!))).map((x) => x.name)).toEqual(['Ashfall Sammlung', 'Nur Drei']);
    expect(await e.ms.itemCollections(admin, item(lib.bare!))).toEqual([]);
  });

  it('kids: parts above the cap are omitted (never reported); a collection without a visible part does not exist', async () => {
    const c = await e.ms.itemCollections(kid, item(lib.ash!));
    expect(c[0]!.parts.map((p) => p.item.name)).toEqual(['Eins', 'Privat', 'Ashfall', 'Ohne Datum']);
    expect(JSON.stringify(c)).not.toContain('Drei');
    expect(await e.ms.itemCollections(kid, item(lib.drei!))).toEqual([]); // the item itself is hidden
    expect(await e.ms.itemCollections(kid, item(lib.eins!))).toHaveLength(1);
  });

  it('role libraries: a part in a library the role lacks is omitted', async () => {
    const c = await e.ms.itemCollections(moviesOnly, item(lib.ash!));
    expect(c[0]!.parts.map((p) => p.item.name)).toEqual(['Eins', 'Ashfall', 'Drei', 'Ohne Datum']);
  });

  it('parts carry the viewer\'s own user data (played)', async () => {
    await e.ms.setPlayed(admin, item(lib.eins!), true);
    const c = await e.ms.itemCollections(admin, item(lib.ash!));
    expect(c[0]!.parts.find((p) => p.item.name === 'Eins')!.item.played).toBe(true);
    expect((await e.ms.itemCollections(kid, item(lib.ash!)))[0]!.parts.find((p) => p.item.name === 'Eins')!.item.played).toBe(false);
  });

  it('findByTmdb also finds a legacy-agent movie', async () => {
    expect(await e.ms.findByTmdb(555, 'movie')).toEqual({ id: item(lib.legacyTmdb!), name: 'Legacy Teil' });
    expect(await e.ms.findByTmdb(348, 'movie')).toEqual({ id: item(lib.ash!), name: 'Ashfall' });
    expect(await e.ms.findByTmdb(555, 'tv')).toBeNull();
  });
});

// ---------------------------------------------------------------- behind the routes (MEDIA_SERVER=plex)

type Sess = { cookies: Record<string, string>; csrf: string };
const TMDB_KEY = 'tmdbkey-plex-test-123456', OMDB_KEY = 'omdbkey-plex-7890';
const ext: Record<string, Handler> = {
  'GET /3/movie/348': () => ({ json: { imdb_id: 'tt0078748', belongs_to_collection: { id: 10, name: 'Ashfall Collection' }, keywords: { keywords: [{ name: 'alien' }, { name: 'xenomorph' }] } } }),
  'GET /3/collection/10': () => ({ json: { id: 10, name: 'Ashfall Collection', parts: [
    { id: 300, title: 'Drei', release_date: '1997-11-26' }, { id: 100, title: 'Eins', release_date: '1979-05-25' }, { id: 348, title: 'Ashfall', release_date: '1986-07-18' },
    { id: 200, title: 'Vier', release_date: '1992-05-22', poster_path: '/abcdefg.jpg' }, { id: 555, title: 'Legacy Teil', release_date: '1999-01-01' },
  ] } }),
  'GET /': () => ({ json: { Response: 'True', imdbRating: '8.1', Ratings: [{ Source: 'Internet Movie Database', Value: '8.1/10' }, { Source: 'Rotten Tomatoes', Value: '92%' }, { Source: 'Metacritic', Value: '81/100' }] } }),
};
const extCalls: Call[] = [];

describe('GET /api/items/:id/about on Plex', () => {
  let env: TestEnv;
  let owner: Sess;
  let kidPid = '';
  const bodies: string[] = [];
  const fake = new PlexFake();
  seed(fake);
  const call = async (s: Sess, method: string, url: string, body?: unknown) => {
    const r = await env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
    bodies.push(r.body, JSON.stringify(r.headers));
    return r;
  };
  const about = async (s: Sess, rk: string) => {
    const r = await call(s, 'GET', `/api/items/${item(rk)}/about`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  };
  const names = (b: { collection: { parts: Array<{ name: string }> } | null }) => b.collection?.parts.map((p) => p.name);
  const sid = (r: { cookies: Array<{ name: string; value: string }> }) => r.cookies.find((c) => c.name === 'ff_sid')!.value;
  /** runs fn as the kids profile, then switches the device back to the owner profile */
  const asKid = async <T>(fn: (kid: Sess) => Promise<T>): Promise<T> => {
    const sel = await call(owner, 'POST', `/api/profiles/${kidPid}/select`, {});
    expect(sel.statusCode, sel.body).toBe(200);
    const kid: Sess = { cookies: { ff_sid: sid(sel) }, csrf: owner.csrf };
    try { return await fn(kid); } finally {
      const ownerPid = (await env.pool.query<{ id: string }>("select p.id from profiles p join users u on u.id=p.user_id where u.authentik_sub='sub-admin' and p.is_owner")).rows[0]!.id;
      const back = await call(kid, 'POST', `/api/profiles/${ownerPid}/select`, {});
      expect(back.statusCode, back.body).toBe(200);
      owner = { cookies: { ff_sid: sid(back) }, csrf: owner.csrf };
    }
  };

  beforeAll(async () => {
    env = await makeEnv({}, { server: 'plex', plexFake: fake, ctxPatch: (c) => { c.fetchImpl = fakeHttp(ext, extCalls); } });
    owner = await env.login();
    const p = await call(owner, 'POST', '/api/profiles', { name: 'Mia', kids: true, maxRating: 12 });
    expect(p.statusCode, p.body).toBe(201);
    kidPid = p.json().profile.id;
  });
  afterAll(async () => {
    for (const b of bodies) {
      expect(b).not.toContain(PLEX_TOKEN);
      expect(b).not.toContain(PLEX_URL);
      expect(b).not.toContain('X-Plex-Token');
      expect(b).not.toContain(TMDB_KEY);
      expect(b).not.toContain(OMDB_KEY);
    }
    await env.close();
  });
  beforeEach(async () => {
    for (const n of ['tmdb', 'omdb'] as const) { await removeSourceKey(env.ctx, n); await resetSourceState(env.ctx, n); }
    for (const k of await env.kv.keys('about:')) await env.kv.del(k);
    extCalls.length = 0;
  });

  it('no keys: Plex ratings, facts, links and the Plex collection in release order; sources [media server]', async () => {
    const b = await about(owner, lib.ash!);
    expect(b.ratings).toEqual([{ key: 'community', value: 7.9, max: 10, from: 'jellyfin' }, { key: 'critic', value: 88, max: 100, from: 'jellyfin' }]);
    expect(b).toMatchObject({ tagline: 'In space no one hears', originalTitle: 'Cendres', releaseDate: '1986-07-18', studios: ['Brandywine'], tags: ['space', 'Alien'],
      countries: ['United States of America'], keywords: [], sources: ['jellyfin'], canRequest: true });
    expect(b.links.map((l: { kind: string }) => l.kind)).toEqual(['imdb', 'tmdb', 'tvdb', 'trakt']);
    expect(b.collection).toMatchObject({ name: 'Ashfall Sammlung', from: 'jellyfin' });
    expect(names(b)).toEqual(['Eins', 'Privat', 'Ashfall', 'Drei', 'Ohne Datum']);
    expect(b.collection.parts.find((p: { current: boolean }) => p.current).id).toBe(item(lib.ash!));
    expect(extCalls).toHaveLength(0);
  });

  it('legacy agent item: IMDb link from com.plexapp.agents.imdb, community rating, no collection', async () => {
    const b = await about(owner, lib.legacy!);
    expect(b.links).toEqual([{ kind: 'imdb', url: 'https://www.imdb.com/title/tt0090605/' }, { kind: 'trakt', url: 'https://trakt.tv/search/imdb/tt0090605' }]);
    expect(b.ratings).toEqual([{ key: 'community', value: 7.4, max: 10, from: 'jellyfin' }]);
    expect(b.collection).toBeNull();
  });

  it('series: tvdb link from the Guid, no collection lookup', async () => {
    const spy = vi.spyOn(env.plex!.ms, 'itemCollections');
    try {
      const b = await about(owner, '3');
      expect(b.links).toContainEqual({ kind: 'tvdb', url: 'https://www.thetvdb.com/dereferrer/series/370160' });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('with TMDB + OMDb: TMDB order, a missing part, the legacy-agent copy found in the library, OMDb ratings replace the critic score', async () => {
    await setSourceKey(env.ctx, 'tmdb', TMDB_KEY);
    await setSourceKey(env.ctx, 'omdb', OMDB_KEY);
    const b = await about(owner, lib.ash!);
    expect(b.collection.name).toBe('Ashfall Sammlung'); // shares >= 2 parts with the TMDB collection
    expect(names(b)).toEqual(['Eins', 'Ashfall', 'Vier', 'Drei', 'Legacy Teil', 'Privat', 'Ohne Datum']);
    expect(b.collection.parts.find((p: { name: string }) => p.name === 'Vier')).toMatchObject({ inLibrary: false, poster: '/api/seerr/image/abcdefg.jpg', from: 'tmdb' });
    expect(b.collection.parts.find((p: { name: string }) => p.name === 'Legacy Teil')).toMatchObject({ id: item(lib.legacyTmdb!), inLibrary: true });
    expect(b.ratings.map((r: { key: string }) => r.key)).toEqual(['community', 'imdb', 'rt', 'mc']);
    expect(b.keywords).toEqual(['xenomorph']);
    expect(b.sources).toEqual(['jellyfin', 'tmdb', 'omdb']);
    expect(extCalls.find((c) => c.path === '/')!.search).toContain('i=tt0078748');
  });

  it('kids profile: hidden item 404 before any collection or external lookup; parts above the cap and missing parts absent', async () => {
    await setSourceKey(env.ctx, 'tmdb', TMDB_KEY);
    const spy = vi.spyOn(env.plex!.ms, 'itemCollections');
    try {
      await asKid(async (kid) => {
        const r = await call(kid, 'GET', `/api/items/${item(lib.drei!)}/about`);
        expect(r.statusCode).toBe(404);
        expect(r.body).not.toContain('Drei');
        expect(spy).not.toHaveBeenCalled();
        expect(extCalls).toHaveLength(0);
        const b = await about(kid, lib.ash!);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(names(b)).toEqual(['Eins', 'Ashfall', 'Legacy Teil', 'Privat', 'Ohne Datum']);
        expect(b.collection.parts.every((p: { inLibrary: boolean }) => p.inLibrary)).toBe(true);
        expect(b.canRequest).toBe(false);
        expect(b.ratings.map((x: { key: string }) => x.key)).not.toContain('friends');
      });
    } finally { spy.mockRestore(); }
  });

  it('unknown id 404, no session 401, bad id 400', async () => {
    expect((await call(owner, 'GET', `/api/items/${item(424242)}/about`)).statusCode).toBe(404);
    expect((await env.app.inject({ url: `/api/items/${item(lib.ash!)}/about` })).statusCode).toBe(401);
    expect((await call(owner, 'GET', '/api/items/nothex/about')).statusCode).toBe(400);
  });

  it('Data sources admin API works unchanged on Plex and never returns a key', async () => {
    const put = await call(owner, 'PUT', '/api/admin/sources/tmdb', { key: TMDB_KEY });
    expect(put.statusCode, put.body).toBeLessThan(300);
    const list = await call(owner, 'GET', '/api/admin/sources');
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain(TMDB_KEY.slice(-4));
    const del = await call(owner, 'DELETE', '/api/admin/sources/tmdb');
    expect(del.statusCode).toBeLessThan(300);
  });
});
