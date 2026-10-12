import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { m } from '../i18n.js';
import { endpointAllowed, pushEnabled, sendWebPush } from '../push.js';
import { requireGrownUp } from '../kids.js';
import { requireUser } from '../session.js';

const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
const subscribeBody = z.object({
  endpoint: z.string().max(1024),
  keys: z.object({ p256dh: b64url.max(200), auth: b64url.max(64) }),
  broadcast: z.boolean().optional(),
});
const endpointBody = z.object({ endpoint: z.string().max(1024) });

export function pushRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };
  // the account's push notifications are social (party invites, recommendations ...): a kids profile cannot subscribe a device
  const grown = { preHandler: requireGrownUp(ctx) };

  app.get('/api/push/config', pre, async () => (pushEnabled(ctx.cfg) ? { enabled: true, publicKey: ctx.cfg.VAPID_PUBLIC_KEY } : { enabled: false }));

  app.post('/api/push/subscribe', { ...grown, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!pushEnabled(ctx.cfg)) return reply.code(404).send({ error: 'push_disabled' });
    const b = subscribeBody.parse(req.body);
    if (!endpointAllowed(b.endpoint)) return reply.code(400).send({ error: 'push_endpoint_denied' });
    const deviceId = req.session!.deviceId;
    if (!deviceId) return reply.code(403).send({ error: 'device_required' });
    const dev = await ctx.db.query<{ approved: boolean }>('select approved from devices where user_id = $1 and device_id = $2', [req.user!.id, deviceId]);
    if (!dev.rows[0]?.approved) return reply.code(403).send({ error: 'device_pending' });
    const r = await ctx.db.query<{ broadcast: boolean }>(
      `insert into push_subscriptions(user_id, device_id, profile_id, endpoint, p256dh, auth, broadcast) values ($1,$2,$3,$4,$5,$6,coalesce($7::boolean, false))
       on conflict (endpoint) do update set user_id = excluded.user_id, device_id = excluded.device_id, profile_id = excluded.profile_id,
         p256dh = excluded.p256dh, auth = excluded.auth, broadcast = coalesce($7::boolean, push_subscriptions.broadcast), fail_count = 0 returning broadcast`,
      [req.user!.id, deviceId, req.profile!.id, b.endpoint, b.keys.p256dh, b.keys.auth, b.broadcast ?? null],
    );
    return { ok: true, broadcast: r.rows[0]!.broadcast };
  });

  app.post('/api/push/unsubscribe', pre, async (req) => {
    const b = endpointBody.parse(req.body);
    await ctx.db.query('delete from push_subscriptions where endpoint = $1 and user_id = $2', [b.endpoint, req.user!.id]);
    return { ok: true };
  });

  app.post('/api/push/test', { ...grown, config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!pushEnabled(ctx.cfg)) return reply.code(404).send({ error: 'push_disabled' });
    const b = endpointBody.parse(req.body);
    const own = await ctx.db.query('select 1 from push_subscriptions where endpoint = $1 and user_id = $2', [b.endpoint, req.user!.id]);
    if (!own.rowCount) return reply.code(404).send({ error: 'not_found' });
    const [status] = await sendWebPush(ctx, {
      userId: req.user!.id, kind: 'push_test', title: 'FriendFlix',
      body: m(req.profile!.is_owner ? 'push.testOk' : 'push.generic'), link: '/settings',
    }, { endpoint: b.endpoint });
    return { sent: status != null && status >= 200 && status < 300, ...(status != null ? { status } : {}) };
  });
}
