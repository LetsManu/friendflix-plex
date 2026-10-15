// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { preHandlerAsyncHookHandler } from 'fastify';
import type { FastifyRequest } from 'fastify';
import { audit } from './audit.js';
import type { Ctx } from './ctx.js';
import { freshAuth, type OidcClaims, RESET_PIN_MAX_AGE } from './oidc.js';
import { COOKIE, loadSession, requireOwner, saveSession, type Session } from './session.js';
import { getUserById } from './users.js';

/** seconds a re-authentication unlocks sensitive account actions (password screen, account deletion …) */
export const REAUTH_WINDOW_S = 600;
/** seconds the IdP's auth_time may be old on a re-authentication callback (same bound as the forgotten-PIN reset) */
export const REAUTH_MAX_AGE = RESET_PIN_MAX_AGE;
/** clock skew allowed for a stamp from the future (several backend instances) */
const SKEW_MS = 30_000;

/** true when the session was re-authenticated at most `maxAgeS` seconds ago (and the stamp is not from the future) */
export function recentlyAuthenticated(s: Session, maxAgeS = REAUTH_WINDOW_S, now = Date.now()): boolean {
  const at = s.reauthAt;
  return typeof at === 'number' && Number.isFinite(at) && now - at <= maxAgeS * 1000 && at - now <= SKEW_MS;
}

/**
 * The single gate for actions that need a recent re-authentication: the owner profile (requireOwner), then a fresh
 * `reauthAt` stamp, else 401 reauth_required (the client then starts /auth/reauth).
 */
export function requireRecentAuth(ctx: Ctx, maxAgeS = REAUTH_WINDOW_S): preHandlerAsyncHookHandler {
  const owner = requireOwner(ctx);
  return async (req, reply) => {
    const r = await owner(req, reply);
    if (reply.sent) return r;
    if (!recentlyAuthenticated(req.session!, maxAgeS)) return reply.code(401).send({ error: 'reauth_required' });
  };
}

/**
 * The producer of the stamp on a live session: stores `reauthAt`; false when it was revoked meanwhile (never resurrected). The only other
 * producer is setup/state.ts completeSetup, which stamps the first admin's new session before it is saved.
 */
export async function markReauthenticated(ctx: Ctx, sid: string, s: Session, now = Date.now()): Promise<boolean> {
  s.reauthAt = now;
  return saveSession(ctx, sid, s, true);
}

/** `stale`: the IdP login is not fresh; `mismatch`: another person or another (or no) session; `revoked`: the session ended meanwhile */
export type StampResult = 'ok' | 'stale' | 'mismatch' | 'revoked';

/**
 * The checks every re-authentication ends with, shared by the classic `/auth/callback` and the in-app flow (preflight P18): the IdP login
 * must be fresh (auth_time), and it must be the same person as the request's session (`userId`, the session's user, and the account's
 * `authentik_sub` = the claims' sub). Then the session is stamped (`markReauthenticated`) and `session.reauth` audited; a mismatch is
 * audited as `session.reauth_mismatch`. No session, device or account is ever created here.
 */
export async function stampReauth(ctx: Ctx, req: FastifyRequest, claims: OidcClaims, userId: string): Promise<StampResult> {
  if (!freshAuth(claims.authTime, REAUTH_MAX_AGE)) return 'stale';
  const sid = req.cookies[COOKIE];
  const s = await loadSession(ctx, sid);
  const user = s?.userId === userId ? await getUserById(ctx, userId) : null;
  if (!sid || !s || !user || user.disabled || user.authentik_sub !== claims.sub) {
    await audit(ctx, userId, 'session.reauth_mismatch', userId, { ip: req.ip });
    return 'mismatch';
  }
  if (!(await markReauthenticated(ctx, sid, s))) return 'revoked';
  await audit(ctx, userId, 'session.reauth', userId, { ip: req.ip });
  return 'ok';
}
