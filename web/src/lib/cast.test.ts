// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CastInfo } from './cast';

const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** Fake of the Cast Web Sender SDK globals (cast.framework + chrome.cast), recording what the sender does. */
function fakeSdk() {
  const ctxListeners = new Map<string, (e: { castState?: string; sessionState?: string }) => void>();
  let anyChange: () => void = () => undefined;
  const player = { isConnected: false, isPaused: true, isMediaLoaded: false, currentTime: 0, duration: 0, volumeLevel: 1, isMuted: false, playerState: null as string | null, mediaInfo: null as { contentId: string } | null };
  const controller = { playOrPause: vi.fn(), stop: vi.fn(), seek: vi.fn(), setVolumeLevel: vi.fn(), muteOrUnmute: vi.fn(), addEventListener: (_t: string, fn: () => void) => { anyChange = fn; } };
  const mediaSession = {
    editTracksInfo: vi.fn((_r: unknown, ok: () => void) => ok()),
    idleReason: null as string | null,
    items: [] as Array<{ itemId: number; media: { contentId: string } }>,
    queueInsertItems: vi.fn((r: any, ok: () => void, _err: (e: unknown) => void) => { for (const q of r.args[0]) mediaSession.items.push({ itemId: 100 + mediaSession.items.length, media: { contentId: q.args[0].args[0] } }); ok(); }),
    queueRemoveItems: vi.fn((_r: unknown, ok: () => void) => ok()),
    queueNext: vi.fn((ok: () => void) => ok()),
  };
  const session = { getCastDevice: () => ({ friendlyName: 'Living Room TV' }), loadMedia: vi.fn(async (_r: any): Promise<string | undefined> => undefined), media: mediaSession as typeof mediaSession | null, getMediaSession() { return this.media; } };
  const context = {
    setOptions: vi.fn(),
    addEventListener: (t: string, fn: (e: { castState?: string; sessionState?: string }) => void) => ctxListeners.set(t, fn),
    requestSession: vi.fn(async (): Promise<string | undefined> => undefined),
    current: null as typeof session | null,
    getCurrentSession() { return this.current; },
    endCurrentSession: vi.fn(),
  };
  class Rec { [k: string]: unknown; constructor(...args: unknown[]) { this.args = args; } }
  const framework = {
    CastContext: { getInstance: () => context },
    CastContextEventType: { CAST_STATE_CHANGED: 'caststatechanged', SESSION_STATE_CHANGED: 'sessionstatechanged' },
    SessionState: { SESSION_STARTED: 'SESSION_STARTED', SESSION_RESUMED: 'SESSION_RESUMED', SESSION_ENDED: 'SESSION_ENDED' },
    RemotePlayer: function RemotePlayer() { return player; },
    RemotePlayerController: function RemotePlayerController() { return controller; },
    RemotePlayerEventType: { ANY_CHANGE: 'anyChanged' },
  };
  const chromeCast = {
    AutoJoinPolicy: { ORIGIN_SCOPED: 'origin_scoped' },
    Image: class extends Rec {},
    media: {
      DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845',
      MediaInfo: class extends Rec {}, LoadRequest: class extends Rec {}, MovieMediaMetadata: class extends Rec {}, TvShowMediaMetadata: class extends Rec {},
      Track: class extends Rec {}, EditTracksInfoRequest: class extends Rec {},
      QueueItem: class extends Rec {}, QueueInsertItemsRequest: class extends Rec {}, QueueRemoveItemsRequest: class extends Rec {},
      StreamType: { BUFFERED: 'BUFFERED' }, HlsSegmentFormat: { TS: 'ts' }, MetadataType: { MOVIE: 1, TV_SHOW: 2 }, TrackType: { TEXT: 'TEXT' }, TextTrackType: { SUBTITLES: 'SUBTITLES' },
    },
  };
  return {
    framework, chromeCast, player, controller, session, context, mediaSession,
    fire: (type: string, e: { castState?: string; sessionState?: string }) => ctxListeners.get(type)!(e),
    change: (patch: Partial<typeof player>) => { Object.assign(player, patch); anyChange(); },
  };
}

let ua: string;
let platform: string;
let classes: Set<string>;
let scripts: Array<{ src: string; async: boolean }>;
let win: Record<string, any>;
let castEnabled: boolean | 'error';
const fetchMock = vi.fn(async (_url: string) => {
  if (castEnabled === 'error') return new Response('{}', { status: 500 });
  return new Response(JSON.stringify({ enabled: castEnabled }));
});
type Cast = typeof import('./cast');
let C: Cast;

beforeEach(async () => {
  ua = CHROME_UA;
  platform = 'Linux x86_64';
  classes = new Set();
  scripts = [];
  castEnabled = true;
  fetchMock.mockClear();
  win = {};
  vi.stubGlobal('navigator', { get userAgent() { return ua; }, get platform() { return platform; }, maxTouchPoints: 0 });
  vi.stubGlobal('document', {
    documentElement: { classList: { contains: (c: string) => classes.has(c) } },
    createElement: () => ({ src: '', async: false }),
    head: { appendChild: (s: { src: string; async: boolean }) => scripts.push(s) },
  });
  vi.stubGlobal('window', win);
  vi.stubGlobal('location', { pathname: '/', href: '/' });
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  C = await import('./cast');
});
afterEach(() => vi.unstubAllGlobals());

/** initCast + SDK "loaded" callback with a fake SDK installed */
async function connectSdk() {
  const sdk = fakeSdk();
  await C.initCast();
  win.cast = { framework: sdk.framework };
  win.chrome = { cast: sdk.chromeCast };
  win.__onGCastApiAvailable(true);
  return sdk;
}

describe('castCapableBrowser', () => {
  it('accepts desktop Chromium, rejects Firefox, Safari, every iOS browser and the TV mode', () => {
    expect(C.castCapableBrowser()).toBe(true);
    ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';
    expect(C.castCapableBrowser()).toBe(false);
    ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/130.0 Mobile/15E148 Safari/604.1';
    expect(C.castCapableBrowser()).toBe(false);
    ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';
    platform = 'MacIntel';
    expect(C.castCapableBrowser()).toBe(true);
    (navigator as { maxTouchPoints: number }).maxTouchPoints = 5; // iPadOS pretends to be a Mac
    expect(C.castCapableBrowser()).toBe(false);
    ua = CHROME_UA;
    platform = 'Linux';
    (navigator as { maxTouchPoints: number }).maxTouchPoints = 0;
    classes.add('tv');
    expect(C.castCapableBrowser()).toBe(false);
  });

  it('is false outside a browser', () => {
    vi.stubGlobal('navigator', undefined);
    expect(C.castCapableBrowser()).toBe(false);
  });
});

describe('castConfigEnabled', () => {
  it('asks the server once per page and remembers the answer', async () => {
    await expect(C.castConfigEnabled()).resolves.toBe(true);
    await expect(C.castConfigEnabled()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/cast/config');
  });

  it('a failed request is asked again next time', async () => {
    castEnabled = 'error';
    await expect(C.castConfigEnabled()).rejects.toThrow();
    castEnabled = false;
    await expect(C.castConfigEnabled()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('initCast', () => {
  it('loads the SDK script once when the server offers casting', async () => {
    await C.initCast();
    await C.initCast();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.src).toContain('gstatic.com/cv/js/sender/v1/cast_sender.js');
    expect(scripts[0]!.async).toBe(true);
  });

  it('loads nothing when casting is off or the browser cannot cast', async () => {
    castEnabled = false;
    await C.initCast();
    expect(scripts).toHaveLength(0);
    vi.resetModules();
    C = await import('./cast');
    ua = 'Firefox/131.0';
    await C.initCast();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(scripts).toHaveLength(0);
  });

  it('retries on the next call after the config request failed (e.g. not logged in yet)', async () => {
    castEnabled = 'error';
    await C.initCast();
    expect(scripts).toHaveLength(0);
    castEnabled = true;
    await C.initCast();
    expect(scripts).toHaveLength(1);
  });

  it('configures the Default Media Receiver with origin-scoped auto join when the SDK reports ready', async () => {
    const sdk = await connectSdk();
    expect(sdk.context.setOptions).toHaveBeenCalledWith({ receiverApplicationId: 'CC1AD845', autoJoinPolicy: 'origin_scoped' });
  });

  it('does nothing when the SDK reports unavailable or its globals are missing', async () => {
    await C.initCast();
    win.__onGCastApiAvailable(false);
    win.__onGCastApiAvailable(true); // no globals installed
    expect(await C.requestCastSession()).toBe(false);
  });
});

describe('session and player state', () => {
  it('tracks device availability, session start/resume/end and emits events', async () => {
    const sdk = await connectSdk();
    const events: string[] = [];
    const off = C.onCastEvent((e) => events.push(e));
    sdk.fire('caststatechanged', { castState: 'NOT_CONNECTED' });
    expect(get(C.castState).available).toBe(true);
    sdk.fire('caststatechanged', { castState: 'NO_DEVICES_AVAILABLE' });
    expect(get(C.castState).available).toBe(false);

    sdk.context.current = sdk.session;
    Object.assign(sdk.player, { isConnected: true, playerState: 'PLAYING', currentTime: 12, duration: 3600, isPaused: false, volumeLevel: 0.5 });
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
    expect(get(C.castState)).toMatchObject({ connected: true, deviceName: 'Living Room TV', state: 'playing', currentTime: 12, duration: 3600, paused: false, volume: 0.5 });
    expect(C.castConnected()).toBe(true);
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_RESUMED' });
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_ENDED' });
    expect(get(C.castState)).toMatchObject({ connected: false, deviceName: '', state: 'idle', loaded: false });
    expect(events).toEqual(['session-start', 'session-end']); // resume starts nothing on its own
    off();
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
    expect(events).toHaveLength(2);
  });

  it('emits media-end once when loaded media goes idle on the receiver', async () => {
    const sdk = await connectSdk();
    const events: string[] = [];
    C.onCastEvent((e) => events.push(e));
    sdk.context.current = sdk.session;
    sdk.change({ isConnected: true, isMediaLoaded: true, playerState: 'PLAYING' });
    expect(get(C.castState).loaded).toBe(true);
    sdk.change({ isMediaLoaded: false, playerState: 'IDLE' });
    sdk.change({ currentTime: 1 });
    expect(events).toEqual(['media-end']);
    // disconnecting is not "media finished"
    sdk.change({ isMediaLoaded: true, playerState: 'PLAYING' });
    sdk.context.current = null;
    sdk.change({ isConnected: false, isMediaLoaded: false, playerState: null });
    expect(events).toEqual(['media-end']);
    expect(get(C.castState)).toMatchObject({ connected: false, deviceName: '', state: 'idle' });
  });

  it('the receiver\'s idle reason comes with media-end, also when the SDK already dropped its media session', async () => {
    const sdk = await connectSdk();
    const seen: Array<string | null> = [];
    C.onCastEvent((e) => { if (e === 'media-end') seen.push(get(C.castState).idleReason); });
    sdk.context.current = sdk.session;
    sdk.change({ isConnected: true, isMediaLoaded: true, playerState: 'PLAYING', mediaInfo: { contentId: 'https://p/a.m3u8' } });
    expect(get(C.castState)).toMatchObject({ contentId: 'https://p/a.m3u8', idleReason: null });
    // the SDK updates the media object in place (IDLE / FINISHED), then forgets it
    sdk.mediaSession.idleReason = 'FINISHED';
    sdk.session.media = null;
    sdk.change({ isMediaLoaded: false, playerState: 'IDLE', mediaInfo: null });
    expect(seen).toEqual(['FINISHED']);
    // a new media: the old reason is gone
    sdk.session.media = { ...sdk.mediaSession, idleReason: null };
    sdk.change({ isMediaLoaded: true, playerState: 'PLAYING' });
    expect(get(C.castState).idleReason).toBeNull();
  });

  it('requestCastSession: true on success, false on cancel or error, false before the SDK is ready', async () => {
    expect(await C.requestCastSession()).toBe(false);
    const sdk = await connectSdk();
    expect(await C.requestCastSession()).toBe(true);
    sdk.context.requestSession.mockResolvedValueOnce('cancel');
    expect(await C.requestCastSession()).toBe(false);
    sdk.context.requestSession.mockRejectedValueOnce(new Error('session_error'));
    expect(await C.requestCastSession()).toBe(false);
  });
});

describe('loadOnCast', () => {
  const info: CastInfo = {
    castId: 'c', expiresAt: 0, playSessionId: 'ps', mediaSourceId: 'ms', runtimeTicks: 36_000_000_000, startTime: 95,
    contentUrl: 'https://p/media/c/TOKEN/Videos/x/master.m3u8', contentType: 'application/x-mpegURL', hlsSegmentFormat: 'ts',
    title: 'Pilot', seriesName: 'Show', imageUrl: 'https://p/img.jpg',
    subtitles: [{ index: 3, language: 'deu', title: 'Deutsch', url: 'https://p/s3.vtt' }, { index: 7, title: 'Unknown', url: 'https://p/s7.vtt' }],
  };

  it('is false without a session', async () => {
    expect(await C.loadOnCast(info)).toBe(false);
  });

  it('builds a buffered HLS load request with episode metadata, subtitle tracks and the active track', async () => {
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    expect(await C.loadOnCast(info, 7)).toBe(true);
    const req = sdk.session.loadMedia.mock.calls[0]![0];
    const media = req.args[0];
    expect(media.args).toEqual([info.contentUrl, info.contentType]);
    expect(media).toMatchObject({ streamType: 'BUFFERED', hlsSegmentFormat: 'ts', duration: 3600 });
    expect(media.metadata).toMatchObject({ metadataType: 2, title: 'Pilot', seriesTitle: 'Show' });
    expect(media.metadata.images[0].args).toEqual(['https://p/img.jpg']);
    expect(media.tracks.map((t: any) => [t.args[0], t.language, t.name, t.trackContentId, t.trackContentType])).toEqual([
      [1, 'de', 'Deutsch', 'https://p/s3.vtt', 'text/vtt'],
      [2, 'und', 'Unknown', 'https://p/s7.vtt', 'text/vtt'],
    ]);
    expect(req).toMatchObject({ currentTime: 95, autoplay: true, activeTrackIds: [2] });
  });

  it('autoplay false loads paused', async () => {
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    expect(await C.loadOnCast(info, -1, false)).toBe(true);
    expect(sdk.session.loadMedia.mock.calls[0]![0]).toMatchObject({ autoplay: false });
  });

  it('a movie without image or runtime, no active subtitle; a receiver error is false', async () => {
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    const movie = { ...info, seriesName: undefined, imageUrl: undefined, runtimeTicks: undefined, subtitles: [] };
    expect(await C.loadOnCast(movie)).toBe(true);
    const req = sdk.session.loadMedia.mock.calls[0]![0];
    expect(req.args[0].metadata).toMatchObject({ metadataType: 1, title: 'Pilot' });
    expect(req.args[0].metadata.images).toBeUndefined();
    expect(req.args[0].duration).toBeUndefined();
    expect(req.activeTrackIds).toBeUndefined();
    sdk.session.loadMedia.mockResolvedValueOnce('load_failed');
    expect(await C.loadOnCast(movie)).toBe(false);
    sdk.session.loadMedia.mockRejectedValueOnce(new Error('x'));
    expect(await C.loadOnCast(movie)).toBe(false);
  });
});

describe('receiver queue (next episode)', () => {
  const next: CastInfo = {
    castId: 'n', expiresAt: 0, playSessionId: 'ps2', mediaSourceId: 'ms2', runtimeTicks: 18_000_000_000, startTime: 30,
    contentUrl: 'https://p/media/c/NEXT/Videos/y/master.m3u8', contentType: 'application/x-mpegURL', hlsSegmentFormat: 'ts',
    title: 'Second', seriesName: 'Show', subtitles: [{ index: 5, language: 'eng', title: 'English', url: 'https://p/s5.vtt' }],
  };

  it('is null without a session or when the receiver refuses', async () => {
    expect(await C.queueOnCast(next)).toBeNull();
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    sdk.mediaSession.queueInsertItems.mockImplementationOnce((_r: unknown, _ok: () => void, err: (e: unknown) => void) => err(new Error('INVALID_REQUEST')));
    expect(await C.queueOnCast(next)).toBeNull();
    // an SDK without the queue API (older sender, test fakes): null, never a page error
    delete (sdk.chromeCast.media as Record<string, unknown>).QueueItem;
    await expect(C.queueOnCast(next)).resolves.toBeNull();
  });

  it('queues the next title after the playing one (autoplay, preload, its resume position) and returns its queue item id', async () => {
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    expect(await C.queueOnCast(next)).toBe(100);
    const req = sdk.mediaSession.queueInsertItems.mock.calls[0]![0];
    const item = req.args[0][0];
    expect(item).toMatchObject({ autoplay: true, startTime: 30, preloadTime: C.QUEUE_PRELOAD_S });
    expect(item.args[0].args).toEqual([next.contentUrl, next.contentType]);
    expect(item.args[0].metadata).toMatchObject({ title: 'Second', seriesTitle: 'Show' });
    C.castQueueNext();
    expect(sdk.mediaSession.queueNext).toHaveBeenCalledTimes(1);
    C.castQueueRemove(100);
    expect((sdk.mediaSession.queueRemoveItems.mock.calls[0] as any[])[0].args[0]).toEqual([100]);
  });

  it('subtitles follow the title the receiver plays (after it moved on to the queued one)', async () => {
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    await C.loadOnCast({ ...next, contentUrl: 'https://p/first.m3u8', subtitles: [{ index: 5, title: 'X', url: 'x.vtt' }, { index: 6, title: 'Y', url: 'y.vtt' }] });
    await C.queueOnCast({ ...next, subtitles: [{ index: 9, title: 'Z', url: 'z.vtt' }, { index: 6, title: 'Y', url: 'y2.vtt' }] });
    sdk.change({ isConnected: true, isMediaLoaded: true, playerState: 'PLAYING', mediaInfo: { contentId: next.contentUrl } });
    C.castSetSubtitle(6);
    expect((sdk.mediaSession.editTracksInfo.mock.calls.at(-1) as any[])[0].args[0]).toEqual([2]);
  });
});

describe('remote controls', () => {
  it('are no-ops before the SDK is ready', () => {
    expect(() => { C.castPlayPause(); C.castPlay(); C.castPause(); C.castSeek(10); C.castSetVolume(1); C.castToggleMute(); C.castSetSubtitle(1); C.castStop(); }).not.toThrow();
  });

  it('drive the remote player controller', async () => {
    const sdk = await connectSdk();
    C.castPlayPause();
    expect(sdk.controller.playOrPause).toHaveBeenCalledTimes(1);
    sdk.player.isPaused = true;
    C.castPause(); // already paused
    C.castPlay();
    expect(sdk.controller.playOrPause).toHaveBeenCalledTimes(2);
    sdk.player.isPaused = false;
    C.castPlay(); // already playing
    C.castPause();
    expect(sdk.controller.playOrPause).toHaveBeenCalledTimes(3);
    C.castSeek(-5);
    expect(sdk.player.currentTime).toBe(0);
    expect(sdk.controller.seek).toHaveBeenCalled();
    C.castSetVolume(3);
    expect(sdk.player.volumeLevel).toBe(1);
    C.castSetVolume(-1);
    expect(sdk.player.volumeLevel).toBe(0);
    C.castToggleMute();
    expect(sdk.controller.muteOrUnmute).toHaveBeenCalled();
    C.castStop();
    expect(sdk.context.endCurrentSession).toHaveBeenCalledWith(true);
  });

  it('castSetSubtitle switches to the cast track of a subtitle index, or turns subtitles off', async () => {
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    await C.loadOnCast({ castId: 'c', expiresAt: 0, playSessionId: 'p', mediaSourceId: 'm', startTime: 0, contentUrl: 'u', contentType: 't', hlsSegmentFormat: 'ts', title: 'x', subtitles: [{ index: 4, title: 'EN', language: 'eng', url: 'e.vtt' }] });
    C.castSetSubtitle(4);
    C.castSetSubtitle(-1);
    expect(sdk.mediaSession.editTracksInfo.mock.calls.map((c: any[]) => c[0].args[0])).toEqual([[1], []]);
  });
});
