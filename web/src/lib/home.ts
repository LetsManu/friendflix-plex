// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Pure helpers for the home page / rows (paging, data cache, tab choice). */

/** cards rendered immediately beyond the visible ones; the rest follow on hover / scroll / idle */
export const INITIAL_EXTRA = 2;

/** number of pages of a row: page width = the visible cards, the last page may be partial */
export function pageCount(maxScroll: number, pageW: number): number {
  if (!(pageW > 0) || !(maxScroll > 0)) return 1;
  return Math.ceil(maxScroll / pageW - 0.02) + 1;
}

/** current page for a scroll position (the last page is active once the end is reached) */
export function pageIndex(scrollLeft: number, maxScroll: number, pageW: number): number {
  const n = pageCount(maxScroll, pageW);
  if (n <= 1) return 0;
  if (scrollLeft >= maxScroll - 8) return n - 1;
  return Math.max(0, Math.min(n - 1, Math.round(scrollLeft / pageW)));
}

/**
 * Small stale-while-revalidate cache for data that survives client-side navigation (module scope):
 * a fresh entry (younger than `ttl`) is served without a request, a stale one is served at once and refreshed in the background.
 */
export interface Swr<T> { get(key: string, ttl?: number): { value: T; fresh: boolean } | undefined; set(key: string, value: T): void; clear(): void }
export function createSwr<T>(ttl: number, now: () => number = Date.now): Swr<T> {
  const m = new Map<string, { value: T; at: number }>();
  return {
    get(key, maxAge = ttl) { const e = m.get(key); return e ? { value: e.value, fresh: now() - e.at < maxAge } : undefined; },
    set(key, value) { m.set(key, { value, at: now() }); },
    clear() { m.clear(); },
  };
}

/**
 * Loads `key` through the cache: calls `apply` with a cached value at once (if any) and fetches when the entry
 * is missing or stale (`ttl` overrides the cache's max age, 0 = always revalidate). Resolves when the network value (or the fresh cached one) was applied.
 * Without `onError` a failed fetch rejects. With it, `onError` runs only when nothing was applied from the cache:
 * a failed BACKGROUND refresh keeps the stale content on screen instead of wiping it.
 */
export async function swrLoad<T>(cache: Swr<unknown>, key: string, fetcher: () => Promise<T>, apply: (v: T) => void, ttl?: number, onError?: (e: unknown) => void): Promise<void> {
  const hit = cache.get(key, ttl);
  if (hit) apply(hit.value as T);
  if (hit?.fresh) return;
  let v: T;
  try { v = await fetcher(); } catch (e) {
    if (!onError) throw e;
    if (!hit) onError(e);
    return;
  }
  cache.set(key, v);
  apply(v);
}

/** /new without ?tab: first tab that has content (falls back to the first one while loading / when all are empty) */
export function firstNonEmptyTab<T extends string>(tabs: readonly T[], lists: Partial<Record<T, readonly unknown[] | null>>): T | null {
  for (const t of tabs) {
    const l = lists[t];
    if (l === null || l === undefined) return null; // still loading: decide later (keeps the order)
    if (l.length) return t;
  }
  return tabs[0] ?? null;
}

/** home page data (rows, billboard): kept for 5 minutes across client-side navigation */
export const HOME_TTL = 5 * 60_000;
export const homeCache: Swr<unknown> = createSwr<unknown>(HOME_TTL);

/** Parts of GET /api/home (first screen of the home page in one request). */
export const HOME_PARTS = ['hero', 'resume', 'nextup', 'leaving', 'recs', 'because', 'hubs', 'themed'] as const;
export type HomePart = (typeof HOME_PARTS)[number];
export interface HomeResponse<I = unknown> {
  parts: {
    hero: I | null;
    resume: I[]; nextup: I[]; leaving: I[];
    recs: { items: I[]; recIds: number[]; friends: I[] };
    because: { because: { id: string; name: string; liked?: boolean } | null; items: I[]; more: Array<{ because: { id: string; name: string }; items: I[]; engine?: 'v1' | 'v2' }>; engine?: 'v1' | 'v2' };
    /** engine v2: the row ranker's order of the recommendation rows (`friends`, `because`, `more:<n>`); absent = the fixed layout */
    order?: string[];
    hubs: unknown[]; themed: unknown[];
  };
  failed: string[];
}

/** Parts the page has to load the old way (per-row endpoints): the ones the server flagged and any part that is missing or malformed. */
export function failedParts(r: HomeResponse | null | undefined): Set<HomePart> {
  const out = new Set<HomePart>();
  const p = (r?.parts ?? {}) as Record<string, unknown>;
  const arr = (v: unknown) => Array.isArray(v);
  const good: Record<HomePart, boolean> = {
    hero: 'hero' in p,
    resume: arr(p.resume), nextup: arr(p.nextup), leaving: arr(p.leaving),
    recs: arr((p.recs as { items?: unknown } | null)?.items) && arr((p.recs as { friends?: unknown }).friends),
    because: arr((p.because as { items?: unknown } | null)?.items) && arr((p.because as { more?: unknown }).more),
    hubs: arr(p.hubs), themed: arr(p.themed),
  };
  for (const n of HOME_PARTS) if (!good[n] || r?.failed?.includes(n)) out.add(n);
  return out;
}
