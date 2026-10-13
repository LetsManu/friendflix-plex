/** Block 21: the "Über" tab of the detail page — media server facts plus optional TMDB / OMDb data, merged into one neutral DTO. */
import type { Ctx } from './ctx.js';
import { MediaError, type ItemAboutDto, type ItemDto, type MediaCollection, type ProviderIds } from './media/types.js';
import { limitFor } from './requestlimit.js';
import type { ExtLog } from './sources/fetch.js';
import { omdbRatings, type OmdbRatings } from './sources/omdb.js';
import { tmdbCollection, tmdbTitle, type TmdbCollection, type TmdbTitle } from './sources/tmdb.js';
import type { JfUser } from './types.js';

export type RatingKey = 'community' | 'critic' | 'imdb' | 'rt' | 'mc' | 'friends';
export interface AboutRating { key: RatingKey; value: number; max: 5 | 10 | 100; from: 'jellyfin' | 'omdb' | 'friends' }
export interface AboutLink { kind: 'imdb' | 'tmdb' | 'tvdb' | 'trakt'; url: string }
export interface AboutPart {
  id?: string; tmdbId?: number; name: string; year?: number; poster?: string; image: boolean; played: boolean; current: boolean; inLibrary: boolean;
  from: 'jellyfin' | 'tmdb';
}
export interface AboutCollection { name: string; parts: AboutPart[]; from: 'jellyfin' | 'tmdb' }
export type AboutSource = 'jellyfin' | 'tmdb' | 'omdb';
export interface AboutDto {
  ratings: AboutRating[]; tagline?: string; originalTitle?: string; releaseDate?: string; countries: string[]; studios: string[]; tags: string[];
  keywords: string[]; links: AboutLink[]; collection: AboutCollection | null; canRequest: boolean; sources: AboutSource[];
}

const IMDB = /^tt\d{7,10}$/;
const NUM_ID = /^\d{1,9}$/;
/** TMDB collections are short; a bigger one would only cost lookups */
const MAX_PARTS = 30;
/** how long /about waits for the box sets (library-wide index build); later the answer goes out without a collection row */
export const ABOUT_LIMITS = { collectionWaitMs: 2500 };

/** Outbound links; every id is validated first, anything else is dropped (no URL is ever built from an unchecked value). */
export function buildLinks(type: string, ids: ProviderIds): AboutLink[] {
  const kind = type === 'Movie' ? 'movie' : type === 'Series' ? 'tv' : null;
  const imdb = ids.imdb && IMDB.test(ids.imdb) ? ids.imdb : undefined;
  const tmdb = kind && ids.tmdb && NUM_ID.test(ids.tmdb) ? ids.tmdb : undefined;
  const tvdb = kind && ids.tvdb && NUM_ID.test(ids.tvdb) ? ids.tvdb : undefined;
  const out: AboutLink[] = [];
  if (imdb) out.push({ kind: 'imdb', url: `https://www.imdb.com/title/${imdb}/` });
  if (tmdb) out.push({ kind: 'tmdb', url: `https://www.themoviedb.org/${kind}/${tmdb}` });
  if (tvdb) out.push({ kind: 'tvdb', url: `https://www.thetvdb.com/dereferrer/${kind === 'movie' ? 'movie' : 'series'}/${tvdb}` });
  if (imdb) out.push({ kind: 'trakt', url: `https://trakt.tv/search/imdb/${imdb}` });
  else if (tmdb) out.push({ kind: 'trakt', url: `https://trakt.tv/search/tmdb/${tmdb}?id_type=${kind === 'movie' ? 'movie' : 'show'}` });
  return out;
}

/** Ratings in display order; the Jellyfin critic score is dropped when OMDb has Rotten Tomatoes (it is the same number, older). */
export function buildRatings(about: ItemAboutDto | null, omdb: OmdbRatings | null, friends: number | null): AboutRating[] {
  const out: AboutRating[] = [];
  if (about?.communityRating !== undefined) out.push({ key: 'community', value: about.communityRating, max: 10, from: 'jellyfin' });
  if (about?.criticRating !== undefined && omdb?.rt === undefined) out.push({ key: 'critic', value: about.criticRating, max: 100, from: 'jellyfin' });
  if (omdb?.imdb !== undefined) out.push({ key: 'imdb', value: omdb.imdb, max: 10, from: 'omdb' });
  if (omdb?.rt !== undefined) out.push({ key: 'rt', value: omdb.rt, max: 100, from: 'omdb' });
  if (omdb?.mc !== undefined) out.push({ key: 'mc', value: omdb.mc, max: 100, from: 'omdb' });
  if (friends !== null) out.push({ key: 'friends', value: friends, max: 5, from: 'friends' });
  return out;
}

const lower = (s: string) => s.toLocaleLowerCase();
/** TMDB keywords minus the ones already shown as tags (and duplicates), case-insensitive. */
export function mergeKeywords(tags: string[], keywords: string[]): string[] {
  const seen = new Set(tags.map(lower));
  const out: string[] = [];
  for (const k of keywords) {
    if (seen.has(lower(k))) continue;
    seen.add(lower(k));
    out.push(k);
  }
  return out;
}

const tmdbNum = (s: string | undefined): number | undefined => (s && NUM_ID.test(s) ? Number(s) : undefined);
const libPart = (it: ItemDto, currentId: string, tmdbId?: number): AboutPart => ({
  id: it.id, ...(tmdbId !== undefined ? { tmdbId } : {}), name: it.name, ...(it.year ? { year: it.year } : {}),
  image: it.image, played: it.played, current: it.id === currentId, inLibrary: true, from: 'jellyfin',
});

/** The box set to show: most parts shared with the TMDB collection, then most parts; only sets with ≥ 2 visible parts. */
export function pickBoxSet(sets: MediaCollection[], tmdb: TmdbCollection | null): MediaCollection | null {
  const want = new Set((tmdb?.parts ?? []).map((p) => p.tmdbId));
  const overlap = (c: MediaCollection) => dedupeParts(c.parts).filter((p) => { const n = tmdbNum(p.tmdbId); return n !== undefined && want.has(n); }).length;
  let best: MediaCollection | null = null;
  for (const c of sets) {
    if (dedupeParts(c.parts).length < 2) continue;
    if (!best || overlap(c) > overlap(best) || (overlap(c) === overlap(best) && c.parts.length > best.parts.length)) best = c;
  }
  return best;
}

interface CollectionInput {
  ctx: Ctx; user: JfUser; current: ItemDto; currentTmdb?: number; kids: boolean; sets: MediaCollection[]; tmdb: TmdbCollection | null;
}

/** tmdb id -> library item id (admin lookup, the same for every viewer): kv-cached so a collection row costs no lookup per request. */
const LIB_KEY = (tmdbId: number) => `about:tmdb2jf:${tmdbId}`;
const LIB_HIT_TTL = 3600;
const LIB_MISS_TTL = 600;
async function libraryIdOf(ctx: Ctx, tmdbId: number): Promise<string | null> {
  const hit = await ctx.kv.get(LIB_KEY(tmdbId)).catch(() => null);
  if (hit !== null) return hit || null;
  const found = await ctx.jf.findByTmdb(tmdbId, 'movie'); // a failure throws: never cached, never "missing"
  await ctx.kv.set(LIB_KEY(tmdbId), found?.id ?? '', found ? LIB_HIT_TTL : LIB_MISS_TTL).catch(() => undefined);
  return found?.id ?? null;
}

/**
 * Box set parts with one entry per TMDB id (a second version of a movie, e.g. a 4K copy, does not count twice). The copy being viewed wins
 * over another copy of it, so it stays marked as the current part.
 */
function dedupeParts(parts: MediaCollection['parts'], currentId?: string): MediaCollection['parts'] {
  const keep = new Map<number, string>();
  for (const p of parts) {
    const n = tmdbNum(p.tmdbId);
    if (n !== undefined && (!keep.has(n) || p.item.id === currentId)) keep.set(n, p.item.id);
  }
  return parts.filter((p) => { const n = tmdbNum(p.tmdbId); return n === undefined || keep.get(n) === p.item.id; });
}

/**
 * Library parts come from the viewer's own identity only: the current item, a box set part (already filtered by the media server) or, for a
 * TMDB part outside the box set, the library lookup (admin, cached) followed by the viewer's item(). A part in the library the viewer cannot
 * see is left out entirely, never shown as missing. Missing parts (not in the library at all) are dropped for kids.
 * A box set only names the row and adds parts TMDB does not list when it shares at least 2 parts with the TMDB collection: a user-made set
 * ("Favourites") shares just the current item.
 */
export async function buildCollection({ ctx, user, current, currentTmdb, kids, sets, tmdb }: CollectionInput): Promise<AboutCollection | null> {
  const currentId = current.id;
  const box = pickBoxSet(sets, tmdb);
  if (!tmdb || !tmdb.parts.length) {
    if (!box) return null;
    const parts = dedupeParts(box.parts, currentId).slice(0, MAX_PARTS).map((p) => libPart(p.item, currentId, tmdbNum(p.tmdbId)));
    return parts.length >= 2 ? { name: box.name, parts, from: 'jellyfin' } : null;
  }
  const tparts = tmdb.parts.slice(0, MAX_PARTS);
  const tset = new Set(tparts.map((t) => t.tmdbId));
  const boxParts = box ? dedupeParts(box.parts, currentId) : [];
  const related = boxParts.filter((p) => { const n = tmdbNum(p.tmdbId); return n !== undefined && tset.has(n); }).length >= 2;
  const byTmdb = new Map<number, ItemDto>();
  if (related) for (const p of boxParts) { const n = tmdbNum(p.tmdbId); if (n !== undefined) byTmdb.set(n, p.item); }
  const resolved = await Promise.all(tparts.map(async (tp): Promise<AboutPart | null> => {
    if (currentTmdb !== undefined && tp.tmdbId === currentTmdb) return libPart(current, currentId, tp.tmdbId); // never another copy of it
    const inBox = byTmdb.get(tp.tmdbId);
    if (inBox) return libPart(inBox, currentId, tp.tmdbId);
    let hit: string | null;
    try { hit = await libraryIdOf(ctx, tp.tmdbId); } catch { return null; } // unknown: never claim "missing"
    if (hit) {
      try { return libPart(await ctx.jf.item(user, hit), currentId, tp.tmdbId); } catch { return null; } // in the library, not for this viewer
    }
    if (kids) return null;
    const year = tp.releaseDate ? Number(tp.releaseDate.slice(0, 4)) : undefined;
    return {
      tmdbId: tp.tmdbId, name: tp.title, ...(year ? { year } : {}), ...(tp.posterPath ? { poster: `/api/seerr/image${tp.posterPath}` } : {}),
      image: Boolean(tp.posterPath), played: false, current: false, inLibrary: false, from: 'tmdb',
    };
  }));
  const parts = resolved.filter((p): p is AboutPart => p !== null);
  if (related) {
    // parts of the matching box set TMDB does not list (no tmdb id, other cut) stay visible, after the TMDB order
    const listed = new Set(parts.flatMap((p) => (p.id ? [p.id] : [])));
    for (const p of boxParts) {
      const n = tmdbNum(p.tmdbId);
      if (listed.has(p.item.id) || (n !== undefined && tset.has(n)) || parts.length >= MAX_PARTS) continue;
      parts.push(libPart(p.item, currentId, n));
      listed.add(p.item.id);
    }
  }
  if (parts.length < 2) return null;
  return { name: related ? box!.name : tmdb.name, parts, from: 'tmdb' };
}

const settle = <T>(p: Promise<T | null>): Promise<T | null> => p.catch(() => null);
/** p, or null when it takes longer than ms (p itself keeps running) */
function withinMs<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<null>((res) => { timer = setTimeout(() => res(null), ms); });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** Average of the friends' ratings exactly as GET /api/items/:id/ratings counts them (shareRatings respected); null = none. */
async function friendsAverage(ctx: Ctx, itemId: string, userId: string): Promise<number | null> {
  const r = await ctx.db.query<{ avg: string | null }>(
    `select avg(stars)::float8 avg from (select r.stars from ratings r left join user_prefs p on p.user_id=r.user_id
      where r.item_id=$1 and (r.user_id = $2 or coalesce(p.data->>'shareRatings', 'true') <> 'false') order by r.created_at desc limit 50) x`,
    [itemId, userId]);
  const v = r.rows[0]?.avg;
  return v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10;
}

export interface AboutInput { ctx: Ctx; user: JfUser; account: { id: string; role: string }; kids: boolean; id: string; log?: ExtLog }

/**
 * Builds the "Über" DTO. Throws MediaError(404) when the viewer cannot see the item (checked first, with the viewer's identity, before any
 * collection lookup). External lookups that fail or time out only remove their part.
 */
export async function buildAbout({ ctx, user, account, kids, id, log }: AboutInput): Promise<AboutDto> {
  const jf = ctx.jf;
  // access check first: item() and itemAbout() both run as the viewer and answer 404 for an item the viewer cannot see
  const [item, about] = await Promise.all([jf.item(user, id), jf.itemAbout ? jf.itemAbout(user, id) : Promise.resolve(null)]);
  if (!item) throw new MediaError(404, 'not visible');
  const type = about?.type || item.type;
  const ids = about?.providerIds ?? {};
  const tmdbId = tmdbNum(ids.tmdb);
  const tmdbType = type === 'Movie' ? 'movie' : type === 'Series' ? 'tv' : null;
  const jfImdb = ids.imdb && IMDB.test(ids.imdb) ? ids.imdb : undefined;

  const titleP = tmdbId !== undefined && tmdbType ? settle(tmdbTitle(ctx, tmdbType, tmdbId, log)) : Promise.resolve(null as TmdbTitle | null);
  const omdbP = (async () => {
    const imdb = jfImdb ?? (await titleP)?.imdbId;
    return imdb ? settle(omdbRatings(ctx, imdb, log)) : null;
  })();
  const tmdbCollP = (async () => {
    const c = type === 'Movie' ? (await titleP)?.collection : undefined;
    return c ? settle(tmdbCollection(ctx, c.id, log)) : null;
  })();
  // the box-set lookup may wait for the library-wide index build: bounded; the build goes on in the background and fills the cache
  const setsP = type === 'Movie' && jf.itemCollections ? withinMs(jf.itemCollections(user, id).catch(() => [] as MediaCollection[]), ABOUT_LIMITS.collectionWaitMs) : Promise.resolve(null);
  const friendsP = kids ? Promise.resolve(null) : friendsAverage(ctx, id, account.id).catch(() => null);
  const canRequestP = kids ? Promise.resolve(false) : limitFor(ctx, account.role).then((l) => l !== 0, () => false);

  const [title, omdb, tColl, sets, friends, canRequest] = await Promise.all([titleP, omdbP, tmdbCollP, setsP, friendsP, canRequestP]);
  const collection = sets === null ? null : await buildCollection({ ctx, user, current: item, currentTmdb: tmdbId, kids, sets, tmdb: tColl }).catch(() => null);

  const sources: AboutSource[] = [];
  if (about || sets?.length) sources.push('jellyfin');
  if (title || tColl) sources.push('tmdb');
  if (omdb && (omdb.imdb !== undefined || omdb.rt !== undefined || omdb.mc !== undefined)) sources.push('omdb');

  const premiere = about?.premiereDate;
  const releaseDate = premiere && /^\d{4}-\d{2}-\d{2}/.test(premiere) ? premiere.slice(0, 10) : undefined;
  const originalTitle = about?.originalTitle && lower(about.originalTitle) !== lower(item.name) ? about.originalTitle : undefined;
  const tags = about?.tags ?? [];
  return {
    ratings: buildRatings(about, omdb, friends),
    ...(about?.tagline ? { tagline: about.tagline } : {}),
    ...(originalTitle ? { originalTitle } : {}),
    ...(releaseDate ? { releaseDate } : {}),
    countries: about?.countries ?? [],
    studios: about?.studios ?? [],
    tags,
    keywords: mergeKeywords(tags, title?.keywords ?? []),
    links: buildLinks(type, ids),
    collection,
    canRequest,
    sources,
  };
}
