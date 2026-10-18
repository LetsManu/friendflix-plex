// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
import type { TranscodeReason } from './media/types.js';

/** Live playback state (Redis, short TTL). Source of "Now Playing", stream limits and metrics. */
export interface Live {
  userId: string;
  userName: string;
  /** active profile of the account (the stream limit counts per account, this is display only) */
  profileName?: string;
  itemId: string;
  title: string;
  seriesName?: string;
  type?: string;
  positionTicks: number;
  runtimeTicks?: number;
  isPaused: boolean;
  playSessionId: string;
  updatedAt: number;
  source: 'portal' | 'jellyfin';
  /** Block 22 (portal streams): direct / remux / transcode as counted in play_daily, the server's reason, the FriendFlix device */
  playMethod?: 'direct' | 'remux' | 'transcode';
  transcodeReason?: TranscodeReason;
  deviceId?: string;
  /** the media server identity that plays (matches the server's own session list) */
  serverUserId?: string;
}

const TTL = 45;
const key = (userId: string, ps: string) => `play:${userId}:${ps}`;

export async function setLive(ctx: Pick<Ctx, 'kv'>, l: Live, ttl = TTL) {
  await ctx.kv.set(key(l.userId, l.playSessionId), JSON.stringify(l), ttl);
}
export async function getLive(ctx: Pick<Ctx, 'kv'>, userId: string, ps: string): Promise<Live | null> {
  const r = await ctx.kv.get(key(userId, ps));
  return r ? (JSON.parse(r) as Live) : null;
}
export async function clearLive(ctx: Pick<Ctx, 'kv'>, userId: string, ps: string) {
  await ctx.kv.del(key(userId, ps));
}
/**
 * A play session whose stop was reported: a cast receiver may still fetch its token's buffered segments until the new
 * token is loaded (and the old one revoked). Within DRAIN_MS of the stop its sliding refresh (cast.ts touch) does not count it
 * as live again; after that a token still fetched counts again (a stop report is no way to stream uncounted). A new `start`
 * of the same play session clears the mark.
 */
export const DRAIN_MS = 120_000;
const stopKey = (userId: string, ps: string) => `pstop:${userId}:${ps}`;
export async function markStopped(ctx: Pick<Ctx, 'kv'>, userId: string, ps: string) {
  await ctx.kv.set(stopKey(userId, ps), String(Date.now()), 6 * 3600);
}
export async function clearStopped(ctx: Pick<Ctx, 'kv'>, userId: string, ps: string) {
  await ctx.kv.del(stopKey(userId, ps));
}
/** the stop of this play session was reported less than DRAIN_MS ago */
export async function draining(ctx: Pick<Ctx, 'kv'>, userId: string, ps: string): Promise<boolean> {
  const at = Number(await ctx.kv.get(stopKey(userId, ps)));
  return Number.isFinite(at) && at > 0 && Date.now() - at <= DRAIN_MS;
}
export async function listLive(ctx: Pick<Ctx, 'kv'>): Promise<Live[]> {
  const keys = await ctx.kv.keys('play:');
  const out: Live[] = [];
  for (const k of keys) {
    const r = await ctx.kv.get(k);
    if (r) out.push(JSON.parse(r) as Live);
  }
  return out;
}
export async function countLive(ctx: Pick<Ctx, 'kv'>, userId: string): Promise<number> {
  return (await ctx.kv.keys(`play:${userId}:`)).length;
}
