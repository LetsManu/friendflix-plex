import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { CAST_TOKEN_RE, resolveCast } from '../cast.js';
import type { Ctx } from '../ctx.js';
import { authorizeDownload } from '../downloads.js';
import { clearLive, setLive } from '../live.js';
import { jfUserFor, resolveProfile } from '../profiles.js';
import { effectiveRole } from '../roles.js';
import { loadSession } from '../session.js';
import { mediaBrowserHeader } from '../jellyfin/client.js';
import { upstreamUri } from '../mediapath.js';
import { authzNginx } from '../metrics.js';
import { getUserById } from '../users.js';
import { fireEpisode, fireTmdb } from '../reminders.js';
import type { UserRow } from '../types.js';

const normId = (s: string) => s.replace(/-/g, '').toLowerCase();
const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const checkSecret = (req: FastifyRequest, header: string, secret: string) => eq(String(req.headers[header] ?? ''), secret);

/** Jellyfin webhook plugin template (documented in README); values arrive as strings. */
const jfWebhook = z.object({
  type: z.string(),
  user: z.string().optional(),
  itemId: z.string().transform(normId).optional(),
  name: z.string().optional(),
  seriesName: z.string().optional(),
  positionTicks: z.coerce.number().optional(),
  runtimeTicks: z.coerce.number().optional(),
  isPaused: z.union([z.boolean(), z.string()]).optional(),
  deviceName: z.string().optional(),
  itemType: z.string().optional(),
  provider_tmdb: z.union([z.string(), z.number()]).optional(),
  /** ItemAdded Episode: lets "Erinnere mich" match a replaced placeholder episode by series + season + number */
  seriesId: z.string().transform(normId).optional(),
  seasonNumber: z.union([z.string(), z.number()]).optional(),
  episodeNumber: z.union([z.string(), z.number()]).optional(),
});

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
};

export function internalRoutes(app: FastifyInstance, ctx: Ctx) {
  async function lookup(sid: string): Promise<MediaAuth | null> {
    const s = await loadSession(ctx, sid);
    if (!s || !s.deviceApproved) return null;
    const user = await getUserById(ctx, s.userId);
    // unknown (removed) role: fall back to the least privileged template ('guest'); none -> deny
    const role = (user ? await effectiveRole(ctx, user.role) : undefined) ?? (await effectiveRole(ctx, 'guest')); // admin overrides (Admin → Rollen) apply to media too
    const prof = user && !user.disabled ? await resolveProfile(ctx, user, s) : null; // no profile chosen yet (owner PIN) -> deny
    if (!user || !prof || !role) return null;
    const jfUser = jfUserFor(user, prof);
    return { userId: user.id, token: await ctx.jf.token(jfUser), deviceId: ctx.jf.deviceId(jfUser), maxBitrate: role.maxBitrate, canDownload: role.download || ctx.cfg.DIRECT_PLAY_REQUIRES_DOWNLOAD !== 'true', ...(role.maxHeight ? { maxHeight: role.maxHeight } : {}) };
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
      .header('X-Jellyfin-Auth', mediaBrowserHeader({ deviceId: a.deviceId, token: a.token }))
      .header('Cache-Control', 'no-store')
      .code(204)
      .send();
  });

  app.post('/internal/webhook/jellyfin', async (req, reply) => {
    if (!checkSecret(req, 'x-webhook-secret', ctx.cfg.WEBHOOK_SECRET)) return reply.code(403).send({ error: 'forbidden' });
    const b = jfWebhook.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const e = b.data;
    if (e.type === 'ItemAdded' && e.itemId) {
      // "Erinnere mich": a title or episode just arrived in the library
      const tmdb = Number(e.provider_tmdb);
      if ((e.itemType === 'Movie' || e.itemType === 'Series') && Number.isInteger(tmdb) && tmdb > 0) await fireTmdb(ctx, e.itemType === 'Movie' ? 'movie' : 'tv', tmdb, e.itemId);
      else if (e.itemType === 'Episode') {
        const num = (v: string | number | undefined) => (v !== undefined && v !== '' && Number.isInteger(Number(v)) ? Number(v) : undefined);
        const sid = e.seriesId && /^[0-9a-f]{32}$/.test(e.seriesId) ? e.seriesId : undefined;
        await fireEpisode(ctx, { itemId: e.itemId, seriesId: sid, season: num(e.seasonNumber), episode: num(e.episodeNumber) });
      }
      return { ok: true };
    }
    if (!e.user || !e.itemId) return { ok: true };
    const r = await ctx.db.query<UserRow>('select * from users where lower(jellyfin_username)=lower($1)', [e.user]);
    const user = r.rows[0];
    if (!user) return { ok: true };
    // played state / resume position changed outside the portal: drop memoised items and dependent caches of that Jellyfin user
    if (e.type === 'PlaybackStop' || e.type === 'PlaybackStart' || e.type === 'PlaybackProgress') await ctx.jf.touchUserData(user.jellyfin_user_id);
    const ps = `wh-${(e.deviceName ?? 'dev').replace(/[^\w]/g, '').slice(0, 24)}`;
    if (e.type === 'PlaybackStop') await clearLive(ctx, user.id, ps);
    else if (e.type === 'PlaybackStart' || e.type === 'PlaybackProgress') {
      await setLive(ctx, {
        userId: user.id, userName: user.name, itemId: e.itemId, title: e.name ?? '', seriesName: e.seriesName,
        positionTicks: e.positionTicks ?? 0, runtimeTicks: e.runtimeTicks, isPaused: e.isPaused === true || e.isPaused === 'True' || e.isPaused === 'true',
        playSessionId: ps, updatedAt: Date.now(), source: 'jellyfin',
      });
    }
    return { ok: true };
  });
}

/** Fallback when the webhook plugin is not installed: poll GET /Sessions (every 10 s). */
export async function pollJellyfinSessions(ctx: Ctx) {
  const sessions = await ctx.jf.client.sessions();
  const active = sessions.filter((s) => s.NowPlayingItem && !String(s.DeviceId ?? '').startsWith('ff-'));
  if (!active.length) return;
  const r = await ctx.db.query<UserRow>('select * from users where jellyfin_user_id = any($1)', [active.map((s) => s.UserId)]);
  const byJf = new Map(r.rows.map((u) => [u.jellyfin_user_id.replace(/-/g, ''), u]));
  for (const s of active) {
    const u = byJf.get(String(s.UserId).replace(/-/g, ''));
    if (!u) continue;
    const it = s.NowPlayingItem;
    await setLive(ctx, {
      userId: u.id, userName: u.name, itemId: it.Id, title: it.Name, seriesName: it.SeriesName, type: it.Type,
      positionTicks: s.PlayState?.PositionTicks ?? 0, runtimeTicks: it.RunTimeTicks, isPaused: Boolean(s.PlayState?.IsPaused),
      playSessionId: `jf-${s.Id}`, updatedAt: Date.now(), source: 'jellyfin',
    }, 25);
  }
}
