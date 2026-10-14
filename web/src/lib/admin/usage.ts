// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Admin → Nutzung (Block 22): mirror of `backend/src/routes/usage.ts` (aggregated per account, no titles) and view helpers. */
import { fmtNumber, tr } from '#lib/i18n';
import type { TranscodeReason } from './health';

export const PERIODS = [7, 30, 90] as const;
export type Period = (typeof PERIODS)[number];
export interface UsageRow {
  userId: string; name: string; role: string; disabled: boolean; lastSeen: string | null;
  seconds: number; movieSeconds: number; seriesSeconds: number; titles: number;
  streams: number; transcodes: number; topReason: TranscodeReason | null;
  devices: number; devicesUsed: number; liveNow: number;
}
export interface UsageDevice { label: string; lastSeen: string | null; streams: number; transcodes: number; app: boolean }
export interface UsageDetail {
  userId: string; days: Array<{ day: string; seconds: number }>; devices: UsageDevice[];
  reasons: Partial<Record<TranscodeReason, number>>; since: string | null;
}

/** "1,5 Std." (one decimal under 10 h) */
export function fmtHours(seconds: number): string {
  const h = Math.max(0, seconds) / 3600;
  return tr('common.duration.h', { h: fmtNumber(h, { maximumFractionDigits: h < 10 ? 1 : 0 }) });
}

/** share of transcoded streams in % (null without streams) */
export const transcodePct = (r: Pick<UsageRow, 'streams' | 'transcodes'>): number | null => (r.streams > 0 ? Math.round((r.transcodes / r.streams) * 100) : null);

/** bar heights relative to the busiest day (all zero → 0) */
export function dayBars(days: ReadonlyArray<{ day: string; seconds: number }>): Array<{ day: string; pct: number }> {
  const max = days.reduce((m, d) => Math.max(m, d.seconds), 0);
  return days.map((d) => ({ day: d.day, pct: max > 0 ? Math.round((d.seconds / max) * 100) : 0 }));
}

const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** first day of the period (the last N days including today) */
export function periodStart(days: number, today = new Date()): string {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
  return ymd(d);
}
/** "Daten seit …" only when the recorded data starts inside the chosen period */
export const showSince = (since: string | null, days: number, today = new Date()): boolean => Boolean(since && since > periodStart(days, today));
