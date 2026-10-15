// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
import { randomToken } from './crypto.js';

/**
 * Cover wall of the in-app login (Block 23 phase 3, Ruling 6): the poster thumbnails of the library, only items whose own rating is on
 * this exact, case-sensitive allow-list (up to FSK 12 and equivalents). Unrated items and unknown spellings (NR, Unrated, Approved,
 * PG-13, TV-14) are not on it and fail safe.
 */
export const LOGIN_ART_RATINGS: readonly string[] = [
  'FSK 0', 'FSK-0', 'FSK 6', 'FSK-6', 'FSK 12', 'FSK-12', 'DE-0', 'DE-6', 'DE-12', '0', '6', '12',
  'G', 'PG', 'TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G', 'TV-PG',
  'U', 'PG', '12A', 'GB-U', 'GB-PG', 'GB-12', 'GB-12A',
].filter((r, i, a) => a.indexOf(r) === i);
export const LOGIN_ART_COUNT = 36;
export const LOGIN_ART_WIDTH = 200;
export const LOGIN_ART_TTL = 3600;

export const ART_SET_RE = /^[A-Za-z0-9_-]{12}$/;
export const ART_INDEX_RE = /^(0|[1-9]\d?)$/;

/** images outlive the list: a browser holding a cached list (max-age = LOGIN_ART_TTL) must never get 404s for its images */
export const LOGIN_ART_IMAGE_TTL = 2 * LOGIN_ART_TTL + 600;
const BUILDING = 'loginart:building';
const CURRENT = 'loginart:current';
const EMPTY = 'loginart:empty';
const LOCK_TTL = 60;
const EMPTY_TTL = 45;
/** no new poster fetch starts after this, so a build ends well inside its lock */
const BUILD_BUDGET_MS = 40_000;
const FETCH_CONCURRENCY = 6;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export interface ArtLog { warn(o: object, m: string): void }

async function readCurrent(ctx: Ctx): Promise<{ set: string; count: number } | null> {
  const raw = await ctx.kv.get(CURRENT);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { set?: unknown; count?: unknown };
    return typeof v.set === 'string' && ART_SET_RE.test(v.set) && typeof v.count === 'number' && v.count > 0 ? { set: v.set, count: v.count } : null;
  } catch {
    return null;
  }
}

async function build(ctx: Ctx): Promise<{ set: string; count: number } | null> {
  const admin = ctx.jf.admin;
  if (!admin.loginArtIds || !admin.posterThumb) return null;
  const thumb = admin.posterThumb.bind(admin);
  const ids = (await admin.loginArtIds({ ratings: LOGIN_ART_RATINGS, limit: LOGIN_ART_COUNT })).slice(0, LOGIN_ART_COUNT);
  if (!ids.length) return null;
  const set = randomToken(9);
  const results: Array<{ type: string; b64: string } | null> = new Array(ids.length).fill(null);
  const deadline = Date.now() + BUILD_BUDGET_MS;
  let next = 0;
  const worker = async () => {
    while (next < ids.length && Date.now() < deadline) {
      const k = next++;
      try {
        const img = await thumb(ids[k]!, LOGIN_ART_WIDTH);
        if (img) results[k] = { type: img.type, b64: Buffer.from(img.bytes).toString('base64') };
      } catch { /* a single image is skipped */ }
    }
  };
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
  let n = 0;
  for (const r of results) {
    if (!r) continue;
    await ctx.kv.set(`loginart:${set}:${n}`, JSON.stringify(r), LOGIN_ART_IMAGE_TTL);
    n++;
  }
  if (!n) return null;
  // the list is written last, after every image
  await ctx.kv.set(CURRENT, JSON.stringify({ set, count: n }), LOGIN_ART_TTL);
  return { set, count: n };
}

/** The current set (built on first use, then reused for an hour); null when off, unsupported by the media server, or empty. */
export async function currentArtSet(ctx: Ctx, log?: ArtLog): Promise<{ set: string; count: number } | null> {
  if (ctx.cfg.LOGIN_COVER_WALL !== 'true') return null;
  if (!ctx.jf.admin.loginArtIds || !ctx.jf.admin.posterThumb) return null;
  const have = await readCurrent(ctx);
  if (have) return have;
  // a failed or empty build is remembered for a short while: the public route must not make a library listing per request
  if (await ctx.kv.get(EMPTY)) return null;
  const token = randomToken(9);
  if (await ctx.kv.setnx(BUILDING, token, LOCK_TTL)) {
    try {
      const again = await readCurrent(ctx); // a builder may have finished just before we won the lock
      if (again) return again;
      const r = await build(ctx);
      if (!r) await ctx.kv.set(EMPTY, '1', EMPTY_TTL);
      return r;
    } catch (e) {
      // class and status only: the message may quote the request URL
      log?.warn({ type: (e as Error)?.name, status: (e as { statusCode?: unknown })?.statusCode }, 'login art build failed');
      await ctx.kv.set(EMPTY, '1', EMPTY_TTL);
      return null;
    } finally {
      await ctx.kv.delIfEquals(BUILDING, token);
    }
  }
  // another request is building: wait for its result instead of listing again
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const r = await readCurrent(ctx);
    if (r) return r;
    if (!(await ctx.kv.get(BUILDING))) break;
  }
  return readCurrent(ctx);
}
/** One cached image, or null. The caller has validated `set` and `i` with ART_SET_RE / ART_INDEX_RE. */
export async function artImage(ctx: Ctx, set: string, i: number): Promise<{ bytes: Buffer; type: string } | null> {
  const raw = await ctx.kv.get(`loginart:${set}:${i}`);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { type: string; b64: string };
    return { bytes: Buffer.from(v.b64, 'base64'), type: v.type };
  } catch {
    return null;
  }
}
