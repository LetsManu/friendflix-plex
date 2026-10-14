// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { getSnapshot, worstOf, type HealthIssue } from '../health.js';
import { requireAdmin } from '../session.js';

const REFRESH_PER_MIN = 6;
const healthQuery = z.object({ refresh: z.enum(['1', '0', 'true', 'false']).optional() });
const dismissBody = z.object({
  // e.g. svc:media, svc:playbackCheck, disk:downloads, errors:client
  id: z.string().max(40).regex(/^[a-z]+:[a-zA-Z]+$/),
  fp: z.string().regex(/^[0-9a-f]{12}$/),
});

/** Block 22: admin health snapshot and the warning banner (admin role on the owner profile only). */
export function healthRoutes(app: FastifyInstance, ctx: Ctx) {
  const admin = { preHandler: requireAdmin(ctx) };

  app.get('/api/admin/health', admin, async (req, reply) => {
    const q = healthQuery.parse(req.query);
    const refresh = q.refresh === '1' || q.refresh === 'true';
    if (refresh && (await ctx.kv.incr(`health:refresh:${req.sid}`, 60)) > REFRESH_PER_MIN) return reply.code(429).send({ error: 'rate_limited' });
    return getSnapshot(ctx, { refresh });
  });

  app.get('/api/admin/health/banner', admin, async (req) => {
    const snap = await getSnapshot(ctx);
    const r = await ctx.db.query<{ issue_id: string; fp: string }>(
      "select issue_id, fp from health_dismissals where user_id = $1 and at > now() - interval '30 days'", [req.user!.id]);
    const hidden = new Set(r.rows.map((x) => `${x.issue_id}|${x.fp}`));
    const issues: HealthIssue[] = snap.issues
      .filter((i) => !hidden.has(`${i.id}|${i.fp}`))
      .sort((a, b) => (a.level === b.level ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.level === 'err' ? -1 : 1));
    return { issues, worst: worstOf(issues.map((i) => i.level)) };
  });

  app.post('/api/admin/health/dismiss', admin, async (req) => {
    const b = dismissBody.parse(req.body);
    await ctx.db.query(
      'insert into health_dismissals(user_id, issue_id, fp) values ($1, $2, $3) on conflict (user_id, issue_id) do update set fp = excluded.fp, at = now()',
      [req.user!.id, b.id, b.fp]);
    return { ok: true };
  });
}
