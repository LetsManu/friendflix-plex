// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Block 21 for Plex (fork): pure mappers from the mirror (plex_items + plex_tags, written by sync.ts) to the neutral DTOs of the
 * optional MediaServer methods itemAbout / itemCollections. No I/O here; service.ts does the visibility checks and the queries.
 * Nothing in here carries a Plex URL or the Plex token: only ids, names, numbers and dates.
 */
import type { ItemAboutDto, ProviderIds } from '../media/types.js';
import { TYPE_OUT } from './dto.js';

const IMDB = /^tt\d{5,12}$/;
const NUM = /^\d{1,12}$/;

/** scheme of a mirrored guid -> provider (new agents: `imdb://`, legacy agents: `com.plexapp.agents.imdb://`) */
const SCHEME: Record<string, keyof ProviderIds> = {
  imdb: 'imdb', tmdb: 'tmdb', tvdb: 'tvdb',
  'com.plexapp.agents.imdb': 'imdb', 'com.plexapp.agents.themoviedb': 'tmdb', 'com.plexapp.agents.thetvdb': 'tvdb',
};

/**
 * Mirrored guids -> ProviderIds. New-agent `Guid` entries win over a legacy agent guid. A legacy guid with a path
 * (`com.plexapp.agents.thetvdb://81189/1/2`, an episode named by its series) does not name the item itself and is ignored, as is
 * anything that does not look like an id of that provider (`plex://`, `local://`, `com.plexapp.agents.none://…`, `tt` without digits).
 */
export function providerIdsOf(guids: readonly string[] | null | undefined): ProviderIds {
  const out: ProviderIds = {};
  const legacy: ProviderIds = {};
  for (const g of Array.isArray(guids) ? guids : []) {
    if (typeof g !== 'string') continue;
    const m = /^([a-z.]+):\/\/([^/?#\s]+)(\/[^?#\s]*)?(?:\?.*)?$/i.exec(g.trim());
    if (!m) continue;
    const scheme = m[1]!.toLowerCase();
    const kind = SCHEME[scheme];
    if (!kind || (m[3] && m[3] !== '/')) continue;
    const v = kind === 'imdb' ? m[2]!.toLowerCase() : m[2]!;
    if (kind === 'imdb' ? !IMDB.test(v) : !NUM.test(v)) continue;
    const into = scheme.startsWith('com.plexapp.agents.') ? legacy : out;
    if (!into[kind]) into[kind] = v;
  }
  return { ...legacy, ...out };
}

/** The TMDB id of mirrored guids (new or legacy agent), as a number; undefined without one. */
export function tmdbIdOf(guids: readonly string[] | null | undefined): number | undefined {
  const t = providerIdsOf(guids).tmdb;
  return t ? Number(t) : undefined;
}

/** The guids findByTmdb() looks for: the new-agent and the legacy-agent spelling of one TMDB id. */
export const tmdbGuids = (tmdbId: number): string[] => [`tmdb://${tmdbId}`, `com.plexapp.agents.themoviedb://${tmdbId}`];

const RT = /^rottentomatoes:\/\//;

/**
 * Plex `rating` / `audienceRating` (both 0-10) -> the DTO's community (0-10) and critic (0-100) scores, like the Jellyfin fields:
 * - `audienceRating` is the community score (Rotten Tomatoes audience, TMDB or IMDb, whatever the agent chose);
 * - `rating` with a Rotten Tomatoes image is the critics score (x10, 0-100);
 * - `rating` from another source (IMDb / TMDB image, or a legacy agent without images) is a community score, used only when
 *   there is no `audienceRating` (the same fallback as ItemDto.communityRating).
 */
export function plexRatings(r: { audience_rating: number | null; critic_rating: number | null; rating_image: string | null; audience_rating_image?: string | null }):
  { communityRating?: number; criticRating?: number } {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10;
  const audience = ok(r.audience_rating) ? r.audience_rating : undefined;
  const rating = ok(r.critic_rating) ? r.critic_rating : undefined;
  const rtCritic = rating !== undefined && RT.test(r.rating_image ?? '');
  const community = audience ?? (rating !== undefined && !rtCritic ? rating : undefined);
  return {
    ...(community !== undefined ? { communityRating: Math.round(community * 10) / 10 } : {}),
    ...(rtCritic ? { criticRating: Math.round(rating! * 10) } : {}),
  };
}

/** The mirror columns itemAbout() reads. */
export interface AboutRow {
  type: string; guids: string[] | null; tagline: string | null; original_title: string | null; originally_available: string | null;
  studio: string | null; audience_rating: number | null; critic_rating: number | null; rating_image: string | null; audience_rating_image: string | null;
}

/** Mirror row + its tags (kind, tag in Plex order) -> ItemAboutDto. Labels are the tags (genres already show in the info block). */
export function toPlexAbout(row: AboutRow, tags: Array<{ kind: string; tag: string }>): ItemAboutDto {
  const names = (kind: string) => [...new Set(tags.filter((t) => t.kind === kind && t.tag).map((t) => t.tag))];
  const studios = [...new Set([...(row.studio ? [row.studio] : []), ...names('studio')])].slice(0, 6);
  return {
    type: TYPE_OUT[row.type] ?? 'Video',
    providerIds: providerIdsOf(row.guids),
    ...(row.tagline ? { tagline: row.tagline } : {}),
    ...(row.original_title ? { originalTitle: row.original_title } : {}),
    ...(row.originally_available && /^\d{4}-\d{2}-\d{2}$/.test(row.originally_available) ? { premiereDate: row.originally_available } : {}),
    countries: names('country').slice(0, 10),
    studios,
    tags: names('label').slice(0, 20),
    ...plexRatings(row),
  };
}
