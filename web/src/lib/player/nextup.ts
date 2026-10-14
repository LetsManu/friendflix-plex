// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Decides when the "Nächste Folge" / "Mehr davon" card appears and how its countdown runs. */
export interface Segment { type: string; start: number; end: number }
export const LAST_SECONDS = 25;
export const COUNTDOWN_SECONDS = 10;

/** second at which the credits begin: the Outro/Credits segment, else the last 25 s (Infinity while the duration is unknown) */
export function creditsStart(segments: Segment[], duration: number): number {
  if (!(duration > 0)) return Infinity;
  const fallback = Math.max(0, duration - LAST_SECONDS);
  const seg = segments.filter((s) => (s.type === 'outro' || s.type === 'credits') && s.start > 0 && s.start < duration).sort((a, b) => a.start - b.start)[0];
  // an "outro" in the first half is no end credits (some providers tag mid-episode recaps that way)
  return seg && seg.start >= duration / 2 ? seg.start : fallback;
}

export type NextKind = 'episode' | 'movie' | 'none';
export function nextKind(type: string | undefined, hasNext: boolean): NextKind {
  if (type === 'Episode') return hasNext ? 'episode' : 'none';
  return type === 'Movie' ? 'movie' : 'none';
}

/** true while the card should be on screen */
export function cardVisible(o: { kind: NextKind; current: number; start: number; dismissed: boolean }): boolean {
  return o.kind !== 'none' && !o.dismissed && Number.isFinite(o.start) && o.current >= o.start;
}

/** whether reaching zero may start the next episode by itself */
export function mayAutoplay(o: { kind: NextKind; autoplayNext: boolean; sleepAfterEpisode: boolean; askStill: boolean }): boolean {
  return o.kind === 'episode' && o.autoplayNext && !o.sleepAfterEpisode && !o.askStill;
}

/** countdown that only runs while the film plays: returns the new elapsed ms */
export function advanceCountdown(elapsed: number, dt: number, running: boolean, total = COUNTDOWN_SECONDS * 1000): { elapsed: number; done: boolean } {
  const e = running ? Math.min(total, elapsed + Math.max(0, dt)) : elapsed;
  return { elapsed: e, done: e >= total };
}
export const secondsLeft = (elapsed: number, total = COUNTDOWN_SECONDS * 1000) => Math.max(0, Math.ceil((total - elapsed) / 1000));
/** stroke-dashoffset of a ring with circumference `c` (full at 0 elapsed, empty when done) */
export const ringOffset = (elapsed: number, c: number, total = COUNTDOWN_SECONDS * 1000) => c * Math.min(1, Math.max(0, elapsed / total));
