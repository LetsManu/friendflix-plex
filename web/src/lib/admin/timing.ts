// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Admin → Wiedergabe → Startzeit: mirror of `backend/src/playtiming.ts` (GET /api/admin/playback/timing) and view helpers. */
import { fmtNumber } from '#lib/i18n';

export const PHASES = ['info', 'manifest', 'firstFrag', 'firstFrame'] as const;
export type Phase = (typeof PHASES)[number];
export type Device = 'phone' | 'pc' | 'tv';
export interface Pct { p50: number | null; p90: number | null }
export interface TimingGroup {
  home: boolean; device: Device | null; n: number; switches: number; total: Pct; phases: Record<Phase, Pct>;
  targetDuration: number | null; seekP50: number | null; stallsPerSession: number; stallMsPerSession: number;
}
export interface TimingRow {
  at: string; home: boolean; device: Device; mode: 'direct' | 'hls' | null; qualitySwitch: boolean; bitrate: number | null; targetDuration: number | null;
  infoMs: number | null; manifestMs: number | null; firstFragMs: number | null; firstFragBytes: number | null; firstFragDlMs: number | null; firstFrameMs: number | null;
  seeks: number; seekMedianMs: number | null; seekMaxMs: number | null; stalls: number; stallMs: number; effectiveType: string | null;
}
export interface TimingView { day: TimingGroup[]; week: TimingGroup[]; recent: TimingRow[] }

/** segments this long (EXT-X-TARGETDURATION) delay the start: the first one has to be transcoded and loaded in full */
export const LONG_SEGMENT_S = 6;

/** the phase with the largest median (null without any measured phase) */
export function biggestPhase(phases: Partial<Record<Phase, number | null>>): Phase | null {
  let best: Phase | null = null, max = -1;
  for (const p of PHASES) { const v = phases[p]; if (v !== null && v !== undefined && v > max) { max = v; best = p; } }
  return best;
}
export const groupBiggest = (g: TimingGroup): Phase | null => biggestPhase(Object.fromEntries(PHASES.map((p) => [p, g.phases[p].p50])));

/** step durations of one row, like the server computes them (each phase minus the last earlier measured phase) */
export function rowSteps(r: TimingRow): Record<Phase, number | null> {
  const d = (x: number | null, ...prev: Array<number | null>) => (x === null ? null : Math.max(0, x - (prev.find((p) => p !== null) ?? 0)));
  return {
    info: r.infoMs,
    manifest: d(r.manifestMs, r.infoMs),
    firstFrag: d(r.firstFragMs, r.manifestMs, r.infoMs),
    firstFrame: d(r.firstFrameMs, r.firstFragMs, r.manifestMs, r.infoMs),
  };
}

/** the remote side's typical segment length when it is LONG_SEGMENT_S or more (null otherwise) */
export function longRemoteSegments(groups: readonly TimingGroup[]): number | null {
  const g = groups.find((x) => !x.home && x.device === null && x.n > 0);
  return g?.targetDuration !== null && g?.targetDuration !== undefined && g.targetDuration >= LONG_SEGMENT_S ? g.targetDuration : null;
}

/** home first, then remote; per side the "all devices" row first, then phone, pc, tv */
export function orderGroups(groups: readonly TimingGroup[]): TimingGroup[] {
  const rank = (g: TimingGroup) => (g.home ? 0 : 10) + (g.device === null ? 0 : g.device === 'phone' ? 1 : g.device === 'pc' ? 2 : 3);
  return [...groups].sort((a, b) => rank(a) - rank(b));
}

/** "850 ms" below a second, "3,2 s" above; "–" when not measured */
export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '–';
  return ms < 1000 ? `${fmtNumber(Math.round(ms))} ms` : `${fmtNumber(ms / 1000, { maximumFractionDigits: 1 })} s`;
}
export const fmtPct = (p: Pct): string => (p.p50 === null ? '–' : `${fmtMs(p.p50)} / ${fmtMs(p.p90)}`);
export const fmtMbit = (bps: number | null): string => (bps ? `${fmtNumber(bps / 1e6, { maximumFractionDigits: 1 })} Mbit/s` : '–');
