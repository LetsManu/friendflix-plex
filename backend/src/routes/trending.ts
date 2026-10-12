import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../ctx.js';
import { JellyfinError } from '../jellyfin/client.js';
import type { ItemDto } from '../jellyfin/dto.js';
import { requireGrownUp } from '../kids.js';
import { itemsByIds } from './discover.js';

const TTL = 600;
const MAX_ITEMS = 10;
const MAX_CANDIDATES = 300;
const MIN_SECONDS = 300;

type Trending = ItemDto & { viewers: number };

export function trendingRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireGrownUp(ctx) }; // "Diese Woche bei uns" is what friends watch: not on kids profiles

  /** "Diese Woche bei uns": what friends watched in the last 7 days. Counts only, never names. */
  app.get('/api/library/trending', pre, async (req, reply) => {
    const me = req.user!;
    const key = `trend:${req.jfUser!.jellyfin_user_id}:${me.id}`; // result depends on the viewer (own plays count without opt-in)
    const hit = await ctx.kv.get(key);
    if (hit) return { items: JSON.parse(hit) as Trending[] };
    try {
      const rows = (await ctx.db.query<{ item_id: string; users: string[]; secs: string }>(
        `select p.item_id, array_agg(distinct p.user_id::text) users, sum(p.seconds) secs
           from play_seconds p join users u on u.id = p.user_id left join user_prefs pr on pr.user_id = p.user_id
          where p.day >= current_date - 6 and p.seconds >= $1 and not u.disabled
            and (p.user_id = $3 or coalesce((pr.data->>'shareHistory')::boolean, false))
          group by p.item_id order by sum(p.seconds) desc limit $2`, [MIN_SECONDS, MAX_CANDIDATES, me.id])).rows;
      const resolved = await itemsByIds(ctx, req.jfUser!, rows.map((r) => r.item_id));
      const byId = new Map(resolved.map((i) => [i.id, i]));
      const missingSeries = [...new Set(resolved.filter((i) => i.type === 'Episode' && i.seriesId && !byId.has(i.seriesId)).map((i) => i.seriesId!))];
      for (const s of await itemsByIds(ctx, req.jfUser!, missingSeries)) byId.set(s.id, s);

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
        .filter((g) => g.users.size >= 2 || g.users.has(me.id))
        .sort((a, b) => b.users.size - a.users.size || b.secs - a.secs)
        .slice(0, MAX_ITEMS)
        .map((g) => ({ ...g.item, viewers: g.users.size }));
      await ctx.kv.set(key, JSON.stringify(items), TTL);
      return { items };
    } catch (e) {
      if (e instanceof JellyfinError) return reply.code(502).send({ error: 'jellyfin', status: e.status });
      throw e;
    }
  });
}
