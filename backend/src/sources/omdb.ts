// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
import { extFetch, extRequest, omdbReserve, statusOf, type ExtLog } from './fetch.js';
import type { SourceName } from './keys.js';
import { tmdbProbe } from './tmdb.js';

const url = (imdbId: string, key: string) => ({ url: `https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(key)}` });

export interface OmdbRatings { imdb?: number; rt?: number; mc?: number }

function parseRatings(j: unknown): OmdbRatings {
  const o = j as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || o.Response === 'False') throw new Error('bad');
  const out: OmdbRatings = {};
  const imdb = parseFloat(String(o.imdbRating ?? ''));
  if (Number.isFinite(imdb)) out.imdb = imdb;
  for (const r of Array.isArray(o.Ratings) ? o.Ratings : []) {
    const { Source: s, Value: v } = r as { Source?: unknown; Value?: unknown };
    const n = parseInt(String(v ?? ''), 10);
    if (!Number.isFinite(n) || typeof v !== 'string') continue;
    if (s === 'Rotten Tomatoes' && /^\d+%$/.test(v)) out.rt = n;
    else if (s === 'Metacritic' && /^\d+\/100$/.test(v)) out.mc = n;
  }
  return out;
}

export function omdbRatings(ctx: Ctx, imdbId: string, log?: ExtLog): Promise<OmdbRatings | null> {
  if (!/^tt\d{1,10}$/.test(imdbId)) return Promise.resolve(null);
  return extFetch(ctx, 'omdb', imdbId, (key) => url(imdbId, key), parseRatings, log);
}

export async function testSourceKey(ctx: Ctx, name: SourceName, key: string): Promise<{ ok: true } | { ok: false; error: 'invalid_key' | 'unreachable' | 'budget' }> {
  if (name === 'tmdb') return tmdbProbe(ctx, key);
  if (!(await omdbReserve(ctx))) return { ok: false, error: 'budget' };
  try {
    const j = (await extRequest(ctx, url('tt0111161', key))) as { Response?: unknown; Error?: unknown } | null;
    if (j?.Response === 'False') return { ok: false, error: /api key/i.test(String(j.Error ?? '')) ? 'invalid_key' : 'unreachable' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: statusOf(e) === 401 ? 'invalid_key' : 'unreachable' };
  }
}
