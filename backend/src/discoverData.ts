// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
import type { ItemDto } from './media/types.js';
import type { JfUser } from './types.js';

/**
 * The data queries behind the discovery rows that other code reuses: items by id, friends' recommendations, friends' ratings and the
 * "this week" aggregates. They lived in routes/discover.ts and routes/trending.ts; recommendation engine v2 (reco/) needs the same
 * queries (friends signal, trending source) with the same opt-ins, so they sit here and the routes re-export them. No Fastify in here,
 * so the engine can import it without a cycle through the routes.
 */

/**
 * Fetches items by id in chunks of 40 (keeps URLs short), up to 4 chunks in parallel, with the viewer's own token, so library
 * permissions apply. Jellyfin errors count as "not visible" unless `strict` (then they throw). Keeps the requested order.
 */
export async function itemsByIds(ctx: Pick<Ctx, 'jf'>, user: JfUser, ids: string[], strict = false): Promise<ItemDto[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 40) chunks.push(ids.slice(i, i + 40));
  const parts = await inPool(chunks, 4, async (c) =>
    (await ctx.jf.items(user, { ids: c, types: 'Movie,Series,Episode,BoxSet', limit: 40 }).catch((e) => { if (strict) throw e; return { items: [] as ItemDto[] }; })).items);
  const byId = new Map(parts.flat().map((i) => [i.id, i]));
  return ids.map((i) => byId.get(i)).filter((x): x is ItemDto => Boolean(x));
}

/** Runs `fn` over `xs` with at most `n` calls in flight; results keep the input order. The first error rejects. */
export async function inPool<T, R>(xs: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i]!, i);
    }
  }));
  return out;
}

export interface RecommendationRow { id: string; item_id: string; note: string | null; from_name: string }

/** What friends recommended to this user in the last 60 days, unseen first (the query behind GET /api/recommendations). */
export async function recommendationRows(ctx: Pick<Ctx, 'db'>, userId: string): Promise<RecommendationRow[]> {
  return (await ctx.db.query<RecommendationRow>(
    `select r.id, r.item_id, r.note, u.name from_name from recommendations r join users u on u.id=r.from_user
      where r.to_user=$1 and r.created_at > now() - interval '60 days' order by r.seen, r.created_at desc limit 30`, [userId])).rows;
}

/** Data of GET /api/recommendations (also part of GET /api/home): what friends recommended to this user, newest unseen first. */
export async function recommendationsFor(ctx: Pick<Ctx, 'db' | 'jf'>, jfUser: JfUser, userId: string) {
  const rows = await recommendationRows(ctx, userId);
  const items = await itemsByIds(ctx, jfUser, [...new Set(rows.map((r) => r.item_id))]);
  const meta = new Map(rows.map((r) => [r.item_id, `Von ${r.from_name}${r.note ? `: ${r.note}` : ''}`]));
  const shown = new Set(items.map((i) => i.id));
  return { items: items.map((i) => ({ ...i, caption: meta.get(i.id) })), recIds: rows.filter((r) => shown.has(r.item_id)).map((r) => Number(r.id)) }; // recIds: send back to /seen
}

export interface FriendsRatedRow { item_id: string; names: string[]; /** the same friends without the stars, newest first */ who: string[]; avg: string }

/**
 * Titles friends rated 4 stars or more in the last 90 days (only friends with `shareRatings` on, which is the default), minus what this
 * user rated or thumbed down. The query behind GET /api/library/friends-rated; `names` carry the stars for the caption.
 */
export async function friendsRatedRows(ctx: Pick<Ctx, 'db'>, userId: string, profileId: string): Promise<FriendsRatedRow[]> {
  return (await ctx.db.query<FriendsRatedRow>(
    `select r.item_id, array_agg(u.name || ' ' || r.stars || '★' order by r.created_at desc) names, array_agg(u.name order by r.created_at desc) who, avg(r.stars) avg
       from ratings r join users u on u.id = r.user_id left join user_prefs p on p.user_id = r.user_id
      where r.user_id <> $1 and r.stars >= 4 and r.created_at > now() - interval '90 days' and not u.disabled
        and coalesce((p.data->>'shareRatings')::boolean, true)
        and r.item_id not in (select item_id from ratings where user_id = $1)
        and r.item_id not in (select item_id from thumbs where profile_id = $2 and value = -1)
      group by r.item_id order by max(r.created_at) desc limit 24`, [userId, profileId])).rows;
}

/** Data of GET /api/library/friends-rated (also part of GET /api/home). */
export async function friendsRatedFor(ctx: Pick<Ctx, 'db' | 'jf'>, jfUser: JfUser, userId: string, profileId: string) {
  const rows = await friendsRatedRows(ctx, userId, profileId);
  const items = await itemsByIds(ctx, jfUser, rows.map((r) => r.item_id));
  const cap = new Map(rows.map((r) => [r.item_id, r.names.slice(0, 2).join(', ')]));
  return { items: items.filter((i) => !i.played).map((i) => ({ ...i, caption: cap.get(i.id) })) };
}

// -------------------------------------------------------------------------------------------------------------------- trending

const TREND_TTL = 600;
const TREND_MAX_ITEMS = 10;
const TREND_MAX_CANDIDATES = 300;
const TREND_MIN_SECONDS = 300;

export type Trending = ItemDto & { viewers: number };

/**
 * "Diese Woche bei uns": what accounts with `shareHistory` on watched in the last 7 days (at least 5 minutes a day), at least 2 viewers
 * or the user's own plays; films and series (episodes rolled up), resolved with the viewer's token. Counts only, never names. Cached
 * 10 min per viewer. Throws a MediaError when the media server fails (the route turns it into a 502). Kids profiles must not call this.
 */
export async function trendingItems(ctx: Pick<Ctx, 'db' | 'jf' | 'kv'>, jfUser: JfUser, userId: string): Promise<Trending[]> {
  const key = `trend:${jfUser.jellyfin_user_id}:${userId}`; // result depends on the viewer (own plays count without opt-in)
  const hit = await ctx.kv.get(key);
  if (hit) return JSON.parse(hit) as Trending[];
  const rows = (await ctx.db.query<{ item_id: string; users: string[]; secs: string }>(
    `select p.item_id, array_agg(distinct p.user_id::text) users, sum(p.seconds) secs
       from play_seconds p join users u on u.id = p.user_id left join user_prefs pr on pr.user_id = p.user_id
      where p.day >= current_date - 6 and p.seconds >= $1 and not u.disabled
        and (p.user_id = $3 or coalesce((pr.data->>'shareHistory')::boolean, false))
      group by p.item_id order by sum(p.seconds) desc limit $2`, [TREND_MIN_SECONDS, TREND_MAX_CANDIDATES, userId])).rows;
  const resolved = await itemsByIds(ctx, jfUser, rows.map((r) => r.item_id));
  const byId = new Map(resolved.map((i) => [i.id, i]));
  const missingSeries = [...new Set(resolved.filter((i) => i.type === 'Episode' && i.seriesId && !byId.has(i.seriesId)).map((i) => i.seriesId!))];
  for (const s of await itemsByIds(ctx, jfUser, missingSeries)) byId.set(s.id, s);

  const groups = new Map<string, { item: ItemDto; users: Set<string>; secs: number }>();
  for (const r of rows) {
    const it = byId.get(r.item_id);
    if (!it) continue; // not visible to the viewer
    const target = it.type === 'Episode' ? (it.seriesId ? byId.get(it.seriesId) : undefined) : it;
    if (!target || (target.type !== 'Movie' && target.type !== 'Series')) continue;
    const g = groups.get(target.id) ?? { item: target, users: new Set<string>(), secs: 0 };
    for (const u of r.users) g.users.add(u);
    g.secs += Number(r.secs);
    groups.set(target.id, g);
  }
  const items: Trending[] = [...groups.values()]
    .filter((g) => g.users.size >= 2 || g.users.has(userId))
    .sort((a, b) => b.users.size - a.users.size || b.secs - a.secs)
    .slice(0, TREND_MAX_ITEMS)
    .map((g) => ({ ...g.item, viewers: g.users.size }));
  await ctx.kv.set(key, JSON.stringify(items), TREND_TTL);
  return items;
}
