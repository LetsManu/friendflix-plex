// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import type { Ctx } from './ctx.js';
import { compressJson } from './compress.js';
import { newTimingStore, serverTimingHeader, timedDb, timedKv, timingStorage, timingSummary, type TimingStore } from './timing.js';
import { metricsPlugin } from './metrics.js';
import { recordError } from './errorlog.js';
import { HttpError } from './users.js';
import { accountRoutes } from './routes/account.js';
import { accountSecurityRoutes } from './routes/accountSecurity.js';
import { adminRoutes, inviteRoutes } from './routes/admin.js';
import { adminSettingsRoutes } from './routes/adminSettings.js';
import { adminUserRoutes } from './routes/adminUsers.js';
import { authRoutes } from './routes/auth.js';
import { authFlowRoutes } from './routes/authFlow.js';
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
import { setupRoutes } from './routes/setup.js';
import { statsRoutes } from './routes/stats.js';
import { publicArtRoutes } from './routes/publicArt.js';
import { tvRoutes } from './routes/tv.js';
import { clientErrorRoutes } from './clientErrors.js';
import { recoRoutes } from './routes/reco.js';
import { playbackTimingRoutes } from './playtiming.js';
import { mediaRoutes } from './routes/media.js';
import { socialRoutes } from './routes/social.js';
import { reactionRoutes } from './routes/reactions.js';
import { trendingRoutes } from './routes/trending.js';
import { hubRoutes } from './routes/hubs.js';
import { homeRoutes } from './routes/home.js';
import { animeRoutes } from './routes/anime.js';
import { sourceRoutes } from './routes/sources.js';
import { aboutRoutes } from './routes/about.js';
import { healthRoutes } from './routes/health.js';
import { hygieneRoutes } from './routes/hygiene.js';
import { usageRoutes } from './routes/usage.js';
import { SettingsError } from './settings/store.js';
import { hasSetupSession } from './setup/code.js';
import { isSetupComplete, SETUP_EXPIRED } from './setup/state.js';
import { syncFileKeys } from './sources/keys.js';
import { testSourceKey } from './sources/omdb.js';
import { appVersion } from './version.js';

export interface Extra {
  /** Additional route registrars for later steps. */
  register?: Array<(app: FastifyInstance, ctx: Ctx) => void | Promise<void>>;
  /** tests: capture the request log (production logs to stdout; tests are silent otherwise) */
  logger?: { stream: { write(line: string): void }; level?: string };
}

/** routes whose bodies hold secrets or one-time credentials (spec Part E3; the in-app sign-in's passwords and codes): never logged with an error */
const SENSITIVE_BODY = /^\/(api\/(setup\/|admin\/settings)|auth\/flow\/)/;

/**
 * What answers while setup is incomplete (spec Part E1, rulings D23): matched by the route pattern, so an unknown or encoded path is
 * gated too. /auth/login and /auth/callback additionally need a setup session (the first admin's sign-in).
 */
const SETUP_OPEN_GET: ReadonlySet<string> = new Set(['/health', '/api/version']);
const SETUP_OPEN: ReadonlySet<string> = new Set(['/internal/gateway-config']);
const SETUP_LOGIN: ReadonlySet<string> = new Set(['/auth/login', '/auth/callback']);

/**
 * State-changing /api routes that carry no session authority, by route pattern (never the raw url: `/%61pi/...` routes to `/api/...`).
 * - /api/invite/*: anonymous, token-protected
 * - /api/client-errors: the browser error beacon (sendBeacon cannot send the csrf header); no ambient authority, rate limited
 * - /api/tv/code, /api/tv/claim: anonymous, protected by the TV's own poll secret
 * - /api/restore: acts on the account named by the signed ff_restore cookie, never on a session (another account's live session in the
 *   same browser must not make it demand that session's token); JSON-only + SameSite + HMAC cookie protect it (routes/auth.ts)
 * - /api/setup/*: never acts on an account session; requireSetupSession checks its own token (x-ff-setup-csrf against the setup session
 *   and the ff_setup_csrf cookie). An admin's ff_sid next to an old ff_setup cookie must get 409 setup_complete, never this hook's 403.
 */
const CSRF_EXEMPT: ReadonlySet<string> = new Set(['/api/client-errors', '/api/tv/code', '/api/tv/claim', '/api/restore']);
const CSRF_EXEMPT_PREFIX = /^\/api\/(invite|setup)\//;
const MUTATING: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** requests slower than this are logged (info) with their jf/db/kv breakdown */
const SLOW_REQUEST_MS = 500;

export async function buildApp(ctx: Ctx, extra: Extra = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: extra.logger ?? process.env.NODE_ENV !== 'test', trustProxy: true, bodyLimit: 256 * 1024 });
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
    // a refused settings save: each key with its code (never a value)
    if (err instanceof SettingsError) return reply.code(400).send({ error: err.message, errors: err.errors });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    // a business error with a 5xx status (e.g. 503 authentik_unavailable): answered only when its message is a code,
    // so upstream text (URLs, bodies) never reaches the browser
    if (err instanceof HttpError) {
      const code = /^[a-z0-9_]{1,64}$/.test(err.message) ? err.message : 'internal';
      req.log.warn({ status: err.statusCode, error: code }, 'upstream error');
      return reply.code(err.statusCode).send({ error: code });
    }
    // the wizard's and Admin -> Settings' requests carry one-time admin credentials and secrets: the error is logged by its type and
    // code only (an error object may quote a request value), never with a body
    // matched against the route pattern (the path as Fastify decoded and routed it: `/%61uth/flow/…` is `/auth/flow/…`), never the raw
    // url; a request without a route is treated as sensitive too
    const route = req.routeOptions.url;
    if (route === undefined || SENSITIVE_BODY.test(route)) req.log.error({ err: { type: (err as Error).name, code: (err as { code?: unknown }).code } }, 'unhandled error');
    else req.log.error({ err }, 'unhandled error');
    if (process.env.DEBUG_TEST) console.error(err);
    return reply.code(500).send({ error: 'internal' });
  });
  // Security headers for API responses (the UI gets its own CSP from SvelteKit).
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin').header('X-Frame-Options', 'DENY');
    // same-origin unless a route opened itself up for the Chromecast receiver (/api/cast/subtitle)
    if (reply.getHeader('cross-origin-resource-policy') === undefined) reply.header('Cross-Origin-Resource-Policy', 'same-origin');
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
  // Block 22 error log: server errors by route pattern only (never req.url: ids and query strings must not form keys)
  app.addHook('onResponse', (req, reply, done) => {
    if (reply.statusCode >= 500) void recordError(ctx, { source: 'server', code: `${req.method} ${req.routeOptions.url ?? 'unmatched'} ${reply.statusCode}` });
    done();
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  await app.register(metricsPlugin, { ctx });

  // Setup mode: until setup completes, everything but the allow-list answers 503 setup_required (the web then opens /setup).
  // Cheap once complete: isSetupComplete is cached until the settings rev moves.
  app.addHook('onRequest', async (req, reply) => {
    const route = req.routeOptions.url;
    // the allow-list first: /health and the gateway's polls never wait for the setup state
    if (route !== undefined && (route.startsWith('/api/setup/') || SETUP_OPEN.has(route))) return;
    if (route !== undefined && SETUP_OPEN_GET.has(route) && (req.method === 'GET' || req.method === 'HEAD')) return;
    let open = false;
    try {
      open = (await isSetupComplete(ctx)) || (route !== undefined && SETUP_LOGIN.has(route) && (await hasSetupSession(ctx, req)));
    } finally {
      // a refused websocket upgrade (Node's own flag: an Upgrade header without Connection: upgrade is a plain request): this hook runs
      // before @fastify/websocket's own (which would destroy the socket on response), so the upgrade socket is closed here, also when a
      // check above throws (the error handler's 500); otherwise it stays open and holds up app.close()
      if (!open && (req.raw as { upgrade?: boolean }).upgrade === true) reply.raw.once('finish', () => req.raw.socket?.destroy());
    }
    if (open) return;
    // the sign-in routes are browser navigations: without a setup session (it ran out between login and callback, or the cookie was lost on
    // the way back from the IdP) they go to the wizard, which asks for the code again, instead of showing a JSON answer
    if (route !== undefined && SETUP_LOGIN.has(route) && req.method === 'GET') return reply.redirect(route === '/auth/callback' ? SETUP_EXPIRED : '/setup');
    return reply.code(503).send({ error: 'setup_required' });
  });

  // CSRF: every state-changing /api request must carry the per-session token. Decided by the route pattern (the path as Fastify decoded
  // and routed it); a request that matched no route gets the strictest branch (checked).
  app.addHook('preHandler', async (req, reply) => {
    if (!MUTATING.has(req.method)) return;
    const route = req.routeOptions.url;
    if (route !== undefined && (!route.startsWith('/api/') || CSRF_EXEMPT.has(route) || CSRF_EXEMPT_PREFIX.test(route))) return;
    const sid = req.cookies.ff_sid;
    const raw = sid ? await ctx.kv.get(`sess:${sid}`) : null;
    if (!raw) return; // unauthenticated -> route handler answers 401
    const want = Buffer.from((JSON.parse(raw) as { csrf: string }).csrf);
    const sent = Buffer.from(String(req.headers['x-csrf-token'] ?? ''));
    if (sent.length !== want.length || !timingSafeEqual(sent, want)) return reply.code(403).send({ error: 'csrf' });
  });

  app.get('/health', async () => ({ status: 'ok', version: ctx.cfg.GIT_SHA.slice(0, 7) }));
  // unauthenticated: the update page polls it while the backend restarts
  // public and harmless (the web footer shows the same): release version, codename, build sha
  app.get('/api/version', async () => ({ sha: ctx.cfg.GIT_SHA, ...appVersion(ctx.cfg) }));
  app.get('/health/ready', async (_req, reply) => {
    const checks: Record<string, boolean> = {
      redis: await ctx.kv.ping().catch(() => false),
      postgres: await ctx.db.query('select 1').then(() => true, () => false),
      jellyfin: await ctx.jf.admin.ping(),
    };
    const ok = Object.values(checks).every(Boolean);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', checks });
  });

  authRoutes(app, ctx);
  authFlowRoutes(app, ctx);
  publicArtRoutes(app, ctx);
  accountRoutes(app, ctx);
  accountSecurityRoutes(app, ctx);
  mediaRoutes(app, ctx);
  castRoutes(app, ctx);
  internalRoutes(app, ctx);
  adminRoutes(app, ctx);
  adminSettingsRoutes(app, ctx);
  setupRoutes(app, ctx);
  adminUserRoutes(app, ctx);
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
  recoRoutes(app, ctx);
  playbackTimingRoutes(app, ctx);
  reminderRoutes(app, ctx);
  listRoutes(app, ctx);
  pushRoutes(app, ctx);
  downloadRoutes(app, ctx);
  searchRoutes(app, ctx);
  socialRoutes(app, ctx);
  reactionRoutes(app, ctx);
  trendingRoutes(app, ctx);
  const hubs = hubRoutes(app, ctx);
  homeRoutes(app, ctx, hubs);
  animeRoutes(app, ctx);
  await syncFileKeys(ctx).catch(() => undefined); // a replaced TMDB/OMDb secret file lifts the old key's 1 h pause at once
  sourceRoutes(app, ctx, testSourceKey);
  aboutRoutes(app, ctx);
  healthRoutes(app, ctx);
  hygieneRoutes(app, ctx);
  usageRoutes(app, ctx);
  for (const r of extra.register ?? []) await r(app, ctx);
  return app;
}
