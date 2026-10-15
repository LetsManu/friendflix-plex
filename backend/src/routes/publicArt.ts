// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../ctx.js';
import { ART_INDEX_RE, ART_SET_RE, LOGIN_ART_TTL, artImage, currentArtSet } from '../loginArt.js';

/**
 * Public cover-wall images of the login page (Block 23 phase 3). No auth and no CSRF; behind the setup gate (503 during setup).
 * The JSON lists same-origin paths only: never item ids, the media-server host or titles.
 */
export function publicArtRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/public/login-art', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const cur = await currentArtSet(ctx, req.log);
    // an empty answer (wall off, outage, nothing eligible) is never cached: it must not outlive the cause
    reply.header('cache-control', cur ? `public, max-age=${LOGIN_ART_TTL}` : 'no-store');
    return { images: cur ? Array.from({ length: cur.count }, (_, i) => `/api/public/login-art/${cur.set}/${i}`) : [] };
  });

  app.get('/api/public/login-art/:set/:i', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { set, i } = req.params as { set: string; i: string };
    // validated before any kv lookup
    if (!ART_SET_RE.test(set) || !ART_INDEX_RE.test(i)) return reply.code(404).header('cache-control', 'no-store').send({ error: 'not_found' });
    if (ctx.cfg.LOGIN_COVER_WALL !== 'true') return reply.code(404).header('cache-control', 'no-store').send({ error: 'not_found' });
    const img = await artImage(ctx, set, Number(i));
    if (!img) return reply.code(404).header('cache-control', 'no-store').send({ error: 'not_found' });
    return reply.header('cache-control', `public, max-age=${LOGIN_ART_TTL}, immutable`).type(img.type).send(img.bytes);
  });
}
