// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Chromecast sender (Google Cast Web Sender SDK, Default Media Receiver).
 *
 * The SDK is lazy-loaded from gstatic only when it can be useful: Chromium browsers (not iOS), not in TV mode,
 * and only when the server offers casting (/api/cast/config). Nothing is loaded for everyone else.
 * The Cast globals are declared minimally below (no extra npm dependency).
 */
import { get, writable } from 'svelte/store';
import { api } from '#lib/api';

declare global {
  interface Window {
    __onGCastApiAvailable?: (available: boolean) => void;
    cast?: { framework: CastFramework };
    chrome?: { cast: ChromeCast } & Record<string, unknown>;
  }
}
interface CastFramework {
  CastContext: { getInstance(): CastContextT };
  CastContextEventType: { CAST_STATE_CHANGED: string; SESSION_STATE_CHANGED: string };
  SessionState: { SESSION_STARTED: string; SESSION_RESUMED: string; SESSION_ENDED: string };
  RemotePlayer: new () => RemotePlayerT;
  RemotePlayerController: new (p: RemotePlayerT) => RemotePlayerControllerT;
  RemotePlayerEventType: { ANY_CHANGE: string };
}
interface CastContextT {
  setOptions(o: Record<string, unknown>): void;
  addEventListener(t: string, fn: (e: { castState?: string; sessionState?: string }) => void): void;
  requestSession(): Promise<string | undefined>;
  getCurrentSession(): CastSessionT | null;
  endCurrentSession(stopCasting: boolean): void;
}
interface CastSessionT {
  getCastDevice(): { friendlyName: string };
  loadMedia(r: unknown): Promise<string | undefined>;
  getMediaSession(): MediaT | null;
}
/** chrome.cast.media.Media: the receiver's media session (updated in place by the SDK) */
interface MediaT {
  idleReason?: string | null;
  items?: Array<{ itemId: number; media?: { contentId?: string } | null }> | null;
  editTracksInfo(r: unknown, ok: () => void, err: (e: unknown) => void): void;
  queueInsertItems(r: unknown, ok: () => void, err: (e: unknown) => void): void;
  queueRemoveItems(r: unknown, ok: () => void, err: (e: unknown) => void): void;
  queueNext(ok: () => void, err: (e: unknown) => void): void;
}
interface RemotePlayerT {
  isConnected: boolean; isPaused: boolean; isMediaLoaded: boolean; currentTime: number; duration: number; volumeLevel: number; isMuted: boolean;
  playerState: string | null; mediaInfo: { contentId?: string } | null;
}
interface RemotePlayerControllerT {
  addEventListener(t: string, fn: () => void): void;
  playOrPause(): void; stop(): void; seek(): void; setVolumeLevel(): void; muteOrUnmute(): void;
}
interface ChromeCast {
  AutoJoinPolicy: { ORIGIN_SCOPED: string };
  Image: new (url: string) => unknown;
  media: {
    DEFAULT_MEDIA_RECEIVER_APP_ID: string;
    MediaInfo: new (url: string, type: string) => Record<string, unknown>;
    LoadRequest: new (m: unknown) => Record<string, unknown>;
    MovieMediaMetadata: new () => Record<string, unknown>;
    TvShowMediaMetadata: new () => Record<string, unknown>;
    Track: new (id: number, type: string) => Record<string, unknown>;
    EditTracksInfoRequest: new (ids: number[]) => unknown;
    QueueItem: new (m: unknown) => Record<string, unknown>;
    QueueInsertItemsRequest: new (items: unknown[]) => Record<string, unknown>;
    QueueRemoveItemsRequest: new (ids: number[]) => unknown;
    StreamType: { BUFFERED: string };
    HlsSegmentFormat: { TS: string };
    MetadataType: { MOVIE: number; TV_SHOW: number };
    TrackType: { TEXT: string };
    TextTrackType: { SUBTITLES: string };
  };
}

/** answer of POST /api/cast/session */
export interface CastInfo {
  castId: string;
  expiresAt: number;
  playSessionId: string;
  mediaSourceId: string;
  runtimeTicks?: number;
  startTime: number;
  contentUrl: string;
  contentType: string;
  hlsSegmentFormat: string;
  title: string;
  seriesName?: string;
  imageUrl?: string;
  subtitles: Array<{ index: number; language?: string; title: string; url: string }>;
}

export interface CastState {
  available: boolean;
  connected: boolean;
  deviceName: string;
  state: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  volume: number;
  muted: boolean;
  /** a media is loaded on the receiver */
  loaded: boolean;
  /** the receiver's media (its content URL, '' = unknown): a queued next title shows up here once the receiver moved on */
  contentId: string;
  /** why the receiver went idle (FINISHED / CANCELLED / INTERRUPTED / ERROR; null = unknown or not idle) */
  idleReason: string | null;
}
const initial: CastState = { available: false, connected: false, deviceName: '', state: 'idle', currentTime: 0, duration: 0, paused: true, volume: 1, muted: false, loaded: false, contentId: '', idleReason: null };
export const castState = writable<CastState>(initial);

export type CastEvent = 'session-start' | 'session-end' | 'media-end';
const listeners = new Set<(e: CastEvent) => void>();
/** subscribes to session start/end and "media finished on the receiver"; returns the unsubscribe function */
export function onCastEvent(fn: (e: CastEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = (e: CastEvent) => listeners.forEach((fn) => fn(e));

const SDK = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
let initStarted = false;
let ctxT: CastContextT | null = null;
let player: RemotePlayerT | null = null;
let controller: RemotePlayerControllerT | null = null;
/** subtitle index -> cast track id, per content URL (the loaded title and a queued one) */
const trackMaps = new Map<string, Map<number, number>>();
let trackIds = new Map<number, number>();
let lastLoaded = false;
/** the receiver's media session as last seen: the SDK may drop it before the idle update reaches the RemotePlayer */
let lastMedia: MediaT | null = null;

/** Chromium only (Chrome, Edge, Opera, Samsung ...), never iOS (all iOS browsers are WebKit), never a paired TV. */
export function castCapableBrowser(): boolean {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return false;
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios || !/Chrome\/|Chromium\/|CriOS/.test(ua) || /CriOS/.test(ua)) return false;
  return !document.documentElement.classList.contains('tv');
}

/** GET /api/cast/config once per page (Chromecast SDK and the AirPlay button share it); a failure is asked again next time. */
let cfgP: Promise<boolean> | null = null;
export function castConfigEnabled(): Promise<boolean> {
  cfgP ??= api<{ enabled: boolean }>('/api/cast/config').then((c) => Boolean(c?.enabled)).catch((e) => { cfgP = null; throw e; });
  return cfgP;
}

/** Loads the SDK once if casting makes sense here. Safe to call repeatedly. Never throws. */
export async function initCast(): Promise<void> {
  if (initStarted || !castCapableBrowser()) return;
  initStarted = true;
  try {
    if (!(await castConfigEnabled())) return;
    window.__onGCastApiAvailable = (ok) => { if (ok) setup(); };
    const s = document.createElement('script');
    s.src = SDK;
    s.async = true;
    document.head.appendChild(s);
  } catch {
    initStarted = false; // e.g. not logged in yet: try again on the next call
  }
}

function sync() {
  const p = player, c = ctxT;
  if (!p || !c) return;
  const sess = c.getCurrentSession();
  const loaded = p.isConnected && p.isMediaLoaded;
  const ms = sess?.getMediaSession() ?? null;
  if (ms) lastMedia = ms;
  const contentId = p.mediaInfo?.contentId ?? '';
  if (contentId && trackMaps.has(contentId)) trackIds = trackMaps.get(contentId)!;
  castState.update((s) => ({
    ...s,
    connected: p.isConnected,
    deviceName: sess?.getCastDevice().friendlyName ?? (p.isConnected ? s.deviceName : ''),
    state: p.isConnected ? (p.playerState ?? 'IDLE').toLowerCase() : 'idle',
    currentTime: p.currentTime,
    duration: p.duration,
    paused: p.isPaused,
    volume: p.volumeLevel,
    muted: p.isMuted,
    loaded,
    contentId,
    idleReason: lastMedia?.idleReason ?? null,
  }));
  // media ended on the receiver: it was loaded, and now IDLE (the Default Media Receiver reports IDLE + FINISHED)
  if (lastLoaded && !loaded && p.isConnected && (p.playerState === 'IDLE' || p.playerState === null)) emit('media-end');
  lastLoaded = loaded;
}

function setup() {
  const fw = window.cast?.framework, ch = window.chrome?.cast;
  if (!fw || !ch) return;
  ctxT = fw.CastContext.getInstance();
  ctxT.setOptions({ receiverApplicationId: ch.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: ch.AutoJoinPolicy.ORIGIN_SCOPED });
  player = new fw.RemotePlayer();
  controller = new fw.RemotePlayerController(player);
  controller.addEventListener(fw.RemotePlayerEventType.ANY_CHANGE, sync);
  ctxT.addEventListener(fw.CastContextEventType.CAST_STATE_CHANGED, (e) => {
    castState.update((s) => ({ ...s, available: e.castState !== 'NO_DEVICES_AVAILABLE' }));
  });
  ctxT.addEventListener(fw.CastContextEventType.SESSION_STATE_CHANGED, (e) => {
    if (e.sessionState === fw.SessionState.SESSION_STARTED) {
      sync();
      emit('session-start'); // the user just picked a device
    } else if (e.sessionState === fw.SessionState.SESSION_RESUMED) {
      sync(); // auto-joined an earlier session of this origin: no playback is started on its own
    } else if (e.sessionState === fw.SessionState.SESSION_ENDED) {
      lastLoaded = false;
      castState.update((s) => ({ ...s, connected: false, deviceName: '', state: 'idle', loaded: false }));
      emit('session-end');
    }
  });
}

/** Opens the browser's device picker (must run from a click). Resolves when a session started or the picker was dismissed. */
export async function requestCastSession(): Promise<boolean> {
  if (!ctxT) return false;
  try {
    return (await ctxT.requestSession()) === undefined; // undefined = success, otherwise an error code ('cancel' ...)
  } catch {
    return false;
  }
}
export const castConnected = () => get(castState).connected;

/** the receiver's MediaInfo for a cast token (metadata, subtitle tracks); its track map is kept by content URL */
function mediaOf(info: CastInfo, ch: ChromeCast): Record<string, unknown> {
  const m = ch.media;
  const media = new m.MediaInfo(info.contentUrl, info.contentType);
  media.streamType = m.StreamType.BUFFERED;
  media.hlsSegmentFormat = m.HlsSegmentFormat.TS;
  if (info.runtimeTicks) media.duration = info.runtimeTicks / 10_000_000;
  const meta = info.seriesName ? new m.TvShowMediaMetadata() : new m.MovieMediaMetadata();
  meta.metadataType = info.seriesName ? m.MetadataType.TV_SHOW : m.MetadataType.MOVIE;
  meta.title = info.title;
  if (info.seriesName) meta.seriesTitle = info.seriesName;
  if (info.imageUrl) meta.images = [new ch.Image(info.imageUrl)];
  media.metadata = meta;
  const ids = new Map<number, number>();
  media.tracks = info.subtitles.map((s, i) => {
    const t = new m.Track(i + 1, m.TrackType.TEXT);
    ids.set(s.index, i + 1);
    t.trackContentId = s.url;
    t.trackContentType = 'text/vtt';
    t.subtype = m.TextTrackType.SUBTITLES;
    t.name = s.title;
    t.language = s.language?.slice(0, 2) || 'und';
    return t;
  });
  if (trackMaps.size > 8) trackMaps.clear();
  trackMaps.set(info.contentUrl, ids);
  return media;
}

/** loads the token on the receiver; `autoplay` false: it stays paused at the start (a renewal while the TV is paused); false on failure */
export async function loadOnCast(info: CastInfo, activeSubtitle = -1, autoplay = true): Promise<boolean> {
  const sess = ctxT?.getCurrentSession(), ch = window.chrome?.cast;
  if (!sess || !ch) return false;
  const media = mediaOf(info, ch);
  trackIds = trackMaps.get(info.contentUrl)!;
  lastMedia = null; // a new media session: the previous one's idle reason is not this one's
  const req = new ch.media.LoadRequest(media);
  req.currentTime = info.startTime;
  req.autoplay = autoplay;
  const active = trackIds.get(activeSubtitle);
  if (active) req.activeTrackIds = [active];
  try {
    return (await sess.loadMedia(req)) === undefined;
  } catch {
    return false;
  }
}

/** a queued title starts loading this many seconds before the playing one ends (seamless move on, also without the sender) */
export const QUEUE_PRELOAD_S = 30;
/**
 * Puts the next title into the receiver's queue after the playing one (autoplay, its resume position): the receiver moves on
 * by itself at the end, even when the phone sleeps. Resolves the queue item id, or null (no media session, refused).
 */
export async function queueOnCast(info: CastInfo): Promise<number | null> {
  const ms = ctxT?.getCurrentSession()?.getMediaSession(), ch = window.chrome?.cast;
  if (!ms || !ch) return null;
  const m = ch.media;
  // an SDK / receiver without the queue API: null (the engine's countdown loads the next episode instead)
  const ok = await new Promise<boolean>((done) => {
    try {
      const item = new m.QueueItem(mediaOf(info, ch));
      item.autoplay = true;
      item.startTime = info.startTime;
      item.preloadTime = QUEUE_PRELOAD_S;
      ms.queueInsertItems(new m.QueueInsertItemsRequest([item]), () => done(true), () => done(false));
    } catch { done(false); }
  });
  if (!ok) return null;
  return ms.items?.find((q) => q.media?.contentId === info.contentUrl)?.itemId ?? null;
}
/** drops a queued title (its countdown was cancelled, another title plays) */
export function castQueueRemove(itemId: number) {
  const ms = ctxT?.getCurrentSession()?.getMediaSession(), ch = window.chrome?.cast;
  if (!ms || !ch) return;
  try { ms.queueRemoveItems(new ch.media.QueueRemoveItemsRequest([itemId]), () => undefined, () => undefined); } catch { /* gone with its session */ }
}
/** the receiver jumps to the queued title now (end of the countdown) */
export function castQueueNext() {
  const ms = ctxT?.getCurrentSession()?.getMediaSession();
  try { ms?.queueNext(() => undefined, () => undefined); } catch { /* gone with its session */ }
}

export const castPlayPause = () => controller?.playOrPause();
export function castPlay() { if (player?.isPaused) controller?.playOrPause(); }
export function castPause() { if (player && !player.isPaused) controller?.playOrPause(); }
export function castSeek(sec: number) { if (!player) return; player.currentTime = Math.max(0, sec); controller?.seek(); }
export function castSetVolume(v: number) { if (!player) return; player.volumeLevel = Math.max(0, Math.min(1, v)); controller?.setVolumeLevel(); }
export function castToggleMute() { controller?.muteOrUnmute(); }
/** subtitle index of the cast session info (-1 = off) */
export function castSetSubtitle(index: number) {
  const ch = window.chrome?.cast, ms = ctxT?.getCurrentSession()?.getMediaSession();
  if (!ch || !ms) return;
  const id = trackIds.get(index);
  ms.editTracksInfo(new ch.media.EditTracksInfoRequest(id ? [id] : []), () => undefined, () => undefined);
}
/** ends the cast session (the receiver stops) */
export function castStop() { ctxT?.endCurrentSession(true); }
