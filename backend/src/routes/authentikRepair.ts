// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Status → Sign-in → "Repair Authentik setup": the parts of the automatic setup an existing install may lack after an update
 * (setup/authentikSetup.ts repairAuthentik): the service account's permissions, the e-mail change flow once its template is mounted, and
 * the service token. It needs a one-time superuser token, like the wizard; the token goes only to the saved AUTHENTIK_URL, lives in this
 * request only, and is never stored, logged (app.ts SENSITIVE_BODY) or put into an answer. A service token that changed (it was deleted
 * and the import created a new one) is saved like an admin's settings change; one set in the environment is reported by name instead.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { randomToken } from '../crypto.js';
import { checkLoginFlows } from '../flowCheck.js';
import { requireRecentAuth } from '../reauth.js';
import { requireAdmin } from '../session.js';
import { AK_BLUEPRINT_DIR, applyLockTtlS, repairAuthentik } from '../setup/authentikSetup.js';
import { saveWithProbes } from './adminSettings.js';

const Body = z.strictObject({ token: z.string().min(1).max(512) });
/** the wizard's lock: a repair and a wizard run never import the same blueprints at once */
const LOCK = 'setup:authentik:apply';

export function authentikRepairRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/api/admin/authentik/repair', {
    // admins only, after a recent sign-in (it changes Authentik with a superuser token and may replace the saved service token)
    preHandler: [requireAdmin(ctx), requireRecentAuth(ctx)],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const b = Body.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const url = ctx.cfg.AUTHENTIK_URL;
    if (!url) return reply.code(409).send({ error: 'authentik_not_configured' });
    const owner = randomToken();
    if (!(await ctx.kv.setnx(LOCK, owner, applyLockTtlS()))) return reply.code(409).send({ error: 'busy' });
    try {
      const { steps, values } = await repairAuthentik({ url, token: b.data.token }, { fetchImpl: ctx.fetchImpl, blueprintDir: AK_BLUEPRINT_DIR, cfg: ctx.cfg });
      req.log.info({ steps: steps.map((s) => `${s.id}:${s.state}${s.detail ? `:${s.detail}` : ''}`) }, 'authentik: setup repaired');
      await audit(ctx, req.user!.id, 'authentik.repair', undefined, { steps: steps.map((s) => `${s.id}:${s.state}`), ok: Boolean(values) });
      if (!values) return { ok: false, steps };
      let tokenSaved = false;
      const envKept: string[] = [];
      if (values.AUTHENTIK_API_TOKEN !== ctx.cfg.AUTHENTIK_API_TOKEN) {
        if (ctx.settings.sources().AUTHENTIK_API_TOKEN === 'env') envKept.push('AUTHENTIK_API_TOKEN');
        else {
          const r = await saveWithProbes(ctx, { AUTHENTIK_API_TOKEN: values.AUTHENTIK_API_TOKEN }, { force: false, actor: req.user!.id });
          if (!('rev' in r)) return reply.code(400).send({ error: 'token_not_saved', steps });
          tokenSaved = true;
        }
      }
      // the card shows the state after the repair, not the cached one from before
      const check = await checkLoginFlows(ctx, { fresh: true });
      return { ok: true, steps, tokenSaved, ...(envKept.length ? { envKept } : {}), check };
    } finally {
      await ctx.kv.delIfEquals(LOCK, owner).catch(() => undefined);
    }
  });
}
