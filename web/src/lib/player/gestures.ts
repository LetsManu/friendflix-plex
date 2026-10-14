// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Pure maths of the touch gestures (the component feeds pointer coordinates in and applies the results). */
export type Zone = 'left' | 'center' | 'right';
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** left third / middle / right third of the stage */
export function zoneOf(x: number, width: number): Zone {
  const f = width > 0 ? x / width : 0.5;
  return f < 1 / 3 ? 'left' : f > 2 / 3 ? 'right' : 'center';
}

export interface TapState { t: number; zone: Zone; streak: number }
export interface TapResult { state: TapState; /** 'first' = might become a double tap (single-tap action is deferred), 'seek' = double/multi tap */ kind: 'first' | 'seek'; /** signed seconds of THIS tap */ by: number; /** accumulated seconds since the streak began (unsigned) */ total: number }
export const TAP_WINDOW = 350;
export const SEEK_STEP = 10;

/** Repeated taps in the same side zone within the window accumulate: tap 2 = 10 s, tap 3 = 20 s, ... */
export function registerTap(prev: TapState | null, now: number, zone: Zone, step = SEEK_STEP, windowMs = TAP_WINDOW): TapResult {
  const chained = prev !== null && now - prev.t <= windowMs && zone !== 'center' && prev.zone === zone;
  const streak = chained ? prev!.streak + 1 : 1;
  const state = { t: now, zone, streak };
  if (streak < 2) return { state, kind: 'first', by: 0, total: 0 };
  return { state, kind: 'seek', by: zone === 'left' ? -step : step, total: (streak - 1) * step };
}

export type Axis = 'scrub' | 'volume' | 'brightness' | null;
/** decides after the finger moved `slop` px: horizontal = scrub; vertical = volume (right half) / brightness (left half) */
export function classifyMove(dx: number, dy: number, startX: number, width: number, opts: { volumeOk: boolean; slop?: number } = { volumeOk: true }): Axis {
  const slop = opts.slop ?? 12;
  if (Math.hypot(dx, dy) < slop) return null;
  if (Math.abs(dx) > Math.abs(dy)) return 'scrub';
  const right = startX >= width / 2;
  if (right) return opts.volumeOk ? 'volume' : null;
  return 'brightness';
}

/** swiping the full width moves at most `maxSpan` seconds (shorter for short videos) */
export function scrubTarget(start: number, dx: number, width: number, duration: number, maxSpan = 240): number {
  if (!(duration > 0) || width <= 0) return start;
  return clamp(start + (dx / width) * Math.min(duration, maxSpan), 0, duration);
}

/** vertical drag: dragging up by 60 % of the height moves the level by the whole range (up = more) */
export function levelFromDrag(start: number, dy: number, height: number, lo = 0, hi = 1): number {
  if (height <= 0) return start;
  return clamp(start - (dy / (height * 0.6)) * (hi - lo), lo, hi);
}

export const BRIGHTNESS_MIN = 0.5;
export const brightnessPct = (b: number) => Math.round(clamp(b, BRIGHTNESS_MIN, 1) * 100);
/** iOS keeps video.volume at 1: probe by setting and reading back */
export function volumeSettable(v: { volume: number }): boolean {
  const old = v.volume;
  try { v.volume = old > 0.5 ? 0.25 : 0.75; const ok = Math.abs(v.volume - (old > 0.5 ? 0.25 : 0.75)) < 0.01; v.volume = old; return ok; } catch { return false; }
}
