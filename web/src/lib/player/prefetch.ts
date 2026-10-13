import { preloadCode } from '$app/navigation';
import { get } from 'svelte/store';
import { api, getActiveProfile } from '#lib/api';
import { prefs } from '#lib/stores';
import { loadHls } from './hls';
import { bodyKey, firstPlaybackRequest, type PlaybackDto } from './infobody';
import { markPlayArt } from './transition';

/** true when this browser plays HLS itself (Safari/iOS): hls.js is never needed there */
const nativeHls = () => typeof document !== 'undefined' && document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== '';
let codeDone = false, hlsDone = false;

/**
 * Warm up the player before the click (hover/focus/touchstart of a play button): the /watch route code and, where
 * the browser needs it, hls.js. Cheap to call repeatedly; failures are ignored (the real navigation loads it again).
 * Play links use the `playPrefetch` action below, which also starts the playback info.
 */
export function prefetchPlayer(): void {
  if (typeof window === 'undefined') return;
  if (!codeDone) { codeDone = true; preloadCode('/watch/[id]').catch(() => { codeDone = false; }); }
  if (!hlsDone && !nativeHls()) { hlsDone = true; loadHls().catch(() => { hlsDone = false; }); }
}

// ---- prefetched /api/playback/info: one entry, reused by the player for 30 s when its first request body is identical ----
export const PREFETCH_TTL_MS = 30_000;
/** hover must rest this long on a play control (sweeping the mouse across a row fires nothing) */
export const HOVER_DWELL_MS = 150;
interface Entry { itemId: string; key: string; profile: string | null; at: number; promise: Promise<PlaybackDto> }
const entries = new Map<string, Entry>();
/** the player's stop report while it is on its way: the resume position it writes must be in before a new info is asked for */
let hold: Promise<void> | null = null;
/** a stop that never answers releases the hold after this long (prefetch must not stay off until a reload) */
export const HOLD_TIMEOUT_MS = 4000;

/**
 * Called by the player when it goes away: drops any cached answer and holds new prefetches until `p` (the stop report)
 * settles. Otherwise a prefetch fired by autofocus or a quick hover could read the last progress report (up to 10 s old)
 * and a Play within 30 s would resume too early. Prefetches asked for meanwhile start after it settles, at the latest
 * after HOLD_TIMEOUT_MS.
 */
export function holdPrefetch(p: Promise<unknown>): void {
  entries.clear();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((r) => { timer = setTimeout(r, HOLD_TIMEOUT_MS); });
  const settled = Promise.resolve(p).then(() => undefined, () => undefined);
  const h: Promise<void> = Promise.race([settled, timeout]).then(() => { clearTimeout(timer); if (hold === h) hold = null; });
  hold = h;
}

/**
 * Starts POST /api/playback/info for `itemId` with the body the player will send first (saved quality or the rung for the
 * remembered bandwidth, reason hint, preferred audio). The route has no side effects (no stream slot, no live session,
 * no transcode: that starts with the stream URL), so an unused prefetch costs one Jellyfin PlaybackInfo. At most one
 * item is kept: a new one replaces the old entry. Errors (429 max_streams, network) drop the entry; the player then asks itself.
 */
export function prefetchPlayback(itemId: string, o: { audio?: string; startSec?: number } = {}): void {
  if (typeof window === 'undefined' || !itemId) return;
  if (hold) { const h = hold; void h.then(() => { if (!hold) prefetchPlayback(itemId, o); }); return; } // never before the stop settled
  const { body } = firstPlaybackRequest(itemId, get(prefs), o.audio ?? '', o.startSec);
  const key = bodyKey(body), profile = getActiveProfile(), now = Date.now();
  const cur = entries.get(itemId);
  if (cur && cur.key === key && cur.profile === profile && now - cur.at < PREFETCH_TTL_MS) return; // already on its way
  entries.clear();
  const e: Entry = { itemId, key, profile, at: now, promise: api<PlaybackDto>('/api/playback/info', { method: 'POST', body }) };
  e.promise.catch(() => { if (entries.get(itemId) === e) entries.delete(itemId); });
  entries.set(itemId, e);
}

/** the prefetched answer for exactly this request body, once; null when there is none, it is older than 30 s or the body differs */
export function takePrefetched(itemId: string, body: object): Promise<PlaybackDto> | null {
  const e = entries.get(itemId);
  if (!e) return null;
  entries.delete(itemId);
  if (Date.now() - e.at >= PREFETCH_TTL_MS || e.profile !== getActiveProfile() || e.key !== bodyKey(body)) return null;
  return e.promise;
}

/** `/watch/<id>?audio=..&t=..` -> what the player will ask for (null = not a player link) */
export function watchTarget(href: string | null | undefined): { id: string; audio?: string; startSec?: number } | null {
  if (!href || typeof location === 'undefined') return null;
  let u: URL;
  try { u = new URL(href, location.origin); } catch { return null; }
  const m = /^\/watch\/([^/]+)$/.exec(u.pathname);
  if (!m || u.origin !== location.origin) return null;
  const t = Number(u.searchParams.get('t'));
  return { id: decodeURIComponent(m[1]!), audio: u.searchParams.get('audio') ?? undefined, startSec: Number.isFinite(t) && t > 0 && t < 86_400 ? Math.floor(t) : undefined };
}

/** the artwork that grows into the player poster: `[data-play-art]` inside the play control's `[data-play-scope]` */
const artFor = (node: HTMLElement) => node.closest('[data-play-scope]')?.querySelector<HTMLElement>('[data-play-art]') ?? null;

/**
 * Svelte action for play links (`<a href="/watch/..." use:playPrefetch>`): hover (after a 150 ms dwell), focus, touchstart
 * and pointerdown warm the player code and prefetch the playback info; the click marks the artwork for the view transition.
 */
export function playPrefetch(node: HTMLElement): { destroy(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const now = () => {
    clearTimeout(timer); prefetchPlayer();
    const t = watchTarget(node.getAttribute('href'));
    if (t) prefetchPlayback(t.id, t);
  };
  const enter = () => { prefetchPlayer(); clearTimeout(timer); timer = setTimeout(now, HOVER_DWELL_MS); };
  const leave = () => clearTimeout(timer);
  // a modified / middle click opens a tab or window: no navigation here, so no artwork for a transition
  const click = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0 || e.defaultPrevented) return;
    if (watchTarget(node.getAttribute('href'))) markPlayArt(artFor(node));
  };
  const opts = { passive: true };
  node.addEventListener('pointerenter', enter);
  node.addEventListener('pointerleave', leave);
  node.addEventListener('focus', now);
  node.addEventListener('touchstart', now, opts);
  node.addEventListener('pointerdown', now);
  node.addEventListener('click', click);
  return {
    destroy() {
      clearTimeout(timer);
      node.removeEventListener('pointerenter', enter); node.removeEventListener('pointerleave', leave); node.removeEventListener('focus', now);
      node.removeEventListener('touchstart', now); node.removeEventListener('pointerdown', now); node.removeEventListener('click', click);
    },
  };
}

/** tests only */
export function _resetPrefetch(): void { entries.clear(); hold = null; }
