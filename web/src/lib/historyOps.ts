export interface HistoryLike { id: string; seriesId?: string }

/** Splits the history into what stays and what an optimistic removal takes away. */
export function removeFromHistory<T extends HistoryLike>(items: T[], i: T, scope: 'item' | 'series'): { kept: T[]; removed: T[] } {
  const hit = (x: T) => (scope === 'series' && i.seriesId ? x.seriesId === i.seriesId || x.id === i.seriesId : x.id === i.id);
  return { kept: items.filter((x) => !hit(x)), removed: items.filter(hit) };
}

/** Rolls back one failed removal: puts only `removed` back (in `original` order) and keeps every other change made meanwhile. */
export function restoreRemoved<T extends HistoryLike>(current: T[], removed: T[], original: T[]): T[] {
  const have = new Set(current.map((x) => x.id)), back = new Set(removed.map((x) => x.id));
  return original.filter((x) => have.has(x.id) || back.has(x.id));
}
