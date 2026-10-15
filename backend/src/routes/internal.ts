// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { CAST_TOKEN_RE, resolveCast } from '../cast.js';
import type { Ctx } from '../ctx.js';
import { authorizeDownload } from '../downloads.js';
import { setLive } from '../live.js';
import { dispatchMediaEvent } from '../media/events.js';
import { mediaUrlKey } from '../media/index.js';
import { MediaError, type ExternalSession } from '../media/types.js';
import { effectiveLimits } from '../limits.js';
import { jfUserFor, resolveProfile } from '../profiles.js';
import { isHomeAddress } from '../netaddr.js';
import { effectiveRole, remoteBitrateCap } from '../roles.js';
import { loadSession } from '../session.js';
import { upstreamUri } from '../mediapath.js';
import { authzNginx } from '../metrics.js';
import { getUserById } from '../users.js';
import type { UserRow } from '../types.js';
import { appDeviceId, countStreamOnce, methodOf } from '../playstats.js';

const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** An empty secret (WEBHOOK_SECRET is unset until it is generated) never matches, also not a missing or empty header. */
export const checkSecret = (req: FastifyRequest, header: string, secret: string) => secret.length > 0 && eq(String(req.headers[header] ?? ''), secret);

interface MediaAuth {
  userId: string;
  token: string;
  deviceId: string;
  maxBitrate: number;
  /** bit/s outside the home networks (applied per request from the caller's ip; never part of the answer) */
  remoteMaxBitrate?: number;
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

/** Answer for the gateway: remoteMaxBitrate is internal; for a remote caller it lowers maxBitrate. */
function withoutRemoteCap(a: MediaAuth | null, remote = false): Omit<MediaAuth, 'remoteMaxBitrate'> | null {
  if (!a) return null;
  const { remoteMaxBitrate, ...rest } = a;
  return remote && remoteMaxBitrate ? { ...rest, maxBitrate: Math.min(rest.maxBitrate, remoteMaxBitrate) } : rest;
}

/** /internal/authz/item answers per session + item (5 s; errors are never memoised). */
const ITEM_MEMO_MS = 5_000;
const itemMemo = new Map<string, { exp: number; v: boolean }>();

export function internalRoutes(app: FastifyInstance, ctx: Ctx) {
  /** The settings revision on every authenticated authz answer: the gateway refetches /internal/gateway-config when it moves. */
  const withRev = (reply: FastifyReply) => reply.header('x-ff-config-rev', String(ctx.settings.rev()));
  let planBWarned = false; // the "Plan B unsupported" error is logged once per process, not per request
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
    const { user, jfUser } = id;
    // per-user overrides (remote cap) on top of the role; an unknown role keeps the guest fallback without overrides
    const role = (await effectiveLimits(ctx, user)) ?? id.role;
    return { userId: user.id, ...(await ctx.jf.mediaAuth(jfUser)), maxBitrate: role.maxBitrate, remoteMaxBitrate: remoteBitrateCap(role), canDownload: role.download || ctx.cfg.DIRECT_PLAY_REQUIRES_DOWNLOAD !== 'true', ...(role.maxHeight ? { maxHeight: role.maxHeight } : {}) };
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
    withRev(reply);
    const body = z.union([
      // ip = address the gateway derived for the caller (same rule as `client`): outside HOME_NETWORKS the role's remote cap lowers maxBitrate
      z.object({ sid: z.string().regex(/^[\w-]{20,80}$/), ip: z.string().min(1).max(64).optional() }).strict(),
      // client = address the gateway derived for the caller (X-Real-IP / last XFF): the first one to use a token pins it
      z.object({ ct: z.string().regex(CAST_TOKEN_RE), client: z.string().min(1).max(64) }).strict(),
      // offline download licence (gateway /media/d/<uuid>): same session checks as {sid}, plus the licence itself
      z.object({ sid: z.string().regex(/^[\w-]{20,80}$/), dl: z.string().uuid() }).strict(),
    ]).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    if ('dl' in body.data) {
      // 401 = no valid session / device / profile, 404 = licence not usable by this session (unknown, other device, expired, revoked, role)
      const a = withoutRemoteCap(await mediaAuth(body.data.sid));
      if (!a) return reply.code(401).send({ error: 'unauthenticated' });
      const session = await loadSession(ctx, body.data.sid);
      const user = session ? await getUserById(ctx, session.userId) : undefined;
      if (!session || !user || user.disabled) return reply.code(401).send({ error: 'unauthenticated' });
      const prof = await resolveProfile(ctx, user, session); // licenses belong to a profile: only that profile's session may fetch them
      if (!prof) return reply.code(401).send({ error: 'unauthenticated' });
      const download = await authorizeDownload(ctx, session, user, prof.id, body.data.dl.toLowerCase());
      return download ? { ...a, download } : reply.code(404).send({ error: 'not_found' });
    }
    if ('ct' in body.data) return (await resolveCast(ctx, body.data.ct, body.data.client)) ?? reply.code(401).send({ error: 'unauthenticated' });
    const m = await mediaAuth(body.data.sid);
    if (!m) return reply.code(401).send({ error: 'unauthenticated' });
    // no ip (an older gateway, or one that cannot tell) is ambiguous = remote
    const remote = body.data.ip === undefined || !isHomeAddress(body.data.ip, ctx.cfg.HOME_NETWORKS);
    return withoutRemoteCap(m, remote);
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
    withRev(reply);
    if (!ctx.jf.capabilities.planB) {
      // a server without Plan B support (capabilities.planB): refuse clearly instead of failing somewhere inside planBAuthHeader()
      authzNginx.inc({ result: 'unsupported' });
      if (!planBWarned) {
        planBWarned = true;
        req.log.error(`Plan B (nginx auth_request) is not supported with MEDIA_SERVER=${ctx.jf.kind}: route /media/ through the gateway (deploy/npm/portal.advanced.conf)`);
      }
      return reply.code(501).send({ error: 'plan_b_unsupported', kind: ctx.jf.kind });
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
    withRev(reply);
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

  /**
   * The gateway's configuration (it has no database): the media server URL from the live settings plus the settings revision it belongs
   * to. 503 setup_required while the URL is empty; the gateway keeps retrying and answers /media/* with 503 until then.
   */
  app.get('/internal/gateway-config', { config: { rateLimit: false } }, async (req, reply) => {
    if (!checkSecret(req, 'x-internal-secret', ctx.cfg.INTERNAL_SECRET)) return reply.code(403).send({ error: 'forbidden' });
    const rev = ctx.settings.rev(); // same snapshot as ctx.cfg (both read synchronously)
    const cfg = ctx.cfg;
    const url = (cfg as unknown as Record<string, unknown>)[mediaUrlKey(cfg)];
    reply.header('cache-control', 'no-store');
    if (typeof url !== 'string' || !url) return reply.code(503).send({ error: 'setup_required' });
    return { rev, upstreamUrl: url };
  });

  // Webhooks of the configured server (Jellyfin: /internal/webhook/jellyfin), translated into neutral events by the implementation.
  if (ctx.jf.webhookEvents) {
    app.post(`/internal/webhook/${ctx.jf.kind}`, async (req, reply) => {
      if (!checkSecret(req, 'x-webhook-secret', ctx.cfg.WEBHOOK_SECRET)) return reply.code(403).send({ error: 'forbidden' });
      const events = ctx.jf.webhookEvents?.(req.body); // the current instance (rebuilt when the media settings change)
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
  const jfIds = active.map((s) => s.serverUserId);
  const r = await ctx.db.query<UserRow>('select * from users where jellyfin_user_id = any($1)', [jfIds]);
  const byJf = new Map(r.rows.map((u) => [u.jellyfin_user_id.replace(/-/g, ''), u]));
  // Block 22: a profile's own server identity counts for its account (usage sums profiles into the account)
  const p = await ctx.db.query<{ jf: string; user_id: string }>(
    `select replace(lower(jellyfin_user_id), '-', '') jf, user_id from profiles
      where not is_owner and jellyfin_user_id is not null and replace(lower(jellyfin_user_id), '-', '') = any($1)`,
    [jfIds.map((id) => id.replace(/-/g, '').toLowerCase())],
  );
  const profileOwner = new Map(p.rows.map((x) => [x.jf, x.user_id]));
  for (const s of active) {
    const jf = s.serverUserId.replace(/-/g, '');
    const u = byJf.get(jf);
    const accountId = u?.id ?? profileOwner.get(jf.toLowerCase());
    if (!accountId) continue;
    const it = s.item;
    await countForeignStream(ctx, accountId, s).catch(() => undefined);
    if (!u) continue;
    await setLive(ctx, {
      userId: u.id, userName: u.name, itemId: it.id, title: it.name, seriesName: it.seriesName, type: it.type,
      positionTicks: s.positionTicks, runtimeTicks: it.runtimeTicks, isPaused: s.isPaused,
      playSessionId: `jf-${s.sessionId}`, updatedAt: Date.now(), source: 'jellyfin',
    }, 25);
  }
}

/**
 * Block 22: a foreign app's stream counts once for its account (device = the app's name, never the title). The server
 * fills the transcode reasons only after the encoder reported: a transcode first seen without reasons waits one poll, so
 * it is not counted as remux for good.
 */
async function countForeignStream(ctx: Ctx, userId: string, s: ExternalSession) {
  const key = `jf-${s.sessionId}:${s.item.id}`;
  if (s.playMethod === 'Transcode' && !s.reasons?.length && (await ctx.kv.setnx(`pstat:wait:${userId}:${key}`, '1', 600))) return;
  const method = methodOf(s.playMethod, s.reasons?.[0]);
  await countStreamOnce(ctx, userId, key, appDeviceId(s.client), method, method === 'transcode' ? s.reasons?.[0] : undefined);
}
