import { preloadCode } from '$app/navigation';
import { loadHls } from './hls';

/** true when this browser plays HLS itself (Safari/iOS): hls.js is never needed there */
const nativeHls = () => typeof document !== 'undefined' && document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== '';
let codeDone = false, hlsDone = false;

/**
 * Warm up the player before the click (hover/focus/touchstart of a play button): the /watch route code and, where
 * the browser needs it, hls.js. Cheap to call repeatedly; failures are ignored (the real navigation loads it again).
 * Usage: `on:pointerenter={prefetchPlayer} on:focus={prefetchPlayer} on:touchstart|passive={prefetchPlayer}` on play links.
 */
export function prefetchPlayer(): void {
  if (typeof window === 'undefined') return;
  if (!codeDone) { codeDone = true; preloadCode('/watch/[id]').catch(() => { codeDone = false; }); }
  if (!hlsDone && !nativeHls()) { hlsDone = true; loadHls().catch(() => { hlsDone = false; }); }
}
