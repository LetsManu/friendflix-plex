// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { requireUser } from '../session.js';
import { recoClicks, recoDismiss, recoImpressions } from '../metrics.js';

/** Closed label sets: the metric cardinality is fixed here, whatever the browser sends. New rows / engines are added with their step. */
export const RECO_ROWS = ['because', 'because_more', 'top_picks', 'popular', 'friends', 'postplay'] as const;
export const RECO_ENGINES = ['v1', 'v2'] as const;

/**
 * One aggregate per row and engine: counts only, no item, title, position or profile. The route never stores anything;
 * it only bumps the Prometheus counters.
 */
export const recoEventsBody = z.object({
  events: z.array(z.object({
    row: z.enum(RECO_ROWS),
    engine: z.enum(RECO_ENGINES),
    impressions: z.number().int().min(0).max(50).default(0),
    clicks: z.number().int().min(0).max(50).default(0),
    dismisses: z.number().int().min(0).max(50).default(0),
  })).min(1).max(12),
});

/** POST /api/reco/events: signed-in only (kids profiles too: it carries counts, no titles), CSRF-checked like every other write, 60 requests per minute. */
export function recoRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/api/reco/events', { preHandler: requireUser(ctx), config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = recoEventsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });
    for (const e of parsed.data.events) {
      const l = { row: e.row, engine: e.engine };
      if (e.impressions) recoImpressions.inc(l, e.impressions);
      if (e.clicks) recoClicks.inc(l, e.clicks);
      if (e.dismisses) recoDismiss.inc(l, e.dismisses);
    }
    return reply.code(204).send();
  });
}
