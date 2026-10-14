// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { HLS_INIT, HLS_PLAYLIST, HLS_SEGMENTS } from './hls.js';

/** Shared cast fakes of the player / cast specs: Safari's AirPlay API, the Google Cast sender SDK, the cast token endpoints. */

/**
 * AirPlay button (Safari API simulated): Chromium has no webkitShowPlaybackTargetPicker, so the spec stubs it on
 * HTMLMediaElement and fires Safari's events by hand. The real picker / receiver can only be checked on Apple hardware.
 * `pickTv`: the stubbed picker "chooses the TV" right away (Safari then reports the wireless target); `__srcAtPick` is what the TV
 * would have been handed.
 */
export async function stubAirPlay(page: Page, o: { pickTv?: boolean } = {}) {
  await page.addInitScript((pickTv) => {
    const w = window as unknown as { __picks: number; __wireless: boolean; __srcAtPick: string };
    w.__picks = 0; w.__wireless = false; w.__srcAtPick = '';
    Object.defineProperty(HTMLMediaElement.prototype, 'webkitShowPlaybackTargetPicker', { configurable: true, value(this: HTMLMediaElement) {
      w.__picks++; w.__srcAtPick = this.src;
      if (pickTv) { w.__wireless = true; this.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged')); }
    } });
    Object.defineProperty(HTMLMediaElement.prototype, 'webkitCurrentPlaybackTargetIsWireless', { configurable: true, get: () => w.__wireless });
  }, Boolean(o.pickTv));
}
/**
 * /api/cast/config enabled (the AirPlay button's gate); the Chromecast SDK Chromium then asks for is answered empty.
 * `fakeCastSdk()` must be called after this (Playwright tries the most recently added route first).
 */
export async function castOn(page: Page, enabled = true) {
  await page.route('**/api/cast/config', (r) => r.fulfill({ json: { enabled } }));
  await page.route('https://www.gstatic.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
}
/** the player plays a real HLS stream through hls.js (like Safari normally does) */
export async function mockHls(page: Page, segTypes: string[] = []) {
  await page.route('**/api/playback/info', (r) => r.fulfill({ json: {
    resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: 'ps1', roleMaxBitrate: 20_000_000, subtitles: [], audioTracks: [],
    hlsUrl: '/media/hls/4000000/out.m3u8', maxBitrate: 4_000_000, transcodeReason: 'network',
  } }));
  await page.route('**/media/hls/**', (r) => {
    const file = new URL(r.request().url()).pathname.split('/').pop()!;
    const seg = /^s(\d+)\.m4s$/.exec(file);
    if (file === 'out.m3u8') return r.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: HLS_PLAYLIST });
    if (file === 'init.mp4') return r.fulfill({ contentType: 'video/mp4', body: HLS_INIT });
    if (seg) segTypes.push(r.request().resourceType());
    if (seg) return r.fulfill({ contentType: 'video/mp4', body: HLS_SEGMENTS[Number(seg[1])]! }).catch(() => undefined);
    return r.fulfill({ status: 404 });
  });
}
export const available = (page: Page) => page.evaluate(() => document.querySelector('video')!.dispatchEvent(Object.assign(new Event('webkitplaybacktargetavailabilitychanged'), { availability: 'available' })));
export const wireless = (page: Page, on: boolean) => page.evaluate((on) => {
  (window as unknown as { __wireless: boolean }).__wireless = on;
  document.querySelector('video')!.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged'));
}, on);

/** POST /api/cast/session answers with a token URL (a test file the phone can play); `fail` -> 429 max_streams */
export async function castSessions(page: Page, o: { fail?: () => boolean; castId?: string } = {}) {
  const sessions: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  await page.route('**/api/cast/session', (r) => {
    sessions.push(r.request().postDataJSON());
    if (o.fail?.()) return r.fulfill({ status: 429, json: { error: 'max_streams', max: 1 } });
    return r.fulfill({ json: {
      castId: o.castId ?? 'c'.repeat(32), expiresAt: Date.now() + 3 * 3600_000, playSessionId: 'air-ps', mediaSourceId: 'ms', startTime: 0,
      contentUrl: `${new URL(page.url()).origin}/media/p1test.webm#airplay`, contentType: 'application/x-mpegURL', hlsSegmentFormat: 'ts', title: 'Film', subtitles: [],
    } });
  });
  await page.route('**/api/cast/session/*', (r) => { deleted.push(r.request().url().split('/').pop()!); return r.fulfill({ json: { ok: true } }); });
  return { sessions, deleted };
}
export const picks = (page: Page) => page.evaluate(() => (window as unknown as { __picks: number }).__picks);
export const srcAtPick = (page: Page) => page.evaluate(() => (window as unknown as { __srcAtPick: string }).__srcAtPick);

/** runs in the page as the Cast sender SDK (same shape as `fakeSdk()` in web/src/lib/cast.test.ts) */
function castSdkScript() {
  type Rec = { args: unknown[] } & Record<string, unknown>;
  const w = window as unknown as Record<string, unknown> & { __castLoads: unknown[]; __castCalls: string[]; __castLoadFails?: boolean; __onGCastApiAvailable?: (ok: boolean) => void; chrome?: Record<string, unknown> };
  w.__castLoads = []; w.__castCalls = [];
  const ctxListeners = new Map<string, (e: { castState?: string; sessionState?: string }) => void>();
  let anyChange: () => void = () => undefined;
  const player = { isConnected: false, isPaused: true, isMediaLoaded: false, currentTime: 0, duration: 0, volumeLevel: 1, isMuted: false, playerState: null as string | null, mediaInfo: null };
  const change = (p: Partial<typeof player>) => { Object.assign(player, p); anyChange(); };
  // the receiver plays: its clock advances (4 updates per second, like the SDK's ANY_CHANGE stream)
  setInterval(() => { if (player.isConnected && player.isMediaLoaded && !player.isPaused) change({ currentTime: player.currentTime + 0.25 }); }, 250);
  const controller = {
    addEventListener: (_t: string, fn: () => void) => { anyChange = fn; },
    playOrPause() { w.__castCalls.push('playOrPause'); change({ isPaused: !player.isPaused, playerState: player.isPaused ? 'PLAYING' : 'PAUSED' }); },
    stop() { w.__castCalls.push('stop'); },
    seek() { w.__castCalls.push(`seek:${player.currentTime}`); change({}); },
    setVolumeLevel() { w.__castCalls.push(`volume:${player.volumeLevel}`); change({}); },
    muteOrUnmute() { w.__castCalls.push('muteOrUnmute'); change({ isMuted: !player.isMuted }); },
  };
  const mediaSession = { editTracksInfo(_r: unknown, ok: () => void) { w.__castCalls.push('editTracksInfo'); ok(); } };
  const session = {
    getCastDevice: () => ({ friendlyName: 'Wohnzimmer-TV' }),
    async loadMedia(req: Rec): Promise<string | undefined> {
      const media = req.args[0] as Rec;
      w.__castLoads.push({ contentId: media.args[0], contentType: media.args[1], currentTime: req.currentTime, activeTrackIds: req.activeTrackIds ?? [] });
      if (w.__castLoadFails) throw new Error('LOAD_FAILED'); // the receiver cannot play it
      setTimeout(() => change({ isMediaLoaded: true, isPaused: false, playerState: 'PLAYING', currentTime: Number(req.currentTime) || 0, duration: Number(media.duration) || 600 }), 0);
      return undefined;
    },
    getMediaSession: () => mediaSession,
  };
  const fire = (type: string, e: { castState?: string; sessionState?: string }) => ctxListeners.get(type)?.(e);
  const context = {
    current: null as typeof session | null,
    setOptions() { /* nothing to configure */ },
    addEventListener: (t: string, fn: (e: { castState?: string; sessionState?: string }) => void) => { ctxListeners.set(t, fn); },
    async requestSession(): Promise<string | undefined> { w.__castCalls.push('requestSession'); return 'cancel'; },
    getCurrentSession() { return context.current; },
    endCurrentSession() { w.__castCalls.push('endCurrentSession'); setTimeout(end, 0); },
  };
  // no class fields: the transpiled script must not depend on helpers outside this function
  class R { constructor(...args: unknown[]) { (this as unknown as Rec).args = args; } }
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
    Image: class extends R {},
    media: {
      DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845',
      MediaInfo: class extends R {}, LoadRequest: class extends R {}, MovieMediaMetadata: class extends R {}, TvShowMediaMetadata: class extends R {},
      Track: class extends R {}, EditTracksInfoRequest: class extends R {},
      StreamType: { BUFFERED: 'BUFFERED' }, HlsSegmentFormat: { TS: 'ts' }, MetadataType: { MOVIE: 1, TV_SHOW: 2 }, TrackType: { TEXT: 'TEXT' }, TextTrackType: { SUBTITLES: 'SUBTITLES' },
    },
  };
  function start() {
    context.current = session;
    player.isConnected = true;
    fire('caststatechanged', { castState: 'CONNECTED' });
    fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
  }
  function end() {
    context.current = null;
    Object.assign(player, { isConnected: false, isMediaLoaded: false, isPaused: true, playerState: null });
    fire('caststatechanged', { castState: 'NOT_CONNECTED' });
    fire('sessionstatechanged', { sessionState: 'SESSION_ENDED' });
  }
  /** the Default Media Receiver reports a finished media as IDLE, nothing loaded */
  const finish = () => change({ isMediaLoaded: false, isPaused: true, playerState: 'IDLE' });
  /** the receiver plays the last seconds of the media (so a following `finish()` is its real end) */
  const nearEnd = () => change({ currentTime: Math.max(0, player.duration - 5) });
  w.cast = { framework };
  w.chrome = { ...(w.chrome ?? {}), cast: chromeCast };
  w.__castFake = { start, end, finish, nearEnd };
  w.__onGCastApiAvailable?.(true);
  fire('caststatechanged', { castState: 'NOT_CONNECTED' }); // a receiver is around
}

/**
 * Google Cast sender SDK fake, served for gstatic's sender script (call after `castOn()`): `loads()` = the `loadMedia` requests,
 * `calls()` = controller / context calls (`playOrPause`, `seek:<sec>`, `endCurrentSession`, ...); `start()` = the user picked
 * `Wohnzimmer-TV`, `end()` = the session ended, `nearEnd()` = the receiver jumps to the last seconds, `finish()` = the media
 * finished on the receiver (the end only counts as finished after `nearEnd()`); `failLoads()` = every
 * later `loadMedia` rejects (the receiver cannot play the title).
 */
export async function fakeCastSdk(page: Page) {
  await page.route('https://www.gstatic.com/cv/js/sender/**', (r) => r.fulfill({ contentType: 'text/javascript', body: `(${castSdkScript.toString()})();` }));
  type Fake = { start(): void; end(): void; finish(): void; nearEnd(): void };
  const ready = () => page.waitForFunction(() => Boolean((window as unknown as { __castFake?: unknown }).__castFake));
  const run = async (fn: keyof Fake) => {
    await ready();
    await page.evaluate((f) => (window as unknown as { __castFake: Fake }).__castFake[f](), fn);
  };
  return {
    loads: () => page.evaluate(() => (window as unknown as { __castLoads?: unknown[] }).__castLoads ?? []),
    calls: () => page.evaluate(() => (window as unknown as { __castCalls?: string[] }).__castCalls ?? []),
    start: () => run('start'),
    end: () => run('end'),
    finish: () => run('finish'),
    nearEnd: () => run('nearEnd'),
    failLoads: () => page.evaluate(() => { (window as unknown as { __castLoadFails: boolean }).__castLoadFails = true; }),
  };
}
