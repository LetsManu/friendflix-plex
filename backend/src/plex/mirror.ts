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

/** `Guid: [{id:"tmdb://123"}]` (+ the item's own `guid` when it is an agent guid). */
function guidsOf(m: Record<string, any>): string[] {
  const out = new Set<string>();
  for (const g of Array.isArray(m.Guid) ? m.Guid : []) if (typeof g?.id === 'string' && /^[a-z]+:\/\/[\w./-]{1,200}$/i.test(g.id)) out.add(g.id.toLowerCase());
  return [...out];
}

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
  };
}

const CORE_COLS: Array<[keyof CoreRow, string]> = [
  ['rating_key', 'bigint'], ['section_id', 'int'], ['type', 'text'], ['parent_key', 'bigint'], ['grandparent_key', 'bigint'], ['title', 'text'],
  ['title_sort', 'text'], ['original_title', 'text'], ['summary', 'text'], ['year', 'int'], ['originally_available', 'date'], ['content_rating', 'text'],
  ['audience_rating', 'real'], ['critic_rating', 'real'], ['studio', 'text'], ['duration_ms', 'bigint'], ['idx', 'int'], ['parent_idx', 'int'],
  ['leaf_count', 'int'], ['child_count', 'int'], ['added_at', 'timestamptz'], ['plex_updated_at', 'bigint'], ['thumb', 'text'], ['art', 'text'],
  ['parent_thumb', 'text'], ['grandparent_thumb', 'text'], ['guids', 'text[]'],
];

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
      : `${c} = excluded.${c}`)),
    ...['age_req', 'age_opt'].map((c) => `${c} = case when plex_items.content_rating is distinct from excluded.content_rating then null else plex_items.${c} end`),
  ].join(', ');
  const changed = cols.filter((c) => c !== 'rating_key' && c !== 'guids').map((c) => `plex_items.${c} is distinct from excluded.${c}`).join(' or ');
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
  'default', 'selected', 'forced', 'key', 'format', 'channels', 'bitDepth', 'height', 'width', 'profile', 'level', 'bitrate', 'hearingImpaired'] as const;
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
  extra_type: string | null;
}

export function detailRow(m: Record<string, any>): DetailRow | null {
  const rk = key(m.ratingKey);
  if (!rk) return null;
  const logo = (Array.isArray(m.Image) ? m.Image : []).find((i: Record<string, any>) => i?.type === 'clearLogo');
  return { rating_key: rk, logo: relPath(logo?.url), media: trimMedia(m), markers: markersOf(m), extra_type: str(m.subtype) };
}

/** Writes the detail columns + tags of fully fetched items (tags are replaced). */
export async function writeDetails(db: Db, details: DetailRow[], tags: TagRow[]): Promise<void> {
  if (!details.length) return;
  const keys = details.map((d) => d.rating_key);
  await db.query(
    `update plex_items i set logo = x.logo, media = x.media, markers = x.markers, extra_type = coalesce(x.extra_type, i.extra_type), detail_at = now()
     from jsonb_to_recordset($1::jsonb) as x(rating_key bigint, logo text, media jsonb, markers jsonb, extra_type text)
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
