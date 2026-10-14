// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AIRPLAY_PIN2_WINDOW_MS, CAST_IDLE_TTL, castKeyTtl, hashToken } from '../src/cast.js';
import { revokeSessions } from '../src/devices.js';
import { countLive, getLive, setLive } from '../src/live.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

const ID = 'a'.repeat(32);
const MS = 'b'.repeat(32);
const H = { 'x-internal-secret': cfg.INTERNAL_SECRET };
type Sess = { cookies: Record<string, string>; csrf: string };
/** Jumps the wall clock forward (only Date is faked) so memo windows elapse without real waiting. */
const skipClock = (ms: number) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + ms); };
afterEach(() => { vi.useRealTimers(); });
let env: TestEnv;
let admin: Sess;
let visible = true;
const runtime = 7200 * 10_000_000;

beforeAll(async () => {
  env = await makeEnv({
    'GET /Users/[^/]+/Items/[^/]+': () => (visible ? { json: { Id: ID, Name: 'Film', Type: 'Movie', ImageTags: { Primary: 'x' }, UserData: { PlaybackPositionTicks: 600_000_000 } } } : { status: 404 }),
    'POST /Items/[^/]+/PlaybackInfo': () => ({
      json: {
        PlaySessionId: 'ps-12345678',
        MediaSources: [{ Id: MS, Container: 'mkv', SupportsDirectPlay: true, Bitrate: 4_000_000, RunTimeTicks: runtime, MediaStreams: [{ Index: 0, Type: 'Video', Height: 2160 }, { Index: 1, Type: 'Audio' }, { Index: 2, Type: 'Subtitle', Codec: 'srt', Language: 'ger' }] }],
      },
    }),
  });
  admin = await env.login();
});
afterAll(() => env.close());

let n = 0;
// a fresh client address per request keeps the 10/min route limit out of the way (it has its own test)
const call = (s: Sess, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf, 'x-forwarded-for': `10.1.${Math.floor(++n / 250)}.${n % 250}` }, payload: body as object });
// every cast authz carries the gateway's client key; default = one fixed address
const authz = (body: unknown, headers: Record<string, string> = H) => {
  const b = body as Record<string, unknown>;
  return env.app.inject({ method: 'POST', url: '/internal/authz', headers, payload: (b.ct !== undefined && !('client' in b) ? { ...b, client: '198.51.100.1' } : b) as object });
};
const create = async (s: Sess = admin, body: Record<string, unknown> = {}) => {
  const r = await call(s, 'POST', '/api/cast/session', { itemId: ID, ...body });
  return { r, j: r.json(), ct: (/\/media\/c\/([\w-]{43})\//.exec(r.json().contentUrl ?? '')?.[1]) as string };
};

describe('cast session', () => {
  it('reports config (https PUBLIC_URL + CAST_ENABLED)', async () => {
    expect((await call(admin, 'GET', '/api/cast/config')).json()).toEqual({ enabled: true });
  });

  it('creates an absolute, token-in-path HLS URL with the cast profile and cast-only query params', async () => {
    const { r, j, ct } = await create(admin, { startTicks: 1_200_000_000 });
    expect(r.statusCode).toBe(200);
    expect(ct).toHaveLength(43);
    expect(j.contentUrl).toMatch(new RegExp(`^https://portal\\.example\\.com/media/c/${ct}/Videos/${ID}/master\\.m3u8\\?`));
    expect(j.contentUrl).toContain('AudioCodec=aac&');
    expect(j.contentUrl).toContain('Level=41');
    expect(j.contentUrl).toContain('EnableTrickplay=false'); // no trickplay image playlist line for AirPlay / cast receivers
    expect(j.contentUrl).toContain('MaxStreamingBitrate=20000000');
    expect(j.contentUrl).not.toMatch(/api_key|ApiKey/i);
    expect(j).toMatchObject({ contentType: 'application/x-mpegURL', hlsSegmentFormat: 'ts', startTime: 120, mediaSourceId: MS, playSessionId: 'ps-12345678', title: 'Film' });
    // the poster carries its OWN image-only token, never the media token
    const imgCt = /\/media\/c\/([\w-]{43})\/Items\//.exec(j.imageUrl)![1]!;
    expect(imgCt).not.toBe(ct);
    expect(j.imageUrl).toBe(`https://portal.example.com/media/c/${imgCt}/Items/${ID}/Images/Primary?maxWidth=600`);
    expect(j.subtitles[0].url).toBe(`https://portal.example.com/media/c/${ct}/Videos/${ID}/${MS}/Subtitles/2/0/Stream.vtt`);
    expect(r.headers['cache-control']).toBe('no-store');
    // Jellyfin got the cast transcoding profile: no direct play, aac only, h264 level <= 4.1
    const info = env.jfCalls.filter((c) => c.path.endsWith('/PlaybackInfo')).at(-1)!;
    expect(info.body.DeviceProfile.DirectPlayProfiles).toEqual([]);
    expect(info.body.DeviceProfile.TranscodingProfiles[0]).toMatchObject({ Container: 'ts', AudioCodec: 'aac', VideoCodec: 'h264', MaxAudioChannels: '2' });
    expect(JSON.stringify(info.body.DeviceProfile.CodecProfiles)).toContain('"Property":"VideoLevel","Value":"41"');
    expect(info.search).toContain('MaxHeight=1080');
    expect(JSON.stringify(info)).not.toContain(ct); // the token never reaches Jellyfin
  });

  it('never stores the raw token in Redis (only its hash) and never in the response body elsewhere', async () => {
    const { ct } = await create();
    const keys = await env.kv.keys('');
    expect(keys.some((k) => k.includes(ct))).toBe(false);
    for (const k of keys) expect(await env.kv.get(k)).not.toContain(ct);
    expect(keys).toContain(`cast:${hashToken(ct)}`);
    // pins live in Redis as well, keyed by hash
    await authz({ ct });
    expect((await env.kv.keys('castpin:')).some((k) => k.includes(ct))).toBe(false);
  });

  it('is refused for an item the profile cannot see', async () => {
    visible = false;
    env.ctx.jf.forgetItems(); // item() is memoised for 10 s; the fake library just changed underneath it
    const before = (await env.kv.keys('cast:')).length;
    const r = await call(admin, 'POST', '/api/cast/session', { itemId: ID });
    visible = true;
    expect(r.statusCode).toBe(404);
    expect((await env.kv.keys('cast:')).length).toBe(before);
  });

  it('enforces maxStreams like normal playback', async () => {
    const userId = (await call(admin, 'GET', '/api/me')).json().id as string;
    const role = env.ctx.roles.admin!;
    const before = role.maxStreams;
    role.maxStreams = 1;
    await setLive(env.ctx, { userId, userName: 'a', itemId: ID, title: 't', positionTicks: 0, isPaused: false, playSessionId: 'other-ps-1', updatedAt: Date.now(), source: 'portal' });
    const r = await call(admin, 'POST', '/api/cast/session', { itemId: ID });
    role.maxStreams = before;
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toBe('max_streams');
  });

  it('rate limits session creation to 10 per minute per client', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await env.app.inject({ method: 'POST', url: '/api/cast/session', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf, 'x-forwarded-for': '203.0.113.9' }, payload: { itemId: ID } });
      codes.push(r.statusCode);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(2);
    await revokeSessions(env.ctx, (await call(admin, 'GET', '/api/me')).json().id);
    admin = await env.login();
  });

  it('requires CSRF and login', async () => {
    expect((await env.app.inject({ method: 'POST', url: '/api/cast/session', payload: { itemId: ID } })).statusCode).toBe(401);
    expect((await env.app.inject({ method: 'POST', url: '/api/cast/session', cookies: admin.cookies, payload: { itemId: ID } })).statusCode).toBe(403);
  });

  it('keeps at most 2 active tokens per account (oldest revoked)', async () => {
    await revokeSessions(env.ctx, (await call(admin, 'GET', '/api/me')).json().id); // clean slate (also kills the session)
    admin = await env.login();
    const a = await create();
    const b = await create();
    const c = await create();
    expect((await authz({ ct: a.ct })).statusCode).toBe(401);
    expect((await authz({ ct: b.ct })).statusCode).toBe(200);
    expect((await authz({ ct: c.ct })).statusCode).toBe(200);
  });

  it('DELETE revokes only own token and is idempotent-404', async () => {
    const a = await create();
    expect((await authz({ ct: a.ct })).statusCode).toBe(200);
    expect((await call(admin, 'DELETE', `/api/cast/session/${a.j.castId}`)).statusCode).toBe(200);
    expect((await authz({ ct: a.ct })).statusCode).toBe(401);
    expect((await call(admin, 'DELETE', `/api/cast/session/${a.j.castId}`)).statusCode).toBe(404);
    expect((await call(admin, 'DELETE', '/api/cast/session/zz')).statusCode).toBe(400);
  });
});

describe('POST /internal/authz with ct', () => {
  it('needs the internal secret', async () => {
    const { ct } = await create();
    expect((await authz({ ct }, {})).statusCode).toBe(403);
  });

  it('returns the profile token and the scope', async () => {
    const { ct } = await create();
    const r = await authz({ ct });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ token: expect.stringMatching(/^tok-/), maxBitrate: 20_000_000, scope: { itemId: ID, mediaSourceId: MS, playSessionId: 'ps-12345678' } });
  });

  it('rejects malformed or unknown tokens and bodies mixing sid and ct', async () => {
    expect((await authz({ ct: 'short' })).statusCode).toBe(400);
    expect((await authz({ ct: 'A'.repeat(43) })).statusCode).toBe(401);
    expect((await authz({ ct: 'A'.repeat(43), sid: 'x'.repeat(30) })).statusCode).toBe(400);
    expect((await authz({})).statusCode).toBe(400);
  });

  it('401 once the token is expired', async () => {
    const { ct } = await create();
    const k = `cast:${hashToken(ct)}`;
    const rec = JSON.parse((await env.kv.get(k))!);
    await env.kv.set(k, JSON.stringify({ ...rec, exp: Date.now() - 1 }), 60);
    expect((await authz({ ct })).statusCode).toBe(401);
  });

  it('401 when the user is disabled afterwards', async () => {
    const { ct } = await create();
    const me = (await call(admin, 'GET', '/api/me')).json().id;
    await env.pool.query('update users set disabled=true where id=$1', [me]);
    try {
      expect((await authz({ ct })).statusCode).toBe(401);
    } finally {
      await env.pool.query('update users set disabled=false where id=$1', [me]);
    }
  });

  it('401 when the sender device is no longer approved', async () => {
    const { ct } = await create();
    await env.pool.query('update devices set approved=false');
    try {
      expect((await authz({ ct })).statusCode).toBe(401);
    } finally {
      await env.pool.query('update devices set approved=true');
    }
  });

  it('401 when the profile was deleted', async () => {
    const me = (await call(admin, 'GET', '/api/me')).json().id;
    const p = await call(admin, 'POST', '/api/profiles', { name: 'Kind' });
    const pid = p.json().profile?.id ?? p.json().id;
    expect(pid).toBeTruthy();
    const sel = await call(admin, 'POST', `/api/profiles/${pid}/select`, {});
    expect(sel.statusCode).toBe(200);
    const { ct, r } = await create(admin);
    expect(r.statusCode).toBe(200);
    await env.pool.query('delete from profiles where id=$1 and user_id=$2', [pid, me]);
    expect((await authz({ ct })).statusCode).toBe(401);
    await call(admin, 'POST', `/api/profiles/${me}/select`, {});
  });

  it('revokeSessions revokes cast tokens (device-scoped and account-wide)', async () => {
    const me = (await call(admin, 'GET', '/api/me')).json().id;
    const { ct } = await create();
    expect((await authz({ ct })).statusCode).toBe(200);
    await revokeSessions(env.ctx, me, 'some-other-device');
    expect((await authz({ ct })).statusCode).toBe(200);
    const dev = (await env.pool.query<{ device_id: string }>('select device_id from devices where user_id=$1', [me])).rows[0]!.device_id;
    await revokeSessions(env.ctx, me, dev);
    expect((await authz({ ct })).statusCode).toBe(401);
    expect(await env.kv.keys(`castidx:${me}:`)).toEqual([]);
    admin = await env.login();
  });
});

describe('cast token hardening', () => {
  it('pins the token to the first client: first ok, second 401, first still ok', async () => {
    const { ct } = await create();
    expect((await authz({ ct, client: '203.0.113.1' })).statusCode).toBe(200);
    expect((await authz({ ct, client: '203.0.113.2' })).statusCode).toBe(401);
    expect((await authz({ ct, client: '203.0.113.1' })).statusCode).toBe(200);
    expect((await authz({ ct, client: '203.0.113.2' })).statusCode).toBe(401);
  });

  it('does not pin on a failed authz (revoked device) and needs a client in the body', async () => {
    const { ct } = await create();
    await env.pool.query('update devices set approved=false');
    try {
      expect((await authz({ ct, client: '203.0.113.5' })).statusCode).toBe(401);
    } finally {
      await env.pool.query('update devices set approved=true');
    }
    skipClock(2100); // negative memo (2 s)
    expect((await authz({ ct, client: '203.0.113.6' })).statusCode).toBe(200); // first SUCCESSFUL client pins
    expect((await authz({ ct, client: '203.0.113.5' })).statusCode).toBe(401);
    expect((await env.app.inject({ method: 'POST', url: '/internal/authz', headers: H, payload: { ct } })).statusCode).toBe(400);
  });

  it('AirPlay token (via airplay): sender + TV may both use it (two-address pin), a third address is refused; record says airplay', async () => {
    const { r, ct } = await create(admin, { via: 'airplay' });
    expect(r.statusCode).toBe(200);
    const rec = JSON.parse((await env.kv.get(`cast:${hashToken(ct)}`))!);
    expect(rec.via).toBe('airplay');
    expect((await authz({ ct, client: '203.0.113.21' })).statusCode).toBe(200); // Safari on the phone loads the playlist
    expect((await authz({ ct, client: '203.0.113.22' })).statusCode).toBe(200); // the TV streams
    expect((await authz({ ct, client: '203.0.113.23' })).statusCode).toBe(401);
    expect((await authz({ ct, client: '203.0.113.21' })).statusCode).toBe(200);
    expect((await authz({ ct, client: '203.0.113.22' })).statusCode).toBe(200);
    // revoking drops both pins
    expect((await call(admin, 'DELETE', `/api/cast/session/${r.json().castId}`)).statusCode).toBe(200);
    expect((await env.kv.keys('castpin2:')).some((k) => k.endsWith(hashToken(ct)))).toBe(false);
    skipClock(5100);
    expect((await authz({ ct, client: '203.0.113.22' })).statusCode).toBe(401);
  });

  it('AirPlay second pin only within 120 s of creation (phone first, TV after the picker); afterwards the token is locked to the addresses it has', async () => {
    expect(AIRPLAY_PIN2_WINDOW_MS).toBe(120_000);
    const late = await create(admin, { via: 'airplay' });
    expect((await authz({ ct: late.ct, client: '203.0.113.41' })).statusCode).toBe(200);
    const early = await create(admin, { via: 'airplay' });
    expect((await authz({ ct: early.ct, client: '203.0.113.51' })).statusCode).toBe(200);
    expect((await authz({ ct: early.ct, client: '203.0.113.52' })).statusCode).toBe(200);
    skipClock(121_000);
    // too late for a second address
    expect((await authz({ ct: late.ct, client: '203.0.113.42' })).statusCode).toBe(401);
    expect((await authz({ ct: late.ct, client: '203.0.113.41' })).statusCode).toBe(200);
    // both early pins keep working, nobody else gets in
    expect((await authz({ ct: early.ct, client: '203.0.113.51' })).statusCode).toBe(200);
    expect((await authz({ ct: early.ct, client: '203.0.113.52' })).statusCode).toBe(200);
    expect((await authz({ ct: early.ct, client: '203.0.113.53' })).statusCode).toBe(401);
  });

  it('AirPlay token first: the phone pins it at once, the TV may still take the second address 90 s later (slow picker)', async () => {
    const t = await create(admin, { via: 'airplay' });
    expect((await authz({ ct: t.ct, client: '203.0.113.61' })).statusCode).toBe(200); // the phone plays the token stream
    skipClock(90_000);
    expect((await authz({ ct: t.ct, client: '203.0.113.62' })).statusCode).toBe(200); // the TV, picked 90 s later
    expect((await authz({ ct: t.ct, client: '203.0.113.63' })).statusCode).toBe(401);
  });

  it('Chromecast stays single-pin (default via) and an unknown via is refused', async () => {
    const { ct } = await create();
    expect(JSON.parse((await env.kv.get(`cast:${hashToken(ct)}`))!).via).toBe('chromecast');
    expect((await authz({ ct, client: '203.0.113.31' })).statusCode).toBe(200);
    expect((await authz({ ct, client: '203.0.113.32' })).statusCode).toBe(401);
    expect((await call(admin, 'POST', '/api/cast/session', { itemId: ID, via: 'miracast' })).statusCode).toBe(400);
  });

  it('simultaneous first uses: exactly one client wins the pin', async () => {
    const { ct } = await create();
    const rs = await Promise.all(['203.0.113.10', '203.0.113.11', '203.0.113.12'].map((client) => authz({ ct, client })));
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1);
  });

  it('sliding TTL: idle window capped by the absolute expiry; seen is refreshed (throttled)', async () => {
    const now = Date.now();
    expect(castKeyTtl(now + 6 * 3600_000, now)).toBe(CAST_IDLE_TTL);
    expect(castKeyTtl(now + 600_000, now)).toBe(600);
    expect(castKeyTtl(now - 1, now)).toBe(0);
    const { ct } = await create();
    const k = `cast:${hashToken(ct)}`;
    const rec0 = JSON.parse((await env.kv.get(k))!);
    expect(rec0.seen).toBeGreaterThan(0);
    expect((await authz({ ct })).statusCode).toBe(200);
    expect(JSON.parse((await env.kv.get(k))!).seen).toBe(rec0.seen); // within the throttle window: no write
    await env.kv.set(k, JSON.stringify({ ...rec0, seen: Date.now() - 120_000 }), 60);
    skipClock(5100); // 5 s memo
    expect((await authz({ ct })).statusCode).toBe(200);
    const rec1 = JSON.parse((await env.kv.get(k))!);
    expect(rec1.seen).toBeGreaterThan(Date.now() - 5000);
    expect(rec1.exp).toBe(rec0.exp); // the absolute cap never moves
  });

  it('image token: image-only kind, same item, no live record, revoked with the media token; media authz reports maxHeight', async () => {
    const { ct, j } = await create();
    const imgCt = /\/media\/c\/([\w-]{43})\//.exec(j.imageUrl)![1]!;
    const m = (await authz({ ct })).json();
    expect(m).toMatchObject({ kind: 'media', maxHeight: 1080 });
    const i = (await authz({ ct: imgCt })).json();
    expect(i).toMatchObject({ kind: 'img', scope: { itemId: ID } });
    expect((await call(admin, 'DELETE', `/api/cast/session/${j.castId}`)).statusCode).toBe(200);
    expect((await authz({ ct: imgCt })).statusCode).toBe(401);
    expect((await authz({ ct })).statusCode).toBe(401);
  });

  it('an image token alone does not count as a live stream', async () => {
    const me = (await call(admin, 'GET', '/api/me')).json().id as string;
    await revokeSessions(env.ctx, me);
    admin = await env.login();
    const { j } = await create();
    const imgCt = /\/media\/c\/([\w-]{43})\//.exec(j.imageUrl)![1]!;
    await env.kv.del(`play:${me}:ps-12345678`);
    expect((await authz({ ct: imgCt })).statusCode).toBe(200);
    expect(await getLive(env.ctx, me, 'ps-12345678')).toBeNull();
  });

  it('a cast with no sender reports still counts as live (maxStreams), and keeps an existing live record', async () => {
    const me = (await call(admin, 'GET', '/api/me')).json().id as string;
    const { ct } = await create();
    for (const k of await env.kv.keys(`play:${me}:`)) await env.kv.del(k);
    expect(await countLive(env.ctx, me)).toBe(0);
    await env.kv.set(`cast:${hashToken(ct)}`, JSON.stringify({ ...JSON.parse((await env.kv.get(`cast:${hashToken(ct)}`))!), seen: 0 }), 600);
    expect((await authz({ ct })).statusCode).toBe(200);
    expect(await countLive(env.ctx, me)).toBe(1);
    expect(await getLive(env.ctx, me, 'ps-12345678')).toMatchObject({ itemId: ID, title: 'Film', playSessionId: 'ps-12345678', source: 'portal' });
    // a sender report is kept, only refreshed
    await setLive(env.ctx, { userId: me, userName: 'a', itemId: ID, title: 'Film', positionTicks: 5, isPaused: true, playSessionId: 'ps-12345678', updatedAt: 1, source: 'portal' });
    await env.kv.set(`cast:${hashToken(ct)}`, JSON.stringify({ ...JSON.parse((await env.kv.get(`cast:${hashToken(ct)}`))!), seen: 0 }), 600);
    skipClock(5100);
    expect((await authz({ ct })).statusCode).toBe(200);
    const l = (await getLive(env.ctx, me, 'ps-12345678'))!;
    expect(l.positionTicks).toBe(5);
    expect(l.updatedAt).toBeGreaterThan(1);
  });
});

describe('logout / revokeSessions device cleanup', () => {
  const meId = async () => (await call(admin, 'GET', '/api/me')).json().id as string;
  const subFor = async (uid: string, dev: string, id: string) => {
    const prof = (await env.pool.query('select id from profiles where user_id=$1 and is_owner', [uid])).rows[0].id;
    await env.pool.query("insert into devices(user_id, device_id, label, approved) values ($1,$2,'x',true) on conflict do nothing", [uid, dev]);
    await env.pool.query("insert into push_subscriptions(user_id, device_id, profile_id, endpoint, p256dh, auth) values ($1,$2,$3,$4,'p','a')", [uid, dev, prof, `https://fcm.googleapis.com/fcm/send/${id}`]);
  };
  const subs = async (uid: string) => Number((await env.pool.query('select count(*) from push_subscriptions where user_id=$1', [uid])).rows[0].count);

  it('logout deletes this device\'s push subscriptions and cast tokens when no other session uses the device', async () => {
    const me = await meId();
    await revokeSessions(env.ctx, me);
    await env.pool.query('delete from push_subscriptions');
    const s = await env.login();
    admin = s;
    const dev = (await env.pool.query<{ device_id: string }>('select device_id from devices where user_id=$1', [me])).rows[0]!.device_id;
    await subFor(me, dev, 'a1');
    await subFor(me, 'other-device', 'a2');
    const { ct } = await create();
    expect((await authz({ ct })).statusCode).toBe(200);
    expect((await call(s, 'POST', '/auth/logout')).statusCode).toBe(200);
    expect(await subs(me)).toBe(1); // only the other device's subscription is left
    expect((await authz({ ct })).statusCode).toBe(401);
    admin = await env.login();
  });

  it('logout keeps them while another live session still uses the same device', async () => {
    const me = await meId();
    await env.pool.query('delete from push_subscriptions');
    const dev = (await env.pool.query<{ device_id: string }>('select device_id from devices where user_id=$1', [me])).rows[0]!.device_id;
    await subFor(me, dev, 'b1');
    const second = await env.login(); // same browser (device cookie), second session
    const { ct } = await create();
    expect((await call(second, 'POST', '/auth/logout')).statusCode).toBe(200);
    expect(await subs(me)).toBe(1);
    expect((await authz({ ct })).statusCode).toBe(200);
  });

  it('revokeSessions(exceptSid) spares the current session\'s device (push + cast) but clears other devices', async () => {
    const me = await meId();
    await env.pool.query('delete from push_subscriptions');
    const dev = (await env.pool.query<{ device_id: string }>('select device_id from devices where user_id=$1', [me])).rows[0]!.device_id;
    await subFor(me, dev, 'c1');
    await subFor(me, 'other-device', 'c2');
    const { ct } = await create();
    expect((await authz({ ct })).statusCode).toBe(200);
    // a cast token that belongs to another device
    await env.kv.set(`castidx:${me}:${'f'.repeat(32)}`, JSON.stringify({ hash: 'f'.repeat(64), createdAt: 1, deviceId: 'other-device' }), 600);
    await env.kv.set(`cast:${'f'.repeat(64)}`, '{}', 600);
    await revokeSessions(env.ctx, me, undefined, admin.cookies.ff_sid);
    expect(await subs(me)).toBe(1);
    expect((await env.pool.query('select device_id from push_subscriptions where user_id=$1', [me])).rows[0].device_id).toBe(dev);
    expect(await env.kv.get(`cast:${'f'.repeat(64)}`)).toBeNull();
    expect((await authz({ ct })).statusCode).toBe(200);
    // without exceptSid everything goes
    await revokeSessions(env.ctx, me);
    expect(await subs(me)).toBe(0);
    expect((await authz({ ct })).statusCode).toBe(401);
    admin = await env.login();
  });
});

describe('cast disabled', () => {
  it('is off when CAST_ENABLED=false or PUBLIC_URL is not https', async () => {
    const was = env.ctx.cfg.CAST_ENABLED;
    const { ct } = await create();
    env.ctx.cfg.CAST_ENABLED = 'false';
    try {
      expect((await call(admin, 'GET', '/api/cast/config')).json()).toEqual({ enabled: false });
      expect((await call(admin, 'POST', '/api/cast/session', { itemId: ID })).statusCode).toBe(404);
      expect((await authz({ ct })).statusCode).toBe(401);
    } finally {
      env.ctx.cfg.CAST_ENABLED = was;
    }
  });
});

/** capabilities.subtitleExtract: PlaybackDto subtitles point at /api/items/…/stream.vtt, which the receiver reaches via a signed cast URL. */
describe('cast: FriendFlix-served subtitles (subtitleExtract)', () => {
  type Jf = typeof env.ctx.jf;
  const subCalls: Array<{ user: string; args: unknown[] }> = [];
  let restore: () => void = () => {};
  beforeAll(() => {
    const jf = env.ctx.jf as { -readonly [K in keyof Jf]: Jf[K] };
    const prev = { caps: jf.capabilities, prepare: jf.preparePlayback, sub: jf.subtitleStream };
    jf.capabilities = { ...prev.caps, subtitleExtract: true };
    jf.preparePlayback = async (_u, info) => ({ ...info, subtitles: info.subtitles.map((s) => ({ ...s, url: `/api/items/${ID}/subtitle/${info.mediaSourceId}/${s.index}/stream.vtt` })) });
    jf.subtitleStream = async (u, ...args) => {
      subCalls.push({ user: u.jellyfin_username, args });
      return new Response('WEBVTT\n\n00:00.000 --> 00:01.000\nHallo\n');
    };
    restore = () => Object.assign(jf, { capabilities: prev.caps, preparePlayback: prev.prepare, subtitleStream: prev.sub });
  });
  afterAll(() => restore());
  const fetchSub = (url: string) => env.app.inject({ method: 'GET', url: url.replace('https://portal.example.com', '') });

  it('the cast session carries a signed /api/cast/subtitle URL without the media token, served without a cookie', async () => {
    const { r, j, ct } = await create();
    expect(r.statusCode).toBe(200);
    const url: string = j.subtitles[0].url;
    expect(url).toMatch(new RegExp(`^https://portal\\.example\\.com/api/cast/subtitle/[0-9a-f-]{36}/${j.castId}/\\d+/[\\w-]{43}/${ID}/${MS}/2/stream\\.vtt$`));
    expect(url).not.toContain(ct);
    subCalls.length = 0;
    const s = await fetchSub(url);
    expect(s.statusCode).toBe(200);
    expect(s.body).toContain('WEBVTT');
    expect(s.headers['content-type']).toBe('text/vtt; charset=utf-8');
    expect(s.headers['access-control-allow-origin']).toBe('*'); // the receiver runs on another origin
    expect(s.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(s.headers['cache-control']).toBe('no-store');
    expect(subCalls).toEqual([{ user: expect.any(String), args: [ID, MS, 2, 'vtt'] }]);
    // other API responses keep the same-origin resource policy
    expect((await call(admin, 'GET', '/api/cast/config')).headers['cross-origin-resource-policy']).toBe('same-origin');
  });
  it('only the signed track of the token\'s item: tampered signature / track / media source / payload -> 404', async () => {
    const { j } = await create();
    const url: string = j.subtitles[0].url;
    const [, uid, cid, exp, sig] = /\/api\/cast\/subtitle\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\//.exec(url)! as unknown as string[];
    const other = await create(); // a second live token of the same account
    for (const bad of [
      url.replace(`/${sig}/`, `/${sig!.slice(0, -1)}${sig!.endsWith('A') ? 'B' : 'A'}/`),
      url.replace('/2/stream.vtt', '/3/stream.vtt'),
      url.replace(`/${MS}/`, `/${'c'.repeat(32)}/`),
      url.replace(`/${exp}/`, `/${Number(exp) + 3600}/`), // longer life
      url.replace(`/${cid}/`, `/${other.j.castId}/`), // another token
      url.replace(`/${uid}/`, `/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}/`),
      url.replace(`/${sig}/`, `/${sig}x/`),
    ]) expect((await fetchSub(bad)).statusCode, bad).toBe(404);
  });
  it('dies with its cast token (revoke) and when the item is no longer visible', async () => {
    const a = await create();
    const url: string = a.j.subtitles[0].url;
    expect((await fetchSub(url)).statusCode).toBe(200);
    visible = false;
    env.ctx.jf.forgetItems(); // item() is memoised
    try {
      expect((await fetchSub(url)).statusCode).toBe(404);
    } finally {
      visible = true;
    }
    expect((await call(admin, 'DELETE', `/api/cast/session/${a.j.castId}`)).statusCode).toBe(200);
    expect((await fetchSub(url)).statusCode).toBe(404);
  });
  it('expires with the token\'s absolute cap and is off with cast disabled or without subtitleExtract', async () => {
    const { j } = await create();
    const url: string = j.subtitles[0].url;
    const was = env.ctx.cfg.CAST_ENABLED;
    env.ctx.cfg.CAST_ENABLED = 'false';
    try {
      expect((await fetchSub(url)).statusCode).toBe(404);
    } finally {
      env.ctx.cfg.CAST_ENABLED = was;
    }
    const jf = env.ctx.jf as { capabilities: Jf['capabilities'] };
    const caps = jf.capabilities;
    jf.capabilities = { ...caps, subtitleExtract: false };
    try {
      expect((await fetchSub(url)).statusCode).toBe(404);
    } finally {
      jf.capabilities = caps;
    }
    skipClock(7 * 3600 * 1000);
    expect((await fetchSub(url)).statusCode).toBe(404);
  });
});
