// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import type { ItemDto } from '../media/types.js';
import { requireGrownUp } from '../kids.js';
import { requireUser } from '../session.js';
import { bumpHome } from '../homegen.js';
import type { UserRow } from '../types.js';
import { itemsByIds } from './discover.js';
import { id32, wrap as sharedWrap } from './_shared.js';


export type WatchStatus = 'none' | 'planned' | 'watching' | 'watched' | 'dropped';

const wrap = <T extends (...a: any[]) => Promise<any>>(fn: T): T => sharedWrap(fn, { notFound: [404, 403, 400] });

/** Status derived from Jellyfin's user data (what "watching"/"watched" mean when nothing is stored). */
export function derivedStatus(i: ItemDto): WatchStatus {
  if (i.played) return 'watched';
  if (i.positionTicks > 0 || (i.playedPercentage ?? 0) > 0) return 'watching';
  if (i.type === 'Series' && i.childCount && i.unplayedCount !== undefined && i.unplayedCount < i.childCount) return 'watching';
  return 'none';
}

export function socialRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };
  /** friends' ratings / history: not for kids profiles */
  const grown = { preHandler: requireGrownUp(ctx) };

  /** The visible item, with an episode replaced by its series (status is kept per movie/series). */
  const canonical = async (req: any, id: string): Promise<ItemDto> => {
    const it = await ctx.jf.item(req.jfUser!, id);
    return it.type === 'Episode' && it.seriesId ? ctx.jf.item(req.jfUser!, it.seriesId) : it;
  };
  const stored = async (profileId: string, id: string): Promise<'dropped' | 'planned' | null> => {
    const r = await ctx.db.query<{ s: string }>(
      `select 'dropped' s from dropped where profile_id=$1 and item_id=$2 union all select 'planned' from watchlist where profile_id=$1 and item_id=$2`, [profileId, id]);
    return r.rows.some((x) => x.s === 'dropped') ? 'dropped' : r.rows.length ? 'planned' : null;
  };

  // ---- Watch status (Trakt pattern): planned = watchlist, dropped = own table, watching/watched derived ----
  app.get('/api/items/:id/status', pre, wrap(async (req) => {
    const item = await canonical(req, id32.parse((req.params as { id: string }).id));
    return { status: (await stored(req.profile!.id, item.id)) ?? derivedStatus(item) };
  }));

  app.put('/api/items/:id/status', pre, wrap(async (req) => {
    const want = z.object({ status: z.enum(['planned', 'dropped', 'none']) }).parse(req.body).status;
    const item = await canonical(req, id32.parse((req.params as { id: string }).id));
    const pid = req.profile!.id;
    if (want === 'planned') {
      await ctx.db.query('insert into watchlist(profile_id,user_id,item_id) values ($1,$2,$3) on conflict do nothing', [pid, req.user!.id, item.id]);
      await ctx.db.query('delete from dropped where profile_id=$1 and item_id=$2', [pid, item.id]);
    } else if (want === 'dropped') {
      await ctx.db.query('insert into dropped(profile_id,item_id) values ($1,$2) on conflict (profile_id,item_id) do update set dropped_at = now()', [pid, item.id]);
      await ctx.db.query('delete from watchlist where profile_id=$1 and item_id=$2', [pid, item.id]);
      await ctx.db.query('insert into resume_hidden(profile_id,item_id) values ($1,$2) on conflict (profile_id,item_id) do update set hidden_at=now()', [pid, item.id]);
    } else {
      await ctx.db.query('delete from dropped where profile_id=$1 and item_id=$2', [pid, item.id]);
      await ctx.db.query('delete from watchlist where profile_id=$1 and item_id=$2', [pid, item.id]);
    }
    await bumpHome(ctx, pid);
    return { status: want === 'none' ? derivedStatus(item) : want };
  }));

  app.get('/api/dropped', pre, wrap(async (req) => {
    const r = await ctx.db.query<{ item_id: string }>('select item_id from dropped where profile_id=$1 order by dropped_at desc limit 200', [req.profile!.id]);
    return { items: await itemsByIds(ctx, req.jfUser!, r.rows.map((x) => x.item_id)) };
  }));

  // ---- Freunde-Leiste: who rated / watched / recommended this title (each part respects the friend's privacy flags) ----
  app.get('/api/items/:id/friends', { ...grown, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, wrap(async (req) => {
    const id = id32.parse((req.params as { id: string }).id);
    await ctx.jf.item(req.jfUser!, id); // 404 unless the viewer can see it
    const rows = (await ctx.db.query<UserRow & { stars: number | null; recommended: boolean; share: boolean }>(
      `select u.*,
              case when coalesce((p.data->>'shareRatings')::boolean, true) then r.stars end as stars,
              exists (select 1 from recommendations rc where rc.from_user = u.id and rc.to_user = $1 and rc.item_id = $2) as recommended,
              coalesce((p.data->>'shareHistory')::boolean, false) as share
         from users u left join user_prefs p on p.user_id = u.id left join ratings r on r.user_id = u.id and r.item_id = $2
        where u.id <> $1 and not u.disabled order by u.name`, [req.user!.id, id])).rows;

    // watched: opt-in friends only (shareHistory), max 12 checked, 4 at a time, cached 5 min; a failed lookup just leaves the flag out
    const watched = new Map<string, boolean>();
    const cand = rows.filter((f) => f.share).slice(0, 12);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, cand.length) }, async () => {
      while (next < cand.length) {
        const f = cand[next++]!;
        const key = `fw:${f.id}:${id}`;
        try {
          const hit = await ctx.kv.get(key).catch(() => null);
          if (hit !== null) { watched.set(f.id, hit === '1'); continue; }
          const it = (await ctx.jf.items(f, { ids: [id], types: 'Movie,Series,Episode', limit: 1 })).items[0];
          const w = Boolean(it && (it.played || (it.type === 'Series' && (it.playedPercentage ?? 0) > 0)));
          watched.set(f.id, w);
          await ctx.kv.set(key, w ? '1' : '0', 300).catch(() => undefined);
        } catch {
          // omitted
        }
      }
    }));

    const friends = rows
      .map((f) => ({ id: f.id, name: f.name, ...(f.stars != null ? { stars: f.stars } : {}), ...(watched.get(f.id) ? { watched: true } : {}), ...(f.recommended ? { recommended: true } : {}) }))
      .filter((f) => 'stars' in f || 'watched' in f || 'recommended' in f);
    const rank = (f: { stars?: number; watched?: boolean; recommended?: boolean }) => [f.recommended ? 1 : 0, f.stars ?? 0, f.watched ? 1 : 0];
    friends.sort((a, b) => {
      const x = rank(a), y = rank(b);
      return y[0]! - x[0]! || y[1]! - x[1]! || y[2]! - x[2]! || a.name.localeCompare(b.name, 'de');
    });
    return { friends };
  }));
}
