// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from './ctx.js';
import { getUserById } from './users.js';
import { jfUserFor, resolveProfile } from './profiles.js';
import type { JfUser, ProfileRow, UserRow } from './types.js';

export interface Session {
  userId: string;
  /** epoch ms; absolute lifetime is enforced from here (older sessions without it fall back to the kv ttl) */
  createdAt?: number;
  /** epoch ms of the last ttl refresh (sliding idle timeout) */
  touchedAt?: number;
  csrf: string;
  deviceId?: string;
  deviceApproved: boolean;
  /** absolute lifetime / idle timeout in seconds; defaults come from the config (TV sessions are longer) */
  ttl?: number;
  idle?: number;
  /** active profile of the account (absent on older sessions = owner profile) */
  profileId?: string;
  /** epoch ms of the last re-authentication at the IdP (see reauth.ts) */
  reauthAt?: number;
}

export const COOKIE = 'ff_sid';
export const rand = () => randomBytes(32).toString('base64url');

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserRow;
    /** active profile (watchlist/thumbs/bookmarks/viewing prefs are per profile) */
    profile?: ProfileRow;
    /** the Jellyfin identity to act as: the account's own row for the owner profile, else the profile's hidden Jellyfin user */
    jfUser?: JfUser;
    session?: Session;
    sid?: string;
  }
}

/** Stores a session with the idle ttl (it is refreshed on use, see `touch`). */
export async function saveSession(ctx: Ctx, sid: string, s: Session, onlyIfExists = false): Promise<boolean> {
  const ttl = Math.min(s.idle ?? ctx.cfg.SESSION_IDLE_SECONDS, s.ttl ?? ctx.cfg.SESSION_TTL_SECONDS);
  if (onlyIfExists) return ctx.kv.replace(`sess:${sid}`, JSON.stringify(s), ttl); // never resurrects a session revoked meanwhile
  await ctx.kv.set(`sess:${sid}`, JSON.stringify(s), ttl);
  return true;
}

export function newSession(s: Omit<Session, 'createdAt' | 'touchedAt'>): Session {
  const now = Date.now();
  return { ...s, createdAt: now, touchedAt: now };
}

export async function loadSession(ctx: Ctx, sid: string | undefined): Promise<Session | null> {
  if (!sid) return null;
  const raw = await ctx.kv.get(`sess:${sid}`);
  if (!raw) return null;
  const s = JSON.parse(raw) as Session;
  // absolute lifetime, independent of activity
  if (s.createdAt && Date.now() - s.createdAt > (s.ttl ?? ctx.cfg.SESSION_TTL_SECONDS) * 1000) {
    await ctx.kv.del(`sess:${sid}`);
    return null;
  }
  return s;
}

/** Sliding idle timeout: refreshes the kv ttl at most once a minute. */
async function touch(ctx: Ctx, sid: string, s: Session) {
  const now = Date.now();
  if (s.touchedAt && now - s.touchedAt < 60_000) return;
  s.touchedAt = now;
  await saveSession(ctx, sid, s, true);
}

/** Resolves cookie -> session -> (fresh, non-disabled) user row. */
export async function authenticate(ctx: Ctx, req: FastifyRequest): Promise<boolean> {
  const sid = req.cookies.ff_sid;
  const s = await loadSession(ctx, sid);
  if (!s || !sid) return false;
  const user = await getUserById(ctx, s.userId);
  if (!user || user.disabled) return false;
  req.sid = sid;
  req.session = s;
  req.user = user;
  const prof = await resolveProfile(ctx, user, s);
  req.profile = prof ?? undefined;
  req.jfUser = prof ? jfUserFor(user, prof) : undefined;
  await touch(ctx, sid, s);
  return true;
}

/**
 * allowNoProfile: routes usable before a profile is picked (devices, notifications ...); all others answer 409 profile_required.
 * skipProfileHeader: /api/me and /api/profiles* (they are how a stale tab recovers). Every other route answers 409 profile_changed
 * when the request's `x-ff-profile` header (the profile the tab believes is active) differs from the session's active profile.
 */
export function requireUser(ctx: Ctx, opts: { allowPendingDevice?: boolean; allowNoProfile?: boolean; skipProfileHeader?: boolean } = {}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await authenticate(ctx, req))) return reply.code(401).send({ error: 'unauthenticated' });
    if (!req.session!.deviceApproved && !opts.allowPendingDevice) {
      // Re-check: the device may have been approved since the session was created.
      if (!(await refreshDevice(ctx, req))) return reply.code(403).send({ error: 'device_pending' });
    }
    const claimed = req.headers['x-ff-profile'];
    if (!opts.skipProfileHeader && typeof claimed === 'string' && claimed && claimed !== req.profile?.id) return reply.code(409).send({ error: 'profile_changed' });
    if (!req.profile && !opts.allowNoProfile) return reply.code(409).send({ error: 'profile_required' });
  };
}

/** Account-level changes (devices, sessions) need the owner profile; no profile chosen yet -> 409 profile_required (the picker always offers the owner profile). */
export function requireOwner(ctx: Ctx) {
  const base = requireUser(ctx, { allowNoProfile: true });
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const r = await base(req, reply);
    if (reply.sent) return r;
    if (!req.profile) return reply.code(409).send({ error: 'profile_required' });
    if (!req.profile.is_owner) return reply.code(403).send({ error: 'owner_required' });
  };
}

export function requireAdmin(ctx: Ctx) {
  const base = requireUser(ctx);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const r = await base(req, reply);
    if (reply.sent) return r;
    if (req.user!.role !== 'admin' || !req.profile?.is_owner) return reply.code(403).send({ error: 'forbidden' });
  };
}

/** A session created on a not-yet-approved device becomes usable as soon as the device is approved. */
export async function refreshDevice(ctx: Ctx, req: FastifyRequest): Promise<boolean> {
  const s = req.session!;
  if (!s.deviceId) return false;
  const r = await ctx.db.query<{ approved: boolean }>('select approved from devices where user_id=$1 and device_id=$2', [s.userId, s.deviceId]);
  if (!r.rows[0]?.approved) return false;
  s.deviceApproved = true;
  return saveSession(ctx, req.sid!, s, true); // false: revoked meanwhile
}
