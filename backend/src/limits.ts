// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
import { roleLimitFor } from './requestlimit.js';
import { effectiveRole, type RoleTemplate } from './roles.js';

/** Per-user overrides (table user_limits). null = the role value applies. */
export type UserLimits = { maxStreams: number | null; remoteBitrate: number | null; maxDownloads: number | null; downloadMaxHeight: number | null; requestsPerMonth: number | null };
/** The role template with the user's overrides on top, plus the monthly request limit (null = unlimited). */
export type EffectiveLimits = RoleTemplate & { requestsPerMonth: number | null };

type LimitsCtx = Pick<Ctx, 'db' | 'roles'>;
const NONE: UserLimits = { maxStreams: null, remoteBitrate: null, maxDownloads: null, downloadMaxHeight: null, requestsPerMonth: null };
const TTL_MS = 30_000;
/** userId -> (ctx -> row). Keyed by user first so invalidateLimits(userId) works without a ctx. */
const cache = new Map<string, WeakMap<object, { at: number; v: UserLimits }>>();

export async function getUserLimits(ctx: Pick<Ctx, 'db'>, userId: string): Promise<UserLimits> {
  const r = await ctx.db.query<{ max_streams: number | null; remote_bitrate: number | null; max_downloads: number | null; download_max_height: number | null; requests_per_month: number | null }>(
    'select max_streams, remote_bitrate, max_downloads, download_max_height, requests_per_month from user_limits where user_id=$1', [userId]);
  const x = r.rows[0];
  if (!x) return { ...NONE };
  return { maxStreams: x.max_streams, remoteBitrate: x.remote_bitrate, maxDownloads: x.max_downloads, downloadMaxHeight: x.download_max_height, requestsPerMonth: x.requests_per_month };
}

/** Stores the overrides; all null removes the row (the user follows the role again). */
export async function setUserLimits(ctx: Pick<Ctx, 'db'>, userId: string, l: UserLimits): Promise<void> {
  if (Object.values(l).every((v) => v === null)) {
    await ctx.db.query('delete from user_limits where user_id=$1', [userId]);
  } else {
    await ctx.db.query(
      `insert into user_limits(user_id, max_streams, remote_bitrate, max_downloads, download_max_height, requests_per_month) values ($1,$2,$3,$4,$5,$6)
       on conflict (user_id) do update set max_streams=$2, remote_bitrate=$3, max_downloads=$4, download_max_height=$5, requests_per_month=$6, updated_at=now()`,
      [userId, l.maxStreams, l.remoteBitrate, l.maxDownloads, l.downloadMaxHeight, l.requestsPerMonth]);
  }
  invalidateLimits(userId);
}

async function cachedUserLimits(ctx: LimitsCtx, userId: string): Promise<UserLimits> {
  let per = cache.get(userId);
  const hit = per?.get(ctx);
  if (hit && Date.now() - hit.at <= TTL_MS) return hit.v;
  const v = await getUserLimits(ctx, userId);
  if (!per) cache.set(userId, (per = new WeakMap()));
  per.set(ctx, { at: Date.now(), v });
  return v;
}

/**
 * Effective role (effectiveRole: code default <- env <- role_settings) with the user's set overrides on top.
 * The user row is cached ~30 s per (ctx, user); undefined for an unknown role (like effectiveRole).
 */
export async function effectiveLimits(ctx: LimitsCtx, user: { id: string; role: string }): Promise<EffectiveLimits | undefined> {
  const role = await effectiveRole(ctx, user.role);
  if (!role) return undefined;
  const [u, roleRequests] = await Promise.all([cachedUserLimits(ctx, user.id), roleLimitFor(ctx, user.role)]);
  return {
    ...role,
    maxStreams: u.maxStreams ?? role.maxStreams,
    remoteMaxBitrate: u.remoteBitrate ?? role.remoteMaxBitrate,
    maxDownloads: u.maxDownloads ?? role.maxDownloads,
    downloadMaxHeight: u.downloadMaxHeight ?? role.downloadMaxHeight,
    requestsPerMonth: u.requestsPerMonth ?? roleRequests,
  };
}

/** Drops the cached overrides of one user (all users without an id). */
export const invalidateLimits = (userId?: string) => void (userId === undefined ? cache.clear() : cache.delete(userId));
