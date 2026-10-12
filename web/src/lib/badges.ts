import type { Item } from '#lib/api';
import type { Badge, FreshLabel, MediaTraits } from '#lib/fresh';
import type { TKey } from '#lib/i18n';

const DAY = 86_400_000;
/** "Neue Folgen" window in days */
export const NEW_EPISODES_DAYS = 14;

/** A series the viewer already started, with unwatched episodes, that received media within the last 14 days. */
export function hasNewEpisodes(item: Pick<Item, 'type' | 'lastAdded' | 'unplayedCount' | 'childCount' | 'playedPercentage'>, now: number): boolean {
  if (item.type !== 'Series' || !item.lastAdded || !((item.unplayedCount ?? 0) > 0)) return false;
  const t = Date.parse(item.lastAdded);
  if (!Number.isFinite(t) || t > now + DAY || now - t > NEW_EPISODES_DAYS * DAY) return false;
  const started = (item.playedPercentage ?? 0) > 0 || (item.childCount !== undefined && item.unplayedCount! < item.childCount);
  return started;
}

/** "Neu" window for titles in days (added to the library or premiered) */
export const NEW_TITLE_DAYS = 30;

/**
 * A title that is new in the library: added (lastAdded) or premiered within the last 30 days.
 * Series with new episodes get the "Neue Folgen" badge instead; episodes never count.
 */
export function isNewTitle(item: Pick<Item, 'type' | 'lastAdded' | 'premiereDate' | 'unplayedCount' | 'childCount' | 'playedPercentage'>, now: number): boolean {
  if (item.type === 'Episode' || hasNewEpisodes(item, now)) return false;
  const fresh = (iso?: string) => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) && t <= now + DAY && now - t <= NEW_TITLE_DAYS * DAY;
  };
  return fresh(item.lastAdded) || fresh(item.premiereDate);
}

// ---- Block 17 D1: one tag per card, from the server badge (lib/fresh.ts) ----
/** "Nur noch N Tage" shows this many days before the removal date (the server uses the same window) */
export const LEAVING_BADGE_DAYS = 14;

export const FRESH_KEYS: Record<FreshLabel, TKey> = {
  newEpisode: 'fresh.label.newEpisode', newSeason: 'fresh.label.newSeason', finale: 'fresh.label.finale', newSeries: 'fresh.label.newSeries', new: 'fresh.label.new',
};

export type CardTag =
  | { kind: 'leaving'; key: TKey; n: number }
  | { kind: 'fresh'; key: TKey; label: FreshLabel }
  /** the old client-side hints, used only when the badge request failed */
  | { kind: 'legacy'; key: TKey; label: 'newEpisodes' | 'new' };

/**
 * The single tag of a card. A removal date within two weeks wins over a fresh label (it is the one that costs the viewer something);
 * episodes never get a fresh label. `badge` undefined = not answered yet (nothing shown, no flicker), null = request failed (old hints).
 */
export function cardTag(badge: Badge | null | undefined, item: Pick<Item, 'type' | 'lastAdded' | 'premiereDate' | 'unplayedCount' | 'childCount' | 'playedPercentage'>, now: number): CardTag | null {
  if (badge === undefined) return null;
  if (badge === null) {
    if (hasNewEpisodes(item, now)) return { kind: 'legacy', key: 'home.card.newEpisodes', label: 'newEpisodes' };
    return isNewTitle(item, now) ? { kind: 'legacy', key: 'home.card.new', label: 'new' } : null;
  }
  if (badge.daysLeft !== undefined && badge.daysLeft >= 0 && badge.daysLeft <= LEAVING_BADGE_DAYS) {
    return { kind: 'leaving', key: badge.daysLeft === 0 ? 'fresh.leaving.today' : 'fresh.leaving.days', n: badge.daysLeft };
  }
  if (badge.fresh && item.type !== 'Episode') return { kind: 'fresh', key: FRESH_KEYS[badge.fresh], label: badge.fresh };
  return null;
}

/** Quality chips in a stable order: resolution (4K / HD), HDR flavour, audio. SD and unknown values add nothing. */
export type Chip = { id: string; key: TKey };
export function qualityChips(t: MediaTraits | null | undefined): Chip[] {
  if (!t) return [];
  const out: Chip[] = [];
  if (t.resolution === '4k') out.push({ id: '4k', key: 'fresh.q.4k' });
  else if (t.resolution === 'hd') out.push({ id: 'hd', key: 'fresh.q.hd' });
  if (t.hdr === 'dolbyvision') out.push({ id: 'dv', key: 'fresh.q.dolbyvision' });
  else if (t.hdr === 'hdr10plus') out.push({ id: 'hdr10plus', key: 'fresh.q.hdr10plus' });
  else if (t.hdr) out.push({ id: 'hdr', key: 'fresh.q.hdr' });
  if (t.audio === 'atmos') out.push({ id: 'atmos', key: 'fresh.q.atmos' });
  else if (t.audio === 'surround') out.push({ id: 'surround', key: 'fresh.q.surround' });
  else if (t.audio === 'stereo') out.push({ id: 'stereo', key: 'fresh.q.stereo' });
  return out;
}
