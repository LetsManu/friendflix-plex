// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Ctx } from './ctx.js';
import { jfUserFor, getProfile } from './profiles.js';
import { effectiveRole } from './roles.js';
import { clearLive, draining, getLive, setLive } from './live.js';
import { getUserById } from './users.js';
import type { JfUser, ProfileRow, UserRow } from './types.js';

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
 * - AirPlay (Safari "video URL" mode, `via: 'airplay'`) uses the same tokens: the TV fetches the stream without the user's cookies.
 *   Its pin admits TWO client addresses (castpin: + castpin2:): the player puts the token URL on the phone's <video> BEFORE the
 *   AirPlay picker opens (the TV must never get a cookie URL it cannot load), so the phone pins the first address, and the TV,
 *   once the user picked it, the second (on a home network they reach the server from different addresses). The second address
 *   can only be taken within AIRPLAY_PIN2_WINDOW_MS of the token's creation; after that the token is locked to what it has.
 */
export type CastVia = 'chromecast' | 'airplay';
/** an AirPlay token's second pin can only be taken this soon after creation (the phone pins slot 1 when it loads the token stream, the TV slot 2 once the user picked it; the picker may take a while) */
export const AIRPLAY_PIN2_WINDOW_MS = 120_000;
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
/**
 * A queued next episode's token (`afterPs`) is served while the play session it follows is still live (not stopped) only within
 * this window from its first such fetch: the receiver's preload of the next item. It never counts as a stream meanwhile; after the
 * window it is refused until that play session is over, so the queue cannot be a way past maxStreams.
 */
export const NEXT_OVERLAP_MS = 180_000;

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
  /** which sender protocol asked for the token (audit; AirPlay gets a two-address pin). Default 'chromecast'. */
  via?: CastVia;
  /** epoch ms, absolute cap */
  exp: number;
  createdAt: number;
  /** epoch ms of the last sliding refresh */
  seen?: number;
  /** a queued next episode's token: the play session it follows (the newest other media token of the same device) */
  afterPs?: string;
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
const pin2Key = (hash: string) => `castpin2:${hash}`;
const idxKey = (userId: string, castId: string) => `castidx:${userId}:${castId}`;
/** start of the preload overlap of the queued next episode(s) after a play session (one window per predecessor, set once) */
const ovlKey = (userId: string, ps: string) => `povl:${userId}:${ps}`;
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

interface IdxEntry { hash: string; createdAt: number; deviceId?: string; kind?: 'media' | 'img'; imgHash?: string; /** a queued next episode's token */ next?: boolean }

async function dropByHash(ctx: Ctx, userId: string, hash: string, imgHash?: string) {
  for (const h of imgHash ? [hash, imgHash] : [hash]) {
    await ctx.kv.del(dataKey(h));
    await ctx.kv.del(pinKey(h));
    await ctx.kv.del(pin2Key(h));
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
 * Creates a media token (plus, with `image`, a poster-only token), keeping at most MAX_CAST_TOKENS media tokens per account (oldest
 * revoked). A queued next episode's token (`rec.afterPs`) replaces the device's earlier one and may be one more than that.
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
  const next = Boolean(rec.afterPs);
  // one queued next episode per device: a repeated request replaces a still waiting one (one that plays already stays)
  if (next) for (const i of await listIdx(ctx, rec.userId)) if (i.next && i.deviceId === rec.deviceId && (await waiting(ctx, i))) await dropByHash(ctx, rec.userId, i.hash, i.imgHash);
  const img = image ? await mint('img') : undefined;
  const media = await mint('media', { ...(img ? { imgHash: img.hash } : {}), ...(next ? { next: true } : {}) });
  const active = (await listIdx(ctx, rec.userId)).filter((i) => i.kind !== 'img' && i.hash !== media.hash).sort((a, b) => a.createdAt - b.createdAt);
  while (active.length >= MAX_CAST_TOKENS + (next ? 1 : 0)) {
    const old = active.shift()!;
    await dropByHash(ctx, rec.userId, old.hash, old.imgHash);
  }
  memo.clear();
  return { ct: media.ct, imgCt: img?.ct, castId: castIdOf(media.hash), expiresAt: exp };
}

/**
 * The play session a queued next episode follows still plays: it has a live record. Its stop clears that record and, within
 * DRAIN_MS, nothing brings it back, so a stopped predecessor is over; one still fetched after the drain counts as live again
 * (touch), and then it still plays here too: the safe side (the next token waits / is refused, never a stream uncounted).
 */
const predecessorPlays = async (ctx: Ctx, r: CastRecord) => Boolean(r.afterPs && (await getLive(ctx, r.userId, r.afterPs)));

/** a queued next episode's token whose predecessor still plays: it waits, it is no predecessor itself */
async function waiting(ctx: Ctx, i: IdxEntry, rec?: CastRecord | null): Promise<boolean> {
  if (!i.next) return false;
  const r = rec ?? (await ctx.kv.get(dataKey(i.hash)).then((x) => (x ? (JSON.parse(x) as CastRecord) : null)));
  return Boolean(r && (await predecessorPlays(ctx, r)));
}

/** the cast a queued next episode follows: the newest media token of this device that is not a waiting queued one (null = none) */
export async function castPredecessor(ctx: Ctx, userId: string, deviceId: string): Promise<{ castId: string; playSessionId: string } | null> {
  const mine = (await listIdx(ctx, userId)).filter((i) => i.kind !== 'img' && i.deviceId === deviceId).sort((a, b) => b.createdAt - a.createdAt);
  for (const i of mine) {
    const raw = await ctx.kv.get(dataKey(i.hash));
    const rec = raw ? (JSON.parse(raw) as CastRecord) : null;
    if (rec && !(await waiting(ctx, i, rec))) return { castId: castIdOf(i.hash), playSessionId: rec.playSessionId };
  }
  return null;
}

/** Revokes one token of an account by its public handle (a media token takes its poster token with it). */
export async function revokeCast(ctx: Ctx, userId: string, castId: string): Promise<boolean> {
  const raw = await ctx.kv.get(idxKey(userId, castId));
  if (!raw) return false;
  const i = JSON.parse(raw) as IdxEntry;
  const rec = await ctx.kv.get(dataKey(i.hash));
  await dropByHash(ctx, userId, i.hash, i.imgHash);
  memo.clear();
  // a stream only its segment fetches counted (touch; never a `start` report, e.g. a queued next episode the receiver preloaded
  // and that was dropped) ends with its token; a reported one ends with its own stop
  const ps = rec ? (JSON.parse(rec) as CastRecord).playSessionId : undefined;
  const live = ps ? await getLive(ctx, userId, ps) : null;
  if (ps && live && !live.playMethod) await clearLive(ctx, userId, ps);
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
async function touch(ctx: Ctx, hash: string, rec: CastRecord, userName: string, profileName: string, overlap = false) {
  const now = Date.now();
  const ttl = castKeyTtl(rec.exp, now);
  if (ttl <= 0) return;
  if (!(await ctx.kv.replace(dataKey(hash), JSON.stringify({ ...rec, seen: now } satisfies CastRecord), ttl))) return;
  const ik = idxKey(rec.userId, castIdOf(hash));
  const idx = await ctx.kv.get(ik);
  if (idx) await ctx.kv.replace(ik, idx, ttl);
  if (rec.kind === 'img' || overlap) return; // a queued next episode's preload: the stream it follows is the counted one
  const cur = await getLive(ctx, rec.userId, rec.playSessionId);
  // its stop was reported just now (title switch / end): the receiver only drains buffered segments until the revoke, no ghost
  // stream; a token still fetched after DRAIN_MS counts again
  if (!cur && (await draining(ctx, rec.userId, rec.playSessionId))) return;
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
    const owner = await liveOwner(ctx, rec);
    const ok = owner && (await pinned(ctx, hash, client, rec.exp, rec.via === 'airplay' && Date.now() - rec.createdAt <= AIRPLAY_PIN2_WINDOW_MS ? 2 : 1, rec.via === 'airplay'));
    const overlap = ok ? await nextOverlap(ctx, rec) : false;
    if (ok && owner && overlap !== null) {
      const { user, role, prof } = owner;
      const jfUser = jfUserFor(user, prof);
      v = {
        userId: user.id,
        ...(await ctx.jf.mediaAuth(jfUser)),
        maxBitrate: Math.min(role.maxBitrate, rec.maxBitrate),
        maxHeight: Math.min(role.maxHeight ?? CAST_MAX_HEIGHT, CAST_MAX_HEIGHT),
        kind: rec.kind ?? 'media',
        scope: { itemId: rec.itemId, mediaSourceId: rec.mediaSourceId, playSessionId: rec.playSessionId },
      };
      if (Date.now() - (rec.seen ?? rec.createdAt) > CAST_TOUCH_MS) await touch(ctx, hash, rec, user.name, prof.name, overlap);
    }
  }
  memo.set(mk, { exp: Date.now() + (v ? 5_000 : 2_000), v });
  if (memo.size > 5000) memo.clear();
  return v;
}

/**
 * A queued next episode's token while the play session it follows still plays: true = inside the preload overlap (served, not
 * counted), null = the overlap is over (refused), false = a normal token. The overlap starts with the first such fetch of ANY
 * next token after that play session (`povl:`, set once): re-minting the next token never renews it.
 */
async function nextOverlap(ctx: Ctx, rec: CastRecord): Promise<boolean | null> {
  if (!rec.afterPs || (rec.kind ?? 'media') !== 'media' || !(await predecessorPlays(ctx, rec))) return false;
  const key = ovlKey(rec.userId, rec.afterPs), now = Date.now();
  await ctx.kv.setnx(key, String(now), 6 * 3600);
  const at = Number(await ctx.kv.get(key));
  return Number.isFinite(at) && now - at <= NEXT_OVERLAP_MS ? true : null;
}

/** The token's account, role and profile while all are still usable (account enabled, role known, profile of the account, sender device approved). */
async function liveOwner(ctx: Ctx, rec: CastRecord): Promise<{ user: UserRow; role: NonNullable<Awaited<ReturnType<typeof effectiveRole>>>; prof: ProfileRow } | null> {
  const user = await getUserById(ctx, rec.userId);
  const role = user && !user.disabled ? await effectiveRole(ctx, user.role) : undefined;
  const prof = role ? await getProfile(ctx, rec.userId, rec.profileId) : null;
  const dev = prof ? await ctx.db.query<{ approved: boolean }>('select approved from devices where user_id=$1 and device_id=$2', [rec.userId, rec.deviceId]) : null;
  return user && role && prof && dev?.rows[0]?.approved ? { user, role, prof } : null;
}

/**
 * Subtitles FriendFlix serves itself (capabilities.subtitleExtract: PlaybackDto subtitle URLs are /api/items/<id>/subtitle/<ms>/<index>/stream.vtt)
 * are not under /media/, so the receiver cannot reach them through the gateway's /media/c/<ct>/ route, and the media token must not
 * appear in an /api/ URL (proxy access logs). Instead the cast session gets a signed URL per subtitle track:
 *   /api/cast/subtitle/<account>/<castId>/<expiry s>/<sig>/<itemId>/<ms>/<index>/stream.vtt
 * sig = HMAC (key derived from APP_ENC_KEY) over everything else. It is valid while the cast token it was minted with is (same absolute
 * cap, revoked with it, same account/role/profile/device checks) and only for that token's item + media source.
 */
export const CAST_SUBTITLE_SOURCE_RE = /^\/api\/items\/([0-9a-f]{32})\/subtitle\/([\w-]{1,64})\/(\d{1,3})\/stream\.vtt$/;
export interface CastSubtitleRef { uid: string; cid: string; exp: number; itemId: string; ms: string; index: number }
const subKey = (ctx: Pick<Ctx, 'encKey'>) => createHmac('sha256', ctx.encKey).update('friendflix cast subtitle v1').digest();
const subSig = (ctx: Pick<Ctx, 'encKey'>, r: CastSubtitleRef) =>
  createHmac('sha256', subKey(ctx)).update([r.uid, r.cid, r.exp, r.itemId, r.ms, r.index].join('|')).digest('base64url');

/** Cast-reachable path for a FriendFlix-served subtitle URL, or null when `url` is not one. */
export function castSubtitlePath(ctx: Pick<Ctx, 'encKey'>, url: string, cast: { userId: string; castId: string; expiresAt: number }): string | null {
  const m = CAST_SUBTITLE_SOURCE_RE.exec(url);
  if (!m) return null;
  const r: CastSubtitleRef = { uid: cast.userId, cid: cast.castId, exp: Math.ceil(cast.expiresAt / 1000), itemId: m[1]!, ms: m[2]!, index: Number(m[3]) };
  return `/api/cast/subtitle/${r.uid}/${r.cid}/${r.exp}/${subSig(ctx, r)}/${r.itemId}/${r.ms}/${r.index}/stream.vtt`;
}

/** Verifies a signed cast subtitle URL (see castSubtitlePath): the media user to fetch the track as, or null (invalid, expired, revoked). */
export async function resolveCastSubtitle(ctx: Ctx, r: CastSubtitleRef, sig: string): Promise<JfUser | null> {
  if (!castEnabled(ctx) || r.exp * 1000 <= Date.now()) return null;
  const want = Buffer.from(subSig(ctx, r));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const idx = await ctx.kv.get(idxKey(r.uid, r.cid)); // gone = revoked or expired
  const hash = idx ? (JSON.parse(idx) as IdxEntry).hash : undefined;
  const raw = hash ? await ctx.kv.get(dataKey(hash)) : null;
  const rec = raw ? (JSON.parse(raw) as CastRecord) : null;
  if (!rec || rec.exp <= Date.now() || (rec.kind ?? 'media') !== 'media' || rec.userId !== r.uid || rec.itemId !== r.itemId || rec.mediaSourceId !== r.ms) return null;
  const owner = await liveOwner(ctx, rec);
  return owner ? jfUserFor(owner.user, owner.prof) : null;
}

/**
 * First successful client wins the pin (SET NX, lives as long as the token can); everyone else must match it.
 * `slots` = 2 (AirPlay, early): the second distinct client takes a second pin the same way; a third one is refused.
 * `twoPins` (AirPlay, later): no new pin is taken any more, but an address pinned in either slot keeps working.
 */
async function pinned(ctx: Ctx, hash: string, client: string, exp: number, slots: 1 | 2 = 1, twoPins = false): Promise<boolean> {
  const ttl = Math.max(1, Math.ceil((exp - Date.now()) / 1000));
  const keys = twoPins ? [pinKey(hash), pin2Key(hash)] : [pinKey(hash)];
  for (const [i, key] of keys.entries()) {
    if (i < slots && (await ctx.kv.setnx(key, client, ttl))) return true;
    if ((await ctx.kv.get(key)) === client) return true;
  }
  return false;
}
