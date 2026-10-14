// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { api } from '#lib/api';
import { createSwr, swrLoad } from '#lib/home';
import { fmtNumber, tr } from '#lib/i18n';

/** Block 21: GET /api/items/:id/about (mirrors `AboutDto` in backend/src/about.ts). */
export type RatingKey = 'community' | 'critic' | 'imdb' | 'rt' | 'mc' | 'friends';
export interface AboutRating { key: RatingKey; value: number; max: 5 | 10 | 100; from: 'jellyfin' | 'omdb' | 'friends' }
export interface AboutLink { kind: 'imdb' | 'tmdb' | 'tvdb' | 'trakt'; url: string }
export interface AboutPart {
  id?: string; tmdbId?: number; name: string; year?: number; poster?: string; image: boolean; played: boolean; current: boolean; inLibrary: boolean;
  from: 'jellyfin' | 'tmdb';
}
export interface AboutCollection { name: string; parts: AboutPart[]; from: 'jellyfin' | 'tmdb' }
export type AboutSource = 'jellyfin' | 'tmdb' | 'omdb';
export interface About {
  ratings: AboutRating[]; tagline?: string; originalTitle?: string; releaseDate?: string; countries: string[]; studios: string[]; tags: string[];
  keywords: string[]; links: AboutLink[]; collection: AboutCollection | null; canRequest: boolean; sources: AboutSource[];
}

/** 10 minutes per profile and title; the key carries the profile, so a kids profile never sees a grown-up's cached friends' rating */
const cache = createSwr<About>(10 * 60_000);

/** Loads the "about" data through the cache (cached value at once, then the network one). Errors are swallowed: the page stays as it is. */
export function loadAbout(id: string, profileId: string, apply: (a: About) => void): Promise<void> {
  return swrLoad<About>(cache, profileId + ':' + id, () => api<About>(`/api/items/${id}/about`), apply, undefined, () => undefined);
}

/** The same "about" with the friends' rating set to `avg` (rounded like the server, always last) or removed for null. */
export function withFriends(a: About, avg: number | null): About {
  const ratings = a.ratings.filter((r) => r.key !== 'friends');
  if (avg !== null && Number.isFinite(avg)) ratings.push({ key: 'friends', value: Math.round(avg * 10) / 10, max: 5, from: 'friends' });
  return { ...a, ratings };
}

/**
 * After the viewer rated the title: the cached entry shows the new friends' average at once (`apply` gets it), then the entry is
 * revalidated from the server regardless of its age, so a later visit does not bring back the old average.
 */
export function refreshFriends(id: string, profileId: string, avg: number | null, apply: (a: About) => void): Promise<void> {
  const key = profileId + ':' + id;
  const hit = cache.get(key, Infinity);
  if (hit) cache.set(key, withFriends(hit.value, avg));
  return swrLoad<About>(cache, key, () => api<About>(`/api/items/${id}/about`), apply, 0, () => undefined);
}

const one = (n: number) => fmtNumber(n, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const whole = (n: number) => fmtNumber(Math.round(n));

/** One text per rating, in the order of the response: "★ 7.8", "IMDb 8.1", "RT 92 %", "MC 81", "Kritiker 92 %", "Freunde 4.5 ★". */
export function ratingParts(a: About | null): Array<{ key: RatingKey; text: string }> {
  if (!a) return [];
  const out: Array<{ key: RatingKey; text: string }> = [];
  for (const r of a.ratings) {
    if (!Number.isFinite(r.value)) continue;
    const text = r.key === 'community' ? `★ ${one(r.value)}`
      : r.key === 'imdb' ? `IMDb ${one(r.value)}`
      : r.key === 'rt' ? `RT ${whole(r.value)} %`
      : r.key === 'mc' ? `MC ${whole(r.value)}`
      : r.key === 'critic' ? tr('detail.about.critics', { n: whole(r.value) })
      : r.key === 'friends' ? tr('detail.about.friends', { n: one(r.value) })
      : '';
    if (text) out.push({ key: r.key, text });
  }
  return out;
}

export type DetailTab = 'episodes' | 'details' | 'more' | 'extras';

/** Episodes (series only) · Details · More like this · Extras (only with extras) */
export function detailTabs(type: string, hasExtras: boolean): DetailTab[] {
  return [...(type === 'Series' ? ['episodes' as const] : []), 'details', 'more', ...(hasExtras ? ['extras' as const] : [])];
}

export const defaultTab = (type: string): DetailTab => (type === 'Series' ? 'episodes' : 'details');

/** Position of the current part in a collection ("Teil 2 von 4") and the part to continue with (index 0 when no part is current; the next one, only if it is in the library and not yet watched). */
export function collectionView(c: AboutCollection): { index: number; total: number; next: AboutPart | null } {
  const i = c.parts.findIndex((p) => p.current);
  const nx = i >= 0 ? c.parts[i + 1] : undefined;
  return { index: i + 1, total: c.parts.length, next: nx && nx.inLibrary && !nx.played && nx.id ? nx : null };
}
