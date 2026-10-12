import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import type { Ctx } from './ctx.js';
import { compressJson } from './compress.js';
import { newTimingStore, serverTimingHeader, timedDb, timedKv, timingStorage, timingSummary, type TimingStore } from './timing.js';
import { metricsPlugin } from './metrics.js';
import { adminRoutes, inviteRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { castRoutes } from './routes/cast.js';
import { internalRoutes } from './routes/internal.js';
import { downloadRoutes } from './routes/downloads.js';
import { discoverRoutes } from './routes/discover.js';
import { digestRoutes } from './routes/digest.js';
import { listRoutes } from './routes/lists.js';
import { partyRoutes } from './routes/party.js';
import { profileRoutes } from './routes/profiles.js';
import { pushRoutes } from './routes/push.js';
import { prefsRoutes } from './routes/prefs.js';
import { pollRoutes } from './routes/polls.js';
import { reminderRoutes } from './routes/reminders.js';
import { sceneRoutes } from './routes/scenes.js';
import { searchRoutes } from './routes/search.js';
import { seerrRoutes } from './routes/seerr.js';
import { statsRoutes } from './routes/stats.js';
import { tvRoutes } from './routes/tv.js';
import { clientErrorRoutes } from './clientErrors.js';
import { mediaRoutes } from './routes/media.js';
import { socialRoutes } from './routes/social.js';
import { reactionRoutes } from './routes/reactions.js';
import { trendingRoutes } from './routes/trending.js';

export interface Extra {
  /** Additional route registrars for later steps. */
  register?: Array<(app: FastifyInstance, ctx: Ctx) => void | Promise<void>>;
}

/** requests slower than this are logged (info) with their jf/db/kv breakdown */
const SLOW_REQUEST_MS = 500;

export async function buildApp(ctx: Ctx, extra: Extra = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', trustProxy: true, bodyLimit: 256 * 1024 });
  // Server-Timing: Postgres and Redis calls are booked on the current request (Jellyfin: JellyfinClient). Same objects underneath.
  ctx.db = timedDb(ctx.db);
  ctx.kv = timedKv(ctx.kv);
  const timings = new WeakMap<object, TimingStore>();
  app.addHook('onRequest', (req, _reply, done) => {
    const store = newTimingStore();
    timings.set(req, store);
    timingStorage.run(store, done);
  });
  // body parsing may leave the async context of onRequest: re-enter it before the handler runs
  app.addHook('preValidation', (req, _reply, done) => {
    const store = timings.get(req);
    if (store) timingStorage.run(store, done);
    else done();
  });
  // Browsers send `content-type: application/json` with an empty body on body-less POST/DELETE (favorite, played,
  // watchlist ...). Fastify rejects that with 400 FST_ERR_CTP_EMPTY_JSON_BODY; treat it as "no body". Everything else
  // still goes through Fastify's own parser (prototype-poisoning protection included).
  const defaultJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === '' || body === undefined) return done(null, undefined);
    defaultJson(req, body as string, done);
  });
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request', issues: err.issues.map((i) => i.path.join('.')) });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error({ err }, 'unhandled error');
    if (process.env.DEBUG_TEST) console.error(err);
    return reply.code(500).send({ error: 'internal' });
  });
  // Security headers for API responses (the UI gets its own CSP from SvelteKit).
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin').header('X-Frame-Options', 'DENY')
      .header('Cross-Origin-Resource-Policy', 'same-origin');
    if (reply.getHeader('cache-control') === undefined) reply.header('Cache-Control', 'no-store');
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const store = timings.get(req);
    if (store) {
      reply.header('Server-Timing', serverTimingHeader(store));
      const sum = timingSummary(store);
      if (sum.totalMs >= SLOW_REQUEST_MS) req.log.info({ url: req.routeOptions.url ?? req.url.split('?')[0], method: req.method, status: reply.statusCode, ...sum }, 'slow request');
    }
    return ctx.cfg.API_COMPRESSION === 'false' ? payload : compressJson(req, reply, payload);
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  await app.register(metricsPlugin, { ctx });

  // CSRF: every state-changing /api request must carry the per-session token.
  app.addHook('preHandler', async (req, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !req.url.startsWith('/api/')) return;
    if (req.url.startsWith('/api/invite/')) return; // anonymous, token-protected
    if (req.url.startsWith('/api/client-errors')) return; // browser error beacon: sendBeacon cannot send the csrf header; no ambient authority, rate limited
    if (req.url.startsWith('/api/tv/code') || req.url.startsWith('/api/tv/claim')) return; // anonymous, protected by the TV's own poll secret (no ambient authority)
    const sid = req.cookies.ff_sid;
    const raw = sid ? await ctx.kv.get(`sess:${sid}`) : null;
    if (!raw) return; // unauthenticated -> route handler answers 401
    const want = Buffer.from((JSON.parse(raw) as { csrf: string }).csrf);
    const sent = Buffer.from(String(req.headers['x-csrf-token'] ?? ''));
    if (sent.length !== want.length || !timingSafeEqual(sent, want)) return reply.code(403).send({ error: 'csrf' });
  });

  app.get('/health', async () => ({ status: 'ok', version: ctx.cfg.GIT_SHA.slice(0, 7) }));
  // unauthenticated: the update page polls it while the backend restarts
  app.get('/api/version', async () => ({ sha: ctx.cfg.GIT_SHA }));
  app.get('/health/ready', async (_req, reply) => {
    const checks: Record<string, boolean> = {
      redis: await ctx.kv.ping().catch(() => false),
      postgres: await ctx.db.query('select 1').then(() => true, () => false),
      jellyfin: await ctx.jf.client.ping(),
    };
    const ok = Object.values(checks).every(Boolean);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', checks });
  });

  authRoutes(app, ctx);
  mediaRoutes(app, ctx);
  castRoutes(app, ctx);
  internalRoutes(app, ctx);
  adminRoutes(app, ctx);
  inviteRoutes(app, ctx);
  seerrRoutes(app, ctx);
  await partyRoutes(app, ctx);
  pollRoutes(app, ctx);
  statsRoutes(app, ctx);
  prefsRoutes(app, ctx);
  profileRoutes(app, ctx);
  discoverRoutes(app, ctx);
  digestRoutes(app, ctx);
  sceneRoutes(app, ctx);
  tvRoutes(app, ctx);
  clientErrorRoutes(app, ctx);
  reminderRoutes(app, ctx);
  listRoutes(app, ctx);
  pushRoutes(app, ctx);
  downloadRoutes(app, ctx);
  searchRoutes(app, ctx);
  socialRoutes(app, ctx);
  reactionRoutes(app, ctx);
  trendingRoutes(app, ctx);
  for (const r of extra.register ?? []) await r(app, ctx);
  return app;
}
