// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CAST_MAX_BITRATE, CAST_MAX_HEIGHT, castEnabled, castSubtitlePath, castTtlSeconds, createCast, resolveCastSubtitle, revokeCast } from '../cast.js';
import type { Ctx } from '../ctx.js';
import { MediaError } from '../media/types.js';
import { countLive } from '../live.js';
import { isHomeRequest } from '../netaddr.js';
import { effectiveRole, remoteBitrateCap } from '../roles.js';
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
      /** sender protocol: Chromecast (default) or Safari AirPlay (same token flow, two-address pin, see cast.ts) */
      via: z.enum(['chromecast', 'airplay']).optional(),
    }).parse(req.body);
    const deviceId = req.session!.deviceId;
    if (!deviceId) return reply.code(403).send({ error: 'device_pending' });
    const role = (await effectiveRole(ctx, req.user!.role))!;
    if (!role.transcoding) return reply.code(403).send({ error: 'transcoding_disabled' }); // Chromecast always needs a transcoded HLS stream
    if ((await countLive(ctx, req.user!.id)) >= role.maxStreams) return reply.code(429).send({ error: 'max_streams', max: role.maxStreams });
    try {
      const item = await ctx.jf.item(req.jfUser!, b.itemId); // access check: the profile must be able to see the item
      const startTicks = b.startTicks ?? item.positionTicks;
      // the cast device streams over the same uplink as the sender: outside the home networks the remote cap applies
      const remote = !isHomeRequest(req, ctx.cfg.HOME_NETWORKS);
      const ceiling = remote ? remoteBitrateCap(role) : role.maxBitrate;
      const maxBitrate = Math.min(ceiling, CAST_MAX_BITRATE, b.maxBitrate ?? CAST_MAX_BITRATE);
      const maxHeight = Math.min(role.maxHeight ?? CAST_MAX_HEIGHT, CAST_MAX_HEIGHT);
      const opts = { maxBitrate, maxHeight, startTicks, audioIndex: b.audioIndex, cast: true };
      let info = await ctx.jf.playbackInfo(req.jfUser!, b.itemId, opts);
      if (ctx.jf.preparePlayback) info = await ctx.jf.preparePlayback(req.jfUser!, info, opts);
      const ttl = castTtlSeconds(info.runtimeTicks, startTicks);
      const { ct, imgCt, castId, expiresAt } = await createCast(ctx, {
        userId: req.user!.id, profileId: req.profile!.id, deviceId, itemId: b.itemId, mediaSourceId: info.mediaSourceId, playSessionId: info.playSessionId, maxBitrate, title: item.name, via: b.via ?? 'chromecast',
      }, ttl, Boolean(item.image));
      // Jellyfin returns /media/... URLs; the cast variant carries the token in the path: /media/c/<ct>/...
      const absWith = (t: string, u: string) => `${ctx.cfg.PUBLIC_URL.replace(/\/+$/, '')}/media/c/${t}${u.slice('/media'.length)}`;
      const abs = (u: string) => absWith(ct, u);
      const origin = ctx.cfg.PUBLIC_URL.replace(/\/+$/, '');
      // subtitles FriendFlix serves itself (/api/items/…/stream.vtt, capabilities.subtitleExtract) get a signed cast URL; Jellyfin: gateway path
      const subUrl = (u: string) => {
        const p = ctx.jf.capabilities.subtitleExtract ? castSubtitlePath(ctx, u, { userId: req.user!.id, castId, expiresAt }) : null;
        return p ? `${origin}${p}` : abs(u);
      };
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
        subtitles: info.subtitles.map((s) => ({ index: s.index, language: s.language, title: s.title, url: subUrl(s.url) })),
      };
    } catch (e) {
      if (e instanceof MediaError) return reply.code(e.status === 404 ? 404 : e.status === 403 ? 403 : 502).send({ error: 'jellyfin', status: e.status });
      throw e;
    }
  });

  // FriendFlix-served subtitle for the receiver (no cookie): the signed URL from castSubtitlePath() is the credential
  app.get('/api/cast/subtitle/:uid/:cid/:exp/:sig/:id/:ms/:index/stream.vtt', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.header('access-control-allow-origin', '*').header('cross-origin-resource-policy', 'cross-origin').header('cache-control', 'no-store');
    const p = z.object({
      uid: z.string().regex(/^[0-9a-f-]{36}$/), cid: z.string().regex(/^[0-9a-f]{32}$/), exp: z.coerce.number().int().positive(), sig: z.string().regex(/^[\w-]{43}$/),
      id: itemId, ms: z.string().regex(/^[\w-]{1,64}$/), index: z.coerce.number().int().min(0).max(999),
    }).safeParse(req.params);
    if (!ctx.jf.capabilities.subtitleExtract || !p.success) return reply.code(404).send({ error: 'not_found' });
    const { sig, id, ...rest } = p.data;
    const user = await resolveCastSubtitle(ctx, { ...rest, itemId: id }, sig);
    if (!user) return reply.code(404).send({ error: 'not_found' });
    try {
      await ctx.jf.item(user, p.data.id); // the profile must still see the item
      const res = await ctx.jf.subtitleStream(user, p.data.id, p.data.ms, p.data.index, 'vtt');
      if (!res.ok) return reply.code(404).send({ error: 'not_found' });
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > 10 * 1024 * 1024) return reply.code(502).send({ error: 'jellyfin', reason: 'too_large' });
      return reply.header('content-type', 'text/vtt; charset=utf-8').send(body);
    } catch (e) {
      if (e instanceof MediaError) return [400, 403, 404].includes(e.status) ? reply.code(404).send({ error: 'not_found' }) : reply.code(502).send({ error: 'jellyfin', status: e.status });
      throw e;
    }
  });

  app.delete('/api/cast/session/:castId', pre, async (req, reply) => {
    const { castId } = z.object({ castId: z.string().regex(/^[0-9a-f]{32}$/) }).parse(req.params);
    return (await revokeCast(ctx, req.user!.id, castId)) ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });
}
