import type { Item } from '#lib/api';

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
