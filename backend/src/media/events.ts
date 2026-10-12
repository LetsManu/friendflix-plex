import { bus } from '../bus.js';
import type { Ctx } from '../ctx.js';
import { clearLive, setLive } from '../live.js';
import { fireEpisode, fireTmdb } from '../reminders.js';
import type { UserRow } from '../types.js';
import type { MediaEvent } from './types.js';

/** Applies one neutral media server event: "Erinnere mich" reminders, "now playing" entries, user-data caches. */
export async function handleMediaEvent(ctx: Ctx, e: MediaEvent): Promise<void> {
  if (e.type === 'itemAdded') {
    // "Erinnere mich": a title or episode just arrived in the library
    if ((e.itemType === 'Movie' || e.itemType === 'Series') && e.tmdbId !== undefined && Number.isInteger(e.tmdbId) && e.tmdbId > 0) {
      await fireTmdb(ctx, e.itemType === 'Movie' ? 'movie' : 'tv', e.tmdbId, e.itemId);
    } else if (e.itemType === 'Episode') {
      await fireEpisode(ctx, { itemId: e.itemId, seriesId: e.seriesId, season: e.season, episode: e.episode });
    }
    return;
  }
  if (e.type !== 'playback') return; // itemRemoved: nothing keeps state about library items yet
  const r = e.serverUserId
    ? await ctx.db.query<UserRow>('select * from users where jellyfin_user_id=$1', [e.serverUserId])
    : await ctx.db.query<UserRow>('select * from users where lower(jellyfin_username)=lower($1)', [e.serverUserName ?? '']);
  const user = r.rows[0];
  if (!user) return;
  // played state / resume position changed outside the portal: drop memoised items and dependent caches of that server user
  await ctx.jf.touchUserData(user.jellyfin_user_id);
  const ps = `wh-${e.device.replace(/[^\w]/g, '').slice(0, 24)}`;
  if (e.state === 'stop') await clearLive(ctx, user.id, ps);
  else {
    await setLive(ctx, {
      userId: user.id, userName: user.name, itemId: e.itemId, title: e.name ?? '', seriesName: e.seriesName,
      positionTicks: e.positionTicks ?? 0, runtimeTicks: e.runtimeTicks, isPaused: e.paused,
      playSessionId: ps, updatedAt: Date.now(), source: 'jellyfin',
    });
  }
}

/** Handles the event, then tells other features on the bus ('media.event'). Used by webhook routes and MediaServer.start() feeds. */
export async function dispatchMediaEvent(ctx: Ctx, e: MediaEvent): Promise<void> {
  await handleMediaEvent(ctx, e);
  bus.emitT('media.event', e);
}
