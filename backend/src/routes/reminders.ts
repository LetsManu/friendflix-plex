// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { seerrHooks } from '../hooks.js';
import { MediaError } from '../media/types.js';
import { fireTmdb, isAvailableEpisode } from '../reminders.js';
import { portalStatus, SeerrError } from '../seerr/client.js';
import { requireGrownUp } from '../kids.js';
import { id32 } from './_shared.js';

const body = z.union([
  z.object({ mediaType: z.enum(['movie', 'tv']), tmdbId: z.number().int().positive() }),
  z.object({ episodeId: id32 }),
]);

export function reminderRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireGrownUp(ctx) }; // reminders come from Seerr/calendar features and notify the account: not on kids profiles

  seerrHooks.add(async (c, e) => {
    if (e.type === 'available') await fireTmdb(c, e.mediaType, e.tmdbId);
  });

  app.get('/api/reminders', pre, async (req) => {
    const r = await ctx.db.query(
      "select *, to_char(release_date, 'YYYY-MM-DD') as release_date from reminders where user_id = $1 and fired_at is null order by created_at desc limit 200", [req.user!.id]);
    return {
      reminders: r.rows.map((x) => ({
        id: Number(x.id), kind: x.kind, mediaType: x.media_type, tmdbId: x.tmdb_id, itemId: x.jf_item_id, seriesId: x.series_id, title: x.title,
        poster: x.poster ? `/api/seerr/image${x.poster}` : null, releaseDate: x.release_date ?? null, createdAt: x.created_at,
      })),
    };
  });

  app.get('/api/reminders/keys', pre, async (req) => {
    const r = await ctx.db.query('select id, kind, media_type, tmdb_id, jf_item_id from reminders where user_id = $1 and fired_at is null', [req.user!.id]);
    const keys: Record<string, number> = {};
    for (const x of r.rows) keys[x.kind === 'tmdb' ? `${x.media_type}:${x.tmdb_id}` : `ep:${x.jf_item_id}`] = Number(x.id);
    return { keys };
  });

  app.post('/api/reminders', { ...pre, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });
    const b = parsed.data;
    const userId = req.user!.id;
    const profileId = req.profile?.id ?? null;

    if ('episodeId' in b) {
      let ep;
      try {
        ep = await ctx.jf.item(req.jfUser!, b.episodeId);
      } catch (e) {
        if (e instanceof MediaError && (e.status === 404 || e.status === 400 || e.status === 403)) return reply.code(404).send({ error: 'not_found' });
        throw e;
      }
      if (ep.type !== 'Episode') return reply.code(400).send({ error: 'not_an_episode' });
      if ((await isAvailableEpisode(ctx, req.jfUser!, [ep.id])).has(ep.id)) return reply.code(409).send({ error: 'already_available', itemId: ep.id });
      if (!ep.seriesId || ep.parentIndexNumber == null || ep.indexNumber == null) return reply.code(400).send({ error: 'not_trackable' });
      const title = `${ep.seriesName ?? ep.name}${ep.parentIndexNumber != null && ep.indexNumber != null ? ` S${ep.parentIndexNumber}E${ep.indexNumber}` : ''}`;
      await ctx.db.query(
        `insert into reminders(user_id, profile_id, kind, jf_item_id, series_id, season, episode, title, release_date)
         values ($1,$2,'episode',$3,$4,$5,$6,$7,$8) on conflict (user_id, jf_item_id) where kind='episode' do nothing`,
        [userId, profileId, ep.id, ep.seriesId, ep.parentIndexNumber, ep.indexNumber, title, ep.premiereDate ? ep.premiereDate.slice(0, 10) : null],
      );
      const row = (await ctx.db.query("select id from reminders where user_id=$1 and kind='episode' and jf_item_id=$2", [userId, ep.id])).rows[0];
      const follow = ep.seriesId ? (await ctx.db.query('select 1 from series_follows where user_id=$1 and series_id=$2', [userId, ep.seriesId])).rowCount! > 0 : false;
      return { id: Number(row.id), coveredByFollow: follow };
    }

    let d: any;
    try {
      d = await ctx.seerr.details(b.mediaType, b.tmdbId);
    } catch (e) {
      if (e instanceof SeerrError && e.status === 404) return reply.code(404).send({ error: 'not_found' });
      if (e instanceof SeerrError) return reply.code(502).send({ error: 'seerr', status: e.status });
      throw e;
    }
    if (portalStatus(d.mediaInfo?.status, d.mediaInfo?.requests?.[0]?.status) === 'verfuegbar') {
      const hit = await ctx.jf.findByTmdb(b.tmdbId, b.mediaType).catch(() => null);
      return reply.code(409).send({ error: 'already_available', ...(hit ? { itemId: hit.id } : {}) });
    }
    // a fired reminder of an earlier release must not block a new one
    await ctx.db.query("delete from reminders where user_id=$1 and kind='tmdb' and media_type=$2 and tmdb_id=$3 and fired_at is not null", [userId, b.mediaType, b.tmdbId]);
    const date = String(d.releaseDate ?? d.firstAirDate ?? '').slice(0, 10);
    await ctx.db.query(
      `insert into reminders(user_id, profile_id, kind, media_type, tmdb_id, title, poster, release_date)
       values ($1,$2,'tmdb',$3,$4,$5,$6,$7) on conflict (user_id, media_type, tmdb_id) where kind='tmdb' do nothing`,
      [userId, profileId, b.mediaType, b.tmdbId, String(d.title ?? d.name ?? `#${b.tmdbId}`), d.posterPath ?? null, /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null],
    );
    const row = (await ctx.db.query("select id from reminders where user_id=$1 and kind='tmdb' and media_type=$2 and tmdb_id=$3", [userId, b.mediaType, b.tmdbId])).rows[0];
    return { id: Number(row.id), coveredByFollow: false };
  });

  app.delete('/api/reminders/:id', pre, async (req, reply) => {
    const id = z.coerce.number().int().positive().safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.code(404).send({ error: 'not_found' });
    const r = await ctx.db.query('delete from reminders where id = $1 and user_id = $2', [id.data, req.user!.id]);
    return r.rowCount ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });
}
