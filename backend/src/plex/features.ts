// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Recommendation engine v2 on Plex (fork, 1.1): pure mappers from the library mirror (plex_items + plex_tags, written by sync.ts) to
 * the neutral `ItemFeatures` of the optional MediaServer.libraryFeatures() hook. No I/O here; service.ts runs the queries.
 * Library facts only: ids, names, numbers. Never a path, URL, image path, the Plex token or user data.
 *
 * Plex has (as Jellyfin) genres, studios, countries, credits with ids, year, runtime, ratings, collections, overview and tagline. It has
 * no keyword tags (Plex labels are the tags, usually set by hand and often empty), no "Creator" credit, no original language and no
 * series status (Continuing / Ended): those stay empty, which the engine treats as unknown.
 */
import type { ItemFeatures } from '../media/types.js';
import { plexRatings } from './about.js';
import { encodePlexId } from './ids.js';

const PEOPLE_MAX = 8;
/** how many of the 8 people slots each credit kind may take before actors fill the rest (Jellyfin: Director 2, Creator 2, Writer 2) */
const PEOPLE_QUOTA: Array<[string, number]> = [['director', 2], ['writer', 2], ['actor', PEOPLE_MAX]];

/** The mirror columns libraryFeatures() reads. */
export interface FeatureRow {
  rating_key: string; type: string; year: number | null; duration_ms: string | number | null; summary: string | null; tagline: string | null;
  studio: string | null; audience_rating: number | null; critic_rating: number | null; rating_image: string | null; audience_rating_image: string | null;
  collection_key: string | null;
}
export interface FeatureTag { kind: string; tag: string; tag_id: string | null; pos: number }

/** ids of the top 8 credited people: up to 2 directors, 2 writers, then actors in billing order (Plex lists Role in that order). */
export function featurePeople(tags: readonly FeatureTag[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [kind, cap] of PEOPLE_QUOTA) {
    let n = 0;
    for (const t of [...tags].filter((x) => x.kind === kind && x.tag_id !== null).sort((a, b) => a.pos - b.pos)) {
      if (out.length >= PEOPLE_MAX || n >= cap) break;
      const id = encodePlexId('tag', t.tag_id!);
      if (seen.has(id)) continue;
      seen.add(id); out.push(id); n++;
    }
  }
  return out;
}

const names = (tags: readonly FeatureTag[], kind: string) =>
  [...new Set([...tags].filter((t) => t.kind === kind && t.tag.trim()).sort((a, b) => a.pos - b.pos).map((t) => t.tag))];

/** Mirror row + its tags -> ItemFeatures (films and shows only; the caller filters the type). */
export function toPlexFeatures(row: FeatureRow, tags: readonly FeatureTag[]): ItemFeatures {
  const dur = Number(row.duration_ms);
  const year = typeof row.year === 'number' && row.year > 0 && row.year < 10000 ? row.year : undefined;
  const studios = [...new Set([...(row.studio ? [row.studio] : []), ...names(tags, 'studio')])];
  const ratings = plexRatings(row);
  const f: ItemFeatures = {
    id: encodePlexId('item', row.rating_key), type: row.type === 'show' ? 'Series' : 'Movie',
    genres: names(tags, 'genre'), tags: names(tags, 'label'), studios, people: featurePeople(tags), countries: names(tags, 'country'),
  };
  if (year !== undefined) f.year = year;
  if (Number.isFinite(dur) && dur > 0) f.runtimeMin = Math.round(dur / 60_000);
  if (ratings.communityRating !== undefined) f.communityRating = ratings.communityRating;
  if (ratings.criticRating !== undefined) f.criticRating = ratings.criticRating;
  if (row.collection_key) f.collectionId = encodePlexId('item', row.collection_key);
  if (row.summary?.trim()) f.overview = row.summary.slice(0, 4000);
  if (row.tagline?.trim()) f.tagline = row.tagline.slice(0, 500);
  return f;
}
