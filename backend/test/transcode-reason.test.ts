// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.js';

const ID = 'a'.repeat(32);
type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let friend: Sess;

beforeAll(async () => {
  env = await makeEnv({
    'GET /Users/[^/]+/Items/[^/]+': () => ({ json: { Id: ID, Name: 'Film', Type: 'Movie', UserData: { PlaybackPositionTicks: 0 } } }),
    // MKV at 10 Mbit/s: always transcoded; Jellyfin names only the bitrate
    'POST /Items/[^/]+/PlaybackInfo': () => ({ json: { PlaySessionId: 'ps-12345678', MediaSources: [{ Id: 'ms1', Container: 'mkv', SupportsDirectPlay: false, Bitrate: 10_000_000, RunTimeTicks: 100_000_000, TranscodingUrl: '/videos/x/master.m3u8?TranscodeReasons=ContainerBitrateExceedsLimit', MediaStreams: [{ Index: 0, Type: 'Video', Height: 1080 }, { Index: 1, Type: 'Audio' }] }] } }),
  });
  const admin = await env.login();
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

const info = (ip: string, body: object = {}) =>
  env.app.inject({ method: 'POST', url: '/api/playback/info', cookies: friend.cookies, headers: { 'x-csrf-token': friend.csrf, 'x-real-ip': ip }, payload: { itemId: ID, ...body } });
const REMOTE = '203.0.113.9', HOME = '192.168.1.10';

describe('POST /api/playback/info roleMaxBitrate', () => {
  it('is the effective ceiling: remote friend 8 Mbit/s, home friend 20 Mbit/s, unaffected by the client pick', async () => {
    expect((await info(REMOTE)).json().roleMaxBitrate).toBe(8_000_000);
    expect((await info(HOME)).json().roleMaxBitrate).toBe(20_000_000);
    expect((await info(HOME, { maxBitrate: 2_000_000 })).json().roleMaxBitrate).toBe(20_000_000);
  });
});

describe('POST /api/playback/info transcodeReason', () => {
  it('remote IP with the remote cap below the source bitrate -> remoteCap', async () => {
    expect((await info(REMOTE)).json().transcodeReason).toBe('remoteCap');
  });
  it('home IP, cap = role limit (above the source) -> only Jellyfin\'s bitrate reason: network', async () => {
    expect((await info(HOME)).json().transcodeReason).toBe('network');
  });
  it('client maxBitrate as the binding cap: reasonHint passes through, default network', async () => {
    expect((await info(REMOTE, { maxBitrate: 2_000_000, reasonHint: 'manual' })).json().transcodeReason).toBe('manual');
    expect((await info(REMOTE, { maxBitrate: 2_000_000, reasonHint: 'network' })).json().transcodeReason).toBe('network');
    expect((await info(REMOTE, { maxBitrate: 2_000_000 })).json().transcodeReason).toBe('network');
    // a hint does not override a lower server-side cap
    expect((await info(REMOTE, { maxBitrate: 15_000_000, reasonHint: 'manual' })).json().transcodeReason).toBe('remoteCap');
  });
  it('a client maxBitrate equal to or above the ceiling is not a network limit (Auto on a fast link asks above the ceiling)', async () => {
    expect((await info(REMOTE, { maxBitrate: 8_000_000, reasonHint: 'network' })).json().transcodeReason).toBe('remoteCap');
    expect((await info(REMOTE, { maxBitrate: 70_000_000, reasonHint: 'network' })).json()).toMatchObject({ maxBitrate: 8_000_000, transcodeReason: 'remoteCap' });
  });
  it('rejects an unknown reasonHint', async () => {
    expect((await info(REMOTE, { reasonHint: 'bogus' })).statusCode).toBe(400);
  });
});
