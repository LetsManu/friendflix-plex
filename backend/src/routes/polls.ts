import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { bus } from '../bus.js';
import type { Ctx } from '../ctx.js';
import { seerrHooks } from '../hooks.js';
import { approvePoll, createPoll, InvalidOptions, pollTick, resolveRequestedPolls } from '../polls.js';
import { m } from '../i18n.js';
import { notify } from '../notify.js';
import { MediaError } from '../media/types.js';
import { SeerrError } from '../seerr/client.js';
import { requireGrownUp } from '../kids.js';
import { requireAdmin, requireUser } from '../session.js';
import type { JfUser } from '../types.js';
import { id32 } from './_shared.js';
import { itemsByIds } from './discover.js';

const optionSchema = z.object({ jfItemId: id32.optional(), tmdbId: z.number().int().positive().optional(), mediaType: z.enum(['movie', 'tv']).optional() })
  .refine((o) => Boolean(o.jfItemId) !== Boolean(o.tmdbId && o.mediaType), 'jfItemId or tmdbId+mediaType');

/** Maps Jellyfin lookup failures for a user-supplied item id to 404/403. */
async function itemOr(ctx: Ctx, reply: FastifyReply, user: JfUser, id: string) {
  try {
    return await ctx.jf.item(user, id);
  } catch (e) {
    if (e instanceof MediaError && (e.status === 404 || e.status === 400)) return void reply.code(404).send({ error: 'not_found' });
    if (e instanceof MediaError && e.status === 403) return void reply.code(403).send({ error: 'forbidden' });
    throw e;
  }
}

export function pollRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };
  /** polls and ratings/reviews are shared with friends: kids profiles get 403 kids_profile */
  const grown = { preHandler: requireGrownUp(ctx) };
  const admin = { preHandler: requireAdmin(ctx) };

  seerrHooks.add(async (c, e) => {
    if (e.type === 'available') await resolveRequestedPolls(c);
  });

  app.post('/api/polls', grown, async (req, reply) => {
    const b = z.object({
      title: z.string().trim().min(3).max(80),
      options: z.array(optionSchema).min(2).max(10),
      closesInMinutes: z.number().int().min(5).max(7 * 24 * 60).default(60),
      startsAfterMinutes: z.number().int().min(0).max(7 * 24 * 60).default(10),
    }).parse(req.body);
    const open = await ctx.db.query("select 1 from polls where created_by=$1 and status='open'", [req.user!.id]);
    if (open.rowCount) return reply.code(409).send({ error: 'poll_already_open' });
    try {
      return { id: await createPoll(ctx, req.user!.id, b) };
    } catch (e) {
      if (e instanceof InvalidOptions || (e instanceof MediaError && (e.status === 404 || e.status === 400 || e.status === 403)) || (e instanceof SeerrError && e.status === 404)) return reply.code(400).send({ error: 'invalid_options' });
      throw e;
    }
  });

  /** Ids of the given Jellyfin items that the viewer (with their own token) may see. */
  const visibleIds = async (jfUser: JfUser | undefined, ids: string[]) => {
    const uniq = [...new Set(ids)];
    if (!uniq.length) return new Set<string>();
    if (!jfUser) return new Set<string>();
    return new Set((await itemsByIds(ctx, jfUser, uniq)).map((i) => i.id));
  };

  const detail = async (pollId: string, userId: string, jfUser: JfUser | undefined) => {
    const p = (await ctx.db.query('select p.*, u.name creator from polls p join users u on u.id=p.created_by where p.id=$1', [pollId])).rows[0];
    if (!p) return null;
    const opts = (await ctx.db.query(
      `select o.id, o.title, o.jf_item_id, o.tmdb_id, o.media_type, o.poster, count(v.user_id)::int votes
         from poll_options o left join poll_votes v on v.option_id=o.id where o.poll_id=$1 group by o.id order by o.id`, [pollId])).rows;
    const visible = await visibleIds(jfUser, opts.filter((o) => o.jf_item_id).map((o) => o.jf_item_id as string));
    const mine = (await ctx.db.query('select option_id from poll_votes where poll_id=$1 and user_id=$2', [pollId, userId])).rows[0];
    return {
      id: p.id, title: p.title, creator: p.creator, status: p.status, closesAt: p.closes_at, startsAt: p.starts_at, roomId: p.room_id, winnerOptionId: p.winner_option_id,
      myVote: mine ? Number(mine.option_id) : null,
      options: opts.map((o) => o.jf_item_id && !visible.has(o.jf_item_id) ? { id: Number(o.id), title: null, hidden: true, votes: o.votes } : ({ id: Number(o.id), title: o.title, inLibrary: Boolean(o.jf_item_id), itemId: o.jf_item_id, tmdbId: o.tmdb_id, mediaType: o.media_type, poster: o.poster ? `/api/seerr/image${o.poster}` : undefined, votes: o.votes })),
    };
  };

  app.get('/api/polls', grown, async (req) => {
    const ids = (await ctx.db.query("select id from polls where status in ('open','scheduled','needs_approval','requested') or created_at > now() - interval '3 days' order by created_at desc limit 20")).rows;
    return { polls: (await Promise.all(ids.map((r) => detail(r.id, req.user!.id, req.jfUser)))).filter(Boolean) };
  });
  app.get('/api/polls/:id', grown, async (req, reply) => {
    const d = await detail(z.guid().parse((req.params as { id: string }).id), req.user!.id, req.jfUser);
    return d ?? reply.code(404).send({ error: 'not_found' });
  });

  app.post('/api/polls/:id/vote', grown, async (req, reply) => {
    const pollId = z.guid().parse((req.params as { id: string }).id);
    const { optionId } = z.object({ optionId: z.number().int() }).parse(req.body);
    const ok = await ctx.db.query<{ jf_item_id: string | null }>(
      `select o.jf_item_id from polls p join poll_options o on o.poll_id=p.id where p.id=$1 and o.id=$2 and p.status='open' and p.closes_at > now()`, [pollId, optionId]);
    if (!ok.rowCount) return reply.code(409).send({ error: 'poll_closed_or_option_invalid' });
    const jfId = ok.rows[0]!.jf_item_id;
    if (jfId && !(await visibleIds(req.jfUser, [jfId])).has(jfId)) return reply.code(403).send({ error: 'option_hidden' });
    await ctx.db.query('insert into poll_votes(poll_id,user_id,option_id) values ($1,$2,$3) on conflict (poll_id,user_id) do update set option_id=excluded.option_id', [pollId, req.user!.id, optionId]);
    return { ok: true };
  });

  app.get('/api/admin/polls', admin, async (req) => {
    const ids = (await ctx.db.query("select id from polls where status='needs_approval' order by created_at")).rows;
    return { polls: await Promise.all(ids.map((r) => detail(r.id, req.user!.id, req.jfUser))) };
  });
  for (const [action, approve] of [['approve', true], ['reject', false]] as const) {
    app.post(`/api/admin/polls/:id/${action}`, admin, async (req, reply) => {
      let ok: boolean;
      try {
        ok = await approvePoll(ctx, z.guid().parse((req.params as { id: string }).id), req.user!.id, approve);
      } catch (e) {
        if (e instanceof SeerrError) return reply.code(502).send({ error: 'seerr_failed' });
        throw e;
      }
      return ok ? { ok: true } : reply.code(409).send({ error: 'not_waiting_for_approval' });
    });
  }

  // ---- ratings / reviews ----
  app.get('/api/items/:id/ratings', grown, async (req, reply) => {
    const itemId = id32.parse((req.params as { id: string }).id);
    if (!(await itemOr(ctx, reply, req.jfUser!, itemId))) return reply; // viewer must be able to see the item
    // other users' ratings are hidden when they switched shareRatings off; the viewer's own row always stays
    const r = await ctx.db.query(
      `select u.name, r.stars, r.review, r.created_at, r.user_id = $2 mine from ratings r join users u on u.id=r.user_id left join user_prefs p on p.user_id=r.user_id
        where r.item_id=$1 and (r.user_id = $2 or coalesce(p.data->>'shareRatings', 'true') <> 'false') order by r.created_at desc limit 50`, [itemId, req.user!.id]);
    const avg = r.rows.length ? r.rows.reduce((a, x) => a + x.stars, 0) / r.rows.length : null;
    return { ratings: r.rows, average: avg };
  });
  app.put('/api/items/:id/rating', grown, async (req, reply) => {
    const itemId = id32.parse((req.params as { id: string }).id);
    const b = z.object({ stars: z.number().int().min(1).max(5), review: z.string().trim().max(280).optional() }).parse(req.body);
    const item = await itemOr(ctx, reply, req.jfUser!, itemId);
    if (!item) return reply;
    await ctx.db.query(
      `insert into ratings(user_id,item_id,item_name,stars,review) values ($1,$2,$3,$4,$5)
       on conflict (user_id,item_id) do update set stars=excluded.stars, review=excluded.review, created_at=now()`,
      [req.user!.id, itemId, item.name, b.stars, b.review || null],
    );
    bus.emitT('rating.created', { userId: req.user!.id });
    return { ok: true };
  });
  app.delete('/api/items/:id/rating', grown, async (req) => {
    await ctx.db.query('delete from ratings where user_id=$1 and item_id=$2', [req.user!.id, id32.parse((req.params as { id: string }).id)]);
    return { ok: true };
  });

  // ---- series calendar ----
  app.get('/api/calendar', pre, async (req) => {
    const [up, follows, dropped] = await Promise.all([
      ctx.jf.upcoming(req.jfUser!),
      ctx.db.query<{ series_id: string }>('select series_id from series_follows where user_id=$1', [req.user!.id]),
      droppedSeries(ctx, req.user!.id),
    ]);
    const f = new Set(follows.rows.map((r) => r.series_id));
    return { items: up.filter((e) => !(e.seriesId && dropped.has(e.seriesId))).map((e) => ({ ...e, followed: Boolean(e.seriesId && f.has(e.seriesId)) })) };
  });
  app.post('/api/series/:id/follow', pre, async (req, reply) => {
    const id = id32.parse((req.params as { id: string }).id);
    const s = await itemOr(ctx, reply, req.jfUser!, id);
    if (!s) return reply;
    await ctx.db.query('insert into series_follows(user_id,series_id,series_name) values ($1,$2,$3) on conflict do nothing', [req.user!.id, id, s.name]);
    return { ok: true };
  });
  app.delete('/api/series/:id/follow', pre, async (req) => {
    await ctx.db.query('delete from series_follows where user_id=$1 and series_id=$2', [req.user!.id, id32.parse((req.params as { id: string }).id)]);
    return { ok: true };
  });
  app.get('/api/series/:id/follow', pre, async (req) => ({
    followed: (await ctx.db.query('select 1 from series_follows where user_id=$1 and series_id=$2', [req.user!.id, id32.parse((req.params as { id: string }).id)])).rowCount! > 0,
  }));
  void audit;
}

/** Series any profile of this account marked as "dropped" (no calendar entries / new-episode notifications). */
async function droppedSeries(ctx: Ctx, userId: string): Promise<Set<string>> {
  return new Set((await ctx.db.query<{ item_id: string }>('select d.item_id from dropped d join profiles p on p.id=d.profile_id where p.user_id=$1', [userId])).rows.map((r) => r.item_id));
}

/** Hourly: notify followers about episodes that aired (deduped per episode). */
export async function calendarNotifications(ctx: Ctx) {
  const users = (await ctx.db.query('select distinct u.* from users u join series_follows f on f.user_id=u.id where not u.disabled')).rows;
  for (const u of users) {
    const follows = new Set((await ctx.db.query('select series_id from series_follows where user_id=$1', [u.id])).rows.map((r) => r.series_id));
    const dropped = await droppedSeries(ctx, u.id);
    const up = await ctx.jf.upcoming(u).catch(() => []);
    for (const e of up) {
      if (!e.seriesId || !follows.has(e.seriesId) || dropped.has(e.seriesId) || !e.premiereDate || new Date(e.premiereDate).getTime() > Date.now()) continue;
      await notify(ctx, { userId: u.id, kind: 'episode', title: m('episode.newCode', { series: e.seriesName ?? '', season: String(e.parentIndexNumber), episode: String(e.indexNumber) }), body: e.name, link: `/watch/${e.id}`, dedupe: `cal-${u.id}-${e.id}` });
    }
  }
}

export { pollTick };
