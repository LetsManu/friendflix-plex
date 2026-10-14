// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type Hls from 'hls.js';
import type { HlsConfig, LoadPolicy } from 'hls.js';

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

/** more patience than the hls.js defaults before a fragment / manifest load is reported as a fatal network error (the app then steps the quality down) */
const retry = (n: number) => ({ maxNumRetry: n, retryDelayMs: 1000, maxRetryDelayMs: 8000, backoff: 'exponential' as const });
const policy = (firstByteMs: number, totalMs: number, retries: number): LoadPolicy => ({
  default: { maxTimeToFirstByteMs: firstByteMs, maxLoadTimeMs: totalMs, timeoutRetry: retry(retries), errorRetry: retry(retries) },
});

/** Player tuning: fetch the first fragment with the manifest, keep 90 s behind for rewinds, buffer 60 s ahead (up to 120 s when the bitrate is low), patient load policies. */
export function hlsConfig(startSec: number): Partial<HlsConfig> {
  return {
    startPosition: startSec > 1 ? startSec : -1, maxBufferLength: 60, maxMaxBufferLength: 120, backBufferLength: 90, startFragPrefetch: true,
    manifestLoadPolicy: policy(10_000, 60_000, 4), playlistLoadPolicy: policy(10_000, 60_000, 4), fragLoadPolicy: policy(20_000, 120_000, 5),
  };
}
