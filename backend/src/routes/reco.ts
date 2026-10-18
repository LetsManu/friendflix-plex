// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { requireUser } from '../session.js';
import { recoClicks, recoDismiss, recoImpressions, recoPlays } from '../metrics.js';
import { recoCoefficients } from '../reco/weights.js';
import { recordRowStats, ROW_KINDS } from '../reco/rows.js';

/** Closed label sets: the metric cardinality is fixed here, whatever the browser sends. New rows / engines are added with their step. */
export const RECO_ROWS = ROW_KINDS;
export const RECO_ENGINES = ['v1', 'v2'] as const;

/**
 * One aggregate per row and engine: counts only, no item, title, position or profile. The route never stores anything;
 * it only bumps the Prometheus counters. A play is a playback that started on a title opened from a recommendation row.
 */
export const recoEventsBody = z.object({
  events: z.array(z.object({
    row: z.enum(RECO_ROWS),
    engine: z.enum(RECO_ENGINES),
    impressions: z.number().int().min(0).max(50).default(0),
    clicks: z.number().int().min(0).max(50).default(0),
    plays: z.number().int().min(0).max(50).default(0),
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
      if (e.plays) recoPlays.inc(l, e.plays);
      if (e.dismisses) recoDismiss.inc(l, e.dismisses);
    }
    // the profile's own aggregate per row kind (counts only) for the row ranker, rows.ts
    if (req.profile) await recordRowStats(ctx, req.profile.id, parsed.data.events.map((e) => ({ row: e.row, impressions: e.impressions, clicks: e.clicks, plays: e.plays, dismisses: e.dismisses })), recoCoefficients(ctx.cfg));
    return reply.code(204).send();
  });
}
