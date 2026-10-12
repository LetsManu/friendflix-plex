import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { portalStatus } from '../src/seerr/client.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
const sent: Array<{ url: string; body: string }> = [];
let movieStatus = 1;
let imported: string | null = null;
let videos: any[] = [];

beforeAll(async () => {
  env = await makeEnv({}, {
    ctxPatch: (c) => {
      c.cfg = { ...cfg, NTFY_URL: 'https://ntfy.example.com/ff', DISCORD_WEBHOOK_URL: 'https://discord.example.com/hook' };
      c.fetchImpl = (async (u: string, init: RequestInit) => { sent.push({ url: String(u), body: String(init.body) }); return new Response('ok'); }) as unknown as typeof fetch;
    },
    seerr: {
      'GET /api/v1/search': (u) => ({ json: { totalPages: 1, results: [
        { id: 603, mediaType: 'movie', title: 'The Matrix', releaseDate: '1999-03-30', posterPath: '/abc123.jpg', mediaInfo: { status: 5 } },
        { id: 1, mediaType: 'person', name: 'Someone' },
        { id: 1396, mediaType: 'tv', name: 'Breaking Bad', firstAirDate: '2008-01-20' },
      ], q: u.search } }),
      'GET /api/v1/user': () => ({ json: { results: [{ id: 7, jellyfinUserId: 'x' }, ...(imported ? [{ id: 9, jellyfinUserId: imported.toUpperCase() }] : [])] } }),
      'POST /api/v1/user/import-from-jellyfin': (_u, _i, b) => { imported = b.jellyfinUserIds[0]; return { json: [{ id: 9 }] }; },
      'GET /api/v1/movie/\\d+': () => ({ json: { title: 'Dune', posterPath: '/dune.jpg', relatedVideos: videos, mediaInfo: movieStatus === 1 ? undefined : { status: movieStatus } } }),
      'GET /api/v1/tv/\\d+': () => ({ json: { name: 'Show', relatedVideos: videos } }),
      'POST /api/v1/request': (_u, _i, b) => ({ json: { id: 42, status: 1, media: { status: 2 }, echo: b } }),
      'GET /api/v1/request/42': () => ({ json: { id: 42, status: 2, media: { status: 3 } } }),
      'GET /api/v1/request': () => ({ json: { results: [{ id: 42, type: 'movie', status: 1, media: { status: 2, tmdbId: 438631, mediaType: 'movie' }, requestedBy: { displayName: 'x' }, createdAt: '2026-01-01' }], pageInfo: {} } }),
      'POST /api/v1/request/42/approve': () => ({ json: {} }),
    },
  });
  admin = await env.login();
});
afterAll(() => env.close());

const call = (method: string, url: string, body?: unknown) => env.app.inject({ method: method as 'GET', url, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: body as object });

describe('status mapping', () => {
  it('maps seerr codes', () => {
    expect(portalStatus(5)).toBe('verfuegbar');
    expect(portalStatus(3)).toBe('in_arbeit');
    expect(portalStatus(2, 1)).toBe('angefragt');
    expect(portalStatus(1, 3)).toBe('abgelehnt');
    expect(portalStatus(undefined)).toBe('nicht_angefragt');
  });
});

describe('seerr integration', () => {
  it('search hides persons, proxies posters, encodes spaces as %20', async () => {
    const r = (await call('GET', '/api/seerr/search?q=the%20matrix')).json();
    expect(r.results).toHaveLength(2);
    expect(r.results[0]).toMatchObject({ title: 'The Matrix', status: 'verfuegbar', poster: '/api/seerr/image/abc123.jpg' });
    expect(env.seerrCalls.at(-1)!.search).toContain('query=the%20matrix');
    expect(env.seerrCalls.at(-1)!.auth).toBeUndefined(); // api key is a header, never in url/body
  });
  it('rejects bad poster paths (SSRF guard)', async () => {
    expect((await call('GET', '/api/seerr/image/..%2F..%2Fx.jpg')).statusCode).toBe(400);
    expect((await call('GET', '/api/seerr/image/evil/path.jpg')).statusCode).toBe(400);
  });
  it('creates the request in the name of the mapped seerr user and stores the mapping', async () => {
    const r = await call('POST', '/api/requests', { mediaType: 'movie', tmdbId: 438631 });
    expect(r.statusCode).toBe(200);
    const post = env.seerrCalls.find((c) => c.method === 'POST' && c.path === '/api/v1/request')!;
    expect(post.body).toMatchObject({ mediaType: 'movie', mediaId: 438631, userId: 9 });
    expect((await env.pool.query('select seerr_user_id from users')).rows[0].seerr_user_id).toBe(9);
    expect((await env.pool.query('select title from seerr_requests')).rows[0].title).toBe('Dune');
    const mine = (await call('GET', '/api/requests/mine')).json().requests;
    expect(mine[0]).toMatchObject({ id: 42, status: 'in_arbeit', title: 'Dune' });
  });
  it('does not create duplicates', async () => {
    movieStatus = 3;
    expect((await call('POST', '/api/requests', { mediaType: 'movie', tmdbId: 438631 })).statusCode).toBe(409);
    movieStatus = 1;
  });
  it('admin lists and approves requests; requester is notified', async () => {
    const l = (await call('GET', '/api/admin/requests?filter=pending')).json().requests;
    expect(l[0]).toMatchObject({ id: 42, requestedBy: 'Admin', status: 'angefragt' });
    expect((await call('POST', '/api/admin/requests/42/approve')).statusCode).toBe(200);
    const n = (await call('GET', '/api/notifications')).json().notifications;
    expect(n.map((x: any) => x.kind)).toContain('request_approve');
  });
  it('seerr webhook: secret required, MEDIA_AVAILABLE notifies requester and pushes ntfy/discord once', async () => {
    const payload = { notification_type: 'MEDIA_AVAILABLE', subject: 'Dune (2021)', media: { media_type: 'movie', tmdbId: '438631' }, request: { request_id: '42' } };
    expect((await env.app.inject({ method: 'POST', url: '/internal/webhook/seerr', payload })).statusCode).toBe(403);
    sent.length = 0;
    const ok = await env.app.inject({ method: 'POST', url: '/internal/webhook/seerr', headers: { authorization: cfg.WEBHOOK_SECRET }, payload });
    expect(ok.statusCode).toBe(200);
    expect(sent.map((s) => s.url).sort()).toEqual(['https://discord.example.com/hook', 'https://ntfy.example.com/ff']);
    await env.app.inject({ method: 'POST', url: '/internal/webhook/seerr', headers: { 'x-webhook-secret': cfg.WEBHOOK_SECRET }, payload });
    expect(sent).toHaveLength(2); // dedupe: no duplicate external pushes
    const n = (await call('GET', '/api/notifications')).json().notifications;
    expect(n.some((x: any) => x.kind === 'available' && x.title.includes('Dune'))).toBe(true);
    await call('POST', '/api/notifications/read');
    expect((await call('GET', '/api/notifications')).json().notifications.filter((x: any) => x.kind === 'available')[0].read).toBe(true);
  });
});

describe('trailer', () => {
  let tmdb = 1000;
  const vid = (site: string, type: string, key: string) => ({ site, type, key, name: 'x', url: `https://x/${key}` });
  async function withVideos(v: any[], t = 'movie') {
    videos = v; tmdb++;
    return call('GET', `/api/seerr/${t}/${tmdb}/trailer`);
  }
  it('prefers Trailer over Teaser and ignores non-YouTube', async () => {
    const r = await withVideos([vid('Vimeo', 'Trailer', 'vimeo123456'), vid('YouTube', 'Teaser', 'teaser_1234'), vid('YouTube', 'Trailer', 'trailer-5678')]);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ key: 'trailer-5678' });
    expect((await withVideos([vid('YouTube', 'Teaser', 'teaser_1234')], 'tv')).json()).toEqual({ key: 'teaser_1234' });
  });
  it('404s without usable videos and rejects malformed keys', async () => {
    expect((await withVideos([])).statusCode).toBe(404);
    expect((await withVideos([vid('Vimeo', 'Trailer', 'abcdefgh')])).json()).toEqual({ error: 'no_trailer' });
    expect((await withVideos([vid('YouTube', 'Trailer', '"><script>')])).statusCode).toBe(404);
    expect((await call('GET', '/api/seerr/book/5/trailer')).statusCode).toBe(400);
  });
  it('caches for repeated calls and requires login', async () => {
    videos = [vid('YouTube', 'Trailer', 'cached_key1')]; tmdb++;
    const url = `/api/seerr/movie/${tmdb}/trailer`;
    await call('GET', url);
    const n = env.seerrCalls.length;
    expect((await call('GET', url)).json()).toEqual({ key: 'cached_key1' });
    expect(env.seerrCalls.length).toBe(n);
    expect((await env.app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });
});
