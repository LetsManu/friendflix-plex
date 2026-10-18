// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../ctx.js';
import { MediaError } from '../media/types.js';
import { requireGrownUp } from '../kids.js';
import { trendingItems } from '../discoverData.js';

export function trendingRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireGrownUp(ctx) }; // "Diese Woche bei uns" is what friends watch: not on kids profiles

  /** "Diese Woche bei uns": what friends watched in the last 7 days. Counts only, never names. (The aggregate lives in discoverData.ts: the recommendation engine reuses it.) */
  app.get('/api/library/trending', pre, async (req, reply) => {
    try {
      return { items: await trendingItems(ctx, req.jfUser!, req.user!.id) };
    } catch (e) {
      if (e instanceof MediaError) return reply.code(502).send({ error: 'jellyfin', status: e.status });
      throw e;
    }
  });
}
