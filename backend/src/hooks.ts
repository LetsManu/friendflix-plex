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
