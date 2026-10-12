import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CAST_MAX_BITRATE, CAST_MAX_HEIGHT, castEnabled, castTtlSeconds, createCast, revokeCast } from '../cast.js';
import type { Ctx } from '../ctx.js';
import { JellyfinError } from '../jellyfin/client.js';
import { countLive } from '../live.js';
import { effectiveRole } from '../roles.js';
import { requireUser } from '../session.js';
import { id32 as itemId } from './_shared.js';

export function castRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };

  app.get('/api/cast/config', pre, async () => ({ enabled: castEnabled(ctx) }));

  app.post('/api/cast/session', { ...pre, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!castEnabled(ctx)) return reply.code(404).send({ error: 'cast_disabled' });
    const b = z.object({
      itemId,
      startTicks: z.number().int().min(0).optional(),
      audioIndex: z.number().int().min(0).optional(),
      maxBitrate: z.number().int().min(300_000).max(200_000_000).optional(),
    }).parse(req.body);
    const deviceId = req.session!.deviceId;
    if (!deviceId) return reply.code(403).send({ error: 'device_pending' });
    const role = (await effectiveRole(ctx, req.user!.role))!;
    if (!role.transcoding) return reply.code(403).send({ error: 'transcoding_disabled' }); // Chromecast always needs a transcoded HLS stream
    if ((await countLive(ctx, req.user!.id)) >= role.maxStreams) return reply.code(429).send({ error: 'max_streams', max: role.maxStreams });
    try {
      const item = await ctx.jf.item(req.jfUser!, b.itemId); // access check: the profile must be able to see the item
      const startTicks = b.startTicks ?? item.positionTicks;
      const maxBitrate = Math.min(role.maxBitrate, CAST_MAX_BITRATE, b.maxBitrate ?? CAST_MAX_BITRATE);
      const maxHeight = Math.min(role.maxHeight ?? CAST_MAX_HEIGHT, CAST_MAX_HEIGHT);
      const info = await ctx.jf.playbackInfo(req.jfUser!, b.itemId, { maxBitrate, maxHeight, startTicks, audioIndex: b.audioIndex, cast: true });
      const ttl = castTtlSeconds(info.runtimeTicks, startTicks);
      const { ct, imgCt, castId, expiresAt } = await createCast(ctx, {
        userId: req.user!.id, profileId: req.profile!.id, deviceId, itemId: b.itemId, mediaSourceId: info.mediaSourceId, playSessionId: info.playSessionId, maxBitrate, title: item.name,
      }, ttl, Boolean(item.image));
      // Jellyfin returns /media/... URLs; the cast variant carries the token in the path: /media/c/<ct>/...
      const absWith = (t: string, u: string) => `${ctx.cfg.PUBLIC_URL.replace(/\/+$/, '')}/media/c/${t}${u.slice('/media'.length)}`;
      const abs = (u: string) => absWith(ct, u);
      reply.header('Cache-Control', 'no-store');
      return {
        castId,
        expiresAt,
        playSessionId: info.playSessionId,
        mediaSourceId: info.mediaSourceId,
        runtimeTicks: info.runtimeTicks,
        startTime: Math.floor(startTicks / 10_000_000),
        contentUrl: abs(info.hlsUrl),
        contentType: 'application/x-mpegURL',
        hlsSegmentFormat: 'ts',
        title: item.name,
        seriesName: item.seriesName,
        // the poster gets its own image-only token: the media token must never appear in a URL the receiver shows or fetches as an image
        imageUrl: imgCt ? absWith(imgCt, `/media/Items/${b.itemId}/Images/Primary?maxWidth=600`) : undefined,
        subtitles: info.subtitles.map((s) => ({ index: s.index, language: s.language, title: s.title, url: abs(s.url) })),
      };
    } catch (e) {
      if (e instanceof JellyfinError) return reply.code(e.status === 404 ? 404 : e.status === 403 ? 403 : 502).send({ error: 'jellyfin', status: e.status });
      throw e;
    }
  });

  app.delete('/api/cast/session/:castId', pre, async (req, reply) => {
    const { castId } = z.object({ castId: z.string().regex(/^[0-9a-f]{32}$/) }).parse(req.params);
    return (await revokeCast(ctx, req.user!.id, castId)) ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });
}
