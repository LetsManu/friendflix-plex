import type { ItemDto } from './media/types.js';

/** Percent watched, from ticks when possible, else Jellyfin's PlayedPercentage. */
function pct(i: ItemDto): number | undefined {
  if (i.runtimeTicks && i.runtimeTicks > 0) return (i.positionTicks / i.runtimeTicks) * 100;
  return i.playedPercentage;
}

/**
 * Tidies Jellyfin's resume list: drops barely started (<2%) and nearly finished (>95%) items,
 * items the profile hid since they were last played, and keeps only the newest item per series.
 */
export function tidyResume(items: ItemDto[], hidden: Map<string, Date>, limit = 20): ItemDto[] {
  const ts = (i: ItemDto) => (i.lastPlayedDate ? Date.parse(i.lastPlayedDate) || 0 : 0);
  const best = new Map<string, ItemDto>();
  for (const i of items) {
    const p = pct(i);
    if (p !== undefined && (p < 2 || p > 95)) continue;
    const key = i.seriesId ?? i.id;
    const h = hidden.get(key);
    if (h && h.getTime() >= ts(i)) continue;
    const cur = best.get(key);
    if (!cur || ts(i) > ts(cur)) best.set(key, i);
  }
  return [...best.values()].sort((a, b) => ts(b) - ts(a)).slice(0, limit);
}
