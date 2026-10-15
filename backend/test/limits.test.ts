// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectiveLimits, getUserLimits, invalidateLimits, setUserLimits } from '../src/limits.js';
import { listLive, setLive } from '../src/live.js';
import { forgetAuth } from '../src/routes/internal.js';
import { effectiveRole } from '../src/roles.js';
import { applyRole } from '../src/users.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

vi.mock('../src/downloadprep.js', async (orig) => ({ ...(await orig<typeof import('../src/downloadprep.js')>()), enqueueJob: async () => undefined }));

type Sess = { cookies: Record<string, string>; csrf: string };
const H = { 'x-internal-secret': cfg.INTERNAL_SECRET };
const ID = 'a'.repeat(32);
const EPS = [1, 2, 3].map((n) => String(n).padEnd(32, 'e'));
const TICKS = 90 * 600_000_000;
const NONE = { maxStreams: null, remoteBitrate: null, maxDownloads: null, downloadMaxHeight: null, requestsPerMonth: null };

let env: TestEnv;
let admin: Sess, friend: Sess, family: Sess;
let tmdb = 1000;
let rid = 100;
const imported = new Set<string>();

async function newUser(role: string, sub: string): Promise<Sess> {
  const inv = await env.app.inject({ method: 'POST', url: '/api/admin/invites', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { role, ttlHours: 1 } });
  const token = inv.json().link.split('/').pop();
  env.claims.current = { sub, email: `${sub}@example.com`, name: sub, groups: [] };
  const l = await env.app.inject(`/auth/login?invite=${token}`);
  const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
  const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } });
  const sid = cb.cookies.find((x) => x.name === 'ff_sid')!.value;
  return { cookies: { ff_sid: sid }, csrf: (await env.app.inject({ url: '/api/me', cookies: { ff_sid: sid } })).json().csrfToken };
}
const call = (s: Sess, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
const uid = async (name: string) => (await env.pool.query('select id from users where name=$1', [name])).rows[0].id as string;

beforeAll(async () => {
  const item = (id: string) => ({ Id: id, Name: 'Film', Type: 'Movie', RunTimeTicks: TICKS, UserData: { PlaybackPositionTicks: 0 } });
  env = await makeEnv({
    'GET /Items/[^/]+': (u) => ({ json: item(u.pathname.split('/').pop()!) }),
    'GET /Users/[^/]+/Items/[^/]+': (u) => ({ json: item(u.pathname.split('/').pop()!) }),
    'POST /Items/[^/]+/PlaybackInfo': () => ({ json: { PlaySessionId: 'ps-12345678', MediaSources: [{ Id: 'ms1', Container: 'mkv', SupportsDirectPlay: true, Bitrate: 2_000_000, Size: 2_000_000_000, RunTimeTicks: TICKS, MediaStreams: [{ Index: 0, Type: 'Video', Codec: 'h264', Height: 1080 }, { Index: 1, Type: 'Audio', Codec: 'aac' }] }] } }),
    'POST /Sessions/Playing.*': () => ({ status: 204 }),
  }, {
    seerr: {
      'GET /api/v1/user': () => ({ json: { results: [...imported].map((j, i) => ({ id: 10 + i, jellyfinUserId: j })) } }),
      'POST /api/v1/user/import-from-jellyfin': (_u, _i, b) => { imported.add(b.jellyfinUserIds[0]); return { json: [{ id: 9 }] }; },
      'GET /api/v1/movie/\\d+': () => ({ json: { title: 'Dunmoor' } }),
      'POST /api/v1/request': () => ({ json: { id: ++rid, status: 1, media: { status: 2 } } }),
    },
  });
  admin = await env.login();
  friend = await newUser('friend', 'Fred');
  family = await newUser('family', 'Fam');
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.pool.query('delete from user_limits; delete from role_settings; delete from downloads; delete from download_jobs; delete from seerr_requests; delete from request_reservations');
  invalidateLimits();
});

describe('effectiveLimits', () => {
  it('effectiveLimits overlays only set fields', async () => {
    const user = { id: await uid('Fred'), role: 'friend' };
    expect((await effectiveLimits(env.ctx, user))!.maxStreams).toBe(2);
    await setUserLimits(env.ctx, user.id, { ...NONE, maxStreams: 1 });
    const l = (await effectiveLimits(env.ctx, user))!;
    expect(l.maxStreams).toBe(1);
    expect(l).toEqual({ ...(await effectiveRole(env.ctx, 'friend')), maxStreams: 1, requestsPerMonth: 2 });
    expect(await getUserLimits(env.ctx, user.id)).toEqual({ ...NONE, maxStreams: 1 });
  });

  it('limits cache is invalidated on set', async () => {
    const user = { id: await uid('Fred'), role: 'friend' };
    expect((await effectiveLimits(env.ctx, user))!.maxDownloads).toBe(15);
    await env.pool.query('insert into user_limits(user_id, max_downloads) values ($1, 3)', [user.id]); // behind the cache's back
    expect((await effectiveLimits(env.ctx, user))!.maxDownloads).toBe(15);
    await setUserLimits(env.ctx, user.id, { ...NONE, maxDownloads: 4 });
    expect((await effectiveLimits(env.ctx, user))!.maxDownloads).toBe(4);
    // all null removes the row: the role applies again
    await setUserLimits(env.ctx, user.id, NONE);
    expect((await env.pool.query('select 1 from user_limits where user_id=$1', [user.id])).rowCount).toBe(0);
    expect((await effectiveLimits(env.ctx, user))!.maxDownloads).toBe(15);
  });

  it('/api/me reports the effective limits', async () => {
    await setUserLimits(env.ctx, await uid('Fred'), { ...NONE, maxStreams: 1, maxDownloads: 3 });
    const me = (await call(friend, 'GET', '/api/me')).json();
    expect(me.limits).toMatchObject({ maxStreams: 1, maxDownloads: 3, maxBitrate: 20_000_000 });
  });
});

describe('enforcement', () => {
  it('applyRole writes the user stream limit as the media server session limit', async () => {
    const { id, jellyfin_user_id: jf } = (await env.pool.query('select id, jellyfin_user_id from users where name=$1', ['Fred'])).rows[0];
    const policy = () => env.jfCalls.filter((c) => c.method === 'POST' && c.path === `/Users/${jf}/Policy`).at(-1)!.body;
    await applyRole(env.ctx, jf, 'friend');
    expect(policy().MaxActiveSessions).toBe(2);
    await setUserLimits(env.ctx, id, { ...NONE, maxStreams: 1 });
    await applyRole(env.ctx, jf, 'friend');
    expect(policy().MaxActiveSessions).toBe(1);
  });

  it('a new profile identity gets the user stream limit, not the role one', async () => {
    await setUserLimits(env.ctx, await uid('Fred'), { ...NONE, maxStreams: 1 }); // role friend: 2
    const r = await call(friend, 'POST', '/api/profiles', { name: 'Zweit' });
    expect(r.statusCode).toBe(201);
    const jf = (await env.pool.query("select jellyfin_user_id from profiles where name='Zweit'")).rows[0].jellyfin_user_id as string;
    const calls = env.jfCalls.filter((c) => c.method === 'POST' && c.path === `/Users/${jf}/Policy`);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.body.MaxActiveSessions).toBe(1);
  });

  it('a user stream limit refuses a new start but keeps running ones', async () => {
    const userId = await uid('Fam'); // family: role maxStreams 4
    for (const ps of ['ps-live-1', 'ps-live-2']) await setLive(env.ctx, { userId, userName: 'Fam', itemId: ID, title: 'Film', positionTicks: 0, isPaused: false, playSessionId: ps, updatedAt: Date.now(), source: 'portal' });
    expect((await call(family, 'POST', '/api/playback/info', { itemId: ID })).statusCode).toBe(200);
    await setUserLimits(env.ctx, userId, { ...NONE, maxStreams: 1 });
    const info = await call(family, 'POST', '/api/playback/info', { itemId: ID });
    expect(info.statusCode).toBe(429);
    expect(info.json()).toMatchObject({ error: 'max_streams', max: 1 });
    const start = await call(family, 'POST', '/api/playback/start', { itemId: ID, playSessionId: 'ps-new-0001', mediaSourceId: 'ms1', positionTicks: 0 });
    expect(start.statusCode).toBe(429);
    expect(start.json().error).toBe('max_streams');
    const live = (await listLive(env.ctx)).filter((l) => l.userId === userId).map((l) => l.playSessionId).sort();
    expect(live).toEqual(['ps-live-1', 'ps-live-2']);
    // a running session keeps reporting progress
    expect((await call(family, 'POST', '/api/playback/progress', { itemId: ID, playSessionId: 'ps-live-1', mediaSourceId: 'ms1', positionTicks: 10_000_000 })).statusCode).toBe(200);
  });

  it('gateway authz uses the user remote cap', async () => {
    await setUserLimits(env.ctx, await uid('Fred'), { ...NONE, remoteBitrate: 3_000_000 });
    const sid = friend.cookies.ff_sid!;
    forgetAuth(sid);
    const authz = (ip: string) => env.app.inject({ method: 'POST', url: '/internal/authz', headers: H, payload: { sid, ip } });
    expect((await authz('203.0.113.9')).json().maxBitrate).toBe(3_000_000);
    expect((await authz('192.168.1.10')).json().maxBitrate).toBe(20_000_000);
    // the player gets the same ceiling
    const info = await env.app.inject({ method: 'POST', url: '/api/playback/info', cookies: friend.cookies, headers: { 'x-csrf-token': friend.csrf, 'x-real-ip': '203.0.113.9' }, payload: { itemId: ID } });
    expect(info.json().maxBitrate).toBe(3_000_000);
  });

  it('request limit uses the user override', async () => {
    await setUserLimits(env.ctx, await uid('Fred'), { ...NONE, requestsPerMonth: 3 });
    expect((await call(friend, 'GET', '/api/requests/quota')).json()).toMatchObject({ limit: 3, used: 0, remaining: 3 });
    for (let i = 0; i < 3; i++) expect((await call(friend, 'POST', '/api/requests', { mediaType: 'movie', tmdbId: ++tmdb })).statusCode).toBe(200);
    const r = await call(friend, 'POST', '/api/requests', { mediaType: 'movie', tmdbId: ++tmdb });
    expect(r.statusCode).toBe(429);
    expect(r.json()).toMatchObject({ error: 'request_limit', limit: 3, used: 3 });
  });

  it('download quota uses the user override', async () => {
    const userId = await uid('Fam');
    await setUserLimits(env.ctx, userId, { ...NONE, maxDownloads: 1 });
    expect((await call(family, 'GET', '/api/downloads')).json().quota).toMatchObject({ max: 1 });
    expect((await call(family, 'POST', '/api/downloads', { itemId: EPS[0], quality: 'hd' })).statusCode).toBe(200);
    const r = await call(family, 'POST', '/api/downloads', { itemId: EPS[1], quality: 'hd' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'quota_exceeded', used: 1, max: 1 });
    // a user override of 0 switches downloads off for this user
    await setUserLimits(env.ctx, userId, { ...NONE, maxDownloads: 0 });
    expect((await call(family, 'GET', '/api/me')).json().downloads.allowed).toBe(false);
  });
});
