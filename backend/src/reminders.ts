import type { Ctx } from './ctx.js';
import { m } from './i18n.js';
import { notify } from './notify.js';
import type { JfUser, UserRow } from './types.js';

type Db = Pick<Ctx, 'db' | 'cfg' | 'fetchImpl'>;

interface ReminderRow {
  id: string;
  user_id: string;
  kind: 'tmdb' | 'episode';
  media_type: 'movie' | 'tv' | null;
  tmdb_id: number | null;
  jf_item_id: string | null;
  series_id: string | null;
  season: number | null;
  episode: number | null;
  title: string;
}

/** Marks the reminder as fired; false = somebody else (webhook, tick, hook) was faster. */
async function claim(ctx: Db, id: string): Promise<boolean> {
  const r = await ctx.db.query('update reminders set fired_at = now() where id = $1 and fired_at is null returning id', [id]);
  return (r.rowCount ?? 0) > 0;
}

/** A real (not merely announced) episode. */
export const isAvailableEpisode = (ctx: Pick<Ctx, 'jf'>, user: JfUser, ids: string[]): Promise<Set<string>> => ctx.jf.availableEpisodes(user, ids);

/** A series counts as available once at least one real (non-placeholder) episode exists. */
export const seriesHasEpisode = (ctx: Pick<Ctx, 'jf'>, seriesId: string): Promise<boolean> => ctx.jf.seriesHasEpisode(seriesId);

/** An episode may get a NEW id when its file arrives (the announced one was a placeholder): find it by season + number. */
const realEpisodeIds = (ctx: Pick<Ctx, 'jf'>, user: JfUser, seriesId: string, season: number): Promise<Map<number, string>> => ctx.jf.seasonEpisodeIds(user, seriesId, season);

/** A movie / series with this TMDB id is now in the library: notify everybody who asked to be reminded (once). */
export async function fireTmdb(ctx: Db & Pick<Ctx, 'jf'>, mediaType: string, tmdbId: number, jfItemId?: string): Promise<number> {
  if (mediaType !== 'movie' && mediaType !== 'tv') return 0;
  const rows = (await ctx.db.query<ReminderRow>(
    `select r.* from reminders r join users u on u.id = r.user_id
      where r.kind = 'tmdb' and r.media_type = $1 and r.tmdb_id = $2 and r.fired_at is null and not u.disabled`,
    [mediaType, tmdbId],
  )).rows;
  if (!rows.length) return 0;
  const itemId = jfItemId ?? (await ctx.jf.findByTmdb(tmdbId, mediaType).catch(() => null))?.id;
  // a series shell with only announced (virtual) episodes is not watchable yet
  if (mediaType === 'tv' && !(itemId && (await seriesHasEpisode(ctx, itemId).catch(() => false)))) return 0;
  let sent = 0;
  for (const r of rows) {
    if (!(await claim(ctx, r.id))) continue;
    // the requester already gets "avail-<seerr request id>" for the same title: one notification is enough
    const req = await ctx.db.query(
      `select 1 from seerr_requests s join notifications n on n.user_id = s.user_id and n.dedupe = 'avail-' || s.seerr_request_id
        where s.user_id = $1 and s.tmdb_id = $2 and s.media_type = $3`, [r.user_id, tmdbId, mediaType]);
    if (req.rowCount) continue;
    const ok = await notify(ctx, {
      userId: r.user_id, kind: 'reminder', title: m('title.available', { title: r.title }), link: itemId ? `/item/${itemId}` : '/',
      dedupe: `remind-${r.id}`, personal: true,
    });
    if (ok) sent++;
  }
  return sent;
}

async function fireEpisodeRow(ctx: Db, r: ReminderRow, realId: string): Promise<boolean> {
  if (!(await claim(ctx, r.id))) return false;
  // same key as the follow job (calendarNotifications, keyed on the real episode id): followers get exactly one notification
  return notify(ctx, { userId: r.user_id, kind: 'episode', title: m('episode.new', { title: r.title }), link: `/watch/${realId}`, dedupe: `cal-${r.user_id}-${realId}`, personal: true });
}

/** Jellyfin webhook ItemAdded for an episode: fires the reminders of every user waiting for it (by id, or series + season + number). */
export async function fireEpisode(ctx: Db, e: { itemId: string; seriesId?: string; season?: number; episode?: number }): Promise<number> {
  const rows = (await ctx.db.query<ReminderRow>(
    `select r.* from reminders r join users u on u.id = r.user_id
      where r.kind = 'episode' and r.fired_at is null and not u.disabled
        and (r.jf_item_id = $1 or ($2::text is not null and r.series_id = $2 and r.season = $3 and r.episode = $4))`,
    [e.itemId, e.seriesId ?? null, e.season ?? null, e.episode ?? null],
  )).rows;
  let n = 0;
  for (const r of rows) if (await fireEpisodeRow(ctx, r, e.itemId)) n++;
  return n;
}

let busy = false;

/** Every 30 min: safety net for missed webhooks (TMDB titles via findByTmdb, episodes via Jellyfin) + cleanup. */
export async function reminderTick(ctx: Ctx): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const pairs = (await ctx.db.query<{ media_type: string; tmdb_id: number }>(
      "select media_type, tmdb_id from reminders where kind='tmdb' and fired_at is null group by media_type, tmdb_id order by random() limit 50",
    )).rows;
    for (const p of pairs) {
      try {
        const hit = await ctx.jf.findByTmdb(p.tmdb_id, p.media_type);
        if (hit) await fireTmdb(ctx, p.media_type, p.tmdb_id, hit.id);
      } catch (e) {
        console.error('reminder tmdb check failed', e);
      }
    }
    const eps = (await ctx.db.query<ReminderRow>(
      `select r.* from reminders r join users u on u.id = r.user_id where r.kind = 'episode' and r.fired_at is null and not u.disabled order by r.user_id, r.id`,
    )).rows;
    const byUser = new Map<string, ReminderRow[]>();
    for (const r of eps) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
    for (const [userId, list] of byUser) {
      try {
        const user = (await ctx.db.query<UserRow>('select * from users where id = $1', [userId])).rows[0];
        if (!user) continue;
        const bySeries = new Map<string, ReminderRow[]>();
        for (const r of list) if (r.series_id && r.season != null && r.episode != null) bySeries.set(r.series_id, [...(bySeries.get(r.series_id) ?? []), r]);
        for (const [seriesId, rs] of bySeries) {
          try {
            for (const season of new Set(rs.map((r) => r.season!))) {
              const real = await realEpisodeIds(ctx, user, seriesId, season);
              for (const r of rs) {
                const id = r.season === season ? real.get(r.episode!) : undefined;
                if (id) await fireEpisodeRow(ctx, r, id);
              }
            }
          } catch (e) {
            console.error('reminder series check failed', e);
          }
        }
      } catch (e) {
        console.error('reminder episode check failed', e);
      }
    }
    await ctx.db.query("delete from reminders where fired_at < now() - interval '30 days'");
  } finally {
    busy = false;
  }
}
