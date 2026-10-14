// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Size helpers (pure, unit-tested). Server estimates (estBytes) win; these are fallbacks and formatting.

import { fmtNumber } from '#lib/i18n';

export type QualityId = 'sd' | 'hd' | 'fhd' | 'original';

/** video+audio bit rate per preset in bit/s (plan section 1) */
export const PRESET_BPS: Record<Exclude<QualityId, 'original'>, number> = {
  sd: 1_000_000 + 128_000,
  hd: 2_500_000 + 128_000,
  fhd: 5_000_000 + 160_000,
};

const TICKS_PER_SEC = 10_000_000;

/** fallback estimate when the server gave none; 'original' cannot be estimated without the source size */
export function estimateBytes(quality: QualityId, runtimeTicks: number | undefined, sourceBytes?: number): number {
  if (quality === 'original') return sourceBytes ?? 0;
  if (!runtimeTicks || runtimeTicks <= 0) return 0;
  return Math.round(((runtimeTicks / TICKS_PER_SEC) * PRESET_BPS[quality]) / 8);
}

/** a safety margin on top of the estimate before starting (plan: estimate x 1.05) */
export const withMargin = (bytes: number): number => Math.ceil(bytes * 1.05);

/** does `needed` bytes (with margin) fit into quota - usage? Unknown quota (0/undefined) never blocks. */
export function fitsQuota(needed: number, quota: number | undefined, usage: number | undefined): boolean {
  if (!quota) return true;
  return withMargin(needed) <= quota - (usage ?? 0);
}

/** size text in the UI language: "4,2 GB" / "4.2 GB", "850 MB", "12 KB" */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  const u = [['GB', 1e9], ['MB', 1e6], ['KB', 1e3]] as const;
  for (const [name, f] of u) if (n >= f) {
    const v = n / f;
    return `${fmtNumber(v >= 100 || name !== 'GB' && v >= 10 ? Math.round(v) : Math.round(v * 10) / 10)} ${name}`;
  }
  return `${n} B`;
}

export const pct = (have: number, total: number): number => (total > 0 ? Math.min(100, Math.floor((have / total) * 100)) : 0);
