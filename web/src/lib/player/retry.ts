/** Error recovery policy of the player (pure): what to do after the n-th fatal error. */
export const MAX_NETWORK_TRIES = 3;
export const BACKOFF_MS = [1000, 2500, 5000];
export const backoffMs = (attempt: number) => BACKOFF_MS[Math.max(0, Math.min(BACKOFF_MS.length - 1, attempt - 1))];

export type ErrorKind = 'network' | 'media' | 'other';
export interface RecoveryState { networkTries: number; mediaRecovered: boolean; loweredQuality: boolean; forcedHls: boolean }
export const freshRecovery = (): RecoveryState => ({ networkTries: 0, mediaRecovered: false, loweredQuality: false, forcedHls: false });

export type Recovery =
  | { do: 'retry'; attempt: number; delay: number }
  | { do: 'recover-media' }
  | { do: 'force-hls' }
  | { do: 'lower-quality' }
  | { do: 'fail' };

/**
 * network: up to 3 retries with backoff, resuming at the last position.
 * media: hls.recoverMediaError once, then (direct play) switch to HLS/transcode, then a lower quality; `canLowerQuality` = the quality switcher still has a lower step.
 */
export function decideRecovery(kind: ErrorKind, s: RecoveryState, o: { isHls: boolean; canLowerQuality: boolean }): Recovery {
  if (kind === 'network') return s.networkTries < MAX_NETWORK_TRIES ? { do: 'retry', attempt: s.networkTries + 1, delay: backoffMs(s.networkTries + 1) } : { do: 'fail' };
  if (kind === 'media') {
    if (o.isHls && !s.mediaRecovered) return { do: 'recover-media' };
    if (!o.isHls && !s.forcedHls) return { do: 'force-hls' };
    if (o.canLowerQuality && !s.loweredQuality) return { do: 'lower-quality' };
  }
  return { do: 'fail' };
}

/** map a MediaError code of a plain <video> to a kind (1 aborted by the user is ignored by the caller) */
export function kindOfMediaError(code: number): ErrorKind {
  return code === 2 ? 'network' : code === 3 || code === 4 ? 'media' : 'other';
}

/** next lower bitrate from the quality ladder (descending), below what plays now (0 = automatic = the source bitrate) */
export function lowerQuality(ladder: number[], current: number, sourceBitrate: number): number | null {
  const cur = current || sourceBitrate || Infinity;
  const lower = ladder.filter((b) => b < cur).sort((a, b) => b - a)[0];
  return lower ?? null;
}
