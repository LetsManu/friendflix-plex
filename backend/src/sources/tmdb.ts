import type { Ctx } from '../ctx.js';
import { extFetch, extRequest, statusOf, type ExtLog, type ExtRequest } from './fetch.js';

const BASE = 'https://api.themoviedb.org/3';
const V4 = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;
const POSTER = /^\/[A-Za-z0-9_-]{5,60}\.(jpg|png|webp)$/;

/** v4 read tokens go in the Authorization header, v3 keys in the api_key parameter. */
export function tmdbRequest(path: string, key: string): ExtRequest {
  if (V4.test(key)) return { url: BASE + path, headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } };
  return { url: `${BASE}${path}${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}`, headers: { Accept: 'application/json' } };
}

const obj = (j: unknown): Record<string, unknown> => {
  if (!j || typeof j !== 'object') throw new Error('bad');
  return j as Record<string, unknown>;
};

export interface TmdbTitle { imdbId?: string; collection?: { id: number; name: string }; keywords: string[] }

export function tmdbTitle(ctx: Ctx, type: 'movie' | 'tv', tmdbId: number, log?: ExtLog): Promise<TmdbTitle | null> {
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return Promise.resolve(null);
  return extFetch(ctx, 'tmdb', `${type}:${tmdbId}`, (key) => tmdbRequest(`/${type}/${tmdbId}?append_to_response=keywords,external_ids`, key), (j) => {
    const o = obj(j);
    const kw = obj(o.keywords ?? {});
    const list = (type === 'movie' ? kw.keywords : kw.results);
    const keywords = (Array.isArray(list) ? list : []).map((x) => (x as { name?: unknown })?.name).filter((n): n is string => typeof n === 'string' && n !== '').slice(0, 20);
    const imdb = (o.imdb_id ?? (o.external_ids as { imdb_id?: unknown } | undefined)?.imdb_id);
    const out: TmdbTitle = { keywords };
    if (typeof imdb === 'string' && /^tt\d{1,10}$/.test(imdb)) out.imdbId = imdb;
    const c = o.belongs_to_collection as { id?: unknown; name?: unknown } | null | undefined;
    if (c && typeof c.id === 'number' && typeof c.name === 'string') out.collection = { id: c.id, name: c.name };
    return out;
  }, log);
}

export interface TmdbCollection { id: number; name: string; parts: Array<{ tmdbId: number; title: string; releaseDate?: string; posterPath?: string }> }

export function tmdbCollection(ctx: Ctx, id: number, log?: ExtLog): Promise<TmdbCollection | null> {
  if (!Number.isInteger(id) || id <= 0) return Promise.resolve(null);
  return extFetch(ctx, 'tmdb', `collection:${id}`, (key) => tmdbRequest(`/collection/${id}`, key), (j) => {
    const o = obj(j);
    const parts: TmdbCollection['parts'] = [];
    for (const p of Array.isArray(o.parts) ? o.parts : []) {
      const x = p as Record<string, unknown>;
      if (typeof x?.id !== 'number' || typeof x.title !== 'string') continue;
      const part: TmdbCollection['parts'][number] = { tmdbId: x.id, title: x.title };
      if (typeof x.release_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.release_date)) part.releaseDate = x.release_date;
      if (typeof x.poster_path === 'string' && POSTER.test(x.poster_path)) part.posterPath = x.poster_path;
      parts.push(part);
    }
    parts.sort((a, b) => (a.releaseDate && b.releaseDate ? a.releaseDate.localeCompare(b.releaseDate) : a.releaseDate ? -1 : b.releaseDate ? 1 : 0));
    return { id: typeof o.id === 'number' ? o.id : id, name: typeof o.name === 'string' ? o.name : '', parts };
  }, log);
}

/** Probe for the admin "test" button: /configuration, uncached. */
export async function tmdbProbe(ctx: Ctx, key: string): Promise<{ ok: true } | { ok: false; error: 'invalid_key' | 'unreachable' }> {
  try {
    await extRequest(ctx, tmdbRequest('/configuration', key));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: statusOf(e) === 401 ? 'invalid_key' : 'unreachable' };
  }
}
