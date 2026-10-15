// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { audit } from './audit.js';
import { randomToken } from './crypto.js';
import type { Ctx } from './ctx.js';
import { m } from './i18n.js';
import { notify } from './notify.js';
import { parties } from './routes/party.js';
import { requestsClient, requestsEnabled } from './seerr/client.js';
import { ensureSeerrUser } from './seerr/service.js';
import { isOperational } from './setup/state.js';
import { getUserById } from './users.js';

export interface OptionInput {
  jfItemId?: string;
  tmdbId?: number;
  mediaType?: 'movie' | 'tv';
}

/** Fewer than two distinct options after resolution/dedupe. */
export class InvalidOptions extends Error {}

export async function createPoll(ctx: Ctx, creatorId: string, input: { title: string; options: OptionInput[]; closesInMinutes: number; startsAfterMinutes: number }) {
  const creator = (await getUserById(ctx, creatorId))!;
  const resolved: Array<{ jf?: string; tmdb?: number; type?: string; title: string; poster?: string }> = [];
  const seen = new Set<string>();
  for (const o of input.options) {
    const key = o.jfItemId ? `jf:${o.jfItemId}` : `tmdb:${o.mediaType}:${o.tmdbId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (o.jfItemId) {
      const it = await ctx.jf.item(creator, o.jfItemId); // also verifies the creator can see it
      if (resolved.some((r) => r.jf === it.id)) continue;
      resolved.push({ jf: it.id, title: it.name });
    } else if (o.tmdbId && o.mediaType) {
      if (!ctx.seerr) throw new InvalidOptions('wish options need the request service');
      const d = await ctx.seerr.details(o.mediaType, o.tmdbId);
      const inLib = await ctx.jf.findByTmdb(o.tmdbId, o.mediaType).catch(() => null);
      if (inLib) { if (!resolved.some((r) => r.jf === inLib.id)) resolved.push({ jf: inLib.id, title: inLib.name }); } // already in library -> plain library option
      else resolved.push({ tmdb: o.tmdbId, type: o.mediaType, title: String(d.title ?? d.name), poster: d.posterPath ?? undefined });
    }
  }
  if (resolved.length < 2) throw new InvalidOptions('need two distinct options');
  const closes = new Date(Date.now() + input.closesInMinutes * 60_000);
  const starts = new Date(closes.getTime() + input.startsAfterMinutes * 60_000);
  const id = randomUUID();
  // single statement = atomic (ctx.db only exposes query, no transactions)
  await ctx.db.query(
    `with p as (insert into polls(id,title,created_by,closes_at,starts_at) values ($1,$2,$3,$4,$5) returning id)
     insert into poll_options(poll_id,jf_item_id,tmdb_id,media_type,title,poster)
     select p.id, o.jf, o.tmdb, o.type, o.title, o.poster from p, unnest($6::text[],$7::int[],$8::text[],$9::text[],$10::text[]) as o(jf,tmdb,type,title,poster)`,
    [id, input.title, creatorId, closes, starts, resolved.map((r) => r.jf ?? null), resolved.map((r) => r.tmdb ?? null), resolved.map((r) => r.type ?? null), resolved.map((r) => r.title), resolved.map((r) => r.poster ?? null)],
  );
  await audit(ctx, creatorId, 'poll.create', id, { title: input.title });
  await notify(ctx, { userId: null, kind: 'poll_open', title: m('poll.open', { title: input.title }), link: `/vote`, dedupe: `poll-open-${id}`, external: true });
  return id;
}

async function adminIds(ctx: Ctx): Promise<string[]> {
  return (await ctx.db.query<{ id: string }>("select id from users where role='admin' and not disabled")).rows.map((r) => r.id);
}

function schedule(ctx: Ctx, pollId: string, title: string, itemId: string, hostId: string, startAt: Date, roomId?: string | null) {
  const id = roomId ?? randomToken(9);
  if (!parties.get(id)) parties.create({ id, itemId, title, hostId, startAt: Math.max(startAt.getTime(), Date.now() + 5000) });
  void pollId;
  void ctx;
  return id;
}

/** Closes due polls, schedules winners with a party room (auto-start) or asks the admin for approval. Each transition is claimed atomically. */
export async function closeDuePolls(ctx: Ctx) {
  const due = (await ctx.db.query("select * from polls where status='open' and closes_at <= now()")).rows;
  for (const p of due) {
    const win = (await ctx.db.query(
      `select o.*, count(v.user_id) votes from poll_options o left join poll_votes v on v.option_id = o.id
        where o.poll_id=$1 group by o.id order by votes desc, o.id asc limit 1`,
      [p.id],
    )).rows[0];
    if (!win || Number(win.votes) === 0) {
      if (!(await ctx.db.query("update polls set status='cancelled' where id=$1 and status='open' returning id", [p.id])).rowCount) continue;
      await notify(ctx, { userId: null, kind: 'poll_cancelled', title: m('poll.cancelled', { title: p.title }), dedupe: `poll-cancel-${p.id}` });
      continue;
    }
    if (win.jf_item_id) {
      const room = randomToken(9);
      const claimed = await ctx.db.query("update polls set status='scheduled', winner_option_id=$1, room_id=$2 where id=$3 and status='open' returning id", [win.id, room, p.id]);
      if (!claimed.rowCount) continue;
      schedule(ctx, p.id, win.title, win.jf_item_id, p.created_by, p.starts_at, room);
      await notify(ctx, { userId: null, kind: 'poll_scheduled', title: m('poll.scheduled', { title: win.title }), body: m('poll.start', { when: { date: new Date(p.starts_at).toISOString() } }), link: `/party/${room}`, dedupe: `poll-sched-${p.id}`, external: true });
    } else {
      const claimed = await ctx.db.query("update polls set status='needs_approval', winner_option_id=$1 where id=$2 and status='open' returning id", [win.id, p.id]);
      if (!claimed.rowCount) continue;
      for (const a of await adminIds(ctx)) {
        await notify(ctx, { userId: a, kind: 'poll_needs_approval', title: m('poll.needsApproval', { title: win.title }), link: '/admin/polls', dedupe: `poll-appr-${p.id}-${a}`, external: true });
      }
    }
  }
}

export async function approvePoll(ctx: Ctx, pollId: string, adminId: string, approve: boolean) {
  if (approve) requestsClient(ctx); // no request service: RequestsDisabledError (404) before the poll is claimed
  const next = approve ? 'requested' : 'cancelled';
  const p = (await ctx.db.query("update polls set status=$2 where id=$1 and status='needs_approval' returning *", [pollId, next])).rows[0];
  if (!p) return false;
  if (!approve) {
    await audit(ctx, adminId, 'poll.reject', pollId);
    return true;
  }
  let created: { id: number };
  let opt;
  let creator;
  try {
    opt = (await ctx.db.query('select * from poll_options where id=$1', [p.winner_option_id])).rows[0];
    creator = (await getUserById(ctx, p.created_by))!;
    const seerrUser = await ensureSeerrUser(ctx, creator);
    created = await requestsClient(ctx).createRequest({ mediaType: opt.media_type, mediaId: opt.tmdb_id, seasons: opt.media_type === 'tv' ? 'all' : undefined, userId: seerrUser });
  } catch (e) {
    await ctx.db.query("update polls set status='needs_approval' where id=$1 and status='requested'", [pollId]).catch(() => undefined); // retryable; keep the original error
    throw e;
  }
  // after the revert window: once Seerr has the request, a retry must not create a second one
  await ctx.db.query('insert into seerr_requests(seerr_request_id,user_id,media_type,tmdb_id,title,poster,source) values ($1,$2,$3,$4,$5,$6,$7) on conflict (seerr_request_id) do nothing', [created.id, creator.id, opt.media_type, opt.tmdb_id, opt.title, opt.poster, 'poll']);
  await ctx.seerr?.approve(created.id).catch(() => undefined); // admin approval of the poll = approval of the request
  await ctx.db.query('update polls set seerr_request_id=$1 where id=$2', [created.id, pollId]);
  await audit(ctx, adminId, 'poll.approve', pollId, { seerrRequest: created.id });
  await notify(ctx, { userId: null, kind: 'poll_requested', title: m('poll.requested', { title: opt.title }), link: '/vote', dedupe: `poll-req-${pollId}`, external: true });
  return true;
}

/** Requested titles that became available in the library are scheduled automatically (start in 30 min). */
export async function resolveRequestedPolls(ctx: Ctx) {
  if (!requestsEnabled(ctx)) return; // no request service: nothing was requested that could arrive
  const rows = (await ctx.db.query("select p.*, o.tmdb_id, o.media_type, o.title otitle from polls p join poll_options o on o.id=p.winner_option_id where p.status='requested'")).rows;
  for (const p of rows) {
    const found = await ctx.jf.findByTmdb(p.tmdb_id, p.media_type).catch(() => null);
    if (!found) continue;
    const startsAt = new Date(Math.max(Date.now() + 30 * 60_000, new Date(p.starts_at).getTime()));
    await ctx.db.query('update poll_options set jf_item_id=$1 where id=$2', [found.id, p.winner_option_id]); // idempotent; before the claim so a restored room always has an item
    const room = randomToken(9);
    const claimed = await ctx.db.query("update polls set status='scheduled', room_id=$1, starts_at=$2 where id=$3 and status='requested' returning id", [room, startsAt, p.id]);
    if (!claimed.rowCount) continue;
    schedule(ctx, p.id, p.otitle, found.id, p.created_by, startsAt, room);
    await notify(ctx, { userId: null, kind: 'poll_scheduled', title: m('poll.scheduled', { title: p.otitle }), body: m('poll.start', { when: { date: startsAt.toISOString() } }), link: `/party/${room}`, dedupe: `poll-sched-${p.id}`, external: true });
  }
}

/** Maintenance tick: closes polls, restores rooms lost on restart, marks started polls. */
export async function pollTick(ctx: Ctx) {
  if (!isOperational(ctx)) return; // setup mode: no media or request service calls (server.ts checks every tick as well)
  await closeDuePolls(ctx);
  const sched = (await ctx.db.query("select p.*, o.jf_item_id, o.title otitle from polls p join poll_options o on o.id=p.winner_option_id where p.status='scheduled'")).rows;
  for (const p of sched) {
    if (!parties.get(p.room_id)) {
      if (Date.now() - new Date(p.starts_at).getTime() > 6 * 3600_000) await ctx.db.query("update polls set status='started' where id=$1", [p.id]);
      else schedule(ctx, p.id, p.otitle, p.jf_item_id, p.created_by, new Date(p.starts_at), p.room_id);
    } else if (new Date(p.starts_at).getTime() <= Date.now()) {
      await ctx.db.query("update polls set status='started' where id=$1", [p.id]);
    }
  }
}
