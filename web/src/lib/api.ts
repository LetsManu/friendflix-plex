import { clearHint } from '#lib/gate';

export class ApiError extends Error {
  constructor(public status: number, public body: any) {
    super(`API ${status}`);
  }
}

let csrf = '';
export const setCsrf = (t: string) => (csrf = t);
/** id of the profile the page loaded with; sent as x-ff-profile so the backend can detect a profile switch in another tab */
let activeProfile = '';
export const setActiveProfile = (id: string | null | undefined) => (activeProfile = id ?? '');
export const getActiveProfile = () => activeProfile;

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal; /** survive page unload (progress/stop reports) */ keepalive?: boolean } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    credentials: 'same-origin',
    signal: opts.signal,
    keepalive: opts.keepalive,
    headers: { ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }), 'x-csrf-token': csrf, ...(activeProfile ? { 'x-ff-profile': activeProfile } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (res.status === 401 && !location.pathname.startsWith('/invite/') && location.pathname !== '/tv') {
    clearHint(); // the session is gone: the next start must not render early with this account's hint/profile
    location.href = localStorage.getItem('ff_tv_device') ? '/tv' : '/auth/login'; // a TV re-pairs instead of typing a login
    await new Promise(() => undefined);
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (res.status === 409 && json?.error === 'profile_required' && !/^\/(profiles|invite\/|tv$)/.test(location.pathname)) {
    location.href = '/profiles'; // no profile chosen (yet) for this session
    await new Promise(() => undefined);
  }
  if (res.status === 409 && json?.error === 'profile_changed') {
    // the profile was switched in another tab: reload once (the guard avoids reload loops)
    let again = false;
    try { again = sessionStorage.getItem('ff_profile_reload') === '1'; sessionStorage.setItem('ff_profile_reload', '1'); setTimeout(() => { try { sessionStorage.removeItem('ff_profile_reload'); } catch { /* ignore */ } }, 5000); } catch { /* ignore */ }
    if (!again) { location.reload(); await new Promise(() => undefined); }
  }
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}

export const img = (id: string, w = 300) => `/media/Items/${id}/Images/Primary?maxWidth=${w}&quality=85`;
export const backdrop = (id: string, w = 1600) => `/media/Items/${id}/Images/Backdrop?maxWidth=${w}&quality=80`;
export type ImageKind = 'Primary' | 'Backdrop';
/** `srcset` value (`<url> <w>w, …`) for an item image; widths are de-duplicated and sorted, URLs are identical to img()/backdrop() so they share the cache. */
export function srcset(kind: ImageKind, id: string, widths: readonly number[]): string {
  const ws = [...new Set(widths.filter((w) => Number.isFinite(w) && w > 0).map(Math.round))].sort((a, b) => a - b);
  return ws.map((w) => `${kind === 'Primary' ? img(id, w) : backdrop(id, w)} ${w}w`).join(', ');
}
/** Row card thumbs; `CARD_SIZES` mirrors the slot widths of Row.svelte (--n = 2.4 / 3 / 4 / 5 / 6 at 0 / 560 / 800 / 1100 / 1400px, minus padding and gaps). */
export const CARD_WIDTHS = [320, 520, 780] as const;
export const CARD_SIZES = '(min-width: 1400px) 16vw, (min-width: 1100px) 19vw, (min-width: 800px) 24vw, (min-width: 560px) 31vw, 40vw';
/** full-bleed hero backdrop */
export const HERO_WIDTHS = [800, 1280, 1920] as const;
/** ItemModal backdrop (dialog is min(880px, 96vw) wide) */
export const MODAL_WIDTHS = [640, 960, 1440] as const;
export const MODAL_SIZES = '(min-width: 920px) 880px, 96vw';
export const logoUrl = (id: string) => `/media/Items/${id}/Images/Logo?maxWidth=700&quality=90`;
export const ticksToSec = (t: number) => t / 10_000_000;
export const secToTicks = (s: number) => Math.floor(s * 10_000_000);
export const fmtMin = (ticks?: number) => (ticks ? `${Math.round(ticks / 600_000_000)} Min.` : '');
export const fmtClock = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(x).padStart(2, '0')}`;
};

export interface Item {
  id: string; name: string; type: string; year?: number; overview?: string; runtimeTicks?: number;
  seriesId?: string; seriesName?: string; seasonId?: string; indexNumber?: number; parentIndexNumber?: number;
  genres: string[]; rating?: string; communityRating?: number; premiereDate?: string; image: boolean; backdrop: boolean; logo: boolean; trailers?: number; caption?: string;
  played: boolean; favorite: boolean; positionTicks: number; playedPercentage?: number; lastPlayedDate?: string;
  langs?: { audio: string[]; subs: string[] };
  /** Jellyfin DateLastMediaAdded (ISO) – newest child for series */
  lastAdded?: string; childCount?: number; unplayedCount?: number;
  /** only on /api/library/trending: number of distinct viewers this week */
  viewers?: number;
}
export interface Me { id: string; name: string; role: string; roleLabel: string; isAdmin: boolean; csrfToken: string; deviceApproved: boolean; tv: boolean; profile?: MeProfile | null; profileRequired?: boolean; profileCount?: number; profileChosen?: boolean; downloads?: { allowed: boolean; max: number };
  /** effective UI language (profile → instance default → 'de'); see docs/i18n.md */ language?: string;
  /** false = the active profile never chose a language (first-login picker); absent on older servers */ languageChosen?: boolean;
  /** instance default language */ defaultLanguage?: string;
  /** false = no admin stored the instance language yet (asked once) */ defaultLanguageSet?: boolean;
  /** browser language from Accept-Language when supported, else null */ suggestedLanguage?: string | null;
  /** the active profile is a kids profile (kids home, no social features); absent on older servers */ kids?: boolean;
  /** false = the active profile never finished /welcome (absent = onboarded) */ onboarded?: boolean }
export interface MeProfile { id: string; name: string; avatar: string; isOwner: boolean; kids?: boolean; /** parental cap of a kids profile (0/6/12) */ maxRating?: number }

// ---- shared item cache: the modal / item page render instantly from what a card already had, then revalidate ----
/** detail response of GET /api/items/:id (the item plus per-profile state) */
export interface ItemDetail { item: Item; inWatchlist?: boolean; thumb?: number; langs?: { audio: string[]; subs: string[] } }
type Cached = { item: Item; detail?: ItemDetail; at: number };
const ITEM_TTL = 10 * 60_000, ITEM_MAX = 400;
const itemCache = new Map<string, Cached>();
function putCached(id: string, c: Cached) {
  itemCache.delete(id); // re-insert = most recently used
  itemCache.set(id, c);
  if (itemCache.size > ITEM_MAX) itemCache.delete(itemCache.keys().next().value!);
}
/**
 * Remember an item a card/row already has (call on hover/focus/click of a card). Never downgrades a fuller cached detail:
 * the card's copy only refreshes the item fields. Ignores anything without an id.
 */
export function primeItem(item: Item | null | undefined, now = Date.now()): void {
  if (!item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string') return;
  const old = itemCache.get(item.id);
  putCached(item.id, { item: old?.detail ? { ...old.detail.item, ...item, langs: item.langs ?? old.detail.item.langs } : item, detail: old?.detail, at: now });
}
/** Store a full detail response (DetailView after GET /api/items/:id). */
export function primeDetail(d: ItemDetail | null | undefined, now = Date.now()): void {
  if (!d?.item?.id) return;
  putCached(d.item.id, { item: d.item, detail: d, at: now });
}
/** Cached item for an id (fresh within 10 min), or undefined. Render it immediately, then revalidate with the API. */
export function cachedItem(id: string, now = Date.now()): Item | undefined {
  const c = itemCache.get(id);
  if (!c) return undefined;
  if (now - c.at > ITEM_TTL) { itemCache.delete(id); return undefined; }
  return c.item;
}
/** Cached full detail (watchlist/thumb/langs included) when one was loaded recently, else undefined. */
export function cachedDetail(id: string, now = Date.now()): ItemDetail | undefined {
  const c = itemCache.get(id);
  if (!c?.detail || now - c.at > ITEM_TTL) return undefined;
  return { ...c.detail, item: c.item };
}
/** The viewer rated a title somewhere (hover card, detail view): patch the cached detail so the next render shows it (freshness unchanged). */
export function setCachedThumb(id: string, thumb: number): void {
  const c = itemCache.get(id);
  if (c?.detail) itemCache.set(id, { ...c, detail: { ...c.detail, thumb } });
}
/** Drop cached entries (tests, profile switch). */
export function clearItemCache(): void { itemCache.clear(); }
