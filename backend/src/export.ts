// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Download my data" (GET /api/account/export): one JSON document with everything FriendFlix keeps about the account, built on
 * demand and yielded section by section so the route can stream it.
 *
 * Every query names its columns (an allowlist: a column added later never leaks by accident) and reads only the account's own
 * rows, including everything the user authored (comments, poll votes, sent recommendations). Never exported: other people's ids,
 * names or notes (a list item a member added is listed as `addedByMe: false`; of a list the user is only a member of, only its
 * name and the user's own items; a sent recommendation without its recipient; notification texts, which are rendered with
 * other people's names), device ids, push endpoints/keys, the ntfy topic (it works like a password), PIN hashes, the Authentik
 * subject and any media server credential.
 */
import type { Ctx } from './ctx.js';
import { jfUserFor } from './profiles.js';
import { loadPrefs } from './routes/prefs.js';
import { requestStateKey, SeerrError } from './seerr/client.js';
import type { ItemDto } from './media/types.js';
import type { JfUser, ProfileRow, UserRow } from './types.js';

/** media server history per profile (newest first) */
const HISTORY_LIMIT = 1000;
/** JellyfinService.history answers at most 200 items per call: the export pages with `start` */
const HISTORY_PAGE = 200;
/**
 * The first page also merges in the in-progress items (JellyfinService.resume, at most 40), which can push played items out of its
 * 200-item slice; the second page therefore starts this much earlier, and duplicates are dropped.
 */
const RESUME_OVERLAP = 40;
/** the request service is asked for the state of the newest requests only (one call each); older ones read 'unknown' */
const REQUEST_STATUS_MAX = 100;

/**
 * Up to HISTORY_LIMIT history items of one media server identity, newest first.
 * - `truncated`: the server had more than was kept (an item was dropped at the cap), or may have (the cap was reached on a
 *   full page). Exactly HISTORY_LIMIT items ending on a short page is complete, so not truncated.
 * - `partial`: a later page failed; the pages fetched before it are kept. A failing first page rejects.
 * Known gap (seam behaviour): in-progress items are merged into page 0 only, so with more than 200 items an in-progress item
 * older than page 0's oldest entry is cut off there and never reappears on a later page.
 */
async function historyOf(ctx: Ctx, jfUser: JfUser): Promise<{ items: ItemDto[]; truncated: boolean; partial: boolean }> {
  const seen = new Map<string, ItemDto>();
  let dropped = false;
  for (let start = 0; ; start = start === 0 ? HISTORY_PAGE - RESUME_OVERLAP : start + HISTORY_PAGE) {
    let page: ItemDto[];
    try {
      page = await ctx.jf.history(jfUser, { start, limit: HISTORY_PAGE });
    } catch (e) {
      if (start === 0) throw e;
      return { items: [...seen.values()], truncated: dropped, partial: true };
    }
    const before = seen.size;
    for (const i of page) {
      if (seen.has(i.id)) continue;
      if (seen.size < HISTORY_LIMIT) seen.set(i.id, i);
      else dropped = true;
    }
    const full = page.length >= HISTORY_PAGE;
    const capped = seen.size >= HISTORY_LIMIT;
    // a short page is the last one; a page with nothing new means the server ignores `start` (never loop on it)
    if (!full || capped || seen.size === before) return { items: [...seen.values()], truncated: dropped || (capped && full), partial: false };
  }
}

/** the profile columns the export needs; the media server identity is used for the history call only and never written out */
type ExportProfile = Pick<ProfileRow, 'id' | 'name' | 'avatar' | 'kids' | 'kids_max_rating' | 'is_owner' | 'created_at' | 'jellyfin_user_id' | 'jellyfin_username' | 'jellyfin_pw_enc'>;

export async function* exportUserData(ctx: Ctx, user: UserRow): AsyncGenerator<string> {
  const uid = user.id;
  const q = async <T>(sql: string, p: unknown[] = [uid]) => (await ctx.db.query(sql, p)).rows as T[];
  const field = (key: string, value: unknown) => `,${JSON.stringify(key)}:${JSON.stringify(value)}`;

  yield `{"format":"friendflix-export","version":1,"exportedAt":${JSON.stringify(new Date().toISOString())}`;

  // UserRow carries neither avatar nor access_until: read them here
  const acc = (await q<{ avatar: string | null; access_until: Date | null }>('select avatar, access_until from users where id=$1'))[0];
  yield field('account', {
    id: uid, name: user.name, email: user.email, role: user.role, avatar: acc?.avatar ?? null, createdAt: user.created_at, accessUntil: acc?.access_until ?? null,
  });

  const profiles = await q<ExportProfile>(
    `select id, name, avatar, kids, kids_max_rating, is_owner, created_at, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc
       from profiles where user_id=$1 order by is_owner desc, created_at, name`);
  yield field('profiles', profiles.map((p) => ({
    id: p.id, name: p.name, avatar: p.avatar, kids: p.kids, maxRating: p.kids ? p.kids_max_rating : null, isOwner: p.is_owner, createdAt: p.created_at,
  })));

  // owned lists in full (items of members only as "not by me"); member lists: name + own items only, no owner, no members
  const lists = await q<{ id: string; name: string; description: string | null; themed: boolean; emoji: string | null; cover_color: string | null; created_at: Date; owned: boolean }>(
    `select id, name, description, themed, emoji, cover_color, created_at, true owned from lists where owner_id=$1
     union all
     select l.id, l.name, null, null, null, null, null, false from lists l join list_members m on m.list_id=l.id and m.user_id=$1
     order by owned desc, name`);
  const items = lists.length ? await q<{ list_id: string; item_id: string; item_name: string; note: string | null; mine: boolean; added_at: Date }>(
    `select i.list_id, i.item_id, i.item_name, case when i.added_by=$1 then i.note end note, coalesce(i.added_by=$1, false) mine, i.added_at
       from list_items i where i.list_id = any($2) and (i.added_by=$1 or exists (select 1 from lists l where l.id=i.list_id and l.owner_id=$1))
      order by i.added_at`, [uid, lists.map((l) => l.id)]) : [];
  yield field('lists', lists.map((l) => {
    const own = items.filter((i) => i.list_id === l.id).map((i) => ({ itemId: i.item_id, name: i.item_name, ...(i.note ? { note: i.note } : {}), addedAt: i.added_at, addedByMe: i.mine }));
    return l.owned
      ? { name: l.name, owned: true, description: l.description, themed: l.themed, emoji: l.emoji, coverColor: l.cover_color, createdAt: l.created_at, items: own }
      : { name: l.name, owned: false, items: own };
  }));

  yield field('watchlist', {
    items: (await q<{ profile_id: string; item_id: string; added_at: Date }>('select profile_id, item_id, added_at from watchlist where user_id=$1 order by added_at'))
      .map((r) => ({ profileId: r.profile_id, itemId: r.item_id, addedAt: r.added_at })),
    bookmarks: (await q<{ profile_id: string; item_id: string; item_name: string; position_sec: number; note: string | null; created_at: Date }>(
      'select profile_id, item_id, item_name, position_sec, note, created_at from bookmarks where user_id=$1 order by created_at'))
      .map((r) => ({ profileId: r.profile_id, itemId: r.item_id, name: r.item_name, positionSeconds: r.position_sec, note: r.note, createdAt: r.created_at })),
    reminders: (await q<{ profile_id: string | null; kind: string; media_type: string | null; tmdb_id: number | null; jf_item_id: string | null; series_id: string | null; season: number | null; episode: number | null; title: string; release_date: string | null; created_at: Date; fired_at: Date | null }>(
      `select profile_id, kind, media_type, tmdb_id, jf_item_id, series_id, season, episode, title, release_date::text, created_at, fired_at
         from reminders where user_id=$1 order by created_at`))
      .map((r) => ({
        profileId: r.profile_id, kind: r.kind, mediaType: r.media_type, tmdbId: r.tmdb_id, itemId: r.jf_item_id, seriesId: r.series_id, season: r.season, episode: r.episode,
        title: r.title, releaseDate: r.release_date, createdAt: r.created_at, firedAt: r.fired_at,
      })),
    seriesFollows: (await q<{ series_id: string; series_name: string }>('select series_id, series_name from series_follows where user_id=$1 order by series_name'))
      .map((r) => ({ seriesId: r.series_id, name: r.series_name })),
    seriesLanguages: (await q<{ profile_id: string; series_id: string; audio: string | null; subtitle: string | null; updated_at: Date }>(
      `select s.profile_id, s.series_id, s.audio, s.subtitle, s.updated_at
         from series_langprefs s join profiles p on p.id=s.profile_id where p.user_id=$1 order by s.updated_at`))
      .map((r) => ({ profileId: r.profile_id, seriesId: r.series_id, audio: r.audio, subtitle: r.subtitle, updatedAt: r.updated_at })),
    hiddenFromResume: (await q<{ profile_id: string; item_id: string; hidden_at: Date }>(
      'select h.profile_id, h.item_id, h.hidden_at from resume_hidden h join profiles p on p.id=h.profile_id where p.user_id=$1 order by h.hidden_at'))
      .map((r) => ({ profileId: r.profile_id, itemId: r.item_id, hiddenAt: r.hidden_at })),
  });

  yield field('ratings', {
    stars: (await q<{ item_id: string; item_name: string; stars: number; review: string | null; created_at: Date }>(
      'select item_id, item_name, stars, review, created_at from ratings where user_id=$1 order by created_at'))
      .map((r) => ({ itemId: r.item_id, name: r.item_name, stars: r.stars, review: r.review, createdAt: r.created_at })),
    thumbs: (await q<{ profile_id: string; item_id: string; item_name: string; value: number; created_at: Date }>(
      'select profile_id, item_id, item_name, value, created_at from thumbs where user_id=$1 order by created_at'))
      .map((r) => ({ profileId: r.profile_id, itemId: r.item_id, name: r.item_name, value: r.value, createdAt: r.created_at })),
    reactions: (await q<{ profile_id: string; item_id: string; emoji: string; comment: string | null; created_at: Date }>(
      'select profile_id, item_id, emoji, comment, created_at from reactions where user_id=$1 order by created_at'))
      .map((r) => ({ profileId: r.profile_id, itemId: r.item_id, reaction: r.emoji, comment: r.comment, createdAt: r.created_at })),
  });

  // local watch statistics (own rows only); play_daily is summed over devices, so no device id leaves the server
  const totals = {
    perItem: (await q<{ item_id: string; item_name: string; item_type: string | null; series_name: string | null; seconds: string; first_day: string; last_day: string }>(
      `select item_id, max(item_name) item_name, max(item_type) item_type, max(series_name) series_name, sum(seconds) seconds, min(day)::text first_day, max(day)::text last_day
         from play_seconds where user_id=$1 group by item_id order by max(day) desc, item_id`))
      .map((r) => ({ itemId: r.item_id, name: r.item_name, type: r.item_type, seriesName: r.series_name, seconds: Number(r.seconds), firstDay: r.first_day, lastDay: r.last_day })),
    perDay: (await q<{ day: string; streams: string; transcodes: string }>(
      'select day::text, sum(streams) streams, sum(transcodes) transcodes from play_daily where user_id=$1 group by day order by day'))
      .map((r) => ({ day: r.day, streams: Number(r.streams), transcodes: Number(r.transcodes) })),
  };
  // the media server's history as each profile (every non-owner profile has its own media server user, migration 15's check);
  // a failing profile is marked (`error: 'unavailable'`, or `'partial'` next to the pages it got), all failing → `error`; the rest goes on
  const perProfile = await Promise.all(profiles.map((p) => historyOf(ctx, jfUserFor(user, p as ProfileRow)).then(({ items, truncated, partial }) => ({
    profileId: p.id,
    items: items.map((i) => ({
      itemId: i.id, name: i.name, type: i.type, ...(i.seriesName ? { seriesName: i.seriesName } : {}),
      playedAt: i.lastPlayedDate ?? null, positionSeconds: Math.floor(i.positionTicks / 10_000_000), played: i.played,
    })),
    ...(truncated ? { truncated: true } : {}),
    ...(partial ? { error: 'partial' } : {}),
  }), () => ({ profileId: p.id, error: 'unavailable' }))));
  yield field('history', perProfile.length && perProfile.every((h) => !('items' in h))
    ? { error: 'unavailable', totals }
    : { profiles: perProfile, ...(perProfile.some((h) => 'truncated' in h) ? { truncated: true } : {}), totals });

  // request state from the request service (newest REQUEST_STATUS_MAX only); a removed request reads 'removed', an unreachable
  // service 'unknown' (not asked again), as does every request while no request service is set up
  const reqs = await q<{ seerr_request_id: number; tmdb_id: number; media_type: string; title: string; created_at: Date }>(
    'select seerr_request_id, tmdb_id, media_type, title, created_at from seerr_requests where user_id=$1 order by created_at desc');
  const seerr = ctx.seerr;
  let reachable = seerr !== null;
  const requests = [];
  for (const [n, r] of reqs.entries()) {
    let status = 'unknown';
    if (seerr && reachable && n < REQUEST_STATUS_MAX) {
      try {
        const sr = await seerr.getRequest(r.seerr_request_id);
        status = requestStateKey(sr?.media?.status, sr?.status);
      } catch (e) {
        if (e instanceof SeerrError && e.status === 404) status = 'removed';
        else reachable = false;
      }
    }
    requests.push({ tmdbId: r.tmdb_id, mediaType: r.media_type, title: r.title, status, createdAt: r.created_at });
  }
  yield field('requests', requests);

  yield field('devices', (await q<{ label: string; approved: boolean; created_at: Date; last_seen: Date }>(
    'select label, approved, created_at, last_seen from devices where user_id=$1 order by created_at'))
    .map((d) => ({ label: d.label, approved: d.approved, createdAt: d.created_at, lastSeen: d.last_seen })));

  // notification settings are account level (user_prefs); the ntfy topic is a secret, so only whether one is set. Own notices
  // without title, body and link: they are rendered with other people's names, lists and parties (invites, recommendations,
  // admin notices about other accounts), and links carry their ids.
  const prefs = await loadPrefs(ctx, uid);
  const push = (await q<{ n: string }>('select count(*) n from push_subscriptions where user_id=$1'))[0]!;
  const notes = await q<{ kind: string; created_at: Date; read: boolean }>(
    'select kind, created_at, read_at is not null read from notifications where user_id=$1 order by created_at desc');
  yield field('notifications', {
    weeklyDigest: prefs.weeklyDigest, ntfyTopicSet: prefs.ntfyTopic !== '', pushSubscriptions: Number(push.n),
    items: notes.map((n) => ({ kind: n.kind, createdAt: n.created_at, read: n.read })),
  });

  // what the user wrote or chose in shared places: own comments (soft-deleted ones are still stored, so listed flagged), own
  // poll choices (the poll's title only for the user's own polls: another creator may have named people in it), sent
  // recommendations without the recipient or whether they saw it
  yield field('social', {
    comments: (await q<{ profile_id: string; item_id: string; body: string; spoiler: boolean; created_at: Date; deleted: boolean }>(
      'select profile_id, item_id, body, spoiler, created_at, deleted_at is not null deleted from episode_comments where user_id=$1 order by created_at'))
      .map((r) => ({ profileId: r.profile_id, itemId: r.item_id, body: r.body, spoiler: r.spoiler, createdAt: r.created_at, deleted: r.deleted })),
    pollVotes: (await q<{ poll_title: string | null; option_title: string; starts_at: Date }>(
      `select case when p.created_by=$1 then p.title end poll_title, o.title option_title, p.starts_at
         from poll_votes v join polls p on p.id=v.poll_id join poll_options o on o.id=v.option_id where v.user_id=$1 order by p.starts_at`))
      .map((r) => ({ ...(r.poll_title !== null ? { poll: r.poll_title } : {}), choice: r.option_title, startsAt: r.starts_at })),
    recommendationsSent: (await q<{ item_id: string; item_name: string; note: string | null; created_at: Date }>(
      'select item_id, item_name, note, created_at from recommendations where from_user=$1 order by created_at'))
      .map((r) => ({ itemId: r.item_id, name: r.item_name, note: r.note, createdAt: r.created_at })),
  });

  yield field('achievements', (await q<{ key: string; earned_at: Date }>('select key, earned_at from achievements where user_id=$1 order by earned_at'))
    .map((r) => ({ key: r.key, earnedAt: r.earned_at })));
  yield '}';
}
