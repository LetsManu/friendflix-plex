// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { buildAbout } from '../about.js';
import type { Ctx } from '../ctx.js';
import { isKidsProfile } from '../kids.js';
import { requireUser } from '../session.js';
import { id32, wrap } from './_shared.js';

/** per session (cookie); IP as the fallback for cookie-less callers (they get 401 anyway) */
const perSession = { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: (req: { cookies?: Record<string, string | undefined>; ip: string }) => `about:${req.cookies?.ff_sid ?? req.ip}` } };

/** Block 21: GET /api/items/:id/about — facts, ratings, links and the collection row of the detail page ("Über"). */
export function aboutRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/items/:id/about', { preHandler: requireUser(ctx), config: perSession }, wrap(async (req) => {
    const id = id32.parse((req.params as { id: string }).id);
    return buildAbout({ ctx, user: req.jfUser!, account: { id: req.user!.id, role: req.user!.role }, kids: isKidsProfile(req), id, log: req.log });
  }, { zod: 'plain', notFound: [400, 404], passthrough: [403] }));
}
