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
  getMediaSession(): { editTracksInfo(r: unknown, ok: () => void, err: (e: unknown) => void): void } | null;
}
interface RemotePlayerT {
  isConnected: boolean; isPaused: boolean; isMediaLoaded: boolean; currentTime: number; duration: number; volumeLevel: number; isMuted: boolean;
  playerState: string | null; mediaInfo: unknown;
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
}
const initial: CastState = { available: false, connected: false, deviceName: '', state: 'idle', currentTime: 0, duration: 0, paused: true, volume: 1, muted: false, loaded: false };
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
let trackIds = new Map<number, number>();
let lastLoaded = false;

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

/** Loads the cast stream on the receiver; resolves false on failure. */
/** loads the token on the receiver; `autoplay` false: it stays paused at the start (a renewal while the TV is paused) */
export async function loadOnCast(info: CastInfo, activeSubtitle = -1, autoplay = true): Promise<boolean> {
  const sess = ctxT?.getCurrentSession(), ch = window.chrome?.cast;
  if (!sess || !ch) return false;
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
  trackIds = new Map();
  media.tracks = info.subtitles.map((s, i) => {
    const t = new m.Track(i + 1, m.TrackType.TEXT);
    trackIds.set(s.index, i + 1);
    t.trackContentId = s.url;
    t.trackContentType = 'text/vtt';
    t.subtype = m.TextTrackType.SUBTITLES;
    t.name = s.title;
    t.language = s.language?.slice(0, 2) || 'und';
    return t;
  });
  const req = new m.LoadRequest(media);
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
