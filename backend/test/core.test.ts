// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deprecatedEnvNames, loadConfig } from '../src/config.js';
import { decrypt, encrypt } from '../src/crypto.js';
import { mediaBrowserHeader } from '../src/jellyfin/client.js';
import { pollJellyfinSessions } from '../src/routes/internal.js';
import { ADMIN, ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

const ID = 'a'.repeat(32);
const item = (id: string, extra = {}) => ({ Id: id, Name: 'Film ' + id.slice(0, 2), Type: 'Movie', ImageTags: { Primary: 'x' }, UserData: { Played: false, IsFavorite: false, PlaybackPositionTicks: 5_000_000 }, ...extra });

let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };

beforeAll(async () => {
  env = await makeEnv({
    // legacy server: only old paths exist (tests the compat fallback)
    'GET /Users/[^/]+/Views': () => ({ json: { Items: [{ Id: 'v1', Name: 'Filme', Type: 'CollectionFolder' }] } }),
    'GET /Items': () => ({ json: { Items: [item(ID)], TotalRecordCount: 1 } }),
    'GET /Users/[^/]+/Items/Resume': () => ({ json: { Items: [item(ID)] } }),
    'GET /Users/[^/]+/Items/[^/]+': () => ({ json: item(ID, { RunTimeTicks: 100_000_000 }) }),
    'POST /Items/[^/]+/PlaybackInfo': () => ({
      json: {
        PlaySessionId: 'ps-12345678',
        MediaSources: [{ Id: 'ms1', Container: 'mp4', SupportsDirectPlay: true, Bitrate: 4_000_000, RunTimeTicks: 100_000_000, MediaStreams: [
          { Index: 1, Type: 'Audio', Language: 'ger', DisplayTitle: 'Deutsch', IsDefault: true },
          { Index: 2, Type: 'Audio', Language: 'eng', DisplayTitle: 'English' },
          { Index: 3, Type: 'Subtitle', Language: 'ger', Codec: 'subrip', IsTextSubtitleStream: true, DisplayTitle: 'Deutsch' },
          { Index: 4, Type: 'Subtitle', Codec: 'pgssub', IsTextSubtitleStream: false },
        ] }],
      },
    }),
    'GET /Shows/NextUp': () => ({ json: { Items: [] } }),
    'POST /Sessions/Playing': () => ({ status: 204 }),
    'POST /Sessions/Playing/Progress': () => ({ status: 204 }),
    'POST /Sessions/Playing/Stopped': () => ({ status: 204 }),
    'POST /Users/[^/]+/FavoriteItems/[^/]+': () => ({ json: {} }),
    'DELETE /Users/[^/]+/FavoriteItems/[^/]+': () => ({ json: {} }),
    'GET /Sessions': () => ({ json: [{ Id: 's9', UserId: 'jf' + '0'.repeat(30) + '01ab', DeviceId: 'tv', NowPlayingItem: { Id: ID, Name: 'TV-Film', Type: 'Movie' }, PlayState: { PositionTicks: 7, IsPaused: true } }] }),
  });
  s = await env.login();
});
afterAll(() => env.close());

const call = (method: string, url: string, body?: unknown, csrf = true) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: csrf ? { 'x-csrf-token': s.csrf } : {}, payload: body as object });

describe('crypto / config / header', () => {
  it('roundtrips AES-GCM and detects tampering', () => {
    const k = Buffer.from(ENC_KEY, 'base64');
    const c = encrypt(k, 'secret');
    expect(decrypt(k, c)).toBe('secret');
    const raw = Buffer.from(c, 'base64url');
    raw[raw.length - 1]! ^= 0x01; // always changes the ciphertext, never a no-op
    expect(() => decrypt(k, raw.toString('base64url'))).toThrow();
  });
  it('config fails on missing vars', () => expect(() => loadConfig({})).toThrow());
  it('strips quotes from header values', () => {
    expect(mediaBrowserHeader({ deviceId: 'd"1', token: 't' })).toBe('MediaBrowser Client="FriendFlix", Device="Portal", DeviceId="d1", Version="0.1.0", Token="t"');
  });
});

describe('auth', () => {
  it('provisions the admin with an encrypted jellyfin password and applies a policy', async () => {
    const r = await env.pool.query('select * from users');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].role).toBe('admin');
    expect(r.rows[0].jellyfin_pw_enc).not.toMatch(/^[\w-]{20,}$/.test('') ? '' : /^$/);
    expect(decrypt(Buffer.from(ENC_KEY, 'base64'), r.rows[0].jellyfin_pw_enc).length).toBeGreaterThan(20);
    const pol = env.jfCalls.find((c) => c.path.endsWith('/Policy'))!;
    expect(pol.body).toMatchObject({ Keep: 'me', IsAdministrator: false, EnableContentDownloading: true, MaxActiveSessions: 6 });
  });
  it('rejects unknown users without invite', async () => {
    env.claims.current = { sub: 'x', name: 'X', groups: [] };
    const l = await env.app.inject('/auth/login');
    expect(l.statusCode).toBe(302);
    const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
    expect((await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } })).statusCode).toBe(403);
    env.claims.current = ADMIN;
  });
  it('requires CSRF for state-changing /api calls', async () => {
    expect((await call('POST', `/api/items/${ID}/favorite`, undefined, false)).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: '/api/library/views' })).statusCode).toBe(401);
  });
});

describe('library (legacy jellyfin paths)', () => {
  it('lists views, items, resume and item', async () => {
    expect((await call('GET', '/api/library/views')).json().items[0].name).toBe('Filme');
    expect((await call('GET', '/api/library/items?q=film')).json().total).toBe(1);
    expect((await call('GET', '/api/library/resume')).json().items[0].positionTicks).toBe(5_000_000);
    const it = (await call('GET', `/api/items/${ID}`)).json();
    expect(it.item.runtimeTicks).toBe(100_000_000);
    expect(it.item.positionTicks).toBe(5_000_000);
  });
  it('favorite uses the legacy fallback and validates ids', async () => {
    expect((await call('POST', `/api/items/${ID}/favorite`)).statusCode).toBe(200);
    expect((await call('GET', '/api/items/not-an-id')).statusCode).toBe(400);
  });
  it('empty-body POST/DELETE with a JSON content-type (what the web client sends) is accepted', async () => {
    const browser = (method: string, url: string) => env.app.inject({ method: method as 'POST', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf, 'content-type': 'application/json', 'content-length': '0' }, payload: '' });
    expect((await browser('POST', `/api/items/${ID}/favorite`)).statusCode).toBe(200);
    expect((await browser('DELETE', `/api/items/${ID}/favorite`)).statusCode).toBe(200);
    expect((await browser('POST', `/api/items/${ID}/watchlist`)).statusCode).toBe(200);
    expect((await browser('DELETE', `/api/items/${ID}/watchlist`)).statusCode).toBe(200);
  });
  it('watchlist roundtrip', async () => {
    await call('POST', `/api/items/${ID}/watchlist`);
    expect((await call('GET', `/api/items/${ID}`)).json().inWatchlist).toBe(true);
    expect((await call('GET', '/api/watchlist/ids')).json().ids).toEqual([ID]);
    await call('DELETE', `/api/items/${ID}/watchlist`);
    expect((await call('GET', '/api/watchlist/ids')).json().ids).toEqual([]);
    expect((await call('GET', `/api/items/${ID}`)).json().inWatchlist).toBe(false);
  });
});

describe('playback', () => {
  it('returns gateway URLs only (no jellyfin host, no token) and track lists', async () => {
    const r = await call('POST', '/api/playback/info', { itemId: ID });
    expect(r.statusCode).toBe(200);
    const p = r.json();
    expect(p.hlsUrl).toMatch(/^\/media\/Videos\/a{32}\/master\.m3u8\?/);
    expect(p.hlsUrl).toContain('MaxStreamingBitrate=60000000');
    expect(p.directUrl).toMatch(/^\/media\/Videos\/a{32}\/stream\?/);
    expect(JSON.stringify(p)).not.toMatch(/jellyfin|tok-|adminkey/i);
    expect(p.audioTracks).toHaveLength(2);
    expect(p.subtitles).toHaveLength(1); // image subtitle (pgs) is filtered out
    expect(p.subtitles[0].url).toBe(`/media/Videos/${ID}/ms1/Subtitles/3/0/Stream.vtt`);
    expect(p.resumeTicks).toBe(5_000_000);
  });
  it('playback info: one /Items lookup (resume + trickplay) next to PlaybackInfo, no per-item fetch', async () => {
    const n = env.jfCalls.length;
    const p = (await call('POST', '/api/playback/info', { itemId: ID })).json();
    const calls = env.jfCalls.slice(n);
    expect(calls.map((c) => c.path).sort()).toEqual(['/Items', `/Items/${ID}/PlaybackInfo`]);
    expect(calls.find((c) => c.path === '/Items')!.search).toContain('fields=Trickplay');
    expect(p.resumeTicks).toBe(5_000_000);
    // an explicit start position wins over the saved one
    expect((await call('POST', '/api/playback/info', { itemId: ID, startTicks: 70 })).json().resumeTicks).toBe(70);
  });
  it('playback info: audioLang picks a non-default track in the first request (HLS only), the default track changes nothing', async () => {
    const n = env.jfCalls.filter((c) => c.path.endsWith('/PlaybackInfo')).length;
    const en = (await call('POST', '/api/playback/info', { itemId: ID, audioLang: 'eng' })).json();
    expect(en.audioIndex).toBe(2);
    expect(en.hlsUrl).toContain('AudioStreamIndex=2');
    expect(en.directUrl).toBeUndefined();
    expect(env.jfCalls.filter((c) => c.path.endsWith('/PlaybackInfo')).length).toBe(n + 1);
    const de = (await call('POST', '/api/playback/info', { itemId: ID, audioLang: 'ger' })).json();
    expect(de.audioIndex).toBeUndefined();
    expect(de.directUrl).toBeTruthy();
    const none = (await call('POST', '/api/playback/info', { itemId: ID, audioLang: 'jpn' })).json();
    expect(none.audioIndex).toBeUndefined();
    const explicit = (await call('POST', '/api/playback/info', { itemId: ID, audioLang: 'eng', audioIndex: 1 })).json();
    expect(explicit.audioIndex).toBe(1);
  });
  it('next up: ?seriesId= is passed to Jellyfin (not filtered from the global top 20)', async () => {
    const SER = 'c'.repeat(32);
    expect((await call('GET', `/api/library/nextup?seriesId=${SER}`)).json()).toEqual({ items: [] });
    expect(env.jfCalls.filter((c) => c.path === '/Shows/NextUp').at(-1)!.search).toContain(`seriesId=${SER}`);
    await call('GET', '/api/library/nextup');
    expect(env.jfCalls.filter((c) => c.path === '/Shows/NextUp').at(-1)!.search).not.toContain('seriesId=');
    expect((await call('GET', '/api/library/nextup?seriesId=../x')).statusCode).toBe(400);
  });
  it('uses the per-user token for playback info and reports', async () => {
    const base = { itemId: ID, playSessionId: 'ps-12345678', mediaSourceId: 'ms1', positionTicks: 1000, isPaused: false };
    expect((await call('POST', '/api/playback/start', base)).statusCode).toBe(200);
    expect((await call('POST', '/api/playback/progress', { ...base, positionTicks: 2000, isPaused: true })).statusCode).toBe(200);
    const np = (await call('GET', '/api/nowplaying')).json().items;
    expect(np).toHaveLength(1);
    expect(np[0]).toMatchObject({ user: 'Admin', isPaused: true, positionTicks: 2000 });
    const rep = env.jfCalls.filter((c) => c.path.startsWith('/Sessions/Playing'));
    expect(rep.map((c) => c.path)).toEqual(['/Sessions/Playing', '/Sessions/Playing/Progress']);
    expect(rep[0]!.auth).toMatch(/Token="tok-/); // user token, not the admin key
    expect(rep[1]!.body).toMatchObject({ IsPaused: true, PositionTicks: 2000, PlaySessionId: 'ps-12345678' });
    expect((await call('POST', '/api/playback/stop', base)).statusCode).toBe(200);
    expect((await call('GET', '/api/nowplaying')).json().items).toHaveLength(0);
  });
  it('enforces max concurrent streams per role', async () => {
    await env.pool.query("update users set role='guest'"); // guest: 1 stream
    const b = (n: string) => ({ itemId: ID, playSessionId: `ps-${n}-0000`, mediaSourceId: 'ms1', positionTicks: 0, isPaused: false });
    expect((await call('POST', '/api/playback/start', b('a'))).statusCode).toBe(200);
    expect((await call('POST', '/api/playback/info', { itemId: ID })).statusCode).toBe(429);
    expect((await call('POST', '/api/playback/start', b('b'))).statusCode).toBe(429);
    await call('POST', '/api/playback/stop', b('a'));
    await env.pool.query("update users set role='admin'");
  });
});

describe('internal endpoints', () => {
  it('authz needs the internal secret and returns the token only for valid sessions', async () => {
    const sid = s.cookies.ff_sid;
    expect((await env.app.inject({ method: 'POST', url: '/internal/authz', payload: { sid } })).statusCode).toBe(403);
    const ok = await env.app.inject({ method: 'POST', url: '/internal/authz', headers: { 'x-internal-secret': 'internal-secret-123456' }, payload: { sid, ip: '192.168.1.10' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ token: expect.stringMatching(/^tok-/), maxBitrate: 60_000_000 });
    const bad = await env.app.inject({ method: 'POST', url: '/internal/authz', headers: { 'x-internal-secret': 'internal-secret-123456' }, payload: { sid: 'x'.repeat(30) } });
    expect(bad.statusCode).toBe(401);
  });
  it('jellyfin webhook (secret protected) feeds now-playing, poller as fallback', async () => {
    const payload = { type: 'PlaybackStart', user: (await env.pool.query('select jellyfin_username u from users')).rows[0].u, itemId: ID, name: 'WH-Film', isPaused: 'False', deviceName: 'Fire TV' };
    expect((await env.app.inject({ method: 'POST', url: '/internal/webhook/jellyfin', payload })).statusCode).toBe(403);
    const r = await env.app.inject({ method: 'POST', url: '/internal/webhook/jellyfin', headers: { 'x-webhook-secret': 'webhook-secret-123456' }, payload });
    expect(r.statusCode).toBe(200);
    expect((await call('GET', '/api/nowplaying')).json().items.map((i: any) => i.title)).toContain('WH-Film');
    await env.app.inject({ method: 'POST', url: '/internal/webhook/jellyfin', headers: { 'x-webhook-secret': 'webhook-secret-123456' }, payload: { ...payload, type: 'PlaybackStop' } });
    expect((await call('GET', '/api/nowplaying')).json().items).toHaveLength(0);
    await pollJellyfinSessions(env.ctx);
    const np = (await call('GET', '/api/nowplaying')).json().items;
    expect(np).toEqual([]); // the fake session's UserId does not map to a portal user
  });
  it('health and metrics', async () => {
    expect((await env.app.inject('/health')).statusCode).toBe(200);
    const m = await env.app.inject('/metrics');
    expect(m.body).toContain('friendflix_active_streams');
    expect((await env.app.inject('/health/ready')).json().checks).toMatchObject({ postgres: true, redis: true, jellyfin: true });
  });
});

describe('config file secrets', () => {
  it('reads VAR_FILE only for known settings', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync('/tmp/ff-secret-test', 'from-file\n');
    const base = { PUBLIC_URL: 'https://p.example.com', DATABASE_URL: 'x', REDIS_URL: 'x', APP_ENC_KEY: 'k'.repeat(44), INTERNAL_SECRET: 'i'.repeat(20), OIDC_ISSUER: 'https://a.example.com', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET_FILE: '/tmp/ff-secret-test', JELLYFIN_URL: 'http://j', JELLYFIN_ADMIN_API_KEY: 'k', REQUESTS_URL: 'http://s', REQUESTS_API_KEY: 'k', WEBHOOK_SECRET: 'w'.repeat(20) };
    const c = loadConfig({ ...base, PIP_CONFIG_FILE: '/does/not/exist' });
    expect(c.OIDC_CLIENT_SECRET).toBe('from-file');
  });
  it('an empty value or empty secret file counts as unset (push disabled with an empty vapid_private_key file)', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync('/tmp/ff-secret-empty', '\n');
    const base = { PUBLIC_URL: 'https://p.example.com', DATABASE_URL: 'x', REDIS_URL: 'x', APP_ENC_KEY: 'k'.repeat(44), INTERNAL_SECRET: 'i'.repeat(20), OIDC_ISSUER: 'https://a.example.com', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', JELLYFIN_URL: 'http://j', JELLYFIN_ADMIN_API_KEY: 'k', REQUESTS_URL: 'http://s', REQUESTS_API_KEY: 'k', WEBHOOK_SECRET: 'w'.repeat(20) };
    const c = loadConfig({ ...base, VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: '', VAPID_PRIVATE_KEY_FILE: '/tmp/ff-secret-empty', PIP_CONFIG_FILE: '/does/not/exist' });
    expect(c.VAPID_PRIVATE_KEY).toBeUndefined();
    expect(loadConfig({ ...base, VAPID_PRIVATE_KEY: '', PIP_CONFIG_FILE: '/does/not/exist' }).VAPID_PRIVATE_KEY).toBeUndefined();
  });
});

describe('renamed request service settings', () => {
  const base = { PUBLIC_URL: 'https://p.example.com', DATABASE_URL: 'x', REDIS_URL: 'x', APP_ENC_KEY: 'k'.repeat(44), INTERNAL_SECRET: 'i'.repeat(20), OIDC_ISSUER: 'https://a.example.com', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', JELLYFIN_URL: 'http://j', JELLYFIN_ADMIN_API_KEY: 'k', WEBHOOK_SECRET: 'w'.repeat(20) };
  it('reads REQUESTS_URL / REQUESTS_API_KEY without any warning', () => {
    const env = { ...base, REQUESTS_URL: 'http://requests:5055', REQUESTS_API_KEY: 'new' };
    const c = loadConfig(env);
    expect([c.REQUESTS_URL, c.REQUESTS_API_KEY]).toEqual(['http://requests:5055', 'new']);
    expect(deprecatedEnvNames(env)).toEqual([]);
  });
  it('falls back to the old SEERR_* names and reports them as deprecated (names only)', () => {
    const env = { ...base, SEERR_URL: 'http://seerr:5055', SEERR_API_KEY: 'old-secret' };
    const c = loadConfig(env);
    expect([c.REQUESTS_URL, c.REQUESTS_API_KEY]).toEqual(['http://seerr:5055', 'old-secret']);
    const msgs = deprecatedEnvNames(env);
    expect(msgs).toEqual(['SEERR_URL is deprecated, use REQUESTS_URL', 'SEERR_API_KEY is deprecated, use REQUESTS_API_KEY']);
    expect(msgs.join(' ')).not.toContain('old-secret');
  });
  it('the new name wins when both are set (also over the old _FILE variant)', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync('/tmp/ff-secret-old-requests', 'old-file\n');
    const c = loadConfig({ ...base, REQUESTS_URL: 'http://requests:5055', SEERR_URL: 'http://seerr:5055', REQUESTS_API_KEY: 'new', SEERR_API_KEY: 'old', SEERR_API_KEY_FILE: '/tmp/ff-secret-old-requests' });
    expect([c.REQUESTS_URL, c.REQUESTS_API_KEY]).toEqual(['http://requests:5055', 'new']);
  });
  it('reads REQUESTS_API_KEY_FILE, and the old SEERR_API_KEY_FILE as fallback', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync('/tmp/ff-secret-new-requests', 'new-file\n');
    writeFileSync('/tmp/ff-secret-old-requests', 'old-file\n');
    expect(loadConfig({ ...base, REQUESTS_URL: 'http://requests:5055', REQUESTS_API_KEY_FILE: '/tmp/ff-secret-new-requests', SEERR_API_KEY: 'old' }).REQUESTS_API_KEY).toBe('new-file');
    const old = { ...base, REQUESTS_URL: 'http://requests:5055', SEERR_API_KEY_FILE: '/tmp/ff-secret-old-requests' };
    expect(loadConfig(old).REQUESTS_API_KEY).toBe('old-file');
    expect(deprecatedEnvNames(old)).toEqual(['SEERR_API_KEY_FILE is deprecated, use REQUESTS_API_KEY_FILE']);
  });
  it('an empty new value (compose passes "") does not hide the old name', () => {
    const c = loadConfig({ ...base, REQUESTS_URL: 'http://seerr:5055', REQUESTS_API_KEY: '', SEERR_API_KEY: 'old' });
    expect(c.REQUESTS_API_KEY).toBe('old');
    expect(() => loadConfig({ ...base, REQUESTS_URL: 'http://requests:5055' })).toThrow();
  });
});
