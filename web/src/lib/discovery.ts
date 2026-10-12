import { tr, type TKey } from '#lib/i18n';
import { langLabel } from './langs';

/** Pure helpers for browse / search discovery (URL state, API query, removable filter chips, recent searches). */

export const SORTS = ['SortName', 'DateCreated', 'PremiereDate', 'CommunityRating'] as const;
export const FILTERS = ['', 'unplayed', 'played', 'favorites'] as const;
export const RATINGS = [6, 7, 8] as const;
const DESC_SORTS = new Set<string>(['DateCreated', 'CommunityRating', 'PremiereDate']);

export interface BrowseState {
  genre: string;
  studio: string;
  sort: (typeof SORTS)[number];
  filter: (typeof FILTERS)[number];
  decade: number | null;
  year: number | null;
  minRating: number | null;
  person: string | null;
  audio: string | null;
  subs: string | null;
}

const langOf = (v: string | null): string | null => { const t = (v ?? '').trim().toLowerCase(); return /^[a-z]{3}$/.test(t) ? t : null; };
const intOf = (v: string | null): number | null => (v !== null && /^\d{1,4}$/.test(v.trim()) ? Number(v) : null);

export function isYear(q: string): boolean {
  const t = q.trim();
  return /^\d{4}$/.test(t) && Number(t) >= 1900 && Number(t) <= 2100;
}

export function parseBrowse(sp: Pick<URLSearchParams, 'get'>): BrowseState {
  const sort = sp.get('sort') ?? '';
  const filter = sp.get('filter') ?? '';
  const y = intOf(sp.get('year'));
  const year = y !== null && y >= 1900 && y <= 2100 ? y : null;
  const d = intOf(sp.get('decade'));
  const decade = year === null && d !== null && d % 10 === 0 && d >= 1900 && d <= 2090 ? d : null; // a year wins over a decade
  const r = Number(sp.get('minRating'));
  const person = (sp.get('person') ?? '').trim().toLowerCase();
  return {
    genre: (sp.get('genre') ?? '').trim(),
    studio: (sp.get('studio') ?? '').trim(),
    sort: (SORTS as readonly string[]).includes(sort) ? (sort as BrowseState['sort']) : 'SortName',
    filter: (FILTERS as readonly string[]).includes(filter) ? (filter as BrowseState['filter']) : '',
    decade,
    year,
    minRating: (RATINGS as readonly number[]).includes(r) ? r : null,
    person: /^[0-9a-f]{32}$/.test(person) ? person : null,
    audio: langOf(sp.get('audio')),
    subs: langOf(sp.get('subs')),
  };
}

/** Query string for GET /api/library/items. */
export function browseQuery(s: BrowseState, kind: string, start: number, limit: number): URLSearchParams {
  const p = new URLSearchParams({ types: kind, sort: s.sort, limit: String(limit), start: String(start) });
  if (DESC_SORTS.has(s.sort)) p.set('desc', 'true');
  if (s.genre) p.set('genre', s.genre);
  if (s.studio) p.set('studio', s.studio);
  if (s.filter) p.set('filter', s.filter);
  if (s.year !== null) p.set('year', String(s.year));
  else if (s.decade !== null) p.set('decade', String(s.decade));
  if (s.minRating !== null) p.set('minRating', String(s.minRating));
  if (s.person) p.set('person', s.person);
  if (s.audio) p.set('audio', s.audio);
  if (s.subs) p.set('subs', s.subs);
  return p;
}

const FILTER_LABEL: Record<string, TKey> = { unplayed: 'home.status.unplayed', played: 'home.status.played', favorites: 'home.status.favorites' };

/** Removable filter chips; `key` is the URL parameter to drop. `labels.person` overrides the person label. */
export function activeChips(s: BrowseState, labels: { person?: string } = {}): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  if (s.genre) out.push({ key: 'genre', label: s.genre });
  if (s.studio) out.push({ key: 'studio', label: s.studio });
  if (s.year !== null) out.push({ key: 'year', label: String(s.year) });
  if (s.decade !== null) out.push({ key: 'decade', label: tr('home.browse.decadeLabel', { d: String(s.decade) }) });
  if (s.minRating !== null) out.push({ key: 'minRating', label: tr('home.browse.minRating', { n: s.minRating }) });
  if (s.person) out.push({ key: 'person', label: labels.person || tr('home.browse.chip.person') });
  if (s.audio) out.push({ key: 'audio', label: tr('home.browse.chip.audio', { lang: langLabel(s.audio) }) });
  if (s.subs) out.push({ key: 'subs', label: tr('home.browse.chip.subs', { lang: langLabel(s.subs) }) });
  if (s.filter) out.push({ key: 'filter', label: FILTER_LABEL[s.filter] ? tr(FILTER_LABEL[s.filter]!) : s.filter });
  return out;
}

/** Number shown on the mobile "Filter" button: the active filters, i.e. exactly the chips above the grid (sorting is not a filter). */
export function filterCount(s: BrowseState): number {
  return activeChips(s).length;
}

export interface FilterDraft { genre: string; decade: string; minRating: string; sort: string; filter: string; audio: string; subs: string }
export const draftOf = (s: BrowseState): FilterDraft => ({ genre: s.genre, decade: s.decade !== null ? String(s.decade) : '', minRating: s.minRating !== null ? String(s.minRating) : '', sort: s.sort, filter: s.filter, audio: s.audio ?? '', subs: s.subs ?? '' });

/** URL for "Anwenden" in the mobile filter sheet: writes the whole draft at once (same URL rules as the single selects). */
export function applyDraft(base: URL, d: FilterDraft): URL {
  const u = new URL(base.href);
  const put = (k: string, v: string) => { if (v) u.searchParams.set(k, v); else u.searchParams.delete(k); };
  put('genre', d.genre); put('minRating', d.minRating); put('filter', d.filter); put('audio', d.audio); put('subs', d.subs);
  put('sort', d.sort === 'SortName' ? '' : d.sort);
  put('decade', d.decade);
  if (d.decade) u.searchParams.delete('year');
  return u;
}

// ---- recent searches (per browser; storage may be unavailable) ----
const RECENT_KEY = 'ff-recent-search';
const RECENT_MAX = 8;
/** Per-profile key; without a known profile id nothing is read or stored (a kid profile must not see an adult's searches). */
const recentKey = (profileId: string | null | undefined): string | null => (profileId ? `${RECENT_KEY}:${profileId}` : null);

export function loadRecent(profileId: string | null | undefined): string[] {
  const key = recentKey(profileId);
  if (!key) return [];
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch { return []; }
}

export function pushRecent(profileId: string | null | undefined, q: string): string[] {
  const key = recentKey(profileId);
  const t = q.trim();
  if (!key || t.length < 2) return loadRecent(profileId);
  const next = [t, ...loadRecent(profileId).filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, RECENT_MAX);
  try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage unavailable */ }
  return next;
}

export function clearRecent(profileId: string | null | undefined): void {
  const key = recentKey(profileId);
  if (!key) return;
  try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
}

// ---- "Noch nicht in der Bibliothek": Seerr hits worth wishing for ----
export interface SeerrHit { tmdbId: number; mediaType: string; title: string; year?: number | string | null; overview?: string; poster?: string | null; status: string }

/** Seerr search hits that are not in the library yet (status != verfuegbar), valid, de-duplicated, at most `max`. */
export function wishCandidates<T extends SeerrHit>(results: readonly T[] | null | undefined, max = 8): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of results ?? []) {
    if (out.length >= max) break;
    if (!r || r.status === 'verfuegbar' || !Number.isFinite(r.tmdbId) || (r.mediaType !== 'movie' && r.mediaType !== 'tv')) continue;
    const key = `${r.mediaType}:${r.tmdbId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** Hits that already have a wish (or are being processed): shown as a disabled badge instead of a button. */
export const alreadyWished = (status: string): boolean => status === 'angefragt' || status === 'in_arbeit' || status === 'teilweise';
