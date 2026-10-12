import { writable } from 'svelte/store';
import type { Item } from '#lib/api';
import { fmtDuration, fmtNumber, tr } from '#lib/i18n';

/** uid of the card whose pop-out preview is open (only one at a time) */
export const hoverOwner = writable<string>('');
let uidN = 0;
export const nextHoverUid = () => `hp${++uidN}`;

export interface Rect { left: number; top: number; width: number; height: number }
export interface PreviewBox {
  left: number; top: number; width: number; height: number;
  /** height of the 16:9 media area on top of the info panel */
  mediaH: number;
  /** start transform (translate + scale) that makes the pop-out grow out of the card */
  from: { dx: number; dy: number; scale: number };
}

export const HOVER_MARGIN = 12;
const MIN_W = 300, MAX_W = 480;

/**
 * Geometry of the desktop pop-out preview: ~1.5x the card width (at least 300px), centred over the card.
 * When the centred box would leave the viewport (first/last visible card of a row) it grows from the card's own
 * outer edge instead (left edge stays on the card's left edge, resp. right on right), clamped to the viewport; vertically
 * (when the bottom would overflow the box moves up, i.e. "flips" over the card).
 */
export function previewRect(card: Rect, vp: { w: number; h: number }, infoH = 170, margin = HOVER_MARGIN): PreviewBox {
  const width = Math.round(Math.min(MAX_W, Math.max(MIN_W, card.width * 1.5), Math.max(120, vp.w - 2 * margin)));
  const mediaH = Math.round((width * 9) / 16);
  const height = mediaH + Math.max(0, Math.round(infoH));
  const cx = card.left + card.width / 2;
  const minL = margin, maxL = vp.w - margin - width;
  let l = cx - width / 2;
  if (l < minL) l = card.left; // first card: align to its left edge instead of shifting past it
  else if (l > maxL) l = card.left + card.width - width; // last card: align to its right edge
  const left = Math.round(Math.max(minL, Math.min(l, maxL)));
  const idealTop = card.top + card.height / 2 - mediaH / 2;
  const maxTop = vp.h - margin - height;
  const top = Math.round(maxTop < margin ? margin : Math.max(margin, Math.min(idealTop, maxTop)));
  return { left, top, width, height, mediaH, from: { dx: Math.round(card.left - left), dy: Math.round(card.top - top), scale: card.width / width } };
}

export const fmtRuntime = (ticks?: number): string => {
  if (!ticks || ticks <= 0) return '';
  const min = Math.round(ticks / 600_000_000);
  if (min < 1) return '';
  return fmtDuration(min * 60);
};

const YEAR = 365 * 86_400_000;
/** released within the last twelve months */
export function isNewRelease(item: Pick<Item, 'premiereDate' | 'year'>, now: number): boolean {
  const t = item.premiereDate ? Date.parse(item.premiereDate) : NaN;
  if (Number.isFinite(t)) return t <= now + 30 * 86_400_000 && now - t <= YEAR;
  return item.year !== undefined && item.year >= new Date(now).getFullYear();
}

/** Length part of the meta line: "1 Std. 52 Min." / "3 Staffeln" / "8 Folgen" (empty when unknown). */
export function lengthLabel(item: Pick<Item, 'type' | 'runtimeTicks' | 'childCount'>): string {
  if (item.type === 'Series') {
    const n = item.childCount ?? 0;
    return n > 0 ? tr('home.meta.seasons', { n }) : '';
  }
  if (item.type === 'BoxSet') {
    const n = item.childCount ?? 0;
    return n > 0 ? tr('home.meta.titles', { n }) : '';
  }
  return fmtRuntime(item.runtimeTicks);
}

/** Community rating "★ 8.8", else "Neu" for fresh releases, else nothing. */
export function ratingBadge(item: Pick<Item, 'communityRating' | 'premiereDate' | 'year'>, now: number): string {
  if (item.communityRating && item.communityRating > 0) return `★ ${fmtNumber(item.communityRating, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
  return isNewRelease(item, now) ? tr('home.card.new') : '';
}

/** "Thriller • Drama • Krimi" (max 3). */
export const genreLine = (genres: readonly string[] | undefined, max = 3): string => (genres ?? []).filter(Boolean).slice(0, max).join(' • ');
