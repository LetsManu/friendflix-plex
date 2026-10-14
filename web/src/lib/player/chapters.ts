// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { tr } from '#lib/i18n';
/** Chapters ("Szenen") of the playing video: seek bar marks, hover names and the scenes panel. Pure helpers, no DOM. */

/** One chapter as GET /api/items/:id/chapters sends it (start in seconds; name '' = unnamed; image = still URL) */
export interface Chapter { start: number; name: string; image?: string }
/** the player's trickplay info (PlaybackDto.trickplay) */
export interface Trickplay { width: number; height: number; tileWidth: number; tileHeight: number; count: number; interval: number; url: string }
/** one thumbnail cut out of a trickplay sheet, scaled to `w` px width */
export interface Frame { url: string; w: number; h: number; sw: number; sh: number; k: number; bw: number; bh: number; x: number; y: number }

/** validates the API answer: finite starts >= 0, sorted, at most one chapter per start, names trimmed */
export function normalizeChapters(raw: unknown): Chapter[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  return raw
    .filter((c): c is Chapter => !!c && typeof c === 'object' && Number.isFinite((c as Chapter).start) && (c as Chapter).start >= 0)
    .map((c) => ({ start: c.start, name: typeof c.name === 'string' ? c.name.trim() : '', ...(typeof c.image === 'string' && c.image.startsWith('/') ? { image: c.image } : {}) }))
    .sort((a, b) => a.start - b.start)
    .filter((c) => (seen.has(c.start) ? false : (seen.add(c.start), true)));
}

/** index of the chapter playing at `t` (the last one that started), -1 before the first */
export function chapterIndexAt(chs: readonly Chapter[], t: number): number {
  let i = -1;
  for (let k = 0; k < chs.length; k++) { if (chs[k]!.start <= t + 0.05) i = k; else break; }
  return i;
}

/** shown name: its own, else "Kapitel 3" in the UI language */
export const chapterLabel = (c: Chapter, i: number): string => c.name || tr('scenes.chapters.chapter', { n: i + 1 });

/** marks on the seek bar: every chapter start inside the video except the one at 0 (that is just the left edge) */
export function chapterMarks(chs: readonly Chapter[], duration: number): Array<{ i: number; pct: number }> {
  if (!(duration > 0)) return [];
  return chs.flatMap((c, i) => (c.start > 0.5 && c.start < duration - 0.5 ? [{ i, pct: (c.start / duration) * 100 }] : []));
}

/** the chapters list only makes sense with at least two chapters inside the video */
export const usefulChapters = (chs: readonly Chapter[], duration: number): boolean =>
  chs.length > 1 && (!(duration > 0) || chs.filter((c) => c.start < duration).length > 1);

/** a moment that represents the chapter better than its first (often black) frame: a few seconds in, at most a third of it */
export function thumbTime(chs: readonly Chapter[], i: number, duration: number): number {
  const c = chs[i]!, end = chs[i + 1]?.start ?? (duration > 0 ? duration : c.start + 30);
  return c.start + Math.max(0, Math.min(8, (end - c.start) / 3));
}

/** the trickplay thumbnail for `time` (seconds), `w` px wide; null without trickplay */
export function trickFrame(t: Trickplay | null | undefined, time: number, w: number): Frame | null {
  if (!t || !t.count || !t.width || !t.height || !t.interval || !t.tileWidth || !t.tileHeight) return null;
  const idx = Math.max(0, Math.min(t.count - 1, Math.floor((Math.max(0, time) * 1000) / t.interval)));
  const per = t.tileWidth * t.tileHeight, sheet = Math.floor(idx / per), within = idx % per;
  const k = w / t.width;
  return {
    url: t.url.replace('{n}', String(sheet)), w, h: Math.round(t.height * k), sw: t.width, sh: t.height, k,
    bw: t.tileWidth * t.width, bh: t.tileHeight * t.height, x: (within % t.tileWidth) * t.width, y: Math.floor(within / t.tileWidth) * t.height,
  };
}
