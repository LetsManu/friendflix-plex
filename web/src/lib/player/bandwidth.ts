// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Throughput estimate for the adaptive quality: an EWMA over the bytes/time of each finished media fetch.
 *
 * - Small transfers (under minBytes) say more about latency than about bandwidth, so they are ignored.
 * - Outlier damping: a sample counts at most 1.5x the current estimate, so one burst on a fast link cannot
 *   push the quality up in a single step. A stall (a slow sample) is taken as it comes, so a drop reacts quickly.
 * - The last estimate is remembered for 7 days (localStorage `ff_bw`) to start with a sane quality. Storage can throw
 *   (private mode, blocked site data): every access is guarded and the player works without it.
 */

const KEY = 'ff_bw';
const WEEK_MS = 7 * 86400000;
const ALPHA = 0.3;
const CAP = 1.5;
const MIN_BYTES = 64 * 1024;

export class BandwidthEstimator {
  private readonly alpha: number;
  private readonly minBytes: number;
  private bps: number | null = null;
  private n = 0;

  constructor(o: { alpha?: number; minBytes?: number } = {}) {
    this.alpha = o.alpha ?? ALPHA;
    this.minBytes = o.minBytes ?? MIN_BYTES;
  }

  /** one finished transfer: `bytes` received in `ms` milliseconds */
  add(bytes: number, ms: number): void {
    if (!(ms > 0) || !(bytes >= this.minBytes)) return; // NaN fails both guards
    const sample = (bytes * 8 * 1000) / ms;
    this.bps = this.bps === null ? sample : this.bps + this.alpha * (Math.min(sample, CAP * this.bps) - this.bps);
    this.n++;
  }

  /** bit/s, or null before the first accepted sample */
  get estimate(): number | null {
    return this.bps;
  }

  /** accepted samples so far */
  get samples(): number {
    return this.n;
  }
}

/** the remembered estimate in bit/s, or null when missing, corrupt, older than 7 days or storage is unavailable */
export function loadStoredEstimate(now: number = Date.now()): number | null {
  try {
    const raw = JSON.parse(globalThis.localStorage.getItem(KEY) ?? 'null') as { bps?: unknown; at?: unknown } | null;
    if (!raw || typeof raw.bps !== 'number' || typeof raw.at !== 'number' || !(raw.bps > 0)) return null;
    if (now - raw.at > WEEK_MS) return null;
    return raw.bps;
  } catch {
    return null;
  }
}

/** remember an estimate (bit/s) with its time; storage errors are ignored */
export function storeEstimate(bps: number, now: number = Date.now()): void {
  try {
    globalThis.localStorage.setItem(KEY, JSON.stringify({ bps, at: now }));
  } catch {
    /* private mode: not remembered */
  }
}
