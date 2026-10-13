import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeHttp, makeEnv, type Call, type Handler, type TestEnv } from './helpers.js';
import { extFetch } from '../src/sources/fetch.js';
import { getSourceKey, INVALID_KEY, OMDB_COUNT_KEY, PAUSE_KEY, setSourceKey } from '../src/sources/keys.js';
import { omdbRatings } from '../src/sources/omdb.js';
import { tmdbCollection, tmdbTitle } from '../src/sources/tmdb.js';

const V3 = 'v3key-abcdef123456';
const V4 = 'eyJhbGciOi.eyJhdWQiOi.c2lnbmF0dXJl';
let env: TestEnv;
let calls: Call[];
let headers: Array<Record<string, string> | undefined>;

const use = (routes: Record<string, Handler>) => {
  calls = [];
  headers = [];
  const f = fakeHttp(routes, calls);
  env.ctx.fetchImpl = ((u: RequestInfo | URL, init?: RequestInit) => { headers.push(init?.headers as Record<string, string> | undefined); return f(u, init); }) as typeof fetch;
};
const day = () => new Date().toISOString().slice(0, 10);
const movie = { imdb_id: 'tt0133093', belongs_to_collection: { id: 2344, name: 'Matrix Collection' }, keywords: { keywords: Array.from({ length: 30 }, (_, i) => ({ id: i, name: `kw${i}` })) }, external_ids: { imdb_id: 'tt0133093' } };

beforeEach(async () => {
  env = await makeEnv();
  use({});
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await env.close();
});

describe('extFetch / TMDB / OMDb clients', () => {
  it('no key → null and no fetch call', async () => {
    use({ 'GET /3/movie/603': () => ({ json: movie }) });
    expect(await tmdbTitle(env.ctx, 'movie', 603)).toBeNull();
    expect(await omdbRatings(env.ctx, 'tt0133093')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('tmdbTitle parses collection + keywords + imdbId; second call is served from kv', async () => {
    await setSourceKey(env.ctx, 'tmdb', V3);
    use({ 'GET /3/movie/603': () => ({ json: movie }) });
    const a = await tmdbTitle(env.ctx, 'movie', 603);
    expect(a).toMatchObject({ imdbId: 'tt0133093', collection: { id: 2344, name: 'Matrix Collection' } });
    expect(a!.keywords).toHaveLength(20);
    expect(await tmdbTitle(env.ctx, 'movie', 603)).toEqual(a);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.search).toContain('append_to_response=keywords,external_ids');
  });

  it('tv keywords come from keywords.results', async () => {
    await setSourceKey(env.ctx, 'tmdb', V3);
    use({ 'GET /3/tv/1396': () => ({ json: { keywords: { results: [{ name: 'chemistry' }] }, external_ids: { imdb_id: 'tt0903747' } } }) });
    expect(await tmdbTitle(env.ctx, 'tv', 1396)).toEqual({ imdbId: 'tt0903747', keywords: ['chemistry'] });
  });

  it('v3 key goes in api_key query, eyJ… token in the Authorization header', async () => {
    await setSourceKey(env.ctx, 'tmdb', V3);
    use({ 'GET /3/movie/1': () => ({ json: movie }), 'GET /3/movie/2': () => ({ json: movie }) });
    await tmdbTitle(env.ctx, 'movie', 1);
    expect(calls[0]!.search).toContain(`api_key=${V3}`);
    expect(headers[0]?.Authorization).toBeUndefined();
    await setSourceKey(env.ctx, 'tmdb', V4);
    await tmdbTitle(env.ctx, 'movie', 2);
    expect(calls[1]!.search).not.toContain('api_key');
    expect(headers[1]?.Authorization).toBe(`Bearer ${V4}`);
  });

  it('tmdbCollection sorts by release date, drops a poster path with ../', async () => {
    await setSourceKey(env.ctx, 'tmdb', V3);
    use({ 'GET /3/collection/2344': () => ({ json: { id: 2344, name: 'Matrix', parts: [
      { id: 3, title: 'Undated' },
      { id: 2, title: 'Reloaded', release_date: '2003-05-15', poster_path: '/../etc/passwd.jpg' },
      { id: 1, title: 'Matrix', release_date: '1999-03-31', poster_path: '/abcde12345.jpg' },
    ] } }) });
    const c = await tmdbCollection(env.ctx, 2344);
    expect(c!.parts.map((p) => p.tmdbId)).toEqual([1, 2, 3]);
    expect(c!.parts[0]!.posterPath).toBe('/abcde12345.jpg');
    expect(c!.parts[1]!.posterPath).toBeUndefined();
  });

  it('omdbRatings parses imdb/rt/mc, drops N/A; Response False → null cached for 1 h', async () => {
    await setSourceKey(env.ctx, 'omdb', 'omdbkey-12345678');
    use({
      'GET /': (u) => u.searchParams.get('i') === 'tt0000001'
        ? { json: { Response: 'False', Error: 'Incorrect IMDb ID.' } }
        : { json: { Response: 'True', imdbRating: '8.1', Ratings: [{ Source: 'Internet Movie Database', Value: '8.1/10' }, { Source: 'Rotten Tomatoes', Value: '92%' }, { Source: 'Metacritic', Value: '81/100' }] } },
    });
    expect(await omdbRatings(env.ctx, 'tt0133093')).toEqual({ imdb: 8.1, rt: 92, mc: 81 });
    use({ 'GET /': () => ({ json: { Response: 'True', imdbRating: 'N/A', Ratings: [{ Source: 'Metacritic', Value: 'N/A' }] } }) });
    expect(await omdbRatings(env.ctx, 'tt0000002')).toEqual({});
    use({ 'GET /': () => ({ json: { Response: 'False', Error: 'Incorrect IMDb ID.' } }) });
    vi.useFakeTimers({ toFake: ['Date'] });
    expect(await omdbRatings(env.ctx, 'tt0000001')).toBeNull();
    expect(await omdbRatings(env.ctx, 'tt0000001')).toBeNull();
    expect(calls).toHaveLength(1);
    vi.setSystemTime(Date.now() + 3500 * 1000);
    await omdbRatings(env.ctx, 'tt0000001');
    expect(calls).toHaveLength(1);
    vi.setSystemTime(Date.now() + 200 * 1000);
    await omdbRatings(env.ctx, 'tt0000001');
    expect(calls).toHaveLength(2);
  });

  it('timeout: a fetch that never resolves → null after 3 s, signal has a 3000 ms timeout', async () => {
    await setSourceKey(env.ctx, 'tmdb', V3);
    const spy = vi.spyOn(AbortSignal, 'timeout');
    env.ctx.fetchImpl = (() => new Promise(() => undefined)) as typeof fetch;
    await getSourceKey(env.ctx, 'tmdb'); // warm the key cache so no db round trip runs under fake timers
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = tmdbTitle(env.ctx, 'movie', 9);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toBeNull();
    expect(spy).toHaveBeenCalledWith(3000);
  });

  it('401 → null, pause + invalid set; next call within the hour makes no fetch', async () => {
    await setSourceKey(env.ctx, 'tmdb', V3);
    use({ 'GET /3/movie/.*': () => ({ status: 401, json: {} }) });
    expect(await tmdbTitle(env.ctx, 'movie', 5)).toBeNull();
    expect(await env.ctx.kv.get(PAUSE_KEY('tmdb'))).not.toBeNull();
    expect(await env.ctx.kv.get(INVALID_KEY('tmdb'))).not.toBeNull();
    expect(await tmdbTitle(env.ctx, 'movie', 6)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('OMDb budget: at 900 no fetch, cache still served; new UTC day calls again', async () => {
    await setSourceKey(env.ctx, 'omdb', 'omdbkey-12345678');
    use({ 'GET /': () => ({ json: { Response: 'True', imdbRating: '7.0', Ratings: [] } }) });
    expect(await omdbRatings(env.ctx, 'tt0000010')).toEqual({ imdb: 7 });
    await env.ctx.kv.set(OMDB_COUNT_KEY(day()), '900', 3600);
    expect(await omdbRatings(env.ctx, 'tt0000010')).toEqual({ imdb: 7 }); // cached
    expect(await omdbRatings(env.ctx, 'tt0000011')).toBeNull(); // 901 > 900
    expect(calls).toHaveLength(1);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 86_400_000);
    expect(await omdbRatings(env.ctx, 'tt0000011')).toEqual({ imdb: 7 });
    expect(calls).toHaveLength(2);
  });

  it('key never leaks into logs, console or the result', async () => {
    await setSourceKey(env.ctx, 'omdb', 'SECRET-omdb-key');
    env.ctx.fetchImpl = (() => { throw new TypeError('fetch failed https://www.omdbapi.com/?i=tt1&apikey=SECRET-omdb-key'); }) as typeof fetch;
    const log = { warn: vi.fn() };
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m));
    const r = await extFetch(env.ctx, 'omdb', 'tt0000020', (k) => ({ url: `https://www.omdbapi.com/?i=tt1&apikey=${k}` }), (j) => j, log);
    expect(r).toBeNull();
    const all = JSON.stringify([log.warn.mock.calls, ...spies.map((s) => s.mock.calls)]);
    expect(all).not.toContain('SECRET');
    expect(log.warn).toHaveBeenCalledWith({ source: 'omdb', status: 'error' });
    // stored failure marker holds no secret either
    for (const k of await env.ctx.kv.keys('ext:')) expect(await env.ctx.kv.get(k)).not.toContain('SECRET');
  });
});

describe('admin source test route', () => {
  it('tmdb test: ok, 401 → invalid_key, unreachable', async () => {
    const admin = await env.login();
    const post = (key: string) => env.app.inject({ method: 'POST', url: '/api/admin/sources/tmdb/test', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { key } });
    use({ 'GET /3/configuration': () => ({ json: { images: {} } }) });
    expect((await post(V3)).json()).toEqual({ ok: true });
    use({ 'GET /3/configuration': () => ({ status: 401, json: {} }) });
    expect((await post(V3)).json()).toEqual({ ok: false, error: 'invalid_key' });
    use({ 'GET /3/configuration': () => ({ status: 503, json: {} }) });
    expect((await post(V3)).json()).toEqual({ ok: false, error: 'unreachable' });
    const r = await post(V3);
    expect(r.body).not.toContain(V3);
  });
});
