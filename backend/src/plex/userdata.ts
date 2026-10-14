// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Played / resume / favourite state per FriendFlix identity (users.jellyfin_user_id or profiles.jellyfin_user_id), kept in
 * plex_userdata. Plex is never told: its scrobble/timeline/rating endpoints would write into the ONE admin account.
 * Positions are 100 ns ticks like everywhere in FriendFlix.
 */
import type { Db } from '../db.js';

/** Jellyfin defaults: below 5 % no resume point, from 90 % on the item counts as played. */
export const MIN_RESUME_PCT = 5;
export const MAX_RESUME_PCT = 90;

/** The item plus, for a series / season, its episodes (played state cascades like in Jellyfin). */
async function targets(db: Db, rk: string): Promise<string[]> {
  const r = await db.query<{ rating_key: string }>(
    `select rating_key from plex_items where rating_key = $1
     union select rating_key from plex_items where type = 'episode' and (grandparent_key = $1 or parent_key = $1)
     union select rating_key from plex_items where type = 'season' and parent_key = $1`,
    [rk],
  );
  return r.rows.map((x) => String(x.rating_key));
}

export async function setFavorite(db: Db, identity: string, rk: string, on: boolean): Promise<void> {
  await db.query(
    `insert into plex_userdata(identity_id, rating_key, favorite) values ($1, $2, $3)
     on conflict (identity_id, rating_key) do update set favorite = excluded.favorite, updated_at = now()`,
    [identity, rk, on],
  );
}

export async function setPlayed(db: Db, identity: string, rk: string, on: boolean, at: Date = new Date()): Promise<void> {
  const keys = await targets(db, rk);
  if (!keys.length) return;
  if (on) {
    await db.query(
      `insert into plex_userdata(identity_id, rating_key, played, play_count, position_ticks, last_played)
       select $1, k, true, 1, 0, $3 from unnest($2::bigint[]) k
       on conflict (identity_id, rating_key) do update set played = true, play_count = plex_userdata.play_count + 1, position_ticks = 0,
         last_played = excluded.last_played, updated_at = now()`,
      [identity, keys, at],
    );
  } else {
    await db.query(
      `update plex_userdata set played = false, position_ticks = 0, updated_at = now() where identity_id = $1 and rating_key = any($2::bigint[])`,
      [identity, keys],
    );
  }
}

/** Offline progress sync (and admin tools): position / played / last played date as given. */
export async function setUserData(db: Db, identity: string, rk: string, d: { positionTicks: number; played: boolean; lastPlayedDate: Date | string }): Promise<void> {
  const at = d.lastPlayedDate instanceof Date ? d.lastPlayedDate : new Date(d.lastPlayedDate);
  await db.query(
    `insert into plex_userdata(identity_id, rating_key, played, play_count, position_ticks, last_played) values ($1, $2, $3, $4, $5, $6)
     on conflict (identity_id, rating_key) do update set played = excluded.played,
       play_count = plex_userdata.play_count + case when excluded.played and not plex_userdata.played then 1 else 0 end,
       position_ticks = excluded.position_ticks, last_played = excluded.last_played, updated_at = now()`,
    [identity, rk, d.played, d.played ? 1 : 0, Math.max(0, Math.round(d.positionTicks)), Number.isFinite(at.getTime()) ? at : new Date()],
  );
}

/**
 * A FriendFlix player's progress (what Jellyfin does with /Sessions/Playing*): keeps the resume position, and on stop applies the
 * resume window (< 5 %: no resume point, >= 90 %: played, position cleared). runtimeTicks unknown: plain position.
 */
export async function recordProgress(db: Db, identity: string, rk: string, r: { event: 'start' | 'progress' | 'stop'; positionTicks: number; runtimeTicks?: number }, at: Date = new Date()): Promise<void> {
  const pos = Math.max(0, Math.round(r.positionTicks));
  const pct = r.runtimeTicks && r.runtimeTicks > 0 ? (pos / r.runtimeTicks) * 100 : undefined;
  if (r.event === 'stop' && pct !== undefined && pct >= MAX_RESUME_PCT) return setPlayed(db, identity, rk, true, at);
  const keep = r.event !== 'stop' || pct === undefined || pct >= MIN_RESUME_PCT ? pos : 0;
  if (r.event === 'start' && keep === 0) {
    // starting from the beginning must not wipe an existing resume point before the first progress report
    await db.query(
      `insert into plex_userdata(identity_id, rating_key, last_played) values ($1, $2, $3)
       on conflict (identity_id, rating_key) do update set last_played = excluded.last_played, updated_at = now()`,
      [identity, rk, at],
    );
    return;
  }
  await db.query(
    `insert into plex_userdata(identity_id, rating_key, position_ticks, last_played) values ($1, $2, $3, $4)
     on conflict (identity_id, rating_key) do update set position_ticks = excluded.position_ticks, last_played = excluded.last_played, updated_at = now()`,
    [identity, rk, keep, at],
  );
}

/** Removes everything of one identity (identity deleted). */
export async function forgetIdentity(db: Db, identity: string): Promise<void> {
  await db.query('delete from plex_userdata where identity_id = $1', [identity]);
}
