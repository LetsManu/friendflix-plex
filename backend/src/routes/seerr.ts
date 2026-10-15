// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { effectiveLanguage, m } from '../i18n.js';
import { localizeStored, notify } from '../notify.js';
import { portalStatus, RequestsDisabledError, requestsClient, requestsEnabled, requestStateKey, SeerrError } from '../seerr/client.js';
import { ensureSeerrUser } from '../seerr/service.js';
import { requireGrownUp } from '../kids.js';
import { requireAdmin } from '../session.js';
import { limitFor, quota, release, reserve, resetsAt, usage } from '../requestlimit.js';
import { checkSecret } from './internal.js';
import { seerrHooks } from '../hooks.js';
import { wrap as sharedWrap } from './_shared.js';

const mediaType = z.enum(['movie', 'tv']);

function mapResult(r: any) {
  return {
    tmdbId: r.id as number,
    mediaType: r.mediaType as string,
    title: (r.title ?? r.name ?? '') as string,
    year: String(r.releaseDate ?? r.firstAirDate ?? '').slice(0, 4) || undefined,
    overview: r.overview as string | undefined,
    poster: r.posterPath ? `/api/seerr/image${r.posterPath}` : undefined,
    status: portalStatus(r.mediaInfo?.status),
  };
}

const wrap = <T extends (...a: any[]) => Promise<any>>(fn: T): T => sharedWrap(fn, { zod: 'plain', jellyfin: false, seerr: true });

/** preHandler after the sign-in checks: without a request service its routes answer 404 {error:'requests_disabled'} */
const requestsOn = (ctx: Ctx) => async () => {
  if (!requestsEnabled(ctx)) throw new RequestsDisabledError();
};

export function seerrRoutes(app: FastifyInstance, ctx: Ctx) {
  const on = requestsOn(ctx);
  const pre = { preHandler: [requireGrownUp(ctx), on] }; // Seerr requests are for grown-ups: kids profiles get 403 kids_profile
  // the poster proxy fetches TMDB itself: it also serves stored posters (polls, reminders) while the request service is off
  const img = { preHandler: requireGrownUp(ctx) };
  // the account's notifications (party invites, recommendations, requests ...) are not shown on kids profiles either
  const npre = { preHandler: requireGrownUp(ctx, { allowNoProfile: true }) };
  const admin = { preHandler: [requireAdmin(ctx), on] };

  app.get('/api/seerr/search', pre, wrap(async (req) => {
    const q = z.object({ q: z.string().min(2).max(100), page: z.coerce.number().int().min(1).max(10).default(1) }).parse(req.query);
    const r = await requestsClient(ctx).search(q.q, q.page);
    return { results: r.results.filter((x) => x.mediaType === 'movie' || x.mediaType === 'tv').map(mapResult), totalPages: r.totalPages };
  }));

  // TMDB posters are proxied (fixed host, strict path) so browsers never contact third parties.
  app.get('/api/seerr/image/*', { ...img, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const path = '/' + String((req.params as { '*': string })['*']);
    if (!/^\/[A-Za-z0-9_-]{5,60}\.(jpg|png|webp)$/.test(path)) return reply.code(400).send({ error: 'bad_path' });
    const r = await ctx.fetchImpl(`https://image.tmdb.org/t/p/w342${path}`, { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    if (!r.ok || !r.body) return reply.code(404).send();
    reply.header('content-type', r.headers.get('content-type') ?? 'image/jpeg').header('cache-control', 'private, max-age=86400');
    return reply.send(Readable.fromWeb(r.body as never));
  });

  app.get('/api/seerr/:type/:id/status', pre, wrap(async (req) => {
    const p = z.object({ type: mediaType, id: z.coerce.number().int().positive() }).parse(req.params);
    const d = await requestsClient(ctx).details(p.type, p.id);
    return { status: portalStatus(d.mediaInfo?.status, d.mediaInfo?.requests?.[0]?.status) };
  }));

  // Official trailer key from TMDB (via Seerr); only the validated YouTube key leaves the backend.
  app.get('/api/seerr/:type/:id/trailer', pre, wrap(async (req, reply) => {
    const p = z.object({ type: mediaType, id: z.coerce.number().int().positive() }).parse(req.params);
    const ck = `trailer:${p.type}:${p.id}`;
    const cached = await ctx.kv.get(ck); // '' = cached "no trailer"
    let key = cached ?? '';
    if (cached === null) {
      const vids: any[] = ((await requestsClient(ctx).details(p.type, p.id)) as any).relatedVideos ?? [];
      const yt = Array.isArray(vids) ? vids.filter((v) => v?.site === 'YouTube' && typeof v.key === 'string' && /^[A-Za-z0-9_-]{6,20}$/.test(v.key)) : [];
      key = (yt.find((v) => v.type === 'Trailer') ?? yt.find((v) => v.type === 'Teaser'))?.key ?? '';
      await ctx.kv.set(ck, key, 24 * 3600);
    }
    if (!key) return reply.code(404).send({ error: 'no_trailer' });
    return { key };
  }));

  app.post('/api/requests', pre, wrap(async (req, reply) => {
    const b = z.object({ mediaType, tmdbId: z.number().int().positive(), seasons: z.array(z.number().int().min(0).max(100)).optional() }).parse(req.body);
    const d = await requestsClient(ctx).details(b.mediaType, b.tmdbId);
    const st = portalStatus(d.mediaInfo?.status, d.mediaInfo?.requests?.[0]?.status);
    if (st !== 'nicht_angefragt' && st !== 'abgelehnt') return reply.code(409).send({ error: 'already_requested', status: st });
    const limit = await limitFor(ctx, req.user!);
    const slot = await reserve(ctx, req.user!.id, limit); // atomic check + hold; a failure below must not burn it
    if (slot === null) return reply.code(429).send({ error: 'request_limit', limit, used: await usage(ctx, req.user!.id), resetsAt: await resetsAt(ctx) });
    let created;
    const title = String(d.title ?? d.name ?? `#${b.tmdbId}`);
    try {
      const seerrUserId = await ensureSeerrUser(ctx, req.user!);
      created = await requestsClient(ctx).createRequest({ mediaType: b.mediaType, mediaId: b.tmdbId, seasons: b.mediaType === 'tv' ? (b.seasons ?? 'all') : undefined, userId: seerrUserId });
      await ctx.db.query(
        'insert into seerr_requests(seerr_request_id, user_id, media_type, tmdb_id, title, poster) values ($1,$2,$3,$4,$5,$6) on conflict (seerr_request_id) do nothing',
        [created.id, req.user!.id, b.mediaType, b.tmdbId, title, d.posterPath ?? null],
      );
    } finally {
      await release(ctx, slot);
    }
    await audit(ctx, req.user!.id, 'request.create', String(created.id), { title });
    await seerrHooks.run(ctx, { type: 'requested', user: req.user!, tmdbId: b.tmdbId, mediaType: b.mediaType });
    return { id: created.id, status: portalStatus(created.media?.status, created.status) };
  }));

  app.get('/api/requests/quota', pre, wrap(async (req) => quota(ctx, req.user!)));

  app.get('/api/requests/mine', pre, wrap(async (req) => {
    const rows = (await ctx.db.query('select * from seerr_requests where user_id=$1 order by created_at desc limit 50', [req.user!.id])).rows;
    const out = [];
    for (const r of rows) {
      let status = 'angefragt';
      try {
        const sr = await requestsClient(ctx).getRequest(r.seerr_request_id);
        status = portalStatus(sr.media?.status, sr.status);
      } catch (e) {
        if (e instanceof SeerrError && e.status === 404) status = 'entfernt';
      }
      out.push({ id: r.seerr_request_id, title: r.title, mediaType: r.media_type, tmdbId: r.tmdb_id, poster: r.poster ? `/api/seerr/image${r.poster}` : undefined, status, createdAt: r.created_at });
    }
    return { requests: out };
  }));

  // ---- admin approval ----
  app.get('/api/admin/requests', admin, wrap(async (req) => {
    const q = z.object({
      filter: z.enum(['pending', 'approved', 'processing', 'available', 'all']).default('pending'),
      take: z.coerce.number().int().min(1).max(100).default(50),
      skip: z.coerce.number().int().min(0).max(100_000).default(0),
    }).parse(req.query);
    const r = await requestsClient(ctx).listRequests(q.filter, q.take, q.skip);
    const ids = r.results.map((x: any) => x.id);
    const owners = ids.length ? (await ctx.db.query('select s.seerr_request_id id, u.name from seerr_requests s join users u on u.id=s.user_id where s.seerr_request_id = any($1)', [ids])).rows : [];
    const byId = new Map(owners.map((o: any) => [o.id, o.name]));
    const titles = await Promise.all(r.results.map(async (x: any) => {
      try {
        const m = x.media ?? {};
        const d = await requestsClient(ctx).details(x.type ?? m.mediaType, m.tmdbId);
        return String(d.title ?? d.name);
      } catch {
        return `#${x.media?.tmdbId}`;
      }
    }));
    return {
      // `status` is the legacy portal literal (German); `statusKey` is the language-neutral key the admin UI translates
      requests: r.results.map((x: any, i: number) => ({
        id: x.id, title: titles[i], mediaType: x.type, requestedBy: byId.get(x.id) ?? x.requestedBy?.displayName ?? '?',
        status: portalStatus(x.media?.status, x.status), statusKey: requestStateKey(x.media?.status, x.status), createdAt: x.createdAt,
      })),
      total: Number(r.pageInfo?.results ?? r.results.length),
    };
  }));
  for (const action of ['approve', 'decline'] as const) {
    app.post(`/api/admin/requests/:id/${action}`, admin, wrap(async (req) => {
      const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
      await requestsClient(ctx)[action](id);
      await audit(ctx, req.user!.id, `request.${action}`, String(id));
      const row = (await ctx.db.query('select user_id, title from seerr_requests where seerr_request_id=$1', [id])).rows[0];
      if (row) await notify(ctx, { userId: row.user_id, kind: `request_${action}`, title: m(action === 'approve' ? 'request.approved' : 'request.declined', { title: row.title }), link: '/requests', dedupe: `req-${action}-${id}` });
      return { ok: true };
    }));
  }

  // ---- request service webhook (internal URL, shared secret in Authorization header or x-webhook-secret) ----
  // /internal/webhook/requests is the documented path; the old /internal/webhook/seerr keeps working for existing setups
  const requestWebhook = async (req: FastifyRequest, reply: FastifyReply) => {
    const ok = checkSecret(req, 'x-webhook-secret', ctx.cfg.WEBHOOK_SECRET) || checkSecret(req, 'authorization', ctx.cfg.WEBHOOK_SECRET);
    if (!ok) return reply.code(403).send({ error: 'forbidden' });
    const b = z.object({
      notification_type: z.string(),
      subject: z.string().optional(),
      media: z.object({ media_type: z.string().optional(), tmdbId: z.union([z.string(), z.number()]).optional() }).partial().optional(),
      request: z.object({ request_id: z.union([z.string(), z.number()]).optional() }).partial().optional(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const { notification_type: type, subject, media, request } = b.data;
    const rid = request?.request_id ? Number(request.request_id) : undefined;
    const tmdbId = media?.tmdbId ? Number(media.tmdbId) : undefined;
    const mt = media?.media_type;
    // the tmdb fallback is only right for "available" (everyone who wanted the title); approve/decline are per request
    const rows = (await ctx.db.query(
      type === 'MEDIA_AVAILABLE'
        ? 'select * from seerr_requests where seerr_request_id = $1 or (tmdb_id = $2 and media_type = $3)'
        : 'select * from seerr_requests where seerr_request_id = $1',
      type === 'MEDIA_AVAILABLE' ? [rid ?? -1, tmdbId ?? -1, mt ?? ''] : [rid ?? -1],
    )).rows;
    const named: string | undefined = subject ?? rows[0]?.title;
    const title = named ?? m('title.fallback');
    const dedupeTitle = named ?? 'Titel';
    if (type === 'MEDIA_AVAILABLE') {
      for (const r of rows) await notify(ctx, { userId: r.user_id, kind: 'available', title: m('title.available', { title: r.title }), link: '/requests', dedupe: `avail-${r.seerr_request_id}` });
      await notify(ctx, { userId: null, kind: 'available_all', title: m('title.availableAll', { title }), link: '/', dedupe: `availall-${mt}-${tmdbId ?? dedupeTitle}`, external: true });
      if (tmdbId && mt) await seerrHooks.run(ctx, { type: 'available', tmdbId, mediaType: mt });
    } else if (type === 'MEDIA_PENDING') {
      await notify(ctx, { userId: null, kind: 'request_pending', title: m('request.pending', { title }), link: '/admin/requests', dedupe: `pending-${rid ?? dedupeTitle}`, external: true });
    } else if (type === 'MEDIA_DECLINED' || type === 'MEDIA_APPROVED' || type === 'MEDIA_AUTO_APPROVED') {
      for (const r of rows) await notify(ctx, { userId: r.user_id, kind: type.toLowerCase(), title: m(type === 'MEDIA_DECLINED' ? 'request.declinedShort' : 'request.approvedShort', { title: r.title }), link: '/requests', dedupe: `${type}-${r.seerr_request_id}` });
    }
    return { ok: true };
  };
  app.post('/internal/webhook/requests', requestWebhook);
  app.post('/internal/webhook/seerr', requestWebhook);

  // ---- notifications (in-app) ----
  app.get('/api/notifications', npre, async (req) => {
    const r = await ctx.db.query(
      `select n.id, n.kind, n.title, n.body, n.link, n.created_at, n.msg,
              (case when n.user_id is null then coalesce(n.created_at <= u.notifications_read_at, false) else n.read_at is not null end) as read
         from notifications n, users u
        where u.id = $1 and (n.user_id = $1 or n.user_id is null) order by n.created_at desc limit 30`,
      [req.user!.id],
    );
    const lang = await effectiveLanguage(ctx, req.profile?.id ?? req.user!.id);
    return { notifications: r.rows.map((row) => localizeStored(row as { title: string; body: string | null; msg: unknown }, lang)) };
  });
  app.post('/api/notifications/read', npre, async (req) => {
    await ctx.db.query('update notifications set read_at = now() where user_id = $1 and read_at is null', [req.user!.id]);
    await ctx.db.query('update users set notifications_read_at = now() where id = $1', [req.user!.id]);
    return { ok: true };
  });
}
