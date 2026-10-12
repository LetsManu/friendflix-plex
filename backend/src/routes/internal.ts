import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { CAST_TOKEN_RE, resolveCast } from '../cast.js';
import type { Ctx } from '../ctx.js';
import { authorizeDownload } from '../downloads.js';
import { setLive } from '../live.js';
import { dispatchMediaEvent } from '../media/events.js';
import { MediaError } from '../media/types.js';
import { jfUserFor, resolveProfile } from '../profiles.js';
import { effectiveRole } from '../roles.js';
import { loadSession } from '../session.js';
import { upstreamUri } from '../mediapath.js';
import { authzNginx } from '../metrics.js';
import { getUserById } from '../users.js';
import type { UserRow } from '../types.js';

const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const checkSecret = (req: FastifyRequest, header: string, secret: string) => eq(String(req.headers[header] ?? ''), secret);

interface MediaAuth {
  userId: string;
  token: string;
  deviceId: string;
  maxBitrate: number;
  /** role resolution cap; the gateway clamps MaxHeight/MaxWidth/Height/Width query params to it */
  maxHeight?: number;
  /** role may download: without it (or with a height cap) the gateway refuses direct /stream requests */
  canDownload: boolean;
}

/** Session -> Jellyfin credentials for media requests. Short memo (5 s) keeps per-segment auth cheap. */
const memo = new Map<string, { exp: number; v: MediaAuth | null }>();
/** Single flight: concurrent lookups of one session (a burst of image requests after the memo expired) share one DB/Redis pass. */
const inflight = new Map<string, Promise<MediaAuth | null>>();
/** Drops the memoised credentials of a session (profile switch / revoke) so the gateway never serves the previous profile's token. */
export const forgetAuth = (sid: string) => {
  memo.delete(sid);
  inflight.delete(sid); // a lookup still running for the old profile must neither be joined nor stored
  for (const k of [...itemMemo.keys()]) if (k.startsWith(`${sid}|`)) itemMemo.delete(k);
};

/** /internal/authz/item answers per session + item (5 s; errors are never memoised). */
const ITEM_MEMO_MS = 5_000;
const itemMemo = new Map<string, { exp: number; v: boolean }>();

export function internalRoutes(app: FastifyInstance, ctx: Ctx) {
  /** The session's account, role and media server identity (active profile); null = no usable session. */
  async function sessionIdentity(sid: string) {
    const s = await loadSession(ctx, sid);
    if (!s || !s.deviceApproved) return null;
    const user = await getUserById(ctx, s.userId);
    // unknown (removed) role: fall back to the least privileged template ('guest'); none -> deny
    const role = (user ? await effectiveRole(ctx, user.role) : undefined) ?? (await effectiveRole(ctx, 'guest')); // admin overrides (Admin → Rollen) apply to media too
    const prof = user && !user.disabled ? await resolveProfile(ctx, user, s) : null; // no profile chosen yet (owner PIN) -> deny
    if (!user || !prof || !role) return null;
    return { user, role, jfUser: jfUserFor(user, prof) };
  }

  async function lookup(sid: string): Promise<MediaAuth | null> {
    const id = await sessionIdentity(sid);
    if (!id) return null;
    const { user, role, jfUser } = id;
    return { userId: user.id, ...(await ctx.jf.mediaAuth(jfUser)), maxBitrate: role.maxBitrate, canDownload: role.download || ctx.cfg.DIRECT_PLAY_REQUIRES_DOWNLOAD !== 'true', ...(role.maxHeight ? { maxHeight: role.maxHeight } : {}) };
  }

  /** Errors (DB/Redis/Jellyfin down) propagate and are never memoised: the next request retries. */
  async function mediaAuth(sid: string): Promise<MediaAuth | null> {
    const hit = memo.get(sid);
    if (hit && hit.exp > Date.now()) return hit.v;
    const running = inflight.get(sid);
    if (running) return running;
    const p: Promise<MediaAuth | null> = lookup(sid).then((v) => {
      if (inflight.get(sid) === p) { // not forgotten (profile switch / logout) meanwhile
        memo.set(sid, { exp: Date.now() + (v ? 5_000 : 2_000), v });
        if (memo.size > 5000) memo.clear();
      }
      return v;
    }).finally(() => {
      if (inflight.get(sid) === p) inflight.delete(sid);
    });
    inflight.set(sid, p);
    return p;
  }

  // Used by the gateway only (never routed by NPM). Returns the Jellyfin token of the session owner.
  // Accepts {sid} (browser session cookie) or {ct} (Chromecast token, scoped: the answer carries `scope`). The body is never logged;
  // rate limiting is off (one call per gateway cache miss; the gateway rate-limits failed cast auth itself).
  app.post('/internal/authz', { config: { rateLimit: false } }, async (req, reply) => {
    if (!checkSecret(req, 'x-internal-secret', ctx.cfg.INTERNAL_SECRET)) return reply.code(403).send({ error: 'forbidden' });
    const body = z.union([
      z.object({ sid: z.string().regex(/^[\w-]{20,80}$/) }).strict(),
      // client = address the gateway derived for the caller (X-Real-IP / last XFF): the first one to use a token pins it
      z.object({ ct: z.string().regex(CAST_TOKEN_RE), client: z.string().min(1).max(64) }).strict(),
      // offline download licence (gateway /media/d/<uuid>): same session checks as {sid}, plus the licence itself
      z.object({ sid: z.string().regex(/^[\w-]{20,80}$/), dl: z.string().uuid() }).strict(),
    ]).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    if ('dl' in body.data) {
      // 401 = no valid session / device / profile, 404 = licence not usable by this session (unknown, other device, expired, revoked, role)
      const a = await mediaAuth(body.data.sid);
      if (!a) return reply.code(401).send({ error: 'unauthenticated' });
      const session = await loadSession(ctx, body.data.sid);
      const user = session ? await getUserById(ctx, session.userId) : undefined;
      if (!session || !user || user.disabled) return reply.code(401).send({ error: 'unauthenticated' });
      const prof = await resolveProfile(ctx, user, session); // licenses belong to a profile: only that profile's session may fetch them
      if (!prof) return reply.code(401).send({ error: 'unauthenticated' });
      const download = await authorizeDownload(ctx, session, user, prof.id, body.data.dl.toLowerCase());
      return download ? { ...a, download } : reply.code(404).send({ error: 'not_found' });
    }
    const a = 'ct' in body.data ? await resolveCast(ctx, body.data.ct, body.data.client) : await mediaAuth(body.data.sid);
    return a ?? reply.code(401).send({ error: 'unauthenticated' });
  });

  /**
   * Plan B: nginx `auth_request` for /media/ (see deploy/npm/plan-b-auth-request.conf).
   * nginx sends the browser cookie + original URI + the shared secret; we answer with headers only:
   *   X-Jellyfin-Uri  = validated, sanitized upstream URI (nginx must use exactly this)
   *   X-Jellyfin-Auth = Authorization header carrying the user's Jellyfin token (never sent to the browser)
   * 401 = not logged in / device pending / disabled, 403 = bad secret or path not allowed.
   */
  app.get('/internal/authz-nginx', { config: { rateLimit: false } }, async (req, reply) => {
    if (!checkSecret(req, 'x-internal-secret', ctx.cfg.INTERNAL_SECRET)) {
      authzNginx.inc({ result: 'bad_secret' });
      return reply.code(403).send();
    }
    const sid = req.cookies.ff_sid;
    if (!sid || !/^[\w-]{20,80}$/.test(sid)) {
      authzNginx.inc({ result: 'no_session' });
      return reply.code(401).send();
    }
    const a = await mediaAuth(sid);
    if (!a) {
      authzNginx.inc({ result: 'unauthenticated' });
      return reply.code(401).send();
    }
    const uri = upstreamUri(String(req.headers['x-original-uri'] ?? ''), a.maxBitrate, a.maxHeight, a.canDownload);
    if (!uri) {
      authzNginx.inc({ result: 'path_denied' });
      return reply.code(403).send();
    }
    authzNginx.inc({ result: 'ok' });
    return reply
      .header('X-Jellyfin-Uri', uri)
      .header('X-Jellyfin-Auth', ctx.jf.planBAuthHeader(a))
      .header('Cache-Control', 'no-store')
      .code(204)
      .send();
  });

  /**
   * Per-item access for upstreams that authenticate with one server-wide token (gateway Upstream.authorize hook): may this session's
   * active profile see the item? Same visibility as the API (ctx.jf.item as that profile). 200 {allow}, 401 = no usable session.
   */
  app.post('/internal/authz/item', { config: { rateLimit: false } }, async (req, reply) => {
    if (!checkSecret(req, 'x-internal-secret', ctx.cfg.INTERNAL_SECRET)) return reply.code(403).send({ error: 'forbidden' });
    const b = z.object({
      sid: z.string().regex(/^[\w-]{20,80}$/),
      itemId: z.string().regex(/^[0-9a-f]{32}$/),
      kind: z.enum(['media', 'image', 'subtitle']).default('media'),
    }).strict().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const key = `${b.data.sid}|${b.data.itemId}`; // visibility does not depend on the kind
    const hit = itemMemo.get(key);
    if (hit && hit.exp > Date.now()) return { allow: hit.v };
    const id = await sessionIdentity(b.data.sid);
    if (!id) return reply.code(401).send({ error: 'unauthenticated' });
    let allow: boolean;
    try {
      await ctx.jf.item(id.jfUser, b.data.itemId);
      allow = true;
    } catch (e) {
      if (!(e instanceof MediaError) || ![400, 403, 404].includes(e.status)) throw e; // server trouble: 500/502, not memoised
      allow = false;
    }
    itemMemo.set(key, { exp: Date.now() + ITEM_MEMO_MS, v: allow });
    if (itemMemo.size > 5000) itemMemo.clear();
    return { allow };
  });

  // Webhooks of the configured server (Jellyfin: /internal/webhook/jellyfin), translated into neutral events by the implementation.
  if (ctx.jf.webhookEvents) {
    const translate = ctx.jf.webhookEvents.bind(ctx.jf);
    app.post(`/internal/webhook/${ctx.jf.kind}`, async (req, reply) => {
      if (!checkSecret(req, 'x-webhook-secret', ctx.cfg.WEBHOOK_SECRET)) return reply.code(403).send({ error: 'forbidden' });
      const events = translate(req.body);
      if (!events) return reply.code(400).send({ error: 'bad_request' });
      for (const e of events) await dispatchMediaEvent(ctx, e);
      return { ok: true };
    });
  }
}

/** Fallback when the webhook plugin is not installed: poll GET /Sessions (every 10 s). */
export async function pollJellyfinSessions(ctx: Ctx) {
  const active = await ctx.jf.admin.externalSessions();
  if (!active.length) return;
  const r = await ctx.db.query<UserRow>('select * from users where jellyfin_user_id = any($1)', [active.map((s) => s.serverUserId)]);
  const byJf = new Map(r.rows.map((u) => [u.jellyfin_user_id.replace(/-/g, ''), u]));
  for (const s of active) {
    const u = byJf.get(s.serverUserId.replace(/-/g, ''));
    if (!u) continue;
    const it = s.item;
    await setLive(ctx, {
      userId: u.id, userName: u.name, itemId: it.id, title: it.name, seriesName: it.seriesName, type: it.type,
      positionTicks: s.positionTicks, runtimeTicks: it.runtimeTicks, isPaused: s.isPaused,
      playSessionId: `jf-${s.sessionId}`, updatedAt: Date.now(), source: 'jellyfin',
    }, 25);
  }
}
