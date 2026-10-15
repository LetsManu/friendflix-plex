// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import {
  DownloadError, activeCount, checkLicenses, createDownloads, deleteLicense, downloadHeightCap, getLicense, listLicenses, markFetched, qualityOptions,
  roleAllowsDownloads, syncProgress, type DownloadSourceInfo,
} from '../downloads.js';
import { effectiveLimits } from '../limits.js';
import { effectiveLanguage, msg } from '../i18n.js';
import { requireUser } from '../session.js';

const itemId = z.string().regex(/^[0-9a-f]{32}$/);
const uuid = z.guid().transform((s) => s.toLowerCase());
const lang = z.string().min(1).max(12);
const bySession = (req: FastifyRequest) => req.cookies.ff_sid ?? req.ip;

export function downloadRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };
  const guard = async (reply: FastifyReply) => {
    if (ctx.cfg.DOWNLOADS_ENABLED !== 'true') return reply.code(404).send({ error: 'downloads_disabled' });
  };
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof DownloadError) return reply.code(e.status).send({ error: e.code, ...e.extra });
    throw e;
  };

  app.get('/api/downloads/options/:itemId', { ...pre, config: { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: bySession } } }, async (req, reply) => {
    if (reply.sent || (await guard(reply))) return;
    const id = itemId.parse((req.params as { itemId: string }).itemId);
    const role = await effectiveLimits(ctx, req.user!);
    const max = role?.maxDownloads ?? 0;
    const used = await activeCount(ctx, req.user!.id);
    const empty = { allowed: false, qualities: [], audio: [], subtitles: [], quota: { used, max }, days: role?.downloadDays ?? 0 };
    if (!role || !roleAllowsDownloads(ctx, role) || req.session!.deviceId?.startsWith('tv-')) return empty;
    let src: DownloadSourceInfo;
    try {
      const item = await ctx.jf.item(req.jfUser!, id);
      if (item.type !== 'Movie' && item.type !== 'Episode') return empty;
      src = await ctx.jf.downloadSource(req.jfUser!, id, { quality: 'original', maxHeight: downloadHeightCap(role), maxBitrate: role.maxBitrate });
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
    const dedupe = (xs: Array<{ lang: string; title: string }>) => {
      const seen = new Set<string>();
      return xs.filter((x) => !seen.has(x.lang.toLowerCase()) && seen.add(x.lang.toLowerCase())).map((x) => ({ lang: x.lang, title: x.title }));
    };
    const existing = (await ctx.db.query<{ id: string }>("select id from downloads where user_id=$1 and device_id=$2 and profile_id=$3 and item_id=$4 and status in ('pending','fetched')", [req.user!.id, req.session!.deviceId, req.profile!.id, id])).rows[0];
    const lang = await effectiveLanguage(ctx, req.profile!.id);
    return {
      allowed: true,
      qualities: qualityOptions(role, src).map((q) => ({ id: q.id, label: msg(lang, `download.quality.${q.id}`), height: q.height, estBytes: q.estBytes })),
      audio: dedupe(src.audio),
      subtitles: dedupe(src.subtitles),
      quota: { used, max },
      days: role.downloadDays,
      existingId: existing?.id ?? null,
    };
  });

  const createBody = z.union([
    z.object({ itemId, quality: z.enum(['sd', 'hd', 'fhd', 'original']), audioLang: lang.optional(), subLangs: z.array(lang).max(8).default([]) }),
    z.object({
      seriesId: itemId, fromEpisodeId: itemId, count: z.number().int().min(1).max(10),
      quality: z.enum(['sd', 'hd', 'fhd', 'original']), audioLang: lang.optional(), subLangs: z.array(lang).max(8).default([]),
    }),
  ]);

  app.post('/api/downloads', { ...pre, config: { rateLimit: { max: ctx.cfg.DOWNLOAD_CREATE_PER_HOUR, timeWindow: '1 hour', keyGenerator: bySession } } }, async (req, reply) => {
    if (reply.sent || (await guard(reply))) return;
    const body = createBody.parse(req.body);
    const role = await effectiveLimits(ctx, req.user!);
    if (!roleAllowsDownloads(ctx, role)) return reply.code(403).send({ error: 'downloads_not_allowed' });
    if (!req.session!.deviceId) return reply.code(403).send({ error: 'device_required' });
    try {
      return await createDownloads(ctx, { user: req.user!, profileId: req.profile!.id, jfUser: req.jfUser!, deviceId: req.session!.deviceId, role }, body);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/downloads', pre, async (req, reply) => {
    if (reply.sent || (await guard(reply))) return;
    const role = await effectiveLimits(ctx, req.user!);
    return {
      downloads: req.session!.deviceId ? await listLicenses(ctx, req.user!.id, req.session!.deviceId, req.profile!.id) : [],
      quota: { used: await activeCount(ctx, req.user!.id), max: role?.maxDownloads ?? 0 },
    };
  });

  // client progress poll + session heartbeat (requireUser refreshes the idle ttl; media requests never do)
  app.get('/api/downloads/:id', pre, async (req, reply) => {
    if (reply.sent || (await guard(reply))) return;
    const id = uuid.parse((req.params as { id: string }).id);
    const lic = await getLicense(ctx, req.user!.id, req.session!.deviceId ?? '', req.profile!.id, id);
    return lic ?? reply.code(404).send({ error: 'not_found' });
  });

  app.post('/api/downloads/:id/fetched', pre, async (req, reply) => {
    if (reply.sent || (await guard(reply))) return;
    const id = uuid.parse((req.params as { id: string }).id);
    const b = z.object({ bytes: z.number().int().min(0).max(2 ** 50).optional() }).parse(req.body ?? {});
    const ok = await markFetched(ctx, req.user!.id, req.session!.deviceId ?? '', req.profile!.id, id, b.bytes);
    return ok ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });

  app.delete('/api/downloads/:id', pre, async (req, reply) => {
    if (reply.sent || (await guard(reply))) return;
    const id = uuid.parse((req.params as { id: string }).id);
    const ok = await deleteLicense(ctx, req.user!.id, req.session!.deviceId ?? '', req.profile!.id, id);
    return ok ? { ok: true, status: 'deleted' } : reply.code(404).send({ error: 'not_found' });
  });

  app.post('/api/downloads/check', { ...pre, config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: bySession } } }, async (req, reply) => {
    if (reply.sent || (await guard(reply))) return;
    const b = z.object({ ids: z.array(uuid).max(200) }).parse(req.body);
    return checkLicenses(ctx, req.user!, req.session!.deviceId ?? '', req.profile!.id, [...new Set(b.ids)]);
  });

  app.post('/api/downloads/progress', { ...pre, config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: bySession } } }, async (req, reply) => {
    if (reply.sent || (await guard(reply))) return;
    const b = z.object({
      events: z.array(z.object({
        downloadId: uuid,
        itemId,
        positionTicks: z.number().min(0).max(1e15),
        played: z.boolean().default(false),
        at: z.union([z.number(), z.string()]).transform((v, c) => {
          const t = typeof v === 'number' ? v : Date.parse(v);
          if (!Number.isFinite(t)) { c.addIssue({ code: 'custom', message: 'bad_time' }); return z.NEVER; }
          return t;
        }),
      })).max(200),
    }).parse(req.body);
    return syncProgress(ctx, req.user!, req.session!.deviceId ?? '', req.profile!.id, b.events);
  });
}
