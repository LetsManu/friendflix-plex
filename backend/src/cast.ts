import { createHash, randomBytes } from 'node:crypto';
import type { Ctx } from './ctx.js';
import { jfUserFor, getProfile } from './profiles.js';
import { effectiveRole } from './roles.js';
import { setLive, getLive } from './live.js';
import { getUserById } from './users.js';

/**
 * Chromecast tokens ("ct"): opaque, short-lived, scoped credentials that live in the receiver's URL path
 * (/media/c/<ct>/...), because the Default Media Receiver cannot send cookies or headers.
 *
 * - The raw token only ever exists in the response of POST /api/cast/session and in the gateway's request path.
 *   Redis stores sha256(ct) only, so a Redis dump does not yield usable tokens.
 * - Each token is scoped to ONE item + media source + play session of ONE profile on ONE approved device.
 * - The first client address that uses a token pins it (castpin:<hash>); other addresses get 401. The TTL is sliding
 *   (CAST_IDLE_TTL, refreshed at most every CAST_TOUCH_MS) up to an absolute cap (record.exp).
 * - A second, image-only token (kind 'img') carries the poster URL: the poster is fetched by the receiver and may be
 *   shown/logged elsewhere, so it must not carry the media token.
 * - It must never be logged, put into metrics labels or error messages, or forwarded to Jellyfin.
 */
export const CAST_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const MAX_CAST_TOKENS = 2;
/** the Default Media Receiver decodes H.264 up to level 4.1 */
export const CAST_MAX_BITRATE = 20_000_000;
export const CAST_MAX_HEIGHT = 1080;
const MIN_TTL = 3600;
const MAX_TTL = 6 * 3600;
/** a token that was not used for this long expires (sliding), never beyond the absolute cap */
export const CAST_IDLE_TTL = 45 * 60;
/** record / TTL / live refresh happens at most this often per token (limits Redis writes; also keeps the 45 s live record alive) */
export const CAST_TOUCH_MS = 20_000;

export interface CastRecord {
  userId: string;
  profileId: string;
  deviceId: string;
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  maxBitrate: number;
  /** 'img' = poster-only token (default 'media') */
  kind?: 'media' | 'img';
  /** display title for the live record while no sender reports */
  title?: string;
  /** epoch ms, absolute cap */
  exp: number;
  createdAt: number;
  /** epoch ms of the last sliding refresh */
  seen?: number;
}

export interface CastAuth {
  userId: string;
  token: string;
  deviceId: string;
  maxBitrate: number;
  maxHeight: number;
  kind: 'media' | 'img';
  scope: { itemId: string; mediaSourceId: string; playSessionId: string };
}

export const hashToken = (ct: string) => createHash('sha256').update(ct).digest('hex');
const dataKey = (hash: string) => `cast:${hash}`;
const pinKey = (hash: string) => `castpin:${hash}`;
const idxKey = (userId: string, castId: string) => `castidx:${userId}:${castId}`;
/** public, non-secret handle of a token (cannot be turned back into the token) */
const castIdOf = (hash: string) => hash.slice(0, 32);

export const castEnabled = (ctx: Ctx) => ctx.cfg.CAST_ENABLED === 'true' && ctx.cfg.PUBLIC_URL.startsWith('https://');

/** 5 s memo of resolved tokens (keyed by hash + client): keeps per-segment auth cheap. Cleared on every revoke. */
const memo = new Map<string, { exp: number; v: CastAuth | null }>();

export const castTtlSeconds = (runtimeTicks: number | undefined, startTicks: number) => {
  const remaining = runtimeTicks ? Math.max(0, runtimeTicks - startTicks) / 10_000_000 : 0;
  return Math.min(MAX_TTL, Math.max(MIN_TTL, Math.ceil(remaining) + 3600));
};

/** Redis TTL of a token's keys: idle window, but never past the absolute cap (0 = already over). */
export const castKeyTtl = (exp: number, now = Date.now()) => Math.max(0, Math.min(CAST_IDLE_TTL, Math.ceil((exp - now) / 1000)));

interface IdxEntry { hash: string; createdAt: number; deviceId?: string; kind?: 'media' | 'img'; imgHash?: string }

async function dropByHash(ctx: Ctx, userId: string, hash: string, imgHash?: string) {
  for (const h of imgHash ? [hash, imgHash] : [hash]) {
    await ctx.kv.del(dataKey(h));
    await ctx.kv.del(pinKey(h));
    await ctx.kv.del(idxKey(userId, castIdOf(h)));
  }
}

async function listIdx(ctx: Ctx, userId: string): Promise<Array<IdxEntry & { key: string }>> {
  const out: Array<IdxEntry & { key: string }> = [];
  for (const k of await ctx.kv.keys(`castidx:${userId}:`)) {
    const raw = await ctx.kv.get(k);
    if (raw) out.push({ key: k, ...(JSON.parse(raw) as IdxEntry) });
  }
  return out;
}

/**
 * Creates a media token (plus, with `image`, a poster-only token), keeping at most MAX_CAST_TOKENS media tokens per account (oldest revoked).
 * The limit is enforced AFTER the insert, so two simultaneous creations converge to the limit instead of racing past it.
 * Returns the raw tokens (once).
 */
export async function createCast(ctx: Ctx, rec: Omit<CastRecord, 'exp' | 'createdAt' | 'kind' | 'seen'>, ttlSeconds: number, image = false): Promise<{ ct: string; imgCt?: string; castId: string; expiresAt: number }> {
  const now = Date.now();
  const exp = now + ttlSeconds * 1000;
  const ttl = castKeyTtl(exp, now);
  const mint = async (kind: 'media' | 'img', extra: Partial<IdxEntry> = {}) => {
    const ct = randomBytes(32).toString('base64url');
    const hash = hashToken(ct);
    await ctx.kv.set(dataKey(hash), JSON.stringify({ ...rec, kind, exp, createdAt: now, seen: now } satisfies CastRecord), ttl);
    await ctx.kv.set(idxKey(rec.userId, castIdOf(hash)), JSON.stringify({ hash, createdAt: now, deviceId: rec.deviceId, kind, ...extra } satisfies IdxEntry), ttl);
    return { ct, hash };
  };
  const img = image ? await mint('img') : undefined;
  const media = await mint('media', img ? { imgHash: img.hash } : {});
  const active = (await listIdx(ctx, rec.userId)).filter((i) => i.kind !== 'img' && i.hash !== media.hash).sort((a, b) => a.createdAt - b.createdAt);
  while (active.length >= MAX_CAST_TOKENS) {
    const old = active.shift()!;
    await dropByHash(ctx, rec.userId, old.hash, old.imgHash);
  }
  memo.clear();
  return { ct: media.ct, imgCt: img?.ct, castId: castIdOf(media.hash), expiresAt: exp };
}

/** Revokes one token of an account by its public handle (a media token takes its poster token with it). */
export async function revokeCast(ctx: Ctx, userId: string, castId: string): Promise<boolean> {
  const raw = await ctx.kv.get(idxKey(userId, castId));
  if (!raw) return false;
  const i = JSON.parse(raw) as IdxEntry;
  await dropByHash(ctx, userId, i.hash, i.imgHash);
  memo.clear();
  return true;
}

/** Revokes all tokens of an account, or only those created from one device; `exceptDeviceId` spares one device. Called by revokeSessions / logout. */
export async function revokeCasts(ctx: Ctx, userId: string, deviceId?: string, exceptDeviceId?: string): Promise<number> {
  let n = 0;
  for (const i of await listIdx(ctx, userId)) {
    if (deviceId && i.deviceId !== deviceId) continue;
    if (exceptDeviceId && i.deviceId === exceptDeviceId) continue;
    await dropByHash(ctx, userId, i.hash, i.imgHash);
    n++;
  }
  memo.clear();
  return n;
}

/**
 * Sliding refresh (called on a successful authz, at most every CAST_TOUCH_MS): extends the Redis TTL up to the absolute cap.
 * `replace` (SET XX) so a token revoked in between is never resurrected. Media tokens also keep their play session
 * counted as live (maxStreams), because the Chromecast may never get progress reports from a sender.
 */
async function touch(ctx: Ctx, hash: string, rec: CastRecord, userName: string, profileName: string) {
  const now = Date.now();
  const ttl = castKeyTtl(rec.exp, now);
  if (ttl <= 0) return;
  if (!(await ctx.kv.replace(dataKey(hash), JSON.stringify({ ...rec, seen: now } satisfies CastRecord), ttl))) return;
  const ik = idxKey(rec.userId, castIdOf(hash));
  const idx = await ctx.kv.get(ik);
  if (idx) await ctx.kv.replace(ik, idx, ttl);
  if (rec.kind === 'img') return;
  const cur = await getLive(ctx, rec.userId, rec.playSessionId);
  await setLive(ctx, cur
    ? { ...cur, updatedAt: now }
    : { userId: rec.userId, userName, profileName, itemId: rec.itemId, title: rec.title ?? '', positionTicks: 0, isPaused: false, playSessionId: rec.playSessionId, updatedAt: now, source: 'portal' });
}

/**
 * Token -> Jellyfin credentials + scope, or null. Re-validates on every (memoised, 5 s) call:
 * token exists and not expired, user exists and is enabled, role known, profile still belongs to the account, sender device still approved,
 * and the caller is the client address that first used the token (pin; atomic, first writer wins).
 */
export async function resolveCast(ctx: Ctx, ct: string, client: string): Promise<CastAuth | null> {
  if (!CAST_TOKEN_RE.test(ct) || !castEnabled(ctx)) return null;
  const hash = hashToken(ct);
  const mk = `${hash}|${client}`;
  const hit = memo.get(mk);
  if (hit && hit.exp > Date.now()) return hit.v;
  let v: CastAuth | null = null;
  const raw = await ctx.kv.get(dataKey(hash));
  const rec = raw ? (JSON.parse(raw) as CastRecord) : null;
  if (rec && rec.exp > Date.now()) {
    const user = await getUserById(ctx, rec.userId);
    const role = user && !user.disabled ? await effectiveRole(ctx, user.role) : undefined;
    const prof = role ? await getProfile(ctx, rec.userId, rec.profileId) : null;
    const dev = prof ? await ctx.db.query<{ approved: boolean }>('select approved from devices where user_id=$1 and device_id=$2', [rec.userId, rec.deviceId]) : null;
    if (user && role && prof && dev?.rows[0]?.approved && (await pinned(ctx, hash, client, rec.exp))) {
      const jfUser = jfUserFor(user, prof);
      v = {
        userId: user.id,
        ...(await ctx.jf.mediaAuth(jfUser)),
        maxBitrate: Math.min(role.maxBitrate, rec.maxBitrate),
        maxHeight: Math.min(role.maxHeight ?? CAST_MAX_HEIGHT, CAST_MAX_HEIGHT),
        kind: rec.kind ?? 'media',
        scope: { itemId: rec.itemId, mediaSourceId: rec.mediaSourceId, playSessionId: rec.playSessionId },
      };
      if (Date.now() - (rec.seen ?? rec.createdAt) > CAST_TOUCH_MS) await touch(ctx, hash, rec, user.name, prof.name);
    }
  }
  memo.set(mk, { exp: Date.now() + (v ? 5_000 : 2_000), v });
  if (memo.size > 5000) memo.clear();
  return v;
}

/** First successful client wins the pin (SET NX, lives as long as the token can); everyone else must match it. */
async function pinned(ctx: Ctx, hash: string, client: string, exp: number): Promise<boolean> {
  const ttl = Math.max(1, Math.ceil((exp - Date.now()) / 1000));
  if (await ctx.kv.setnx(pinKey(hash), client, ttl)) return true;
  return (await ctx.kv.get(pinKey(hash))) === client;
}
