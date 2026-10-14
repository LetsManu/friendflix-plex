// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
import type { Live } from './live.js';
import type { UserRow } from './types.js';

export interface PlaybackEvent {
  kind: 'Playing' | 'Playing/Progress' | 'Playing/Stopped';
  user: UserRow;
  live: Live;
  /** Wall-clock ms since the previous report (capped), used for watch-time statistics. */
  elapsedMs: number;
}

type Hook = (ctx: Ctx, e: PlaybackEvent) => Promise<void>;

/** Extension point: stats (step 7) and achievements subscribe here. Hook errors never break playback. */
class Hooks {
  private readonly list: Hook[] = [];
  add(h: Hook) {
    this.list.push(h);
  }
  async run(ctx: Ctx, e: PlaybackEvent) {
    for (const h of this.list) await h(ctx, e).catch((err) => console.error('playback hook failed', err));
  }
}
export const playbackHooks = new Hooks();

export type SeerrEvent =
  | { type: 'available'; tmdbId: number; mediaType: string }
  | { type: 'requested'; user: UserRow; tmdbId: number; mediaType: string };

type SeerrHook = (ctx: Ctx, e: SeerrEvent) => Promise<void>;

/** Voting (step 6) and achievements subscribe to Seerr events here. */
class SeerrHooks {
  private readonly list: SeerrHook[] = [];
  add(h: SeerrHook) {
    this.list.push(h);
  }
  async run(ctx: Ctx, e: SeerrEvent) {
    for (const h of this.list) await h(ctx, e).catch((err) => console.error('seerr hook failed', err));
  }
}
export const seerrHooks = new SeerrHooks();

/** In-process memos that depend on a Jellyfin user's access policy (per app instance: keyed by its ctx). */
const policyListeners = new WeakMap<Ctx, Set<(jellyfinUserId: string) => void>>();
/** Registers a memo cleaner that runs when a Jellyfin user's parental policy changed (see policyChanged). */
export function onPolicyChange(ctx: Ctx, fn: (jellyfinUserId: string) => void) {
  const set = policyListeners.get(ctx) ?? new Set();
  policyListeners.set(ctx, set);
  set.add(fn);
}
/**
 * A profile's kids flag / age cap changed: everything cached for its Jellyfin user may show titles it can no longer see (or
 * miss new ones). Drops the item memo and bumps the user-data version ("Weil du …" rows key on it), deletes the
 * trending/simulcast caches and runs the registered in-process cleaners (brand hubs, extras). Never throws.
 */
export async function policyChanged(ctx: Ctx, jellyfinUserId: string): Promise<void> {
  await ctx.jf.touchUserData(jellyfinUserId);
  for (const prefix of [`trend:${jellyfinUserId}:`, `simulcast:${jellyfinUserId}`]) {
    const keys = await ctx.kv.keys(prefix).catch(() => [] as string[]);
    for (const k of keys) await ctx.kv.del(k).catch(() => undefined);
  }
  for (const fn of policyListeners.get(ctx) ?? []) { try { fn(jellyfinUserId); } catch { /* a cleaner never breaks the request */ } }
}
