// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgetAuth } from '../src/routes/internal.js';
import { invalidateRoles } from '../src/roles.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

const ID = 'a'.repeat(32);
const H = { 'x-internal-secret': cfg.INTERNAL_SECRET };
type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess, friend: Sess;

beforeAll(async () => {
  env = await makeEnv({
    'GET /Users/[^/]+/Items/[^/]+': () => ({ json: { Id: ID, Name: 'Film', Type: 'Movie', UserData: { PlaybackPositionTicks: 0 } } }),
    'POST /Items/[^/]+/PlaybackInfo': () => ({ json: { PlaySessionId: 'ps-12345678', MediaSources: [{ Id: 'ms1', Container: 'mp4', SupportsDirectPlay: true, Bitrate: 2_000_000, RunTimeTicks: 100_000_000, MediaStreams: [{ Index: 0, Type: 'Video', Height: 720 }, { Index: 1, Type: 'Audio' }] }] } }),
  });
  admin = await env.login();
  const inv = await env.app.inject({ method: 'POST', url: '/api/admin/invites', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { role: 'friend', ttlHours: 1 } });
  const token = inv.json().link.split('/').pop();
  env.claims.current = { sub: 'sub-friend', email: 'f@example.com', name: 'Fred', groups: [] };
  const l = await env.app.inject(`/auth/login?invite=${token}`);
  const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
  const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } });
  const sid = cb.cookies.find((x) => x.name === 'ff_sid')!.value;
  friend = { cookies: { ff_sid: sid }, csrf: (await env.app.inject({ url: '/api/me', cookies: { ff_sid: sid } })).json().csrfToken };
});
afterAll(() => env.close());

const info = (s: Sess, headers: Record<string, string> = {}, remoteAddress?: string, body: object = {}) =>
  env.app.inject({ method: 'POST', url: '/api/playback/info', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf, ...headers }, payload: { itemId: ID, ...body }, remoteAddress });
const authz = (sid: string, ip?: string) => env.app.inject({ method: 'POST', url: '/internal/authz', headers: H, payload: ip === undefined ? { sid } : { sid, ip } });

describe('POST /api/playback/info remote cap', () => {
  it('caps a friend at 8 Mbit/s from a public address, 20 Mbit/s from a home address', async () => {
    expect((await info(friend, { 'x-real-ip': '203.0.113.9' })).json().maxBitrate).toBe(8_000_000);
    expect((await info(friend, { 'x-real-ip': '192.168.1.10' })).json().maxBitrate).toBe(20_000_000);
  });
  it('loopback peer without headers is home; any other peer without headers is remote (even RFC1918)', async () => {
    expect((await info(friend, {}, '127.0.0.1')).json().maxBitrate).toBe(20_000_000);
    expect((await info(friend, {}, '172.18.0.5')).json().maxBitrate).toBe(8_000_000);
  });
  it('a spoofed leftmost X-Forwarded-For entry is ignored (the proxy-appended last entry counts)', async () => {
    expect((await info(friend, { 'x-forwarded-for': '192.168.1.10, 203.0.113.9' })).json().maxBitrate).toBe(8_000_000);
    expect((await info(friend, { 'x-forwarded-for': '203.0.113.9, 192.168.1.10' })).json().maxBitrate).toBe(20_000_000);
  });
  it('the client may lower the cap further, never raise it', async () => {
    expect((await info(friend, { 'x-real-ip': '203.0.113.9' }, undefined, { maxBitrate: 2_000_000 })).json().maxBitrate).toBe(2_000_000);
    expect((await info(friend, { 'x-real-ip': '203.0.113.9' }, undefined, { maxBitrate: 15_000_000 })).json().maxBitrate).toBe(8_000_000);
  });
  it('role_settings.remote_max_bitrate overrides the default and is clamped by the role maxBitrate', async () => {
    await env.pool.query("insert into role_settings(role, remote_max_bitrate) values ('friend', 12000000) on conflict (role) do update set remote_max_bitrate=12000000");
    invalidateRoles(env.ctx);
    expect((await info(friend, { 'x-real-ip': '203.0.113.9' })).json().maxBitrate).toBe(12_000_000);
    await env.pool.query("update role_settings set remote_max_bitrate=100000000 where role='friend'");
    invalidateRoles(env.ctx);
    expect((await info(friend, { 'x-real-ip': '203.0.113.9' })).json().maxBitrate).toBe(20_000_000);
    await env.pool.query("update role_settings set remote_max_bitrate=null where role='friend'");
    invalidateRoles(env.ctx);
    expect((await info(friend, { 'x-real-ip': '203.0.113.9' })).json().maxBitrate).toBe(8_000_000);
  });
  it('admin defaults to 12 Mbit/s remote', async () => {
    expect((await info(admin, { 'x-real-ip': '203.0.113.9' })).json().maxBitrate).toBe(12_000_000);
  });
});

describe('POST /api/cast/session remote cap', () => {
  const cast = (s: Sess, ip: string) => env.app.inject({ method: 'POST', url: '/api/cast/session', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf, 'x-real-ip': ip }, payload: { itemId: ID } });
  it('a cast from a public address stores and streams at most the remote cap; from home the role limit', async () => {
    const away = await cast(friend, '203.0.113.9');
    expect(away.statusCode).toBe(200);
    expect(away.json().contentUrl).toContain('MaxStreamingBitrate=8000000');
    const ctAway = /\/media\/c\/([\w-]{43})\//.exec(away.json().contentUrl)![1];
    expect((await env.app.inject({ method: 'POST', url: '/internal/authz', headers: H, payload: { ct: ctAway, client: '198.51.100.1' } })).json().maxBitrate).toBe(8_000_000);
    const home = await cast(friend, '192.168.1.10');
    expect(home.json().contentUrl).toContain('MaxStreamingBitrate=20000000');
  });
});

describe('POST /internal/authz {sid, ip}', () => {
  it('lowers maxBitrate for remote IPs only', async () => {
    const sid = friend.cookies.ff_sid!;
    forgetAuth(sid);
    expect((await authz(sid, '203.0.113.9')).json().maxBitrate).toBe(8_000_000);
    expect((await authz(sid, '192.168.1.10')).json().maxBitrate).toBe(20_000_000);
    expect((await authz(sid, '::ffff:192.168.1.10')).json().maxBitrate).toBe(20_000_000);
    expect((await authz(sid, 'unknown')).json().maxBitrate).toBe(8_000_000);
  });
  it("ip 'unknown' (what the gateway sends for a non-loopback peer without forwarding headers) gets the remote cap", async () => {
    const sid = friend.cookies.ff_sid!;
    forgetAuth(sid);
    expect((await authz(sid, 'unknown')).json().maxBitrate).toBe(8_000_000);
    expect((await authz(sid, '127.0.0.1')).json().maxBitrate).toBe(20_000_000);
  });
  it('without ip the caller counts as remote (ambiguous = remote), and the response carries no internal fields', async () => {
    const r = (await authz(friend.cookies.ff_sid!)).json();
    expect(r.maxBitrate).toBe(8_000_000);
    expect(r).not.toHaveProperty('remoteMaxBitrate');
  });
  it('rejects a malformed ip', async () => {
    expect((await env.app.inject({ method: 'POST', url: '/internal/authz', headers: H, payload: { sid: friend.cookies.ff_sid, ip: 5 } })).statusCode).toBe(400);
  });
});

describe('admin roles API', () => {
  it('exposes and stores remoteMaxBitrate', async () => {
    const put = await env.app.inject({ method: 'PUT', url: '/api/admin/roles/family', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { remoteMaxBitrate: 12_000_000 } });
    expect(put.statusCode).toBe(200);
    const g = (await env.app.inject({ url: '/api/admin/roles', cookies: admin.cookies })).json();
    expect(g.limits.find((l: any) => l.role === 'family').remoteMaxBitrate).toBe(12_000_000);
    expect(g.limits.find((l: any) => l.role === 'guest').remoteMaxBitrate).toBe(4_000_000);
    expect(g.limits.find((l: any) => l.role === 'family')).toMatchObject({ maxBitrate: 40_000_000, remoteDefault: 8_000_000, remoteIsDefault: false });
    expect(g.limits.find((l: any) => l.role === 'guest')).toMatchObject({ remoteDefault: 4_000_000, remoteIsDefault: true });
    // null resets to the role default
    const reset = await env.app.inject({ method: 'PUT', url: '/api/admin/roles/family', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { remoteMaxBitrate: null } });
    expect(reset.statusCode).toBe(200);
    const g2 = (await env.app.inject({ url: '/api/admin/roles', cookies: admin.cookies })).json();
    expect(g2.limits.find((l: any) => l.role === 'family')).toMatchObject({ remoteMaxBitrate: 8_000_000, remoteIsDefault: true });
    // an unrelated update leaves the cap alone
    await env.app.inject({ method: 'PUT', url: '/api/admin/roles/family', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { remoteMaxBitrate: 12_000_000 } });
    await env.app.inject({ method: 'PUT', url: '/api/admin/roles/family', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { downloadDays: 20 } });
    expect((await env.app.inject({ url: '/api/admin/roles', cookies: admin.cookies })).json().limits.find((l: any) => l.role === 'family').remoteMaxBitrate).toBe(12_000_000);
    const bad = await env.app.inject({ method: 'PUT', url: '/api/admin/roles/family', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { remoteMaxBitrate: 100 } });
    expect(bad.statusCode).toBe(400);
  });
});
