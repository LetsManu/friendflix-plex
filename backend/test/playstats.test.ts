// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { recordError, resetErrorLogForTests } from '../src/errorlog.js';
import { setLive } from '../src/live.js';
import { methodOf, resetStreamsMemoForTests } from '../src/playstats.js';
import { pollJellyfinSessions } from '../src/routes/internal.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

// Block 22 Task 4: streams/transcodes per user, day and device (play_daily) and the admin's active streams.
type Sess = { cookies: Record<string, string>; csrf: string };
const TC = 'a'.repeat(32), DP = 'b'.repeat(32), FOREIGN = 'c'.repeat(32), BROKEN1 = 'd'.repeat(32), BROKEN2 = 'e'.repeat(32);
let env: TestEnv;
let admin: Sess, fritz: Sess;
let adminId = '', adminJf = '', fritzId = '';
let sessions: Array<Record<string, unknown>> = [];

const items: Record<string, Record<string, unknown>> = {
  [TC]: { Id: TC, Name: 'Ashfall', Type: 'Movie', RunTimeTicks: 100_000_000, UserData: { PlaybackPositionTicks: 0 } },
  [DP]: { Id: DP, Name: 'Bare', Type: 'Movie', RunTimeTicks: 100_000_000, UserData: { PlaybackPositionTicks: 0 } },
};
const playbackInfo: Record<string, Record<string, unknown>> = {
  [TC]: { PlaySessionId: 'ps-transcode-1', MediaSources: [{ Id: 'ms1', Container: 'mkv', SupportsDirectPlay: false, Bitrate: 2_000_000, RunTimeTicks: 100_000_000, TranscodingUrl: '/videos/x/master.m3u8?TranscodeReasons=VideoCodecNotSupported', MediaStreams: [{ Index: 0, Type: 'Video', Height: 720 }, { Index: 1, Type: 'Audio' }] }] },
  [DP]: { PlaySessionId: 'ps-direct-0001', MediaSources: [{ Id: 'ms2', Container: 'mp4', SupportsDirectPlay: true, Bitrate: 2_000_000, RunTimeTicks: 100_000_000, MediaStreams: [{ Index: 0, Type: 'Video', Height: 720 }, { Index: 1, Type: 'Audio' }] }] },
};

const as = (s: Sess, method: string, url: string, payload?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf, 'x-real-ip': '192.168.1.2' }, payload: payload as object });
const info = (s: Sess, itemId: string) => as(s, 'POST', '/api/playback/info', { itemId });
const report = (s: Sess, kind: 'start' | 'progress' | 'stop', itemId: string, playSessionId: string, playMethod: string) =>
  as(s, 'POST', `/api/playback/${kind}`, { itemId, playSessionId, mediaSourceId: 'ms1', positionTicks: 1000, isPaused: false, playMethod });
const daily = async (userId: string) => (await env.pool.query('select device_id, streams, transcodes, reasons from play_daily where user_id=$1 and day=current_date order by device_id', [userId])).rows;
const sessionOf = async (s: Sess) => JSON.parse((await env.kv.get(`sess:${s.cookies.ff_sid}`))!) as { userId: string; deviceId: string };

beforeAll(async () => {
  env = await makeEnv({
    'GET /Users/[^/]+/Items/[^/]+': (u) => {
      const i = items[u.pathname.split('/')[4]!];
      return i ? { json: i } : { status: 404 };
    },
    'POST /Items/[^/]+/PlaybackInfo': (u) => ({ json: playbackInfo[u.pathname.split('/')[2]!] }),
    'POST /Sessions/Playing.*': () => ({ status: 204 }),
    'GET /Sessions': () => ({ json: sessions }),
  });
  admin = await env.login(ADMIN);
  const a = (await env.pool.query("select id, jellyfin_user_id from users where authentik_sub='sub-admin'")).rows[0];
  adminId = a.id; adminJf = a.jellyfin_user_id;
  fritzId = (await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-f','f@example.com','Fritz','friend',$1,'Fritz',$2) returning id", ['f'.repeat(32), encrypt(env.ctx.encKey, 'pw')])).rows[0].id;
  fritz = await env.login({ sub: 'sub-f', email: 'f@example.com', name: 'Fritz', groups: [] });
});
afterAll(() => env.close());
beforeEach(async () => {
  resetErrorLogForTests();
  resetStreamsMemoForTests();
  sessions = [];
  await env.pool.query('delete from play_daily');
  for (const k of [...(await env.kv.keys('play:')), ...(await env.kv.keys('pbinfo:')), ...(await env.kv.keys('pstat:'))]) await env.kv.del(k);
});

describe('methodOf', () => {
  it('DirectPlay → direct; Transcode + reason → transcode; Transcode without reason → remux; undefined → remux', () => {
    expect(methodOf('DirectPlay', undefined)).toBe('direct');
    expect(methodOf('DirectPlay', 'videoCodec')).toBe('direct');
    expect(methodOf('Transcode', 'videoCodec')).toBe('transcode');
    expect(methodOf('Transcode', undefined)).toBe('remux');
    expect(methodOf('DirectStream', undefined)).toBe('remux');
    expect(methodOf(undefined, undefined)).toBe('remux');
  });
});

describe('recording', () => {
  it('info then start: play_daily row for (user, today, device) with streams 1, transcodes 1, reasons {videoCodec: 1}', async () => {
    const r = await info(admin, TC);
    expect(r.statusCode).toBe(200);
    expect(r.json().transcodeReason).toBe('videoCodec');
    expect((await report(admin, 'start', TC, 'ps-transcode-1', 'Transcode')).statusCode).toBe(200);
    const { deviceId } = await sessionOf(admin);
    expect(await daily(adminId)).toEqual([{ device_id: deviceId, streams: 1, transcodes: 1, reasons: { videoCodec: 1 } }]);
    // the live entry carries method, reason and device
    const live = JSON.parse((await env.kv.get(`play:${adminId}:ps-transcode-1`))!);
    expect(live).toMatchObject({ playMethod: 'transcode', transcodeReason: 'videoCodec', deviceId });
  });

  it('direct start → streams 1, transcodes 0; progress, stop and a repeated start do not count again', async () => {
    await info(admin, DP);
    await report(admin, 'start', DP, 'ps-direct-0001', 'DirectPlay');
    await report(admin, 'progress', DP, 'ps-direct-0001', 'DirectPlay');
    await report(admin, 'start', DP, 'ps-direct-0001', 'DirectPlay');
    await report(admin, 'stop', DP, 'ps-direct-0001', 'DirectPlay');
    expect(await daily(adminId)).toEqual([expect.objectContaining({ streams: 1, transcodes: 0, reasons: {} })]);
  });

  it('HLS without a server reason counts as remux (not a transcode)', async () => {
    await report(admin, 'start', DP, 'ps-noinfo-0001', 'Transcode'); // no /info for this play session
    expect(await daily(adminId)).toEqual([expect.objectContaining({ streams: 1, transcodes: 0 })]);
    expect(JSON.parse((await env.kv.get(`play:${adminId}:ps-noinfo-0001`))!).playMethod).toBe('remux');
  });

  it('prefetched info without a start → no row', async () => {
    await info(admin, TC);
    expect(await daily(adminId)).toEqual([]);
    expect(await env.kv.get(`pbinfo:${adminId}:ps-transcode-1`)).not.toBeNull();
  });

  it('a foreign Jellyfin session seen twice by the poller is counted once, device "app:Infuse"', async () => {
    sessions = [{
      Id: 'sx', UserId: 'f'.repeat(32), DeviceId: 'infuse-1', Client: 'Infuse<script>', DeviceName: 'Apple TV',
      NowPlayingItem: { Id: FOREIGN, Name: 'Pilot', Type: 'Episode', SeriesName: 'Show' },
      PlayState: { PlayMethod: 'Transcode', IsPaused: false }, TranscodingInfo: { TranscodeReasons: ['AudioCodecNotSupported'] },
    }];
    await pollJellyfinSessions(env.ctx);
    await pollJellyfinSessions(env.ctx);
    expect(await daily(fritzId)).toEqual([{ device_id: 'app:Infusescript', streams: 1, transcodes: 1, reasons: { audioCodec: 1 } }]);
    expect(JSON.stringify(await daily(fritzId))).not.toMatch(/Pilot|Show/);
  });
});

describe('foreign app streams (poller)', () => {
  const infuse = (o: Record<string, unknown> = {}) => ({
    Id: 'sy', UserId: 'f'.repeat(32), DeviceId: 'infuse-2', Client: 'Infuse', DeviceName: 'Apple TV',
    NowPlayingItem: { Id: FOREIGN, Name: 'Pilot', Type: 'Episode', SeriesName: 'Show' }, PlayState: { PlayMethod: 'Transcode', IsPaused: false }, ...o,
  });

  it('a transcode first seen without reasons waits one poll and then counts as transcode with its reason', async () => {
    sessions = [infuse()];
    await pollJellyfinSessions(env.ctx);
    expect(await daily(fritzId)).toEqual([]);
    sessions = [infuse({ TranscodingInfo: { TranscodeReasons: ['VideoCodecNotSupported'] } })];
    await pollJellyfinSessions(env.ctx);
    await pollJellyfinSessions(env.ctx);
    expect(await daily(fritzId)).toEqual([{ device_id: 'app:Infuse', streams: 1, transcodes: 1, reasons: { videoCodec: 1 } }]);
  });

  it('a transcode that never reports reasons counts as remux on the second poll', async () => {
    sessions = [infuse()];
    await pollJellyfinSessions(env.ctx);
    await pollJellyfinSessions(env.ctx);
    expect(await daily(fritzId)).toEqual([{ device_id: 'app:Infuse', streams: 1, transcodes: 0, reasons: {} }]);
  });

  it("a non-owner profile's own server identity counts for its account", async () => {
    const pid = '00000000-0000-4000-8000-0000000000aa';
    const pjf = '9'.repeat(32);
    await env.pool.query('insert into profiles(id, user_id, name, is_owner, kids, jellyfin_user_id) values ($1, $2, $3, false, false, $4) on conflict do nothing', [pid, adminId, 'Kind', pjf]);
    try {
      sessions = [infuse({ UserId: pjf, PlayState: { PlayMethod: 'DirectPlay', IsPaused: false } })];
      await pollJellyfinSessions(env.ctx);
      expect(await daily(adminId)).toEqual([{ device_id: 'app:Infuse', streams: 1, transcodes: 0, reasons: {} }]);
    } finally {
      await env.pool.query('delete from profiles where id=$1', [pid]);
    }
  });
});

describe('GET /api/admin/streams', () => {
  it('a portal transcode is enriched with codecs / hardware from transcodeSessions; foreign apps come from it too', async () => {
    await info(admin, TC);
    await report(admin, 'start', TC, 'ps-transcode-1', 'Transcode');
    const { deviceId } = await sessionOf(admin);
    await env.pool.query('update devices set label=$3 where user_id=$1 and device_id=$2', [adminId, deviceId, 'Wohnzimmer-Laptop']);
    sessions = [
      { Id: 's1', UserId: adminJf, DeviceId: `ff-${adminId}`, Client: 'FriendFlix', DeviceName: 'Portal', NowPlayingItem: { Id: TC, Name: 'Ashfall', Type: 'Movie' },
        PlayState: { PlayMethod: 'Transcode', IsPaused: false }, TranscodingInfo: { VideoCodec: 'h264', AudioCodec: 'aac', HardwareAccelerationType: 'vaapi', TranscodeReasons: ['VideoCodecNotSupported'], Url: 'http://jellyfin:8096/x?api_key=zz' } },
      { Id: 's2', UserId: 'f'.repeat(32), DeviceId: 'infuse-1', Client: 'Infuse', DeviceName: 'Apple TV', NowPlayingItem: { Id: FOREIGN, Name: 'Pilot', Type: 'Episode', SeriesName: 'Show', Path: '/mnt/media/pilot.mkv' },
        PlayState: { PlayMethod: 'DirectPlay', IsPaused: true } },
    ];
    const r = await as(admin, 'GET', '/api/admin/streams');
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.details).toBe(true);
    expect(j.streams).toEqual([
      { userId: adminId, userName: 'Admin', profileName: null, device: 'Wohnzimmer-Laptop', title: 'Ashfall', seriesName: null, source: 'portal', method: 'transcode', reason: 'videoCodec', videoCodec: 'h264', audioCodec: 'aac', hardware: true, paused: false },
      { userId: fritzId, userName: 'Fritz', profileName: null, device: 'Infuse · Apple TV', title: 'Pilot', seriesName: 'Show', source: 'app', method: 'direct', reason: null, videoCodec: null, audioCodec: null, hardware: null, paused: true },
    ]);
    expect(j.totals).toEqual({ direct: 1, remux: 0, transcode: 1 });
    const json = r.body;
    for (const bad of ['api_key', 'http://', '/mnt/media', 'jellyfin:8096']) expect(json).not.toContain(bad);
  });

  it('transcodeSessions throws → details false, method from live; foreign streams from live entries', async () => {
    await info(admin, TC);
    await report(admin, 'start', TC, 'ps-transcode-1', 'Transcode');
    await setLive(env.ctx, { userId: fritzId, userName: 'Fritz', itemId: FOREIGN, title: 'Pilot', seriesName: 'Show', positionTicks: 0, isPaused: false, playSessionId: 'jf-sx', updatedAt: Date.now(), source: 'jellyfin' });
    const orig = env.ctx.jf.admin.transcodeSessions;
    env.ctx.jf.admin.transcodeSessions = async () => { throw new Error('boom http://jellyfin:8096'); };
    try {
      const j = (await as(admin, 'GET', '/api/admin/streams')).json();
      expect(j.details).toBe(false);
      expect(j.streams).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: 'Ashfall', source: 'portal', method: 'transcode', reason: 'videoCodec', videoCodec: null, hardware: null }),
        expect.objectContaining({ title: 'Pilot', source: 'app', method: null, reason: null, device: null }),
      ]));
      expect(j.totals).toEqual({ direct: 0, remux: 0, transcode: 1 });
    } finally {
      env.ctx.jf.admin.transcodeSessions = orig;
    }
  });

  it('a server without transcodeSessions → details false', async () => {
    const orig = env.ctx.jf.admin.transcodeSessions;
    delete (env.ctx.jf.admin as { transcodeSessions?: unknown }).transcodeSessions;
    try {
      expect((await as(admin, 'GET', '/api/admin/streams')).json()).toMatchObject({ details: false, streams: [] });
    } finally {
      env.ctx.jf.admin.transcodeSessions = orig;
    }
  });

  it('failed playbacks of 24 h grouped by item with count and title from hygiene_items', async () => {
    await env.pool.query("insert into hygiene_items(item_id, type, name, facts) values ($1, 'Movie', 'Kaputt', '{}')", [BROKEN1]);
    const now = Date.now();
    await recordError(env.ctx, { source: 'playback', code: 'bufferStalledError', itemId: BROKEN1 }, now - 60_000);
    await recordError(env.ctx, { source: 'playback', code: 'MEDIA_ERR_DECODE', itemId: BROKEN1 }, now - 30_000);
    await recordError(env.ctx, { source: 'playback', code: 'manifestLoadError', itemId: BROKEN2 }, now - 120_000);
    await recordError(env.ctx, { source: 'playback', code: 'old', itemId: BROKEN2 }, now - 25 * 3600_000);
    const j = (await as(admin, 'GET', '/api/admin/streams')).json();
    expect(j.failed).toEqual([
      { itemId: BROKEN1, title: 'Kaputt', count: 2, lastAt: new Date(now - 30_000).toISOString(), code: 'MEDIA_ERR_DECODE' },
      { itemId: BROKEN2, title: null, count: 1, lastAt: new Date(now - 120_000).toISOString(), code: 'manifestLoadError' },
    ]);
  });

  it('friend 403; admin on a non-owner profile 403; no session 401', async () => {
    expect((await as(fritz, 'GET', '/api/admin/streams')).statusCode).toBe(403);
    const s = await env.login(ADMIN);
    const pid = '00000000-0000-4000-8000-0000000000ab';
    await env.pool.query('insert into profiles(id, user_id, name, is_owner, kids, jellyfin_user_id) values ($1, $2, $3, false, false, $4)', [pid, adminId, 'Gast', '8'.repeat(32)]);
    const raw = JSON.parse((await env.kv.get(`sess:${s.cookies.ff_sid}`))!);
    await env.kv.set(`sess:${s.cookies.ff_sid}`, JSON.stringify({ ...raw, profileId: pid }), 600);
    expect((await as(s, 'GET', '/api/admin/streams')).statusCode).toBe(403);
    await env.pool.query('delete from profiles where id=$1', [pid]);
    expect((await env.app.inject({ url: '/api/admin/streams' })).statusCode).toBe(401);
  });
});
