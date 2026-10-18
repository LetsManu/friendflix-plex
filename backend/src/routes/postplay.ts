// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** 1.1 post-play screen: GET /api/items/:id/postplay (spec §3.4) and its anonymous counters (POST /api/postplay/event). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { isKidsProfile } from '../kids.js';
import { postplayClick, postplayDismiss, postplayPlay, postplayShown } from '../metrics.js';
import { POSTPLAY_STATES, ROW_KINDS, postplayFor } from '../postplay.js';
import { requireUser } from '../session.js';
import { perSession } from './discover.js';
import { loadPrefs } from './prefs.js';
import { id32, wrap } from './_shared.js';

/** telemetry: only fixed enums reach the counters (bounded labels; no title, item id or user) */
const event = z.discriminatedUnion('type', [
  z.object({ type: z.literal('shown'), state: z.enum(POSTPLAY_STATES) }),
  z.object({ type: z.literal('click'), row: z.enum(ROW_KINDS) }),
  z.object({ type: z.literal('play'), row: z.enum(ROW_KINDS) }),
  z.object({ type: z.literal('dismiss') }),
]);

export const postplayEnabled = (ctx: Pick<Ctx, 'cfg'>): boolean => ctx.cfg.POSTPLAY_ENABLED !== 'false';

export function postplayRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };

  app.get('/api/items/:id/postplay', { ...pre, config: perSession(60) }, wrap(async (req, reply) => {
    if (!postplayEnabled(ctx)) return reply.code(404).send({ error: 'disabled' });
    const id = id32.parse((req.params as { id: string }).id);
    const p = await loadPrefs(ctx, req.user!.id, req.profile!.id);
    return postplayFor(ctx, {
      user: req.jfUser!, userId: req.user!.id, role: req.user!.role, profileId: req.profile!.id, kids: isKidsProfile(req),
      suggestions: p.postplay, spoilerProtection: p.spoilerProtection,
    }, id);
  }, { zod: 'plain', notFound: [400, 403, 404] }));

  app.post('/api/postplay/event', { ...pre, config: perSession(120) }, async (req, reply) => {
    if (!postplayEnabled(ctx)) return reply.code(204).send();
    const e = event.safeParse(req.body);
    if (!e.success) return reply.code(400).send({ error: 'bad_request' });
    const b = e.data;
    if (b.type === 'shown') postplayShown.inc({ state: b.state });
    else if (b.type === 'click') postplayClick.inc({ row_kind: b.row });
    else if (b.type === 'play') postplayPlay.inc({ row_kind: b.row });
    else postplayDismiss.inc();
    return reply.code(204).send();
  });
}
