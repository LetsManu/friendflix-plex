// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { REAUTH_WINDOW_S, recentlyAuthenticated } from '../reauth.js';
import { requireAdmin } from '../session.js';
import { UPDATER_ACTIONS, startJob, updaterView, type UpdaterAction } from '../updater.js';

/**
 * Admin -> Update with the opt-in updater. GET: whether an updater answers, its status (channel, installed/previous tag, the job
 * with its steps, the last log lines) and the automatic-update setting; without an updater `present: false` and the page keeps
 * the manual steps. POST: one of the three jobs, admin only, after a recent re-authentication, at most 3 per 2 minutes for the
 * whole portal, audited (start and result).
 */
export function updaterRoutes(app: FastifyInstance, ctx: Ctx) {
  const admin = { preHandler: requireAdmin(ctx) };
  const auto = () => {
    let locked: string[] = [];
    try { const src = ctx.settings.sources(); locked = ['AUTO_UPDATE', 'AUTO_UPDATE_TIME'].filter((k) => src[k] === 'env'); } catch { /* tests without a store */ }
    return { mode: ctx.cfg.AUTO_UPDATE, time: ctx.cfg.AUTO_UPDATE_TIME, locked };
  };

  app.get('/api/admin/updater', admin, async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return { ...(await updaterView(ctx)), autoUpdate: auto() };
  });

  const action = z.object({ action: z.enum(UPDATER_ACTIONS as [UpdaterAction, ...UpdaterAction[]]) });
  // hook preHandler: the limiter runs after requireAdmin, so nobody but an admin can use up the portal-wide budget
  app.post('/api/admin/updater/:action', { ...admin, config: { rateLimit: { max: 3, timeWindow: '2 minutes', keyGenerator: () => 'updater', hook: 'preHandler' } } }, async (req, reply) => {
    const p = action.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found' });
    if (!recentlyAuthenticated(req.session!, REAUTH_WINDOW_S)) return reply.code(401).send({ error: 'reauth_required' });
    const r = await startJob(ctx, p.data.action, req.user!.id);
    if (!r.ok) {
      req.log.warn({ action: p.data.action, error: r.error }, 'updater job refused');
      return reply.code(r.status).send({ error: r.error });
    }
    return reply.code(202).send({ job: r.job });
  });
}
