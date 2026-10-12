import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { MediaError, type ItemDto } from '../media/types.js';
import { requireGrownUp } from '../kids.js';
import { id32 } from './_shared.js';

const EMOJIS = ['like', 'funny', 'wow', 'sad', 'love'] as const;
type Emoji = (typeof EMOJIS)[number];

const isWatched = (i: ItemDto) => i.played || (i.playedPercentage ?? 0) >= 85;

export function reactionRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireGrownUp(ctx) }; // kids profiles: no reactions (403 kids_profile)

  /** Visible Movie/Episode, or the reply that was sent instead. */
  const load = async (req: any, reply: any): Promise<ItemDto | null> => {
    const id = id32.parse((req.params as { id: string }).id);
    let item: ItemDto;
    try {
      item = await ctx.jf.item(req.jfUser!, id);
    } catch (e) {
      if (e instanceof MediaError) {
        if (e.status === 404 || e.status === 403 || e.status === 400) reply.code(404).send({ error: 'not_found' });
        else reply.code(502).send({ error: 'jellyfin', status: e.status });
        return null;
      }
      throw e;
    }
    if (item.type !== 'Movie' && item.type !== 'Episode') {
      reply.code(400).send({ error: 'unsupported_type' });
      return null;
    }
    return item;
  };

  const view = async (profileId: string, item: ItemDto) => {
    const count = Number((await ctx.db.query<{ n: string }>(
      'select count(*) n from reactions r join users u on u.id = r.user_id where r.item_id = $1 and not u.disabled', [item.id])).rows[0]!.n);
    // a single reaction would reveal that one friend watched it; below 2 the count stays hidden
    if (!isWatched(item)) return { locked: true, ...(count >= 2 ? { count } : {}) };
    const rows = (await ctx.db.query<{ profile_id: string; name: string; emoji: Emoji; comment: string | null; created_at: Date }>(
      `select r.profile_id, case when p.is_owner then u.name else p.name end as name, r.emoji, r.comment, r.created_at
         from reactions r join users u on u.id = r.user_id join profiles p on p.id = r.profile_id
        where r.item_id = $1 and not u.disabled order by r.created_at desc limit 100`, [item.id])).rows;
    const summary: Record<Emoji, number> = { like: 0, funny: 0, wow: 0, sad: 0, love: 0 };
    for (const e of (await ctx.db.query<{ emoji: Emoji; n: string }>(
      'select r.emoji, count(*) n from reactions r join users u on u.id = r.user_id where r.item_id = $1 and not u.disabled group by r.emoji', [item.id])).rows) summary[e.emoji] = Number(e.n);
    return {
      locked: false, count, summary,
      reactions: rows.map((r) => ({
        name: r.name, emoji: r.emoji, ...(r.comment ? { comment: r.comment } : {}), mine: r.profile_id === profileId, createdAt: r.created_at.toISOString(),
      })),
    };
  };

  app.get('/api/items/:id/reactions', pre, async (req, reply) => {
    const item = await load(req, reply);
    return item ? view(req.profile!.id, item) : undefined;
  });

  app.put('/api/items/:id/reactions', { ...pre, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ emoji: z.enum(EMOJIS), comment: z.string().trim().max(280).optional() }).parse(req.body);
    const item = await load(req, reply);
    if (!item) return;
    if (!isWatched(item)) return reply.code(403).send({ error: 'watch_first' });
    await ctx.db.query(
      `insert into reactions(profile_id,user_id,item_id,emoji,comment) values ($1,$2,$3,$4,$5)
       on conflict (profile_id,item_id) do update set emoji = excluded.emoji, comment = excluded.comment, created_at = now()`,
      [req.profile!.id, req.user!.id, item.id, b.emoji, b.comment || null]);
    return view(req.profile!.id, item);
  });

  app.delete('/api/items/:id/reactions', pre, async (req, reply) => {
    const item = await load(req, reply);
    if (!item) return;
    await ctx.db.query('delete from reactions where profile_id = $1 and item_id = $2', [req.profile!.id, item.id]);
    return view(req.profile!.id, item);
  });
}
