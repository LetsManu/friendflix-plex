// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { preHandlerAsyncHookHandler } from 'fastify';
import type { Ctx } from './ctx.js';
import { RESET_PIN_MAX_AGE } from './oidc.js';
import { requireOwner, saveSession, type Session } from './session.js';

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
