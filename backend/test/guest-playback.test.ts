import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgetAuth } from '../src/routes/internal.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

const ID = 'a'.repeat(32);
type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess, guest: Sess;
let height = 2160;

const src = () => ({ Id: 'ms1', Container: 'mp4', SupportsDirectPlay: true, Bitrate: 4_000_000, RunTimeTicks: 100_000_000, MediaStreams: [{ Index: 0, Type: 'Video', Height: height }, { Index: 1, Type: 'Audio' }] });

beforeAll(async () => {
  env = await makeEnv({
    'GET /Users/[^/]+/Items/[^/]+': () => ({ json: { Id: ID, Name: 'Film', Type: 'Movie', UserData: { PlaybackPositionTicks: 0 } } }),
    'POST /Items/[^/]+/PlaybackInfo': () => ({ json: { PlaySessionId: 'ps-12345678', MediaSources: [src()] } }),
  });
  admin = await env.login();
  const inv = await env.app.inject({ method: 'POST', url: '/api/admin/invites', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { role: 'guest', ttlHours: 1 } });
  const token = inv.json().link.split('/').pop();
  env.claims.current = { sub: 'sub-guest', email: 'g@example.com', name: 'Gina', groups: [] };
  const l = await env.app.inject(`/auth/login?invite=${token}`);
  const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
  const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } });
  const sid = cb.cookies.find((x) => x.name === 'ff_sid')!.value;
  guest = { cookies: { ff_sid: sid }, csrf: (await env.app.inject({ url: '/api/me', cookies: { ff_sid: sid } })).json().csrfToken };
});
afterAll(() => env.close());

const call = (s: Sess, method: string, url: string, body?: unknown) => env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
const policies = () => env.jfCalls.filter((c) => c.method === 'POST' && /\/Policy$/.test(c.path));

describe('guest playback', () => {
  it('guest gets transcoding policy on provisioning', () => {
    expect(policies().at(-1)!.body).toMatchObject({ EnableVideoPlaybackTranscoding: true });
  });

  it('caps a 2160p source at 1080 and offers no direct play', async () => {
    const p = (await call(guest, 'POST', '/api/playback/info', { itemId: ID })).json();
    expect(p.hlsUrl).toContain('MaxHeight=1080');
    expect(p.hlsUrl).toContain('MaxWidth=1920');
    expect(p.directUrl).toBeUndefined();
    const info = env.jfCalls.filter((c) => c.path.endsWith('/PlaybackInfo')).at(-1)!;
    expect(info.search).toContain('MaxHeight=1080');
    expect(JSON.stringify(info.body.DeviceProfile.CodecProfiles)).toContain('"Value":"1080"');
  });

  it('offers no direct play to a capped role even when the source is within the cap (the gateway refuses static streams for it)', async () => {
    height = 720;
    const p = (await call(guest, 'POST', '/api/playback/info', { itemId: ID })).json();
    expect(p.directUrl).toBeUndefined();
    expect(p.hlsUrl).toContain('MaxHeight=1080');
    const info = env.jfCalls.filter((c) => c.path.endsWith('/PlaybackInfo')).at(-1)!;
    expect(info.search).toContain('EnableDirectPlay=false');
    expect(info.body.DeviceProfile.DirectPlayProfiles).toEqual([]);
    height = 2160;
  });

  it('keeps direct play for a role without cap that may download', async () => {
    height = 720;
    const p = (await call(admin, 'POST', '/api/playback/info', { itemId: ID })).json();
    expect(p.directUrl).toMatch(/\/stream\?/);
    height = 2160;
  });

  it('without a height cap a role keeps direct play; DIRECT_PLAY_REQUIRES_DOWNLOAD=true also takes it from roles without download rights', async () => {
    height = 720;
    await env.pool.query("update users set role='friend' where authentik_sub='sub-guest'");
    try {
      expect((await call(guest, 'POST', '/api/playback/info', { itemId: ID })).json().directUrl).toMatch(/\/stream\?/);
      const prev = env.ctx.cfg;
      env.ctx.cfg = { ...prev, DIRECT_PLAY_REQUIRES_DOWNLOAD: 'true' };
      try {
        expect((await call(guest, 'POST', '/api/playback/info', { itemId: ID })).json().directUrl).toBeUndefined();
      } finally {
        env.ctx.cfg = prev;
      }
    } finally {
      await env.pool.query("update users set role='guest' where authentik_sub='sub-guest'");
      height = 2160;
    }
  });

  it('admin changes maxHeight/transcoding, which re-applies the policy of the role users', async () => {
    const n = policies().length;
    const r = await call(admin, 'PUT', '/api/admin/roles/guest', { transcoding: false, maxHeight: 720 });
    expect(r.statusCode).toBe(200);
    const added = policies().slice(n);
    expect(added).toHaveLength(1); // only the one guest, not the admin
    expect(added[0]!.body).toMatchObject({ EnableVideoPlaybackTranscoding: false, IsDisabled: false, Keep: 'me' });
    const p = (await call(guest, 'POST', '/api/playback/info', { itemId: ID })).json();
    expect(p.hlsUrl).toContain('MaxHeight=720');
    const authz = await env.app.inject({ method: 'POST', url: '/internal/authz', headers: { 'x-internal-secret': cfg.INTERNAL_SECRET }, payload: { sid: guest.cookies.ff_sid } });
    expect(authz.json().maxHeight).toBe(720); // the gateway clamps resolution params to the admin-set cap
    const list = (await call(admin, 'GET', '/api/admin/roles')).json();
    expect(list.limits.find((x: any) => x.role === 'guest')).toMatchObject({ transcoding: false, maxHeight: 720, requestsPerMonth: 2 });
  });

  it('null maxHeight means unlimited; unchanged values do not re-apply', async () => {
    expect((await call(admin, 'PUT', '/api/admin/roles/guest', { transcoding: true, maxHeight: null })).statusCode).toBe(200);
    const p = (await call(guest, 'POST', '/api/playback/info', { itemId: ID })).json();
    expect(new URL(p.hlsUrl, 'http://x').searchParams.get('MaxHeight')).toBe('1080'); // only the bitrate rung (guest 8 Mbit/s), no role height cap
    const n = policies().length;
    await call(admin, 'PUT', '/api/admin/roles/guest', { requestsPerMonth: 3 });
    expect(policies()).toHaveLength(n);
  });

  it('non-admins get 403', async () => {
    expect((await call(guest, 'PUT', '/api/admin/roles/guest', { maxHeight: 2160 })).statusCode).toBe(403);
    expect((await call(guest, 'GET', '/api/admin/roles')).statusCode).toBe(403);
  });

  it('authz reports canDownload so the gateway can refuse direct streams', async () => {
    const authz = async (s: Sess) => (await env.app.inject({ method: 'POST', url: '/internal/authz', headers: { 'x-internal-secret': cfg.INTERNAL_SECRET }, payload: { sid: s.cookies.ff_sid } })).json();
    expect(await authz(admin)).toMatchObject({ canDownload: true });
    forgetAuth(guest.cookies.ff_sid!);
    expect(await authz(guest)).toMatchObject({ canDownload: true }); // guests may not download, but by default that alone keeps direct play (a height cap blocks it)
    const prev = env.ctx.cfg;
    env.ctx.cfg = { ...prev, DIRECT_PLAY_REQUIRES_DOWNLOAD: 'true' };
    try {
      forgetAuth(guest.cookies.ff_sid!); // drop the 5 s authz memo
      expect(await authz(guest)).toMatchObject({ canDownload: false });
    } finally {
      env.ctx.cfg = prev;
    }
  });
});
