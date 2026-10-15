// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { clearSourceFailures, getSourceKey, removeSourceKey, resetSourceState, setSourceKey, sourceStatus, SOURCES, type SourceName } from '../sources/keys.js';
import { REAUTH_WINDOW_S, recentlyAuthenticated } from '../reauth.js';
import { requireAdmin } from '../session.js';

export type SourceTestResult = { ok: true } | { ok: false; error: 'not_set' | 'invalid_key' | 'unreachable' | 'budget' };
export type SourceTester = (ctx: Ctx, name: SourceName, key: string) => Promise<SourceTestResult>;

const nameSchema = z.enum(['tmdb', 'omdb']);
const keySchema = z.string().trim().min(8).max(200).regex(/^[\x21-\x7e]+$/);

export function sourceRoutes(app: FastifyInstance, ctx: Ctx, test?: SourceTester) {
  const admin = { preHandler: requireAdmin(ctx) };
  const nameOf = (req: { params: unknown }): SourceName => nameSchema.parse((req.params as { name: string }).name);

  app.get('/api/admin/sources', admin, async () => ({ sources: await Promise.all(SOURCES.map((n) => sourceStatus(ctx, n))) }));
  app.get('/api/admin/sources/:name', admin, async (req) => sourceStatus(ctx, nameOf(req)));

  // replacing or removing a key changes a secret: a sign-in at most 10 minutes old, like saving a secret in Admin -> Settings
  const reauthRequired = { error: 'reauth_required' } as const;

  app.put('/api/admin/sources/:name', admin, async (req, reply) => {
    const name = nameOf(req);
    const { key } = z.object({ key: keySchema }).parse(req.body);
    if (!recentlyAuthenticated(req.session!, REAUTH_WINDOW_S)) return reply.code(401).send(reauthRequired);
    if ((await getSourceKey(ctx, name))?.from === 'file') return reply.code(409).send({ error: 'from_file' });
    await setSourceKey(ctx, name, key, req.user!.id);
    await resetSourceState(ctx, name);
    await audit(ctx, req.user!.id, 'source.set', undefined, { name });
    return sourceStatus(ctx, name);
  });

  app.delete('/api/admin/sources/:name', admin, async (req, reply) => {
    const name = nameOf(req);
    if (!recentlyAuthenticated(req.session!, REAUTH_WINDOW_S)) return reply.code(401).send(reauthRequired);
    if ((await getSourceKey(ctx, name))?.from === 'file') return reply.code(409).send({ error: 'from_file' });
    await removeSourceKey(ctx, name, req.user!.id);
    await resetSourceState(ctx, name);
    await audit(ctx, req.user!.id, 'source.remove', undefined, { name });
    return sourceStatus(ctx, name);
  });

  app.post('/api/admin/sources/:name/test', { ...admin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req): Promise<SourceTestResult> => {
    const name = nameOf(req);
    const b = z.object({ key: keySchema.optional() }).parse(req.body ?? {});
    const effective = (await getSourceKey(ctx, name))?.key;
    const key = b.key ?? effective;
    if (!key || !test) return { ok: false, error: 'not_set' };
    const r = await test(ctx, name, key);
    if (r.ok && key === effective) await clearSourceFailures(ctx, name); // the key in use works again: no 1 h wait
    return r;
  });
}
