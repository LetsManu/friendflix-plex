import { fmtDate, fmtDuration, intlLocale, tr, type TKey } from '#lib/i18n';
import type { Item } from '#lib/api';

/** "Spannend • Krimi • Drama" (max 3 genres) */
export const genreLine = (genres: readonly string[] | undefined, max = 3) => (genres ?? []).slice(0, max).join(' • ');

/** "1 Std. 52 Min." / "45 Min." / "3 Staffeln" / "" */
export function runtimeLabel(item: Pick<Item, 'type' | 'runtimeTicks' | 'childCount'>): string {
  if (item.type === 'Series') return item.childCount ? tr('home.meta.seasons', { n: item.childCount }) : tr('home.meta.series');
  const min = item.runtimeTicks ? Math.round(item.runtimeTicks / 600_000_000) : 0;
  if (min <= 0) return '';
  return fmtDuration(min * 60);
}

/** URL the "Teilen" button hands to navigator.share (series for episodes). */
export const itemPath = (item: Pick<Item, 'id' | 'type' | 'seriesId'>) => `/item/${item.type === 'Episode' && item.seriesId ? item.seriesId : item.id}`;

export function shareData(item: Pick<Item, 'id' | 'name' | 'type' | 'seriesId' | 'seriesName'>, origin: string) {
  const title = item.type === 'Episode' && item.seriesName ? item.seriesName : item.name;
  return { title, text: tr('home.meta.shareText', { title }), url: origin + itemPath(item) };
}

/** Where a playable card leads (same rule as Card.svelte). */
export const playPath = (item: Pick<Item, 'id' | 'type'>) => (item.type === 'Series' ? `/item/${item.id}` : item.type === 'BoxSet' ? `/library/${item.id}` : `/watch/${item.id}`);

export type Kind = 'series' | 'movies';
export const kindFromPath = (path: string): Kind => (path.startsWith('/browse/series') ? 'series' : 'movies');
export const categoryHref = (kind: Kind, genre: string) => `/browse/${kind}?genre=${encodeURIComponent(genre)}`;
/** Chip bar (Serien / Filme / Kategorien) lives on the home page and the browse pages only. */
export const showsChips = (path: string) => path === '/' || path.startsWith('/browse');

/** "Okt" + "12" for the date block of upcoming releases */
export function dateBlock(iso: string | undefined): { month: string; day: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return { month: d.toLocaleDateString(intlLocale(), { month: 'short', timeZone: 'UTC' }).replace('.', '').toUpperCase(), day: String(d.getUTCDate()) };
}
export function releaseLabel(iso: string | undefined): string {
  if (!iso) return tr('home.meta.dateOpen');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? tr('home.meta.dateOpen') : tr('home.meta.releasesOn', { date: fmtDate(d, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) });
}
/** upcoming releases sorted by date (undated last) */
export const sortUpcoming = <T extends { releaseDate?: string }>(l: T[]): T[] => [...l].sort((a, b) => (a.releaseDate ? Date.parse(a.releaseDate) : Infinity) - (b.releaseDate ? Date.parse(b.releaseDate) : Infinity));

export type NewTab = 'soon' | 'week' | 'added';
/** tab id + label key (translate when rendering: `$t(label)`) */
export const NEW_TABS: Array<[NewTab, TKey]> = [['soon', 'home.new.soon'], ['week', 'home.new.week'], ['added', 'home.new.added']];
