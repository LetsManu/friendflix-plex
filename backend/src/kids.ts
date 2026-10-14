// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from './ctx.js';
import { requireUser } from './session.js';

/** True when the active profile is a kids profile (column added by migration 31). */
export const isKidsProfile = (req: FastifyRequest): boolean => Boolean((req.profile as { kids?: boolean } | undefined)?.kids);

/** requireUser + no kids profile: social features (comments, party, reactions, lists, polls ...) answer 403 kids_profile. */
export function requireGrownUp(ctx: Ctx, opts: Parameters<typeof requireUser>[1] = {}) {
  const base = requireUser(ctx, opts);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const r = await base(req, reply);
    if (reply.sent) return r;
    if (isKidsProfile(req)) return reply.code(403).send({ error: 'kids_profile' });
  };
}
