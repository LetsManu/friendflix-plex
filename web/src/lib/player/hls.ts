import type Hls from 'hls.js';
import type { HlsConfig } from 'hls.js';

/**
 * hls.js (~190 KB gzip) is loaded only on the HLS path (direct play and Safari's native HLS never need it).
 * The promise is shared, so a prefetch on hover and the player's own load use the same request; a failed load can be retried.
 */
let hlsP: Promise<typeof Hls> | null = null;
export function loadHls(importer: () => Promise<{ default: typeof Hls }> = () => import('hls.js')): Promise<typeof Hls> {
  hlsP ??= importer().then((m) => m.default).catch((e) => { hlsP = null; throw e; });
  return hlsP;
}
/** test helper */
export function resetHlsLoader() { hlsP = null; }

/** Player tuning: fetch the first fragment with the manifest, keep 90 s behind for rewinds, cap the forward buffer at 60 s. */
export function hlsConfig(startSec: number): Partial<HlsConfig> {
  return { startPosition: startSec > 1 ? startSec : -1, maxBufferLength: 30, maxMaxBufferLength: 60, backBufferLength: 90, startFragPrefetch: true };
}
