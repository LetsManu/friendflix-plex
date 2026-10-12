import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bus } from '../src/bus.js';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { JellyfinClient } from '../src/jellyfin/client.js';
import { JellyfinService } from '../src/jellyfin/service.js';
import { jellyfinWebhookEvents } from '../src/jellyfin/webhook.js';
import { MemoryKV } from '../src/kv.js';
import { MediaError, type MediaEvent, type MediaServer, type PlaybackDto } from '../src/media/types.js';
import { forgetAuth } from '../src/routes/internal.js';
import { applyRole } from '../src/users.js';
import { ENC_KEY, fakeHttp, makeEnv, type Call, type Handler, type TestEnv } from './helpers.js';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const key = keyFromBase64(ENC_KEY);
const BOB = { id: 'u1', jellyfin_user_id: 'jfbob', jellyfin_username: 'bob', jellyfin_pw_enc: encrypt(key, 'pw') };

function service(routes: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const svc = new JellyfinService(new JellyfinClient('http://jf.test:8096', 'adminkey', fakeHttp({
    'POST /Users/AuthenticateByName': (_u, _i, b) => ({ json: { AccessToken: `tok-${b.Username}`, User: { Id: 'x', Name: b.Username } } }),
    ...routes,
  }, calls)), new MemoryKV(), key);
  return { svc, calls };
}
const USER_TOKEN = 'Token="tok-bob"';
const ADMIN_TOKEN = 'Token="adminkey"';

describe('Jellyfin: credentials per call', () => {
  it('availableEpisodes / seasonEpisodeIds act as the user; seriesHasEpisode / libraryStreams use the admin key', async () => {
    const { svc, calls } = service({
      'GET /Items': (u) => ({ json: { Items: u.searchParams.get('parentId') ? [{ LocationType: 'FileSystem' }] : [{ Id: A, LocationType: 'FileSystem', MediaStreams: [{ Type: 'Audio', Language: 'ger' }, { Type: 'Subtitle', Language: 'eng' }, { Type: 'Video' }] }, { Id: B, LocationType: 'Virtual' }] } }),
      'GET /Shows/[^/]+/Episodes': () => ({ json: { Items: [{ Id: A, IndexNumber: 3 }] } }),
    });
    const last = () => calls.filter((c) => c.path !== '/Users/AuthenticateByName').at(-1)!;
    expect([...await svc.availableEpisodes(BOB, [A, B])]).toEqual([A]);
    expect(last().auth).toContain(USER_TOKEN);
    expect(last().search).toContain('userId=jfbob');
    expect([...await svc.seasonEpisodeIds(BOB, B, 1)]).toEqual([[3, A]]);
    expect(last().auth).toContain(USER_TOKEN);
    expect(await svc.seriesHasEpisode(B)).toBe(true);
    expect(last().auth).toContain(ADMIN_TOKEN);
    expect(last().search).not.toContain('userId');
    expect(await svc.libraryStreams('Movie', 0, 200)).toEqual([
      { id: A, seriesId: undefined, audio: ['ger'], subtitles: ['eng'] },
      { id: B, seriesId: undefined, audio: [], subtitles: [] },
    ]);
    expect(last().auth).toContain(ADMIN_TOKEN);
  });
});

describe('Jellyfin: only server-relative paths reach the server', () => {
  it.each(['http://evil.example/x', 'https://evil.example/x', '//evil.example/x', '/\\evil.example/x', 'Items/x', '', '/Items/x\n'])('refuses %j without a request', async (p) => {
    const { svc, calls } = service();
    await expect(svc.mediaFetch(BOB, p)).rejects.toBeInstanceOf(MediaError);
    expect(calls.filter((c) => c.path !== '/Users/AuthenticateByName')).toEqual([]);
  });
  it('a relative path + query goes to the configured server (also with // inside the query)', async () => {
    const { svc, calls } = service({ 'GET /Videos/[^/]+/master.m3u8': () => ({ raw: '#EXTM3U' }) });
    const r = await svc.mediaFetch(BOB, `/Videos/${A}/master.m3u8?x=//evil.example/`);
    expect(r.ok).toBe(true);
    expect(calls.at(-1)).toMatchObject({ path: `/Videos/${A}/master.m3u8`, search: '?x=//evil.example/' });
  });
});

describe('Jellyfin: the hooks are no-ops / identity', () => {
  const { svc, calls } = service({
    'POST /Sessions/Playing(/Progress|/Stopped)?': () => ({ status: 204 }),
    'GET /Videos/[^/]+/[^/]+/Subtitles/3/0/Stream.vtt': () => ({ raw: 'WEBVTT\n' }),
  });
  it('no preparePlayback / start / stop; subtitles are not extracted by FriendFlix', () => {
    const ms: MediaServer = svc;
    expect(ms.preparePlayback).toBeUndefined();
    expect(ms.start).toBeUndefined();
    expect(ms.stop).toBeUndefined();
    expect(svc.capabilities.subtitleExtract).toBe(false);
  });
  it('clipTranscode (async) only adds the transcode limits to the PlaybackInfo master', async () => {
    const info = { hlsUrl: `/media/Videos/${A}/master.m3u8?MediaSourceId=ms1&PlaySessionId=ps1&DeviceId=ff-u1`, playSessionId: 'ps1' } as PlaybackDto;
    expect(await svc.clipTranscode(BOB, info, { videoBitrate: 1_200_000, audioBitrate: 128_000, maxWidth: 1280 })).toEqual({
      path: `/Videos/${A}/master.m3u8?MediaSourceId=ms1&PlaySessionId=ps1&DeviceId=ff-u1&AllowVideoStreamCopy=false&AllowAudioStreamCopy=false&VideoBitrate=1200000&AudioBitrate=128000&MaxWidth=1280`,
      playSessionId: 'ps1',
    });
    expect((await svc.clipTranscode(BOB, info, { audioIndex: 2, fmp4: true, videoBitrate: 1, audioBitrate: 2, maxWidth: 3, stereo: true, maxBitrate: 4 })).path).toBe(
      `/Videos/${A}/master.m3u8?MediaSourceId=ms1&PlaySessionId=ps1&DeviceId=ff-u1&AudioStreamIndex=2&SegmentContainer=mp4&VideoCodec=h264&AudioCodec=aac&AllowVideoStreamCopy=false&AllowAudioStreamCopy=false&VideoBitrate=1&AudioBitrate=2&MaxWidth=3&TranscodingMaxAudioChannels=2&MaxStreamingBitrate=4`,
    );
  });
  it('report: the neutral body becomes the same Jellyfin JSON as before (key order included)', async () => {
    await svc.report(BOB, { event: 'progress', itemId: A, mediaSourceId: 'ms1', playSessionId: 'ps1', positionTicks: 50, paused: true });
    const c = calls.at(-1)!;
    expect(c.path).toBe('/Sessions/Playing/Progress');
    expect(c.auth).toContain(USER_TOKEN);
    expect(JSON.stringify(c.body)).toBe(JSON.stringify({ CanSeek: true, PlayMethod: 'DirectStream', ItemId: A, MediaSourceId: 'ms1', PlaySessionId: 'ps1', PositionTicks: 50, IsPaused: true }));
    await svc.report(BOB, { event: 'start', itemId: A, mediaSourceId: 'ms1', playSessionId: 'ps1', positionTicks: 0, paused: false, audioIndex: 2, subtitleIndex: 4, playMethod: 'Transcode' });
    expect(calls.at(-1)).toMatchObject({ path: '/Sessions/Playing', body: { PlayMethod: 'Transcode', AudioStreamIndex: 2, SubtitleStreamIndex: 4 } });
    await svc.report(BOB, { event: 'stop', itemId: A, mediaSourceId: 'ms1', playSessionId: 'ps1', positionTicks: 9, paused: false });
    expect(calls.at(-1)!.path).toBe('/Sessions/Playing/Stopped');
  });
  it('subtitleStream is the WebVTT stream the gateway serves, as the user', async () => {
    const r = await svc.subtitleStream(BOB, A, 'ms1', 3, 'vtt');
    expect(await r.text()).toBe('WEBVTT\n');
    expect(calls.at(-1)).toMatchObject({ path: `/Videos/${A}/ms1/Subtitles/3/0/Stream.vtt`, auth: expect.stringContaining(USER_TOKEN) });
  });
});

describe('Jellyfin webhook -> neutral events', () => {
  it('translates library and playback events', () => {
    expect(jellyfinWebhookEvents({ type: 'ItemAdded', itemId: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', itemType: 'Movie', provider_tmdb: '603' }))
      .toEqual([{ type: 'itemAdded', itemId: A, itemType: 'Movie', tmdbId: 603 }]);
    expect(jellyfinWebhookEvents({ type: 'ItemAdded', itemId: A, itemType: 'Episode', seriesId: B, seasonNumber: '2', episodeNumber: 5 }))
      .toEqual([{ type: 'itemAdded', itemId: A, itemType: 'Episode', seriesId: B, season: 2, episode: 5 }]);
    expect(jellyfinWebhookEvents({ type: 'ItemDeleted', itemId: A, itemType: 'Movie' })).toEqual([{ type: 'itemRemoved', itemId: A, itemType: 'Movie' }]);
    expect(jellyfinWebhookEvents({ type: 'PlaybackProgress', user: 'bob', itemId: A, name: 'F', isPaused: 'True', positionTicks: '7', deviceName: 'Fire TV' }))
      .toEqual([{ type: 'playback', state: 'progress', serverUserName: 'bob', itemId: A, name: 'F', seriesName: undefined, positionTicks: 7, runtimeTicks: undefined, paused: true, device: 'Fire TV' }]);
  });
  it('ignores what it does not know, refuses malformed bodies', () => {
    expect(jellyfinWebhookEvents({ type: 'UserDataSaved', user: 'bob', itemId: A })).toEqual([]);
    expect(jellyfinWebhookEvents({ type: 'PlaybackStart', itemId: A })).toEqual([]); // no user
    expect(jellyfinWebhookEvents({ nope: 1 })).toBeNull();
    expect(jellyfinWebhookEvents(undefined)).toBeNull();
  });
});

describe('backend: item authz endpoint, webhook dispatch, subtitle route, exact policies', () => {
  let env: TestEnv;
  const policies: Array<{ id: string; body: Record<string, unknown> }> = [];
  /** B is invisible for kids profiles (their Jellyfin user name ends in -Mia) */
  const visible = (init: RequestInit, id: string) => id === A || (id === B && !/Token="tok-[^"]*-Mia/.test(String((init.headers as Record<string, string>).Authorization)));
  beforeAll(async () => {
    env = await makeEnv({
      'POST /Users/[^/]+/Policy': (u, _i, b) => { policies.push({ id: u.pathname.split('/')[2]!, body: b }); return { status: 204 }; },
      'GET /Items/[^/]+': (u, init) => { const id = u.pathname.split('/')[2]!; return visible(init, id) ? { json: { Id: id, Name: 'X', Type: 'Movie' } } : { status: 404 }; },
      'GET /Videos/[^/]+/[^/]+/Subtitles/\\d+/0/Stream.vtt': () => ({ raw: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHallo\n' }),
    });
  });
  afterAll(() => env.close());
  afterEach(() => { policies.length = 0; });

  // the test config's internal secret (helpers.ts), read at call time so no secret-looking literal lives here
  const sec = () => ({ 'x-internal-secret': env.ctx.cfg.INTERNAL_SECRET });
  const authzItem = (payload: object, headers: Record<string, string> = sec()) => env.app.inject({ method: 'POST', url: '/internal/authz/item', headers, payload });
  const call = (s: { cookies: Record<string, string>; csrf: string }, method: string, url: string, body?: unknown) =>
    env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
  const itemCalls = () => env.jfCalls.filter((c) => c.path.startsWith('/Items/')).length;

  it('the Jellyfin webhook is dispatched as neutral events and re-emitted on the bus', async () => {
    const seen: MediaEvent[] = [];
    const on = (e: MediaEvent) => seen.push(e);
    bus.onT('media.event', on);
    try {
      await env.login();
      const user = (await env.pool.query('select jellyfin_username u from users')).rows[0].u;
      const r = await env.app.inject({ method: 'POST', url: '/internal/webhook/jellyfin', headers: { 'x-webhook-secret': 'webhook-secret-123456' }, payload: { type: 'PlaybackStart', user, itemId: A, name: 'WH', deviceName: 'TV' } });
      expect(r.statusCode).toBe(200);
      expect(seen).toMatchObject([{ type: 'playback', state: 'start', serverUserName: user, itemId: A, device: 'TV' }]);
      expect((await env.app.inject({ method: 'POST', url: '/internal/webhook/jellyfin', headers: { 'x-webhook-secret': 'webhook-secret-123456' }, payload: { nope: 1 } })).statusCode).toBe(400);
    } finally {
      bus.off('media.event', on);
    }
  });

  it('subtitle route: WebVTT of a visible item, 404 otherwise', async () => {
    const s = await env.login();
    const r = await call(s, 'GET', `/api/items/${A}/subtitle/ms1/3/stream.vtt`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/vtt');
    expect(r.body).toContain('Hallo');
    expect(env.jfCalls.at(-1)!.path).toBe(`/Videos/${A}/ms1/Subtitles/3/0/Stream.vtt`);
    expect((await call(s, 'GET', `/api/items/${'c'.repeat(32)}/subtitle/ms1/3/stream.vtt`)).statusCode).toBe(404);
    expect((await call(s, 'GET', `/api/items/${A}/subtitle/m%2Fs/3/stream.vtt`)).statusCode).toBe(400);
  });

  // exact Jellyfin policy JSON (GET /Users/<id> answers { Policy: { IsAdministrator: false, Keep: 'me' } } in the fake)
  const KEEP = { IsAdministrator: false, Keep: 'me' };
  const common = { EnableRemoteAccess: true, EnableAllFolders: true, EnabledFolders: [], EnablePlaybackRemuxing: true, EnableMediaConversion: false, EnableLiveTvAccess: false, EnableSharedDeviceControl: false };
  const ADMIN_POL = { ...KEEP, ...common, IsDisabled: false, MaxParentalRating: null, EnableVideoPlaybackTranscoding: true, EnableAudioPlaybackTranscoding: true, EnableContentDownloading: true, RemoteClientBitrateLimit: 60_000_000, MaxActiveSessions: 6 };
  const FRIEND_POL = { ...KEEP, ...common, IsDisabled: false, MaxParentalRating: null, EnableVideoPlaybackTranscoding: true, EnableAudioPlaybackTranscoding: true, EnableContentDownloading: false, RemoteClientBitrateLimit: 20_000_000, MaxActiveSessions: 2 };

  it('policy JSON: role change of an account identity and of a hidden profile identity, disable', async () => {
    const s = await env.login();
    const tom = (await call(s, 'POST', '/api/profiles', { name: 'Tom' })).json().profile;
    const tomJf = (await env.pool.query('select jellyfin_user_id j from profiles where id=$1', [tom.id])).rows[0].j as string;
    policies.length = 0;
    await applyRole(env.ctx, 'jfowner0000000000000000000000ab', 'friend', false, { hidden: false }); // no profile row: no kids fields
    await applyRole(env.ctx, tomJf, 'friend', false, { hidden: true });
    await env.ctx.jf.admin.setDisabled(tomJf, true);
    expect(policies).toEqual([
      { id: 'jfowner0000000000000000000000ab', body: FRIEND_POL },
      { id: tomJf, body: { ...FRIEND_POL, IsHidden: true, BlockUnratedItems: [] } }, // a normal profile clears an old unrated block
      { id: tomJf, body: { ...KEEP, IsDisabled: true } },
    ]);
  });

  it('policy JSON: new hidden profile, normal -> kids, kids -> normal', async () => {
    const s = await env.login();
    policies.length = 0;
    const p = (await call(s, 'POST', '/api/profiles', { name: 'Lea' })).json().profile;
    const jf = (await env.pool.query('select jellyfin_user_id j from profiles where id=$1', [p.id])).rows[0].j as string;
    expect((await call(s, 'PATCH', `/api/profiles/${p.id}`, { kids: true, maxRating: 6 })).statusCode).toBe(200);
    expect((await call(s, 'PATCH', `/api/profiles/${p.id}`, { kids: false })).statusCode).toBe(200);
    expect(policies).toEqual([
      { id: jf, body: { ...ADMIN_POL, IsHidden: true } },
      { id: jf, body: { ...ADMIN_POL, IsHidden: true, MaxParentalRating: 6, BlockUnratedItems: ['Movie', 'Series', 'Trailer'] } },
      { id: jf, body: { ...ADMIN_POL, IsHidden: true, BlockUnratedItems: [] } },
    ]);
  });

  it('/internal/authz/item: allow / deny per active profile, memoised, 401/400/403', async () => {
    const s = await env.login();
    const sid = s.cookies.ff_sid!;
    expect((await authzItem({ sid, itemId: A })).json()).toEqual({ allow: true });
    expect((await authzItem({ sid, itemId: B, kind: 'image' })).json()).toEqual({ allow: true });
    const n = itemCalls();
    expect((await authzItem({ sid, itemId: A, kind: 'subtitle' })).json()).toEqual({ allow: true });
    expect(itemCalls()).toBe(n); // memo (5 s), independent of the kind
    expect((await authzItem({ sid, itemId: 'c'.repeat(32) })).json()).toEqual({ allow: false });
    expect((await authzItem({ sid: 'x'.repeat(30), itemId: A })).statusCode).toBe(401);
    expect((await authzItem({ sid, itemId: 'nothex' })).statusCode).toBe(400);
    expect((await authzItem({ sid, itemId: A, extra: 1 })).statusCode).toBe(400);
    expect((await authzItem({ sid, itemId: A }, { 'x-internal-secret': `${env.ctx.cfg.INTERNAL_SECRET}-wrong` })).statusCode).toBe(403);

    // kids profile: same account, the profile's own visibility applies (a profile switch drops the memo of the session)
    const kid = (await call(s, 'POST', '/api/profiles', { name: 'Mia', kids: true, maxRating: 6 })).json().profile;
    const sel = await call(s, 'POST', `/api/profiles/${kid.id}/select`, {});
    expect(sel.statusCode, sel.body).toBe(200);
    const kidSid = sel.cookies.find((c) => c.name === 'ff_sid')!.value;
    expect((await authzItem({ sid: kidSid, itemId: B })).json()).toEqual({ allow: false });
    expect((await authzItem({ sid: kidSid, itemId: A })).json()).toEqual({ allow: true });
    forgetAuth(kidSid);
  });
});
