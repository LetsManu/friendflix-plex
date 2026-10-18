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
import { AkUpstreamError } from '../akdiag.js';
import {
  akChangeUsername, akDeleteDevice, akDevices, akFlowExists, akMfaMandatory, akMfaState, akOauthProvider, akUserBySub, akUsernameTaken, USERNAME_RE,
} from '../authentik.js';
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

/** username changes per account in USERNAME_WINDOW_S (besides the route's per-IP limit) */
export const MAX_USERNAME_CHANGES = 3;
export const USERNAME_WINDOW_S = 86_400;
const usernameKey = (userId: string) => `usernamechange:${userId}`;
const UsernameBody = z.strictObject({ username: z.string().max(200) });

/** why the security section cannot read Authentik right now (shown as a note): the service token was refused, or no answer */
function problemOf(err: unknown): 'service_token' | 'unreachable' | 'error' {
  if (err instanceof AkUpstreamError && err.failure.area === 'api' && (err.failure.cls === 'token_invalid' || err.failure.cls === 'permission')) return 'service_token';
  if (err instanceof HttpError && err.message === 'authentik_token_rejected') return 'service_token';
  return err instanceof HttpError && err.statusCode === 503 ? 'unreachable' : 'error';
}

/**
 * Whether the OIDC subject would change with the username: a provider in subject mode "username" (or a sub that is the username)
 * would turn a rename into a new FriendFlix account at the next sign-in, so the rename is refused there. FriendFlix keys accounts by
 * `sub` (users.authentik_sub); the wizard's provider uses the hashed user id, which a rename does not touch.
 */
async function subFollowsUsername(ctx: Ctx, sub: string, username: string): Promise<boolean> {
  if (sub.toLowerCase() === username.toLowerCase()) return true;
  const p = ctx.cfg.OIDC_CLIENT_ID ? await akOauthProvider(ctx, ctx.cfg.OIDC_CLIENT_ID) : null;
  return p !== null && p !== 'forbidden' && p.subMode === 'user_username';
}

const Params = z.object({ type: z.enum(['totp', 'static', 'webauthn']), id: z.string().regex(/^\d{1,12}$/) });

export function accountSecurityRoutes(app: FastifyInstance, ctx: Ctx) {
  // Only the GET skips the re-authentication: it shows what exists, and the account page needs it before it asks for the password.
  app.get('/api/account/security', { preHandler: requireOwner(ctx) }, async (req) => {
    const user = req.user!;
    const configured = Boolean(ctx.cfg.AUTHENTIK_URL && ctx.cfg.AUTHENTIK_API_TOKEN);
    let problem: ReturnType<typeof problemOf> | null = null;
    const note = (err: unknown) => {
      problem ??= problemOf(err);
      return null;
    };
    const devices = await akDevices(ctx, user.authentik_sub).catch(note);
    const ak = configured ? await akUserBySub(ctx, user.authentik_sub).catch(note) : null;
    return {
      mfa: await akMfaState(ctx, user.authentik_sub).catch(note),
      devices: (devices ?? []).filter((d) => d.confirmed).map(({ id, type, name, lastUsed }) => ({ id, type, name, lastUsed })),
      passkeySetup: (await passkeysInApp(ctx).catch(() => false)) ? 'in-app' : 'sign-in page',
      /** whether the e-mail change flow exists in Authentik (the page hides "E-Mail ändern" otherwise) */
      emailChange: configured && (await akFlowExists(ctx, flowSlug(ctx.cfg, 'change-email')!)),
      emailChangePending: await emailChangePending(ctx, user.id),
      /** the Authentik username (null: not readable right now) and whether it can be changed here */
      username: ak?.username ?? null,
      usernameChange: Boolean(ak) && !(await subFollowsUsername(ctx, user.authentik_sub, ak!.username).catch(() => true)),
      /** why Authentik could not be read (the card shows a note instead of an empty list); null when everything answered */
      problem: configured ? problem : 'not_configured',
    };
  });

  // The Authentik username, changed by FriendFlix through the service account (Authentik's own setting lets people do it on its page
  // only when the admin allows it). Behind a recent re-authentication, rate limited per IP and per account, audited without the names.
  app.put('/api/account/security/username', { preHandler: requireRecentAuth(ctx), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = UsernameBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const username = b.data.username.normalize('NFC').trim();
    if (!USERNAME_RE.test(username)) return reply.code(400).send({ error: 'username_invalid' });
    const user = req.user!;
    const ak = await akUserBySub(ctx, user.authentik_sub);
    if (!ak) throw new HttpError(404, 'authentik_user_not_found');
    if (ak.username === username) return { ok: true, username };
    if (await subFollowsUsername(ctx, user.authentik_sub, ak.username)) return reply.code(409).send({ error: 'username_is_subject' });
    if (await akUsernameTaken(ctx, username, ak.pk)) return reply.code(409).send({ error: 'username_taken' });
    // the per-account budget is taken only for a change that reaches Authentik, and given back when Authentik refuses it
    const key = usernameKey(user.id);
    if ((await ctx.kv.incr(key, USERNAME_WINDOW_S)) > MAX_USERNAME_CHANGES) {
      await ctx.kv.decr(key);
      return reply.code(429).send({ error: 'rate_limited' });
    }
    try {
      await akChangeUsername(ctx, user.authentik_sub, username);
    } catch (e) {
      await ctx.kv.decr(key);
      throw e;
    }
    await audit(ctx, user.id, 'account.username', user.id, { fields: ['username'] });
    return { ok: true, username };
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
