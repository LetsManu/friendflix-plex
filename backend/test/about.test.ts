import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ABOUT_LIMITS, buildLinks } from '../src/about.js';
import { encrypt } from '../src/crypto.js';
import { removeSourceKey, resetSourceState, setSourceKey } from '../src/sources/keys.js';
import { ADMIN, fakeHttp, makeEnv, type Call, type Handler, type TestEnv } from './helpers.js';

/** Block 21 T4: GET /api/items/:id/about (fake Jellyfin + fake TMDB/OMDb behind ctx.fetchImpl). */
type Sess = { cookies: Record<string, string>; csrf: string };
const id = (c: string) => c.repeat(32);
const MOV = id('a'), PA = id('b'), PC = id('c'), HIDLIB = id('d'), MOV2 = id('e'), INVIS = id('f'), B1 = id('1');
// fix round 1: a user-made box set, a hidden duplicate copy of the current item, a second version of a box set part
const MOV3 = id('7'), X1 = id('8'), B2 = id('2'), DUP = id('3'), CUR = id('4'), PA2 = id('5');
const TMDB_KEY = 'tmdbkey-secret-123456', OMDB_KEY = 'omdbkey-secret-7890';

const raw: Record<string, Record<string, unknown>> = {
  [MOV]: {
    Id: MOV, Name: 'Ashfall', Type: 'Movie', ProductionYear: 1986, PremiereDate: '1986-07-18T00:00:00.0000000Z', Taglines: ['In space no one hears'],
    OriginalTitle: 'ASHFALL', ProductionLocations: ['USA'], Studios: [{ Name: 'Brandywine' }], Tags: ['space', 'Alien'],
    ProviderIds: { Imdb: 'tt0078748', Tmdb: '348', Tvdb: '77' }, CommunityRating: 7.9, CriticRating: 88,
  },
  [PA]: { Id: PA, Name: 'Eins', Type: 'Movie', ProductionYear: 1979, PremiereDate: '1979-05-25T00:00:00Z', ProviderIds: { Tmdb: '100' } },
  [PC]: { Id: PC, Name: 'Drei', Type: 'Movie', ProductionYear: 1997, PremiereDate: '1997-11-26T00:00:00Z', ProviderIds: { Tmdb: '300' } },
  [HIDLIB]: { Id: HIDLIB, Name: 'Versteckt', Type: 'Movie', ProductionYear: 1992, ProviderIds: { Tmdb: '200' } },
  [MOV2]: { Id: MOV2, Name: 'Zweiter', Type: 'Movie', OriginalTitle: 'Der Zweite', ProviderIds: { Tmdb: '349' }, CriticRating: 70 },
  [INVIS]: { Id: INVIS, Name: 'Unsichtbar', Type: 'Movie', ProviderIds: { Imdb: 'tt0000001' } },
  [B1]: { Id: B1, Name: 'Ashfall Sammlung', Type: 'BoxSet' },
  [PA2]: { Id: PA2, Name: 'Eins (4K)', Type: 'Movie', ProductionYear: 1979, PremiereDate: '1979-05-25T00:00:00Z', ProviderIds: { Tmdb: '100' } },
  [MOV3]: { Id: MOV3, Name: 'Dritter', Type: 'Movie', ProductionYear: 2001, ProviderIds: { Tmdb: '350' } },
  [X1]: { Id: X1, Name: 'Lieblingsfilm', Type: 'Movie', ProductionYear: 2010, ProviderIds: { Tmdb: '999' } },
  [B2]: { Id: B2, Name: 'Favoriten', Type: 'BoxSet' },
  // listed before CUR: findByTmdb(360) answers with this (hidden) copy first
  [DUP]: { Id: DUP, Name: 'Aktuell (4K)', Type: 'Movie', ProviderIds: { Tmdb: '360' } },
  [CUR]: { Id: CUR, Name: 'Aktuell', Type: 'Movie', ProductionYear: 2003, ProviderIds: { Tmdb: '360' } },
};
const members: Record<string, string[]> = { [B1]: [PA, PA2, MOV, PC], [B2]: [MOV3, X1] };
/** in a library no viewer's role has */
const GLOBAL_HIDDEN = new Set([HIDLIB, INVIS, DUP]);
/** above the kids profile's age cap */
const KID_HIDDEN = new Set([PC]);
let kidJf = '';
let libHasPart3 = false;
const hidden = (uid: string | null, item: string) => GLOBAL_HIDDEN.has(item) || (uid === kidJf && KID_HIDDEN.has(item));

const jellyfin: Record<string, Handler> = {
  'GET /Items/[0-9a-f]{32}': (u) => {
    const i = u.pathname.split('/')[2]!;
    return raw[i] && !hidden(u.searchParams.get('userId'), i) ? { json: raw[i] } : { status: 404 };
  },
  'GET /Items': (u) => {
    const uid = u.searchParams.get('userId');
    const ids = (u.searchParams.get('ids') ?? '').split(',').filter(Boolean);
    const parent = u.searchParams.get('parentId');
    if (!uid) { // admin key
      const any = u.searchParams.get('anyProviderIdEquals');
      if (any) {
        const t = any.replace('tmdb.', '');
        const hit = Object.values(raw).find((r) => (r.ProviderIds as { Tmdb?: string } | undefined)?.Tmdb === t && (r.Id !== HIDLIB || libHasPart3));
        return { json: { Items: hit ? [{ Id: hit.Id, Name: hit.Name }] : [] } };
      }
      if (u.searchParams.get('includeItemTypes') === 'BoxSet') return { json: { Items: Object.keys(members).map((b) => ({ Id: b })) } };
      if (parent) return { json: { Items: (members[parent] ?? []).map((c) => ({ Id: c })) } };
      return { json: { Items: [] } };
    }
    if (ids.length) return { json: { Items: ids.filter((i) => raw[i] && !hidden(uid, i)).map((i) => raw[i]) } };
    if (parent) return { json: { Items: (members[parent] ?? []).filter((c) => !hidden(uid, c)).map((c) => raw[c]) } };
    return { json: { Items: [] } };
  },
};

// ---- external sources
let tmdbMode: 'ok' | '500' | 'timeout' = 'ok';
let omdbMode: 'ok' | '401' = 'ok';
const ext: Record<string, Handler> = {
  'GET /3/movie/348': () => ({ json: { imdb_id: 'tt0078748', belongs_to_collection: { id: 10, name: 'Ashfall Collection' }, keywords: { keywords: [{ name: 'alien' }, { name: 'Space' }, { name: 'xenomorph' }, { name: 'Xenomorph' }] } } }),
  'GET /3/movie/349': () => ({ json: { imdb_id: 'tt0090605', keywords: { keywords: [] } } }),
  'GET /3/collection/10': () => ({ json: { id: 10, name: 'Ashfall Collection', parts: [
    { id: 300, title: 'Drei', release_date: '1997-11-26' },
    { id: 100, title: 'Eins', release_date: '1979-05-25' },
    { id: 348, title: 'Ashfall', release_date: '1986-07-18' },
    { id: 200, title: 'Vier', release_date: '1992-05-22', poster_path: '/abcdefg.jpg' },
  ] } }),
  'GET /3/movie/350': () => ({ json: { belongs_to_collection: { id: 20, name: 'Dritter Collection' }, keywords: { keywords: [] } } }),
  'GET /3/collection/20': () => ({ json: { id: 20, name: 'Dritter Collection', parts: [
    { id: 350, title: 'Dritter', release_date: '2001-01-01' }, { id: 351, title: 'Dritter II', release_date: '2005-01-01', poster_path: '/dritter2.jpg' },
  ] } }),
  'GET /3/movie/360': () => ({ json: { belongs_to_collection: { id: 30, name: 'Aktuell Collection' }, keywords: { keywords: [] } } }),
  'GET /3/collection/30': () => ({ json: { id: 30, name: 'Aktuell Collection', parts: [
    { id: 360, title: 'Aktuell', release_date: '2003-01-01' }, { id: 361, title: 'Aktuell II', release_date: '2006-01-01' },
  ] } }),
  'GET /': () => (omdbMode === '401' ? { status: 401, json: { Response: 'False' } } : {
    json: { Response: 'True', imdbRating: '8.1', Ratings: [{ Source: 'Internet Movie Database', Value: '8.1/10' }, { Source: 'Rotten Tomatoes', Value: '92%' }, { Source: 'Metacritic', Value: '81/100' }] },
  }),
};
const extCalls: Call[] = [];
const extFetch = fakeHttp(ext, extCalls);
const fetchImpl = ((u: RequestInfo | URL, init?: RequestInit) => {
  const s = String(u);
  if (new URL(s).hostname === 'api.themoviedb.org') {
    if (tmdbMode === 'timeout') { extCalls.push({ method: 'GET', path: new URL(s).pathname, search: '', body: undefined }); return Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })); }
    if (tmdbMode === '500') { extCalls.push({ method: 'GET', path: new URL(s).pathname, search: '', body: undefined }); return Promise.resolve(new Response('{}', { status: 500 })); }
  }
  return extFetch(u, init);
}) as typeof fetch;

let env: TestEnv;
let owner: Sess, bea: Sess;
let kidPid = '';
let beaId = '';
const call = (s: Sess, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
const about = async (s: Sess, item = MOV) => {
  const r = await call(s, 'GET', `/api/items/${item}/about`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const keys = async (tmdb: boolean, omdb: boolean) => {
  if (tmdb) await setSourceKey(env.ctx, 'tmdb', TMDB_KEY);
  if (omdb) await setSourceKey(env.ctx, 'omdb', OMDB_KEY);
};
const omdbCalls = () => extCalls.filter((c) => c.path === '/');
const tmdbCalls = () => extCalls.filter((c) => c.path.startsWith('/3/'));

beforeAll(async () => {
  env = await makeEnv(jellyfin, { ctxPatch: (c) => { c.fetchImpl = fetchImpl; } });
  owner = await env.login(ADMIN);
  await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-b','b@example.com','Bea','friend','jfbea','Bea',$1)", [encrypt(env.ctx.encKey, 'pw')]);
  bea = await env.login({ sub: 'sub-b', email: 'b@example.com', name: 'Bea', groups: [] });
  const ownerId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub='sub-admin'")).rows[0]!.id;
  beaId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub='sub-b'")).rows[0]!.id;
  await env.pool.query("insert into ratings(user_id,item_id,item_name,stars) values ($1,$3,'Ashfall',5),($2,$3,'Ashfall',4)", [ownerId, beaId, MOV]);
  const p = await call(owner, 'POST', '/api/profiles', { name: 'Mia', kids: true, maxRating: 12 });
  expect(p.statusCode, p.body).toBe(201);
  const pid = p.json().profile.id as string;
  kidJf = (await env.pool.query<{ j: string }>('select jellyfin_user_id j from profiles where id=$1', [pid])).rows[0]!.j;
  kidPid = pid;
});
afterAll(() => env.close());
beforeEach(async () => {
  for (const n of ['tmdb', 'omdb'] as const) { await removeSourceKey(env.ctx, n); await resetSourceState(env.ctx, n); }
  await env.kv.del(`src:omdb:calls:${new Date().toISOString().slice(0, 10)}`);
  extCalls.length = 0;
  for (const k of await env.kv.keys('about:')) await env.kv.del(k);
  tmdbMode = 'ok'; omdbMode = 'ok'; libHasPart3 = false;
  await env.pool.query("update users set role='admin' where authentik_sub='sub-admin'");
  await env.pool.query("update users set role='friend' where authentik_sub='sub-b'");
  await env.pool.query('delete from role_settings');
});

describe('GET /api/items/:id/about', () => {
  it('no keys: ratings community + critic + friends, tagline, studios, tags, countries, links imdb/tmdb/trakt, collection from BoxSet, sources [jellyfin]', async () => {
    const b = await about(owner);
    expect(b.ratings).toEqual([
      { key: 'community', value: 7.9, max: 10, from: 'jellyfin' },
      { key: 'critic', value: 88, max: 100, from: 'jellyfin' },
      { key: 'friends', value: 4.5, max: 5, from: 'friends' },
    ]);
    expect(b).toMatchObject({ tagline: 'In space no one hears', releaseDate: '1986-07-18', studios: ['Brandywine'], tags: ['space', 'Alien'], countries: ['USA'], keywords: [], canRequest: true, sources: ['jellyfin'] });
    expect(b.originalTitle).toBeUndefined(); // same as the name, case-insensitive
    expect(b.links.map((l: { kind: string }) => l.kind)).toEqual(['imdb', 'tmdb', 'tvdb', 'trakt']);
    expect(b.links).toContainEqual({ kind: 'trakt', url: 'https://trakt.tv/search/imdb/tt0078748' });
    expect(b.links).toContainEqual({ kind: 'tmdb', url: 'https://www.themoviedb.org/movie/348' });
    expect(b.collection.from).toBe('jellyfin');
    expect(b.collection.name).toBe('Ashfall Sammlung');
    expect(b.collection.parts.map((p: { name: string }) => p.name)).toEqual(['Eins', 'Ashfall', 'Drei']);
    expect(b.collection.parts.find((p: { current: boolean }) => p.current).id).toBe(MOV);
    expect(extCalls).toHaveLength(0);
  });

  it('with TMDB: collection has 4 parts in TMDB order, part 3 missing with poster /api/seerr/image/…, keywords present, sources includes tmdb', async () => {
    await keys(true, false);
    const b = await about(owner);
    const parts = b.collection.parts;
    expect(parts.map((p: { name: string }) => p.name)).toEqual(['Eins', 'Ashfall', 'Vier', 'Drei']);
    expect(parts[2]).toEqual({ tmdbId: 200, name: 'Vier', year: 1992, poster: '/api/seerr/image/abcdefg.jpg', image: true, played: false, current: false, inLibrary: false, from: 'tmdb' });
    expect(parts[1]).toMatchObject({ id: MOV, current: true, inLibrary: true, tmdbId: 348 });
    expect(b.collection.from).toBe('tmdb');
    expect(b.keywords).toEqual(['xenomorph']); // alien/Space are tags already; duplicates dropped
    expect(b.sources).toEqual(['jellyfin', 'tmdb']);
  });

  it('with OMDb: imdb 8.1, rt 92, mc 81; Jellyfin critic dropped; OMDb looked up with the IMDb id from TMDB when Jellyfin has none', async () => {
    await keys(true, true);
    const b = await about(owner);
    expect(b.ratings.map((r: { key: string }) => r.key)).toEqual(['community', 'imdb', 'rt', 'mc', 'friends']);
    expect(b.ratings).toContainEqual({ key: 'imdb', value: 8.1, max: 10, from: 'omdb' });
    expect(b.ratings).toContainEqual({ key: 'rt', value: 92, max: 100, from: 'omdb' });
    expect(b.ratings).toContainEqual({ key: 'mc', value: 81, max: 100, from: 'omdb' });
    expect(b.sources).toEqual(['jellyfin', 'tmdb', 'omdb']);
    expect(omdbCalls()[0]!.search).toContain('i=tt0078748');
    const b2 = await about(owner, MOV2);
    expect(omdbCalls().at(-1)!.search).toContain('i=tt0090605');
    expect(b2.ratings.map((r: { key: string }) => r.key)).toEqual(['imdb', 'rt', 'mc']);
    expect(b2.originalTitle).toBe('Der Zweite');
    expect(b2.collection).toBeNull();
  });

  for (const mode of ['timeout', '500'] as const) {
    it(`TMDB ${mode} → 200 without TMDB parts`, async () => {
      await keys(true, false);
      tmdbMode = mode;
      const b = await about(owner);
      expect(tmdbCalls().length).toBeGreaterThan(0);
      expect(b.collection.parts.map((p: { name: string }) => p.name)).toEqual(['Eins', 'Ashfall', 'Drei']);
      expect(b.keywords).toEqual([]);
      expect(b.sources).toEqual(['jellyfin']);
    });
  }

  it('OMDb 401 → 200 without OMDb ratings (critic kept)', async () => {
    await keys(false, true);
    omdbMode = '401';
    const b = await about(owner);
    expect(omdbCalls()).toHaveLength(1);
    expect(b.ratings.map((r: { key: string }) => r.key)).toEqual(['community', 'critic', 'friends']);
    expect(b.sources).toEqual(['jellyfin']);
  });

  it('kids profile: no friends rating, no missing parts, canRequest false, parts above the age cap absent', async () => {
    await keys(true, false);
    // a device that picks a kids profile stays on it: switch there and back on the owner's device
    const sid = (r: { cookies: Array<{ name: string; value: string }> }) => r.cookies.find((c) => c.name === 'ff_sid')!.value;
    const sel = await call(owner, 'POST', `/api/profiles/${kidPid}/select`, {});
    expect(sel.statusCode, sel.body).toBe(200);
    const kid: Sess = { cookies: { ff_sid: sid(sel) }, csrf: owner.csrf };
    let b;
    try { b = await about(kid); } finally {
      const ownerPid = (await env.pool.query<{ id: string }>("select p.id from profiles p join users u on u.id=p.user_id where u.authentik_sub='sub-admin' and p.is_owner")).rows[0]!.id;
      const back = await call(kid, 'POST', `/api/profiles/${ownerPid}/select`, {});
      expect(back.statusCode, back.body).toBe(200);
      owner = { cookies: { ff_sid: sid(back) }, csrf: owner.csrf };
    }
    expect(b.ratings.map((r: { key: string }) => r.key)).toEqual(['community', 'critic']);
    expect(b.canRequest).toBe(false);
    expect(b.collection.parts.map((p: { name: string }) => p.name)).toEqual(['Eins', 'Ashfall']);
    expect(b.collection.parts.every((p: { inLibrary: boolean }) => p.inLibrary)).toBe(true);
    expect(JSON.stringify(b)).not.toContain('Drei');
  });

  it('role with requests_per_month 0 → canRequest false; friend role → true', async () => {
    expect((await about(bea)).canRequest).toBe(true);
    await env.pool.query("insert into role_settings(role, requests_per_month) values ('friend', 0)");
    expect((await about(bea)).canRequest).toBe(false);
    expect((await about(owner)).canRequest).toBe(true); // admin: unlimited
  });

  it('TMDB part that is in the library but in a library the viewer\'s role lacks → omitted, not missing', async () => {
    await keys(true, false);
    libHasPart3 = true;
    const b = await about(owner);
    expect(b.collection.parts.map((p: { name: string }) => p.name)).toEqual(['Eins', 'Ashfall', 'Drei']);
    expect(b.collection.parts.every((p: { inLibrary: boolean }) => p.inLibrary)).toBe(true);
    expect(JSON.stringify(b)).not.toContain('Vier');
    expect(JSON.stringify(b)).not.toContain('Versteckt');
  });

  it('cache shared: two different users → one TMDB fetch per resource, one OMDb fetch', async () => {
    await keys(true, true);
    await about(owner);
    await about(bea);
    expect(tmdbCalls().filter((c) => c.path === '/3/movie/348')).toHaveLength(1);
    expect(tmdbCalls().filter((c) => c.path === '/3/collection/10')).toHaveLength(1);
    expect(omdbCalls()).toHaveLength(1);
  });

  it('invisible item → 404 and no collection lookup; no session → 401; response body never contains a stored key', async () => {
    await keys(true, true);
    const before = env.jfCalls.length;
    const r = await call(owner, 'GET', `/api/items/${INVIS}/about`);
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('Unsichtbar');
    expect(env.jfCalls.slice(before).some((c) => c.search.includes('parentId='))).toBe(false); // itemCollections never ran
    expect(extCalls).toHaveLength(0);
    expect((await env.app.inject({ url: `/api/items/${MOV}/about` })).statusCode).toBe(401);
    expect((await call(owner, 'GET', '/api/items/nothex/about')).statusCode).toBe(400);
    const ok = await call(owner, 'GET', `/api/items/${MOV}/about`);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).not.toContain(TMDB_KEY);
    expect(ok.body).not.toContain(OMDB_KEY);
    expect(ok.body).not.toContain('themoviedb.org/3');
  });
});

describe('fix round 1: collection edge cases', () => {
  const names = (b: { collection: { parts: Array<{ name: string }> } | null }) => b.collection?.parts.map((p) => p.name);

  it('a user-made box set that shares only the current item with the TMDB collection neither names the row nor adds parts', async () => {
    await keys(true, false);
    const b = await about(owner, MOV3);
    expect(b.collection.name).toBe('Dritter Collection');
    expect(names(b)).toEqual(['Dritter', 'Dritter II']);
    expect(JSON.stringify(b)).not.toContain('Favoriten');
    expect(JSON.stringify(b)).not.toContain('Lieblingsfilm');
  });

  it('the current item stands for its own TMDB part, even when findByTmdb answers with another (hidden) copy', async () => {
    await keys(true, false);
    const b = await about(owner, CUR);
    expect(names(b)).toEqual(['Aktuell', 'Aktuell II']);
    expect(b.collection.parts[0]).toMatchObject({ id: CUR, current: true, inLibrary: true });
    expect(JSON.stringify(b)).not.toContain(DUP);
  });

  it('a second version of a box set part (same TMDB id) is listed once, with and without TMDB', async () => {
    expect(names(await about(owner))).toEqual(['Eins', 'Ashfall', 'Drei']);
    await keys(true, false);
    expect(names(await about(owner))).toEqual(['Eins', 'Ashfall', 'Vier', 'Drei']);
  });

  it('library lookups of TMDB parts are kv-cached across requests and viewers; visibility is still checked per viewer', async () => {
    await keys(true, false);
    const lookups = () => env.jfCalls.filter((c) => c.search.includes('anyProviderIdEquals=tmdb.361')).length;
    const before = lookups();
    await about(owner, CUR);
    await about(bea, CUR);
    expect(lookups() - before).toBe(1);
    libHasPart3 = true; // a cached "in the library" answer still goes through the viewer's item(): hidden → omitted
    await about(owner);
    const b = await about(bea);
    expect(names(b)).toEqual(['Eins', 'Ashfall', 'Drei']);
  });
});

describe('final review fixes', () => {
  const resetIndex = async () => {
    await env.kv.del('jf:boxsets:v1');
    (env.ctx.jf as unknown as { boxsetIndexBuild: null }).boxsetIndexBuild = null;
  };

  it('M2: of two copies of a film in a box set (no TMDB), the one being viewed is kept and marked current', async () => {
    const b = await about(owner, PA2);
    expect(b.collection.parts.map((p: { id: string }) => p.id)).toEqual([PA2, MOV, PC]);
    expect(b.collection.parts[0]).toMatchObject({ id: PA2, current: true });
  });

  it('I1: a slow box-set index does not hold up /about; the build finishes in the background, shared by concurrent requests', async () => {
    await resetIndex();
    const client = (env.ctx.jf as unknown as { client: { adminJson: (p: string) => Promise<unknown> } }).client;
    const orig = client.adminJson.bind(client);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const spy = vi.spyOn(client, 'adminJson').mockImplementation(async (p: string) => {
      if (p.includes('parentId=')) await gate;
      return orig(p);
    });
    const wait = ABOUT_LIMITS.collectionWaitMs;
    ABOUT_LIMITS.collectionWaitMs = 100;
    try {
      const listings = () => env.jfCalls.filter((c) => c.search.includes('includeItemTypes=BoxSet')).length;
      const before = listings();
      const [a, b] = await Promise.all([about(owner), about(bea)]);
      for (const x of [a, b]) {
        expect(x.collection).toBeNull();
        expect(x.ratings.map((r: { key: string }) => r.key)).toContain('community');
        expect(x.tagline).toBe('In space no one hears');
      }
      expect(listings() - before).toBe(1);
      release();
      await vi.waitFor(async () => expect(await env.kv.get('jf:boxsets:v1')).toBeTruthy());
      const c = await about(owner);
      expect(c.collection.parts.map((p: { name: string }) => p.name)).toEqual(['Eins', 'Ashfall', 'Drei']);
      expect(listings() - before).toBe(1);
    } finally {
      release();
      ABOUT_LIMITS.collectionWaitMs = wait;
      spy.mockRestore();
    }
  });
});

describe('buildLinks', () => {
  it("'tt 123', 'tt12', 'abc', '12;x' produce no link", () => {
    for (const v of ['tt 123', 'tt12', 'abc', '12;x', '../1', '1234567890']) {
      expect(buildLinks('Movie', { imdb: v, tmdb: v, tvdb: v })).toEqual([]);
    }
  });
  it('tvdb series vs movie path; trakt from TMDB with id_type; other types get no TMDB/TVDB link', () => {
    expect(buildLinks('Series', { tmdb: '1396', tvdb: '81189' })).toEqual([
      { kind: 'tmdb', url: 'https://www.themoviedb.org/tv/1396' },
      { kind: 'tvdb', url: 'https://www.thetvdb.com/dereferrer/series/81189' },
      { kind: 'trakt', url: 'https://trakt.tv/search/tmdb/1396?id_type=show' },
    ]);
    expect(buildLinks('Movie', { tvdb: '77' })).toEqual([{ kind: 'tvdb', url: 'https://www.thetvdb.com/dereferrer/movie/77' }]);
    expect(buildLinks('Movie', { tmdb: '603' })).toContainEqual({ kind: 'trakt', url: 'https://trakt.tv/search/tmdb/603?id_type=movie' });
    expect(buildLinks('Episode', { imdb: 'tt0959621', tmdb: '62085', tvdb: '349232' })).toEqual([
      { kind: 'imdb', url: 'https://www.imdb.com/title/tt0959621/' },
      { kind: 'trakt', url: 'https://trakt.tv/search/imdb/tt0959621' },
    ]);
  });
});
