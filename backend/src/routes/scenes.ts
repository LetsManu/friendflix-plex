import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { JellyfinError } from '../jellyfin/client.js';
import { requireUser } from '../session.js';
import { id32 } from './_shared.js';

export function sceneRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };

  // ---- Scene bookmarks (share link = /watch/<id>?t=<seconds>) ----
  app.get('/api/bookmarks', pre, async (req) => {
    const itemId = id32.parse((req.query as { itemId?: string }).itemId);
    const r = await ctx.db.query('select id, position_sec as position, note, created_at from bookmarks where profile_id=$1 and item_id=$2 order by position_sec', [req.profile!.id, itemId]);
    return { bookmarks: r.rows };
  });
  app.post('/api/bookmarks', pre, async (req, reply) => {
    const b = z.object({ itemId: id32, position: z.number().int().min(0).max(86_400), note: z.string().trim().max(140).optional() }).parse(req.body);
    const n = await ctx.db.query<{ c: string }>('select count(*) c from bookmarks where profile_id=$1', [req.profile!.id]);
    if (Number(n.rows[0]!.c) >= 500) return reply.code(409).send({ error: 'too_many_bookmarks' });
    let name: string;
    try {
      name = (await ctx.jf.item(req.jfUser!, b.itemId)).name;
    } catch {
      return reply.code(404).send({ error: 'item_not_found' });
    }
    const id = randomUUID();
    await ctx.db.query('insert into bookmarks(id,user_id,profile_id,item_id,item_name,position_sec,note) values ($1,$2,$3,$4,$5,$6,$7)', [id, req.user!.id, req.profile!.id, b.itemId, name, b.position, b.note || null]);
    return { id };
  });
  app.delete('/api/bookmarks/:id', pre, async (req) => {
    await ctx.db.query('delete from bookmarks where id=$1 and profile_id=$2', [z.guid().parse((req.params as { id: string }).id), req.profile!.id]);
    return { ok: true };
  });

  // ---- Find subtitles (Jellyfin remote subtitle providers, e.g. OpenSubtitles plugin) ----
  const guard = (role: string) => role !== 'guest';
  app.get('/api/items/:id/subtitles/search', { ...pre, config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!guard(req.user!.role)) return reply.code(403).send({ error: 'forbidden' });
    const id = id32.parse((req.params as { id: string }).id);
    const lang = z.string().regex(/^[a-z]{3}$/).parse((req.query as { lang?: string }).lang);
    try {
      await ctx.jf.item(req.jfUser!, id); // access check with the user's own token
      return { results: await ctx.jf.searchSubtitles(id, lang) };
    } catch (e) {
      if (e instanceof JellyfinError && e.status === 404) return reply.code(404).send({ error: 'not_found' });
      return reply.code(502).send({ error: 'subtitle_provider_unavailable' });
    }
  });
  app.post('/api/items/:id/subtitles/download', { ...pre, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!guard(req.user!.role)) return reply.code(403).send({ error: 'forbidden' });
    const id = id32.parse((req.params as { id: string }).id);
    const { subtitleId } = z.object({ subtitleId: z.string().regex(/^[\w.%=+-]{1,300}$/) }).parse(req.body);
    try {
      await ctx.jf.item(req.jfUser!, id);
      await ctx.jf.downloadSubtitle(id, subtitleId);
    } catch {
      return reply.code(502).send({ error: 'subtitle_download_failed' });
    }
    await audit(ctx, req.user!.id, 'subtitle.download', id);
    return { ok: true };
  });
}
