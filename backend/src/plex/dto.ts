// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Mirror rows (+ the viewer's FriendFlix user data) -> the server-neutral DTOs of ../media/types.ts. */
import type { ImageTags, ItemDto } from '../media/types.js';
import { encodePlexId } from './ids.js';
import { imageTag } from './mirror.js';

/** Plex type -> FriendFlix vocabulary. */
export const TYPE_OUT: Record<string, string> = {
  movie: 'Movie', show: 'Series', season: 'Season', episode: 'Episode', collection: 'BoxSet', clip: 'Video',
};
/** FriendFlix type -> Plex types (unknown names are ignored). */
export const TYPE_IN: Record<string, string[]> = {
  movie: ['movie'], series: ['show'], season: ['season'], episode: ['episode'], boxset: ['collection'], trailer: ['clip'], video: ['clip'],
};

export function plexTypes(types: string | undefined, fallback = 'Movie,Series'): string[] {
  const out = new Set<string>();
  for (const t of (types || fallback).split(',')) for (const x of TYPE_IN[t.trim().toLowerCase()] ?? []) out.add(x);
  return [...out];
}

/** A row as the item queries in service.ts select it. */
export interface ItemRow {
  rating_key: string;
  section_id: number;
  type: string;
  parent_key: string | null;
  grandparent_key: string | null;
  title: string;
  summary: string | null;
  year: number | null;
  originally_available: Date | string | null;
  content_rating: string | null;
  inherit_rating: string | null;
  audience_rating: number | null;
  critic_rating: number | null;
  duration_ms: string | number | null;
  idx: number | null;
  parent_idx: number | null;
  child_count: number | null;
  leaf_count: number | null;
  added_at: Date | null;
  thumb: string | null;
  art: string | null;
  logo: string | null;
  grandparent_thumb: string | null;
  parent_thumb: string | null;
  extra_type: string | null;
  show_title: string | null;
  show_thumb: string | null;
  genres: string[] | null;
  trailer_count: string | number | null;
  ud_played: boolean | null;
  ud_favorite: boolean | null;
  ud_position: string | number | null;
  ud_last_played: Date | null;
  ep_total: string | number | null;
  ep_played: string | number | null;
  ep_last_played: Date | null;
  last_added: Date | null;
  member_count: string | number | null;
  /** collections: rating key of the first member the viewer may see that has a poster */
  first_member?: string | number | null;
}

const iso = (d: Date | string | null | undefined): string | undefined => {
  if (!d) return undefined;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isFinite(t.getTime()) ? t.toISOString() : undefined;
};
const n = (v: string | number | null | undefined) => (v === null || v === undefined ? undefined : Number(v));

export function toItemDto(r: ItemRow): ItemDto {
  const id = encodePlexId('item', r.rating_key);
  const type = r.type === 'clip' && r.extra_type === 'trailer' ? 'Trailer' : (TYPE_OUT[r.type] ?? 'Video');
  const runtimeTicks = r.duration_ms !== null && r.duration_ms !== undefined && r.type !== 'show' && r.type !== 'season' ? Number(r.duration_ms) * 10_000 : undefined;
  const isGroup = r.type === 'show' || r.type === 'season';
  const epTotal = n(r.ep_total) ?? 0;
  const epPlayed = n(r.ep_played) ?? 0;
  const played = isGroup ? epTotal > 0 && epPlayed >= epTotal : Boolean(r.ud_played);
  const positionTicks = isGroup ? 0 : Number(r.ud_position ?? 0);
  const seriesKey = r.type === 'episode' ? r.grandparent_key : r.type === 'season' ? r.parent_key : null;
  const seriesThumb = r.type === 'episode' ? (r.grandparent_thumb ?? r.show_thumb) : r.type === 'season' ? (r.parent_thumb ?? r.show_thumb) : null;
  // image tags = the Plex artwork timestamp (cache key; the gateway turns ?tag=<ts> into /library/metadata/<rk>/thumb/<ts>).
  // A collection without own artwork only has a Plex *composite* poster, built from ALL members - also the ones this viewer may not
  // see (kids / age caps / libraries). It is never served; the tag m<member id32> names the first member the viewer may see instead
  // (the gateway checks that member's visibility too). Plex answers 404 for the untagged thumb of such a collection: image=false.
  const composite = r.type === 'collection' && (!r.thumb || /^\/library\/collections\/\d+\/composite\//.test(r.thumb));
  const memberTag = composite && r.first_member ? `m${encodePlexId('item', String(r.first_member))}` : undefined;
  const tags: ImageTags = {
    primary: composite ? memberTag : imageTag(r.thumb),
    backdrop: imageTag(r.art),
    logo: imageTag(r.logo),
    seriesPrimary: imageTag(seriesThumb),
  };
  for (const k of Object.keys(tags) as Array<keyof ImageTags>) if (tags[k] === undefined) delete tags[k];
  const ratingSrc = r.content_rating || r.inherit_rating || undefined;
  const community = r.audience_rating ?? r.critic_rating ?? undefined;
  const dto: ItemDto = {
    id,
    name: r.title,
    type,
    year: r.year ?? undefined,
    overview: r.summary || undefined,
    runtimeTicks,
    seriesId: seriesKey ? encodePlexId('item', seriesKey) : undefined,
    seriesName: seriesKey ? (r.show_title ?? undefined) : undefined,
    seasonId: r.type === 'episode' && r.parent_key ? encodePlexId('item', r.parent_key) : undefined,
    indexNumber: r.type === 'season' || r.type === 'episode' || r.type === 'clip' ? (r.idx ?? undefined) : undefined,
    parentIndexNumber: r.type === 'episode' ? (r.parent_idx ?? undefined) : undefined,
    genres: r.genres ?? [],
    rating: ratingSrc,
    communityRating: community === undefined || community === null ? undefined : Math.round(Number(community) * 10) / 10,
    premiereDate: iso(r.originally_available),
    dateCreated: iso(r.added_at),
    image: composite ? false : Boolean(r.thumb || seriesThumb),
    backdrop: Boolean(r.art),
    logo: Boolean(r.logo),
    trailers: Number(r.trailer_count ?? 0),
    played,
    favorite: Boolean(r.ud_favorite),
    positionTicks,
    playedPercentage: !isGroup && positionTicks > 0 && runtimeTicks ? Math.min(100, (positionTicks / runtimeTicks) * 100) : undefined,
    lastPlayedDate: iso(isGroup ? r.ep_last_played : r.ud_last_played),
    childCount: r.type === 'collection' ? n(r.member_count) : r.type === 'show' ? (r.child_count ?? undefined) : r.type === 'season' ? (r.leaf_count ?? undefined) : undefined,
    unplayedCount: isGroup ? Math.max(0, epTotal - epPlayed) : undefined,
    lastAdded: r.type === 'show' ? iso(r.last_added) : undefined,
    imageTags: Object.keys(tags).length ? tags : undefined,
  };
  for (const k of Object.keys(dto) as Array<keyof ItemDto>) if (dto[k] === undefined) delete dto[k];
  return dto;
}

/** A library section as a "view" (Jellyfin CollectionFolder). */
export function sectionDto(s: { section_id: number; title: string; type: string }): ItemDto {
  return {
    id: encodePlexId('section', s.section_id), name: s.title, type: 'CollectionFolder', genres: [], image: false, backdrop: false, logo: false,
    trailers: 0, played: false, favorite: false, positionTicks: 0,
  };
}
