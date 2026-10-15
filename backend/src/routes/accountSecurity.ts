// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The account page's security section (Block 23 phase 3, Task 10): the person's second factors and the e-mail change state.
 * Changing them goes through `/auth/flow/*` (re-authentication, then the Authentik setup flows); only removing a device is a plain
 * route here, and it needs a recent re-authentication. Owner profile only. Nothing from Authentik beyond device ids, kinds, names
 * and last-use times reaches the browser.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { flowSlug, passkeysInApp } from '../akflow.js';
import { akDeleteDevice, akDevices, akFlowExists, akMfaMandatory, akMfaState } from '../authentik.js';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { decrypt } from '../crypto.js';
import { maskEmail } from '../flowSteps.js';
import { requireRecentAuth } from '../reauth.js';
import { requireOwner } from '../session.js';
import { HttpError } from '../users.js';
import { emailChangeKey } from './authFlow.js';

/** the masked address of a pending e-mail change (confirmation not yet followed), or null */
export async function emailChangePending(ctx: Ctx, userId: string): Promise<string | null> {
  const blob = await ctx.kv.get(emailChangeKey(userId));
  if (!blob) return null;
  try {
    return maskEmail(decrypt(ctx.encKey, blob));
  } catch {
    return null; // another key or a damaged entry: nothing pending
  }
}

const Params = z.object({ type: z.enum(['totp', 'static', 'webauthn']), id: z.string().regex(/^\d{1,12}$/) });

export function accountSecurityRoutes(app: FastifyInstance, ctx: Ctx) {
  // Only the GET skips the re-authentication: it shows what exists, and the account page needs it before it asks for the password.
  app.get('/api/account/security', { preHandler: requireOwner(ctx) }, async (req) => {
    const user = req.user!;
    const configured = Boolean(ctx.cfg.AUTHENTIK_URL && ctx.cfg.AUTHENTIK_API_TOKEN);
    const devices = await akDevices(ctx, user.authentik_sub).catch(() => null);
    return {
      mfa: await akMfaState(ctx, user.authentik_sub).catch(() => null),
      devices: (devices ?? []).filter((d) => d.confirmed).map(({ id, type, name, lastUsed }) => ({ id, type, name, lastUsed })),
      passkeySetup: (await passkeysInApp(ctx).catch(() => false)) ? 'in-app' : 'sign-in page',
      /** whether the e-mail change flow exists in Authentik (the page hides "E-Mail ändern" otherwise) */
      emailChange: configured && (await akFlowExists(ctx, flowSlug(ctx.cfg, 'change-email')!)),
      emailChangePending: await emailChangePending(ctx, user.id),
    };
  });

  app.delete('/api/account/security/devices/:type/:id', { preHandler: requireRecentAuth(ctx), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = Params.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const { type } = p.data;
    const sub = req.user!.authentik_sub;
    const devices = await akDevices(ctx, sub);
    if (!devices) throw new HttpError(503, 'authentik_unavailable');
    const target = devices.find((d) => d.type === type && d.id === p.data.id);
    if (!target) return reply.code(404).send({ error: 'device_not_found' });
    // the last second factor stays when the login flow demands one: removing it would lock the person out at the next sign-in
    const others = devices.filter((d) => d.confirmed && d !== target);
    if (target.confirmed && !others.length && (await akMfaMandatory(ctx)) === true) return reply.code(409).send({ error: 'last_factor' });
    await akDeleteDevice(ctx, sub, type, Number(p.data.id));
    await audit(ctx, req.user!.id, 'account.mfa_removed', req.user!.id, { type });
    return { ok: true };
  });
}
