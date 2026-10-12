import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from './ctx.js';
import { clientErrorsTotal } from './metrics.js';
import { loadSession } from './session.js';

/** Browser error report as sent by web/src/lib/telemetry.ts (sendBeacon, text/plain JSON). */
export const clientErrorBody = z.object({
  message: z.string().max(500),
  stack: z.string().max(4000).optional(),
  url: z.string().max(500),
  userAgent: z.string().max(300),
  kind: z.enum(['error', 'unhandledrejection', 'resource']),
  release: z.string().max(40).optional(),
});
export type ClientErrorBody = z.infer<typeof clientErrorBody>;

const HOURLY_LIMIT = 200;

/** Path only: no origin, no query string, no hash (those can carry tokens or search terms). */
export function pathOnly(raw: string): string {
  let p = raw.trim();
  try { p = new URL(p, 'http://x').pathname; } catch { p = p.split(/[?#]/)[0] ?? ''; }
  return p.slice(0, 500);
}

/**
 * Removes anything that looks like a credential or personal data from free text (messages, stacks, user agents):
 * query strings, token-like key=value pairs, bearer / JWT values, long opaque tokens and e-mail addresses.
 * 32-hex Jellyfin ids are kept on purpose (useful to find the broken title, not secret).
 */
export function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, '[jwt]')
    .replace(/\?[\w%.~+-]*=[^\s)'"\]]*/g, '?[query]') // ?a=b&c=d (a bare "?" or optional chaining like a?.b stays)
    .replace(/\b(token|access_token|id_token|refresh_token|code|key|api_key|apikey|secret|password|pwd|auth|sid|session)=[^\s&)'"\]]+/gi, '$1=[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[token]');
}

/** The structured record that is logged (never stored). */
export function toLogEntry(b: ClientErrorBody) {
  return {
    kind: b.kind,
    message: scrub(b.message).replace(/\s+/g, ' ').trim(),
    stack: b.stack ? scrub(b.stack) : undefined,
    url: scrub(pathOnly(b.url)),
    userAgent: scrub(b.userAgent),
    release: b.release,
  };
}

/**
 * POST /api/client-errors: unauthenticated on purpose (errors happen on the login / offline pages too).
 * sendBeacon cannot set an x-csrf-token header, so the route is exempt from the CSRF check like /api/tv/code: it has
 * no ambient authority, writes nothing and is rate limited (20/min per IP, 200/h per user or IP).
 */
export function clientErrorRoutes(app: FastifyInstance, ctx: Ctx) {
  const origin = new URL(ctx.cfg.PUBLIC_URL).origin;
  app.post('/api/client-errors', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const o = req.headers.origin;
    if (typeof o === 'string' && o !== origin) return reply.code(403).send({ error: 'forbidden_origin' });

    // sendBeacon posts text/plain (no CORS preflight); fetch fallbacks and tests may send application/json
    let raw: unknown = req.body;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { return reply.code(400).send({ error: 'bad_request' }); }
    }
    const parsed = clientErrorBody.safeParse(raw);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues.map((i) => i.path.join('.')) });

    const sess = await loadSession(ctx, req.cookies.ff_sid).catch(() => null);
    const who = sess?.userId ? `u:${sess.userId}` : `ip:${req.ip}`;
    if ((await ctx.kv.incr(`clienterr:h:${who}`, 3600)) > HOURLY_LIMIT) return reply.code(429).send({ error: 'rate_limited' });

    const entry = toLogEntry(parsed.data);
    clientErrorsTotal.inc({ kind: entry.kind });
    req.log.warn({ clientError: entry }, 'client error');
    return reply.code(204).send();
  });
}
