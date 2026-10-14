// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Plex JSON -> mirror rows (plex_items / plex_tags / plex_collection_items) and their bulk upserts. The mirror is written only
 * by the sync job (sync.ts) and read by every browse query (service.ts). No server file paths are stored.
 */
import type { Db } from '../db.js';

/** Plex `type` values the mirror keeps. */
export const MIRROR_TYPES = new Set(['movie', 'show', 'season', 'episode', 'collection', 'clip']);

/** Columns a listing (`/library/sections/{id}/all`) delivers. */
export interface CoreRow {
  rating_key: string;
  section_id: number;
  type: string;
  parent_key: string | null;
  grandparent_key: string | null;
  title: string;
  title_sort: string | null;
  original_title: string | null;
  summary: string | null;
  year: number | null;
  originally_available: string | null;
  content_rating: string | null;
  audience_rating: number | null;
  critic_rating: number | null;
  studio: string | null;
  duration_ms: number | null;
  idx: number | null;
  parent_idx: number | null;
  leaf_count: number | null;
  child_count: number | null;
  added_at: string | null;
  plex_updated_at: number | null;
  thumb: string | null;
  art: string | null;
  parent_thumb: string | null;
  grandparent_thumb: string | null;
  guids: string[];
  /** Block 21 (detail page): tagline and the sources of `rating` / `audienceRating` (e.g. rottentomatoes://image.rating.ripe) */
  tagline: string | null;
  rating_image: string | null;
  audience_rating_image: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
};
const key = (v: unknown): string | null => {
  const s = str(v);
  return s && /^\d{1,18}$/.test(s) ? s : null;
};
/** Only server-relative image paths (agents may put absolute plex.tv URLs into person thumbs: not served). */
const relPath = (v: unknown): string | null => {
  const s = str(v);
  return s && /^\/(?![/\\])/.test(s) && !/[\s\\]/.test(s) ? s.slice(0, 500) : null;
};
const date = (v: unknown): string | null => {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};
const epoch = (v: unknown): string | null => {
  const n = num(v);
  return n !== null && n > 0 ? new Date(n * 1000).toISOString() : null;
};

/** Legacy (pre-2020) metadata agents put the external id into the item's own guid: `com.plexapp.agents.imdb://tt0133093?lang=en`. */
const LEGACY_AGENT = /^(com\.plexapp\.agents\.(?:imdb|themoviedb|thetvdb):\/\/[\w./-]{1,200})(?:\?[^#\s]*)?$/i;

/** `Guid: [{id:"tmdb://123"}]` (+ the item's own `guid` when it is a legacy agent guid, query string dropped). */
export function guidsOf(m: Record<string, any>): string[] {
  const out = new Set<string>();
  for (const g of Array.isArray(m.Guid) ? m.Guid : []) if (typeof g?.id === 'string' && /^[a-z]+:\/\/[\w./-]{1,200}$/i.test(g.id)) out.add(g.id.toLowerCase());
  const legacy = typeof m.guid === 'string' ? LEGACY_AGENT.exec(m.guid) : null;
  if (legacy) out.add(legacy[1]!.toLowerCase());
  return [...out];
}

/** short free text (tagline) or a rating source image name (`rottentomatoes://image.rating.ripe`, `imdb://image.rating`) */
const shortText = (v: unknown, max: number): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, max) : null;
};
const ratingImage = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return /^[a-z]+:\/\/[\w.-]{1,80}$/.test(s) ? s : null;
};

/** One `Metadata` entry -> core row; null for types the mirror ignores or entries without a ratingKey. */
export function coreRow(m: Record<string, any>, sectionId: number): CoreRow | null {
  const rk = key(m.ratingKey);
  const type = String(m.type ?? '');
  if (!rk || !MIRROR_TYPES.has(type)) return null;
  const isEp = type === 'episode';
  return {
    rating_key: rk,
    section_id: int(m.librarySectionID) ?? sectionId,
    type,
    parent_key: key(m.parentRatingKey),
    grandparent_key: isEp ? key(m.grandparentRatingKey) : null,
    title: String(m.title ?? '').slice(0, 500),
    title_sort: str(m.titleSort),
    original_title: str(m.originalTitle),
    summary: str(m.summary),
    year: int(m.year),
    originally_available: date(m.originallyAvailableAt),
    content_rating: str(m.contentRating),
    audience_rating: num(m.audienceRating),
    critic_rating: num(m.rating),
    studio: str(m.studio),
    duration_ms: int(m.duration),
    idx: int(m.index),
    parent_idx: int(m.parentIndex),
    leaf_count: int(m.leafCount),
    child_count: int(m.childCount),
    added_at: epoch(m.addedAt),
    plex_updated_at: int(m.updatedAt),
    thumb: relPath(m.thumb),
    art: relPath(m.art),
    parent_thumb: relPath(m.parentThumb),
    grandparent_thumb: relPath(m.grandparentThumb),
    guids: guidsOf(m),
    tagline: shortText(m.tagline, 500),
    rating_image: ratingImage(m.ratingImage),
    audience_rating_image: ratingImage(m.audienceRatingImage),
  };
}

const CORE_COLS: Array<[keyof CoreRow, string]> = [
  ['rating_key', 'bigint'], ['section_id', 'int'], ['type', 'text'], ['parent_key', 'bigint'], ['grandparent_key', 'bigint'], ['title', 'text'],
  ['title_sort', 'text'], ['original_title', 'text'], ['summary', 'text'], ['year', 'int'], ['originally_available', 'date'], ['content_rating', 'text'],
  ['audience_rating', 'real'], ['critic_rating', 'real'], ['studio', 'text'], ['duration_ms', 'bigint'], ['idx', 'int'], ['parent_idx', 'int'],
  ['leaf_count', 'int'], ['child_count', 'int'], ['added_at', 'timestamptz'], ['plex_updated_at', 'bigint'], ['thumb', 'text'], ['art', 'text'],
  ['parent_thumb', 'text'], ['grandparent_thumb', 'text'], ['guids', 'text[]'],
  ['tagline', 'text'], ['rating_image', 'text'], ['audience_rating_image', 'text'],
];
/** Block 21 columns a listing may leave out while the detail fetch has them: a missing value never clears a stored one. */
const KEEP_WHEN_MISSING = new Set(['tagline', 'rating_image', 'audience_rating_image']);

/**
 * Bulk upsert of core rows (one statement). Unchanged rows are not rewritten. guids from a listing only replace stored ones
 * when the listing had any (`includeGuids=1` is honoured by current PMS versions).
 *
 * Fail closed on rating changes: the computed ages (age_req / age_opt, read by every access predicate) are only refreshed by
 * refreshAges() after the pass. Until then an item whose content_rating changed - and every season / episode / extra inheriting
 * from it - gets NULL ages, i.e. it is hidden from age-capped profiles instead of keeping its old (maybe lower) age.
 */
export async function upsertCore(db: Db, rows: CoreRow[]): Promise<void> {
  if (!rows.length) return;
  const json = JSON.stringify(rows);
  await db.query(
    `update plex_items c set age_req = null, age_opt = null
     from jsonb_to_recordset($1::jsonb) as x(rating_key bigint, content_rating text)
     join plex_items p on p.rating_key = x.rating_key
     where p.content_rating is distinct from x.content_rating
       and c.type in ('season', 'episode', 'clip') and (c.parent_key = p.rating_key or c.grandparent_key = p.rating_key)
       and (c.age_req is not null or c.age_opt is not null)`,
    [json],
  );
  const cols = CORE_COLS.map(([c]) => c);
  const def = CORE_COLS.map(([c, t]) => `${c} ${t}`).join(', ');
  const set = [
    ...cols.filter((c) => c !== 'rating_key').map((c) => (c === 'guids'
      ? `guids = case when cardinality(excluded.guids) > 0 then excluded.guids else plex_items.guids end`
      : KEEP_WHEN_MISSING.has(c) ? `${c} = coalesce(excluded.${c}, plex_items.${c})` : `${c} = excluded.${c}`)),
    ...['age_req', 'age_opt'].map((c) => `${c} = case when plex_items.content_rating is distinct from excluded.content_rating then null else plex_items.${c} end`),
  ].join(', ');
  const changed = cols.filter((c) => c !== 'rating_key' && c !== 'guids')
    .map((c) => (KEEP_WHEN_MISSING.has(c) ? `(excluded.${c} is not null and plex_items.${c} is distinct from excluded.${c})` : `plex_items.${c} is distinct from excluded.${c}`))
    .join(' or ');
  await db.query(
    `insert into plex_items(${cols.join(', ')})
     select ${cols.join(', ')} from jsonb_to_recordset($1::jsonb) as x(${def})
     on conflict (rating_key) do update set ${set}
     where ${changed} or (cardinality(excluded.guids) > 0 and plex_items.guids is distinct from excluded.guids)`,
    [json],
  );
}

// ---------------------------------------------------------------- details (tags, streams, markers, extras)

export interface TagRow { rating_key: string; kind: string; tag: string; tag_id: string | null; role: string | null; thumb: string | null; pos: number }

const TAG_KINDS: Array<[string, string]> = [
  ['Genre', 'genre'], ['Role', 'actor'], ['Director', 'director'], ['Writer', 'writer'], ['Producer', 'producer'], ['Country', 'country'],
  ['Label', 'label'], ['Collection', 'collection'], ['Studio', 'studio'],
];

export function tagRows(m: Record<string, any>): TagRow[] {
  const rk = key(m.ratingKey);
  if (!rk) return [];
  const out: TagRow[] = [];
  const seen = new Set<string>();
  for (const [field, kind] of TAG_KINDS) {
    const list = Array.isArray(m[field]) ? m[field] : [];
    list.forEach((t: Record<string, any>, i: number) => {
      const tag = str(t?.tag);
      if (!tag || seen.has(`${kind}|${tag}`)) return;
      seen.add(`${kind}|${tag}`);
      out.push({ rating_key: rk, kind, tag: tag.slice(0, 300), tag_id: key(t.id), role: str(t.role)?.slice(0, 300) ?? null, thumb: relPath(t.thumb), pos: i });
    });
  }
  if (typeof m.studio === 'string' && m.studio && !seen.has(`studio|${m.studio}`)) out.push({ rating_key: rk, kind: 'studio', tag: m.studio.slice(0, 300), tag_id: null, role: null, thumb: null, pos: 0 });
  return out;
}

const STREAM_KEYS = ['id', 'streamType', 'codec', 'index', 'language', 'languageCode', 'languageTag', 'title', 'displayTitle', 'extendedDisplayTitle',
  'default', 'selected', 'forced', 'key', 'format', 'channels', 'bitDepth', 'height', 'width', 'profile', 'level', 'bitrate', 'hearingImpaired',
  // quality traits (traits.ts): dynamic range (PQ / HLG transfer, Dolby Vision) and the audio layout
  'DOVIPresent', 'DOVIProfile', 'colorTrc', 'colorPrimaries', 'audioChannelLayout'] as const;
const MEDIA_KEYS = ['id', 'container', 'videoCodec', 'audioCodec', 'width', 'height', 'bitrate', 'duration', 'videoResolution', 'audioChannels', 'videoProfile'] as const;
const PART_KEYS = ['id', 'key', 'size', 'container', 'duration', 'indexes'] as const;
const pick = (o: Record<string, any>, ks: readonly string[]) => Object.fromEntries(ks.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));

/** Media/Part/Stream without file system paths (the mirror never stores server paths). */
export function trimMedia(m: Record<string, any>): Array<Record<string, any>> | null {
  if (!Array.isArray(m.Media)) return null;
  return m.Media.map((md: Record<string, any>) => ({
    ...pick(md, MEDIA_KEYS),
    Part: (Array.isArray(md.Part) ? md.Part : []).map((pt: Record<string, any>) => ({
      ...pick(pt, PART_KEYS),
      Stream: (Array.isArray(pt.Stream) ? pt.Stream : []).map((s: Record<string, any>) => pick(s, STREAM_KEYS)),
    })),
  }));
}

/**
 * `Chapter: [{id, tag, index, startTimeOffset, endTimeOffset, thumb?}]` (ms; `includeChapters=1`, verified on PMS 1.43). `thumb`
 * (`/library/media/<media id>/chapterImages/<index>`) exists only when PMS generated chapter thumbnails (GenerateChapterThumbBehavior).
 * null = the answer had no Chapter array.
 */
export function chaptersOf(m: Record<string, any>): Array<{ start: number; name: string; media?: string; index?: number }> | null {
  if (!Array.isArray(m.Chapter)) return null;
  return m.Chapter.slice(0, 300).flatMap((c: Record<string, any>) => {
    const start = Number(c?.startTimeOffset);
    if (!Number.isFinite(start) || start < 0) return [];
    const th = /^\/library\/media\/(\d{1,18})\/chapterImages\/(\d{1,4})$/.exec(String(c?.thumb ?? ''));
    return [{ start: Math.round(start), name: typeof c?.tag === 'string' ? c.tag.trim().slice(0, 120) : '', ...(th ? { media: th[1]!, index: Number(th[2]) } : {}) }];
  });
}

/** `Marker: [{type: intro|credits, startTimeOffset, endTimeOffset}]` (ms). */
export function markersOf(m: Record<string, any>): Array<{ type: string; start: number; end: number }> | null {
  if (!Array.isArray(m.Marker)) return null;
  return m.Marker
    .map((x: Record<string, any>) => ({ type: String(x?.type ?? ''), start: Number(x?.startTimeOffset), end: Number(x?.endTimeOffset) }))
    .filter((x: { type: string; start: number; end: number }) => x.type && Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start);
}

export interface DetailRow {
  rating_key: string;
  logo: string | null;
  media: Array<Record<string, any>> | null;
  markers: Array<{ type: string; start: number; end: number }> | null;
  chapters: Array<{ start: number; name: string; media?: string; index?: number }> | null;
  extra_type: string | null;
}

export function detailRow(m: Record<string, any>): DetailRow | null {
  const rk = key(m.ratingKey);
  if (!rk) return null;
  const logo = (Array.isArray(m.Image) ? m.Image : []).find((i: Record<string, any>) => i?.type === 'clearLogo');
  return { rating_key: rk, logo: relPath(logo?.url), media: trimMedia(m), markers: markersOf(m), chapters: chaptersOf(m), extra_type: str(m.subtype) };
}

/** Writes the detail columns + tags of fully fetched items (tags are replaced). */
export async function writeDetails(db: Db, details: DetailRow[], tags: TagRow[]): Promise<void> {
  if (!details.length) return;
  const keys = details.map((d) => d.rating_key);
  await db.query(
    `update plex_items i set logo = x.logo, media = x.media, markers = x.markers, chapters = x.chapters, extra_type = coalesce(x.extra_type, i.extra_type), detail_at = now()
     from jsonb_to_recordset($1::jsonb) as x(rating_key bigint, logo text, media jsonb, markers jsonb, chapters jsonb, extra_type text)
     where i.rating_key = x.rating_key`,
    [JSON.stringify(details)],
  );
  await db.query('delete from plex_tags where rating_key = any($1::bigint[])', [keys]);
  if (tags.length) {
    await db.query(
      `insert into plex_tags(rating_key, kind, tag, tag_id, role, thumb, pos)
       select x.rating_key, x.kind, x.tag, x.tag_id, x.role, x.thumb, x.pos from jsonb_to_recordset($1::jsonb)
         as x(rating_key bigint, kind text, tag text, tag_id bigint, role text, thumb text, pos int)
       where exists (select 1 from plex_items i where i.rating_key = x.rating_key)
       on conflict do nothing`,
      [JSON.stringify(tags)],
    );
  }
}

/** Replaces the member list of one collection. */
export async function writeCollectionItems(db: Db, collectionKey: string, itemKeys: string[]): Promise<void> {
  await db.query('delete from plex_collection_items where collection_key = $1', [collectionKey]);
  if (itemKeys.length) {
    await db.query(
      `insert into plex_collection_items(collection_key, item_key, pos) select $1, k, n - 1 from unnest($2::bigint[]) with ordinality as u(k, n) on conflict do nothing`,
      [collectionKey, itemKeys],
    );
  }
}

/** Cache-buster of a Plex image path (`/library/metadata/1/thumb/1791799951` -> "1791799951"); usable as an image tag. */
export function imageTag(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  const m = /\/(\d{1,20})(?:\?.*)?$/.exec(path);
  return m ? m[1] : undefined;
}
