// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { MediaError, type ItemDto, type MediaTraits } from '../media/types.js';
import { audit } from '../audit.js';
import { badgesFor, instanceToday, leavingFor, LEAVING_ROW_DAYS, storySoFar } from '../fresh.js';
import { m } from '../i18n.js';
import { bumpHomeAll, bumpHome } from '../homegen.js';
import { notify } from '../notify.js';
import { clipPath, previews } from '../previews.js';
import { loadPrefs } from './prefs.js';
import { requireGrownUp } from '../kids.js';
import { requireAdmin, requireUser } from '../session.js';
import { portalStatus } from '../seerr/client.js';
import type { JfUser, UserRow } from '../types.js';
import { id32, wrap as sharedWrap } from './_shared.js';


const wrap = <T extends (...a: any[]) => Promise<any>>(fn: T): T => sharedWrap(fn, { seerr: true, passthrough: [404] });

/**
 * Fetches items by id in chunks of 40 (keeps URLs short), up to 4 chunks in parallel, with the viewer's own token, so library
 * permissions apply. Jellyfin errors count as "not visible" unless `strict` (then they throw). Keeps the requested order.
 */
export async function itemsByIds(ctx: Ctx, user: JfUser, ids: string[], strict = false): Promise<ItemDto[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 40) chunks.push(ids.slice(i, i + 40));
  const parts = await inPool(chunks, 4, async (c) =>
    (await ctx.jf.items(user, { ids: c, types: 'Movie,Series,Episode,BoxSet', limit: 40 }).catch((e) => { if (strict) throw e; return { items: [] as ItemDto[] }; })).items);
  const byId = new Map(parts.flat().map((i) => [i.id, i]));
  return ids.map((i) => byId.get(i)).filter((x): x is ItemDto => Boolean(x));
}

/** Runs `fn` over `xs` with at most `n` calls in flight; results keep the input order. The first error rejects. */
export async function inPool<T, R>(xs: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i]!, i);
    }
  }));
  return out;
}

/** Data of GET /api/recommendations (also part of GET /api/home): what friends recommended to this user, newest unseen first. */
export async function recommendationsFor(ctx: Ctx, jfUser: JfUser, userId: string) {
  const rows = (await ctx.db.query<{ id: string; item_id: string; note: string | null; from_name: string }>(
    `select r.id, r.item_id, r.note, u.name from_name from recommendations r join users u on u.id=r.from_user
      where r.to_user=$1 and r.created_at > now() - interval '60 days' order by r.seen, r.created_at desc limit 30`, [userId])).rows;
  const items = await itemsByIds(ctx, jfUser, [...new Set(rows.map((r) => r.item_id))]);
  const meta = new Map(rows.map((r) => [r.item_id, `Von ${r.from_name}${r.note ? `: ${r.note}` : ''}`]));
  const shown = new Set(items.map((i) => i.id));
  return { items: items.map((i) => ({ ...i, caption: meta.get(i.id) })), recIds: rows.filter((r) => shown.has(r.item_id)).map((r) => Number(r.id)) }; // recIds: send back to /seen
}

/** Data of GET /api/library/friends-rated (also part of GET /api/home). */
export async function friendsRatedFor(ctx: Ctx, jfUser: JfUser, userId: string, profileId: string) {
  const rows = (await ctx.db.query<{ item_id: string; names: string[]; avg: string }>(
    `select r.item_id, array_agg(u.name || ' ' || r.stars || '★' order by r.created_at desc) names, avg(r.stars) avg
       from ratings r join users u on u.id = r.user_id left join user_prefs p on p.user_id = r.user_id
      where r.user_id <> $1 and r.stars >= 4 and r.created_at > now() - interval '90 days' and not u.disabled
        and coalesce((p.data->>'shareRatings')::boolean, true)
        and r.item_id not in (select item_id from ratings where user_id = $1)
        and r.item_id not in (select item_id from thumbs where profile_id = $2 and value = -1)
      group by r.item_id order by max(r.created_at) desc limit 24`, [userId, profileId])).rows;
  const items = await itemsByIds(ctx, jfUser, rows.map((r) => r.item_id));
  const cap = new Map(rows.map((r) => [r.item_id, r.names.slice(0, 2).join(', ')]));
  return { items: items.filter((i) => !i.played).map((i) => ({ ...i, caption: cap.get(i.id) })) };
}

/** Data of GET /api/library/leaving (also part of GET /api/home): home row "Bald nicht mehr verfügbar", only titles the viewer can see. */
export async function leavingRow(ctx: Ctx, jfUser: JfUser) {
  const days = await leavingFor(ctx, (await ctx.db.query<{ item_id: string }>('select item_id from leaving_soon where leaves_at >= $2::date and leaves_at - $2::date <= $1 order by leaves_at limit 60', [LEAVING_ROW_DAYS, instanceToday()])).rows.map((r) => r.item_id), LEAVING_ROW_DAYS);
  const items = await itemsByIds(ctx, jfUser, [...days.keys()]);
  return { items: items.map((i) => ({ ...i, daysLeft: days.get(i.id) ?? 0 })).sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name, 'de')).slice(0, 30) };
}

/** "Weil du ... gesehen hast" cache lifetime (seconds). */
export const BECAUSE_TTL = 600;

/**
 * Data of GET /api/library/because: seed = the profile's latest thumbs-up item, else the last finished title; then Jellyfin's
 * similar titles minus the profile's thumbs-down. The Jellyfin part (seed details, last watched, similar list) is cached in Redis
 * for 10 min per Jellyfin user + profile. The key carries the Jellyfin user's user-data version (bumped by every played / favorite /
 * progress write and by the Jellyfin webhook, see JellyfinService.touchUserData) and the cache entry remembers its seed, so a new
 * thumbs-up re-seeds at once and thumbs-down filtering always uses fresh rows. Plays made outside the portal without the webhook
 * plugin show up after the TTL.
 */
export async function libraryBecause(ctx: Ctx, jfUser: JfUser, profileId: string): Promise<{ because: { id: string; name: string; liked: boolean } | null; items: ItemDto[] }> {
  const [upRow, downRows, ver] = await Promise.all([
    ctx.db.query<{ item_id: string }>('select item_id from thumbs where profile_id=$1 and value>=1 order by created_at desc limit 1', [profileId]).then((r) => r.rows[0]),
    ctx.db.query<{ item_id: string }>('select item_id from thumbs where profile_id=$1 and value=-1', [profileId]).then((r) => r.rows),
    ctx.jf.userDataVersion(jfUser),
  ]);
  const seedId = upRow?.item_id ?? null;
  const key = `because:${jfUser.jellyfin_user_id}:${profileId}:${ver}`;
  type Entry = { seedId: string | null; because: { id: string; name: string; liked: boolean } | null; items: ItemDto[] };
  let entry: Entry | null = null;
  const hit = await ctx.kv.get(key).catch(() => null);
  if (hit) {
    try {
      const e = JSON.parse(hit) as Entry;
      if (e.seedId === seedId) entry = e;
    } catch {
      // corrupt entry: recompute
    }
  }
  if (!entry) {
    const seed = seedId ? await ctx.jf.item(jfUser, seedId).catch(() => null) : null;
    const base = seed ?? (await ctx.jf.lastWatched(jfUser));
    entry = base
      ? { seedId, because: { id: base.id, name: base.name, liked: Boolean(seed) }, items: (await ctx.jf.similar(jfUser, base.id)).filter((i) => i.id !== base.id) }
      : { seedId, because: null, items: [] };
    await ctx.kv.set(key, JSON.stringify(entry), BECAUSE_TTL).catch(() => undefined);
  }
  if (!entry.because) return { because: null, items: [] };
  const down = new Set(downRows.map((r) => r.item_id));
  return { because: entry.because, items: entry.items.filter((i) => !down.has(i.id)) };
}

/** Extra "Weil du X geschaut hast" rows: how many, items per row and the smallest row worth showing. */
export const BECAUSE_MORE_ROWS = 3;
const BECAUSE_MORE_ITEMS = 20;
const BECAUSE_MORE_MIN = 4;

/**
 * Data of GET /api/library/because-more: up to 3 more rows seeded by the profile's most recent DISTINCT watched titles
 * (episodes count as their series), skipping the seed of the main "because" row. Per row Jellyfin's similar titles minus what the
 * profile already finished, thumbed down, or shows in an earlier row (rows never repeat a title or show a seed). The Jellyfin part is
 * cached like libraryBecause (key carries the user-data version); played / thumbs filtering always uses fresh data. The seed lookups run in parallel.
 */
export async function libraryBecauseMore(ctx: Ctx, jfUser: JfUser, profileId: string): Promise<{ rows: Array<{ because: { id: string; name: string }; items: ItemDto[] }> }> {
  const [main, downRows, ver] = await Promise.all([
    libraryBecause(ctx, jfUser, profileId).catch(() => null),
    ctx.db.query<{ item_id: string }>('select item_id from thumbs where profile_id=$1 and value=-1', [profileId]).then((r) => r.rows),
    ctx.jf.userDataVersion(jfUser),
  ]);
  const key = `becausemore:${jfUser.jellyfin_user_id}:${profileId}:${ver}`;
  type Entry = { mainId: string | null; rows: Array<{ because: { id: string; name: string }; items: ItemDto[] }> };
  let entry: Entry | null = null;
  const hit = await ctx.kv.get(key).catch(() => null);
  if (hit) {
    try {
      const e = JSON.parse(hit) as Entry;
      if (e.mainId === (main?.because?.id ?? null)) entry = e;
    } catch {
      // corrupt entry: recompute
    }
  }
  if (!entry) {
    const mainId = main?.because?.id ?? null;
    const seen = new Set<string>();
    const seeds: Array<{ id: string; name: string }> = [];
    for (const i of await ctx.jf.history(jfUser, { limit: 60 })) {
      const id = i.type === 'Episode' && i.seriesId ? i.seriesId : i.id;
      if (seen.has(id) || id === mainId) continue;
      seen.add(id);
      seeds.push({ id, name: i.type === 'Episode' && i.seriesName ? i.seriesName : i.name });
      if (seeds.length >= BECAUSE_MORE_ROWS + 2) break; // a little spare: a seed can end up with too few titles
    }
    const similar = await Promise.all(seeds.map((s) => ctx.jf.similar(jfUser, s.id, 30).catch(() => [] as ItemDto[])));
    entry = { mainId, rows: seeds.map((s, n) => ({ because: s, items: similar[n]!.filter((i) => i.id !== s.id) })) };
    await ctx.kv.set(key, JSON.stringify(entry), BECAUSE_TTL).catch(() => undefined);
  }
  const skip = new Set([...downRows.map((r) => r.item_id), ...entry.rows.map((r) => r.because.id), ...(main?.items ?? []).map((i) => i.id)]);
  const rows: Array<{ because: { id: string; name: string }; items: ItemDto[] }> = [];
  for (const r of entry.rows) {
    const items = r.items.filter((i) => !i.played && !skip.has(i.id)).slice(0, BECAUSE_MORE_ITEMS);
    if (items.length < BECAUSE_MORE_MIN) continue;
    items.forEach((i) => skip.add(i.id));
    rows.push({ because: r.because, items });
    if (rows.length >= BECAUSE_MORE_ROWS) break;
  }
  return { rows };
}

export function discoverRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };
  const grown = { preHandler: requireGrownUp(ctx) }; // friends, matching, recommendations, Seerr: not on kids profiles
  freshRoutes(app, ctx);

  // ---- Group matcher: "what has none of us watched yet?" (opt-in per participant) ----
  app.get('/api/friends', grown, async (req) => {
    const r = await ctx.db.query<{ id: string; name: string; share: boolean | null }>(
      `select u.id, u.name, (p.data->>'shareHistory')::boolean as share from users u left join user_prefs p on p.user_id = u.id where u.id <> $1 and not u.disabled order by u.name`,
      [req.user!.id],
    );
    return { friends: r.rows.map((f) => ({ id: f.id, name: f.name, sharesHistory: f.share === true })) };
  });

  app.post('/api/match', { ...grown, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, wrap(async (req, reply) => {
    const b = z.object({
      userIds: z.array(z.guid()).min(1).max(7),
      type: z.enum(['Movie', 'Series', 'Both']).default('Movie'),
      maxMinutes: z.number().int().min(20).max(400).optional(),
      genre: z.string().max(60).optional(),
    }).parse(req.body);
    const ids = [...new Set(b.userIds.filter((i) => i !== req.user!.id))];
    if (!ids.length) return reply.code(400).send({ error: 'need_other_participants' });
    const others = (await ctx.db.query<UserRow>('select * from users where id = any($1) and not disabled', [ids])).rows;
    if (others.length !== ids.length) return reply.code(400).send({ error: 'unknown_participant' });
    const notShared: string[] = [];
    for (const u of others) if (!(await loadPrefs(ctx, u.id)).shareHistory) notShared.push(u.name);
    if (notShared.length) return reply.code(403).send({ error: 'history_not_shared', names: notShared });

    const types = b.type === 'Both' ? 'Movie,Series' : b.type;
    const everyone = [req.jfUser!, ...others];
    const sets = await Promise.all(everyone.map((u) => ctx.jf.unplayedIds(u, types)));
    const common = [...sets[0]!].filter((id) => sets.every((s) => s.has(id)));
    const total = common.length;
    // details + filters with the requester's token; sort by rating
    // genre/type are filtered by Jellyfin so they apply to the whole common set (capped), not just a prefix
    // group-weighted: titles on more participants' watchlists first; anything dropped or thumbed down by a participant is out
    const accounts = [req.user!.id, ...others.map((u) => u.id)]; // account ids (a non-owner profile's jfUser.id is the profile id)
    const plannedBy = new Map((await ctx.db.query<{ item_id: string; n: number }>(
      'select item_id, count(distinct user_id)::int n from watchlist where user_id = any($1) and item_id = any($2) group by item_id', [accounts, common])).rows.map((r) => [r.item_id, r.n]));
    const vetoed = new Set((await ctx.db.query<{ item_id: string }>(
      `select d.item_id from dropped d join profiles p on p.id = d.profile_id where p.user_id = any($1)
       union select item_id from thumbs where user_id = any($1) and value = -1`, [accounts])).rows.map((r) => r.item_id));
    const planned = (id: string) => plannedBy.get(id) ?? 0;
    const pool = common.filter((id) => !vetoed.has(id)).sort((a, c) => planned(c) - planned(a)).slice(0, 2000);
    const chunks: string[][] = [];
    for (let i = 0; i < pool.length; i += 80) chunks.push(pool.slice(i, i + 80)); // 80 ids keep the Jellyfin request line short
    const parts: ItemDto[][] = new Array(chunks.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, async () => {
      while (next < chunks.length) {
        const n = next++;
        parts[n] = (await ctx.jf.items(req.jfUser!, { ids: chunks[n], types, genre: b.genre, limit: 80 })).items;
      }
    }));
    let items = parts.flat();
    if (b.maxMinutes) items = items.filter((i) => !i.runtimeTicks || i.runtimeTicks <= b.maxMinutes! * 600_000_000);
    if (b.genre) items = items.filter((i) => i.genres.includes(b.genre!));
    items.sort((a, c) => planned(c.id) - planned(a.id) || (c.communityRating ?? 0) - (a.communityRating ?? 0) || a.name.localeCompare(c.name));
    return { participants: everyone.map((u) => u.name), total, items: items.slice(0, 40).map((i) => ({ ...i, planned: planned(i.id) })) };
  }));

  // ---- Recommend to friends / "Von Freunden empfohlen" ----
  app.post('/api/recommend', grown, wrap(async (req, reply) => {
    const b = z.object({ itemId: id32, toUserIds: z.array(z.guid()).min(1).max(10), note: z.string().trim().max(140).optional() }).parse(req.body);
    const item = await ctx.jf.item(req.jfUser!, b.itemId); // proves the sender can see it
    const targets = (await ctx.db.query<{ id: string }>('select id from users where id = any($1) and id <> $2 and not disabled', [b.toUserIds, req.user!.id])).rows;
    let sent = 0;
    for (const t of targets) {
      const dup = await ctx.db.query("select 1 from recommendations where from_user=$1 and to_user=$2 and item_id=$3 and created_at > now() - interval '7 days'", [req.user!.id, t.id, item.id]);
      if (dup.rowCount) continue;
      await ctx.db.query('insert into recommendations(from_user,to_user,item_id,item_name,note) values ($1,$2,$3,$4,$5)', [req.user!.id, t.id, item.id, item.name, b.note || null]);
      await notify(ctx, { userId: t.id, kind: 'recommend', title: m('recommend', { name: req.user!.name, title: item.name }), body: b.note, link: `/item/${item.id}` });
      sent++;
    }
    if (!sent && targets.length) return reply.code(409).send({ error: 'already_recommended' });
    return { sent };
  }));

  app.get('/api/recommendations', grown, wrap(async (req) => recommendationsFor(ctx, req.jfUser!, req.user!.id)));
  app.post('/api/recommendations/seen', grown, async (req) => {
    const b = z.object({ ids: z.array(z.union([z.number().int().positive(), z.string().regex(/^\d{1,15}$/)])).max(200).optional() }).nullish().parse(req.body);
    if (b?.ids) await ctx.db.query('update recommendations set seen = true where to_user = $1 and id = any($2::bigint[])', [req.user!.id, b.ids.map(String)]);
    else await ctx.db.query('update recommendations set seen = true where to_user = $1', [req.user!.id]); // legacy: no body marks everything
    return { ok: true };
  });

  // more "Weil du ... geschaut hast" rows for the home page (2-3 recent distinct titles)
  app.get('/api/library/because-more', pre, wrap(async (req) => libraryBecauseMore(ctx, req.jfUser!, req.profile!.id)));

  app.get('/api/library/friends-rated', grown, wrap(async (req) => friendsRatedFor(ctx, req.jfUser!, req.user!.id, req.profile!.id)));

  // ---- Thumbs: -1 Naja, 1 Gut, 2 Geliebt (>= 1 feeds "Weil du ... gesehen hast") ----
  app.put('/api/items/:id/thumb', pre, wrap(async (req) => {
    const id = id32.parse((req.params as { id: string }).id);
    const { value } = z.object({ value: z.union([z.literal(-1), z.literal(0), z.literal(1), z.literal(2)]) }).parse(req.body);
    if (value === 0) {
      await ctx.db.query('delete from thumbs where profile_id=$1 and item_id=$2', [req.profile!.id, id]);
      await bumpHome(ctx, req.profile!.id);
      return { value: 0 };
    }
    const item = await ctx.jf.item(req.jfUser!, id);
    await ctx.db.query(
      `insert into thumbs(profile_id,user_id,item_id,value,item_name) values ($1,$2,$3,$4,$5)
       on conflict (profile_id,item_id) do update set value = excluded.value, created_at = now()`,
      [req.profile!.id, req.user!.id, id, value, item.name],
    );
    await bumpHome(ctx, req.profile!.id);
    return { value };
  }));

  // ---- Cast panel, hover trailer, collections, studios ----
  app.get('/api/items/:id/people', pre, wrap(async (req) => ({ people: await ctx.jf.people(req.jfUser!, id32.parse((req.params as { id: string }).id)) })));
  app.get('/api/items/:id/next', pre, wrap(async (req) => {
    const id = id32.parse((req.params as { id: string }).id);
    const cur = await ctx.jf.item(req.jfUser!, id);
    return { item: cur.type === 'Episode' && cur.seriesId ? await ctx.jf.nextEpisode(req.jfUser!, cur.seriesId, id) : null };
  }));
  app.get('/api/items/:id/tracks', pre, wrap(async (req) => ctx.jf.tracks(req.jfUser!, id32.parse((req.params as { id: string }).id))));
  // Hover/billboard preview: a short clip, transcoded once (service user, background queue) and then served as a plain MP4 file.
  // Route name kept for old clients; `mp4: true` tells the client to use the url as a plain <video src>.
  const viewable = async (user: JfUser, id: string): Promise<ItemDto | null> => {
    try {
      return await ctx.jf.item(user, id);
    } catch (e) {
      if (e instanceof MediaError && (e.status === 404 || e.status === 403)) return null;
      throw e;
    }
  };
  app.get('/api/items/:id/trailer', pre, wrap(async (req, reply) => {
    if (!(await loadPrefs(ctx, req.user!.id, req.profile!.id)).hoverTrailers) return reply.code(404).send({ error: 'disabled' });
    const id = id32.parse((req.params as { id: string }).id);
    const item = await viewable(req.jfUser!, id);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    if (item.type !== 'Movie' && item.type !== 'Series') return reply.code(404).send({ error: 'no_preview' });
    const pv = previews(ctx);
    const st = await pv.status(id);
    if (st === 'ok') return { url: `/api/items/${id}/preview.mp4`, start: 0, mp4: true };
    if (st === 'failed') return reply.code(404).send({ error: 'no_preview' });
    void pv.enqueue(id).catch((e) => req.log.warn({ e }, 'preview generation failed'));
    return reply.code(404).send({ error: 'preparing' });
  }));
  app.get('/api/items/:id/preview.mp4', pre, wrap(async (req, reply) => {
    const id = id32.parse((req.params as { id: string }).id);
    if (!(await viewable(req.jfUser!, id))) return reply.code(404).send({ error: 'not_found' });
    const size = await stat(clipPath(ctx, id)).then((s) => (s.isFile() ? s.size : -1), () => -1);
    if (size < 0) return reply.code(404).send({ error: 'no_preview' });
    reply.header('content-type', 'video/mp4').header('accept-ranges', 'bytes').header('cache-control', 'private, max-age=86400');
    let start = 0;
    let end = size - 1;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m || (!m[1] && !m[2])) return reply.code(416).header('content-range', `bytes */${size}`).send();
      if (!m[1]) start = Math.max(0, size - Number(m[2])); // suffix: last n bytes
      else {
        start = Number(m[1]);
        if (m[2]) end = Math.min(end, Number(m[2]));
      }
      if (start > end || start >= size) return reply.code(416).header('content-range', `bytes */${size}`).send();
      reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`);
    }
    return reply.header('content-length', end - start + 1).send(createReadStream(clipPath(ctx, id), { start, end }));
  }));
  app.get('/api/library/collections', pre, wrap(async (req) => ({ items: await ctx.jf.collections(req.jfUser!), studios: await ctx.jf.studios(req.jfUser!).catch(() => []) })));

  // ---- Upcoming (Seerr discover) with wish status ----
  app.get('/api/seerr/upcoming', grown, wrap(async (req) => {
    const type = z.enum(['movie', 'tv']).default('movie').parse((req.query as { type?: string }).type);
    const r = await ctx.seerr.upcoming(type);
    return {
      results: r.results.slice(0, 30).map((x: any) => ({
        tmdbId: x.id as number, mediaType: type, title: String(x.title ?? x.name ?? ''), releaseDate: (x.releaseDate ?? x.firstAirDate) as string | undefined,
        overview: x.overview as string | undefined, poster: x.posterPath ? `/api/seerr/image${x.posterPath}` : undefined,
        status: portalStatus(x.mediaInfo?.status, x.mediaInfo?.requests?.[0]?.status),
      })),
    };
  }));
}


// ---------------------------------------------------------------- Block 17 D1: fresh labels, leaving soon, quality, story

/** Traits cache lifetime (seconds): library data, not viewer specific, but only ever read after the viewer's own visibility check. */
const TRAITS_TTL = 6 * 3600;
const QUALITY_CAP = 5000;
const QUALITY_CHUNK = 80;
/** chunks of the quality browse in flight at once (5000 candidates = 63 chunks) */
const QUALITY_PARALLEL = 4;
/** the viewer's visible, sorted id list of one quality browse is kept this long (seconds): paging does not re-scan */
const QUALITY_LIST_TTL = 180;
/** per session (cookie) limits of the two heavier Block 17 routes; IP as the fallback for cookie-less callers (they get 401 anyway) */
const perSession = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute', keyGenerator: (req: { cookies?: Record<string, string | undefined>; ip: string }) => `s:${req.cookies?.ff_sid ?? req.ip}` } });
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().startsWith(v); // 2026-02-30 rolls over: refused
}, 'invalid date');

const qualityQuery = z.object({
  quality: z.string().regex(/^(4k|hdr)(,(4k|hdr))?$/),
  types: z.enum(['Movie', 'Series']).default('Movie'),
  sort: z.enum(['SortName', 'DateCreated', 'PremiereDate', 'CommunityRating']).default('SortName'),
  desc: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  start: z.coerce.number().int().min(0).default(0),
  filter: z.enum(['favorites', 'unplayed', 'played']).optional(),
  genre: z.string().max(300).optional(),
  studio: z.string().max(80).optional(),
  decade: z.coerce.number().int().min(1900).max(2090).refine((n) => n % 10 === 0).optional(),
  year: z.coerce.number().int().min(1900).max(2100).optional(),
  minRating: z.coerce.number().min(0).max(10).optional(),
  person: id32.optional(),
  audio: z.string().regex(/^[a-z]{3}$/).optional(),
  subs: z.string().regex(/^[a-z]{3}$/).optional(),
});

function freshRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };
  const admin = { preHandler: requireAdmin(ctx) };
  /** the series a leaving date belongs to (an episode's date is its series') */
  const subject = (i: ItemDto) => (i.type === 'Episode' && i.seriesId ? i.seriesId : i.id);

  // ---- card badges: fresh label + "Nur noch N Tage" for a batch of ids. Only ids the viewer can see come back (itemsByIds uses the viewer's token). ----
  app.post('/api/discover/badges', { ...pre, config: perSession(60) }, wrap(async (req) => {
    const { ids } = z.object({ ids: z.array(id32).min(1).max(80) }).parse(req.body);
    const items = await itemsByIds(ctx, req.jfUser!, [...new Set(ids)]);
    return { badges: await badgesFor(ctx, req.jfUser!, items) };
  }));

  // ---- detail / hover facts: fresh label, leaving date and quality chips of ONE title ----
  app.get('/api/items/:id/facts', pre, wrap(async (req) => {
    const id = id32.parse((req.params as { id: string }).id);
    const item = await ctx.jf.item(req.jfUser!, id); // 404/403 when the viewer cannot see it
    const [badges, leaving, traits] = await Promise.all([
      badgesFor(ctx, req.jfUser!, [item]),
      ctx.db.query<{ leaves_at: string; days: number; note: string | null }>(
        'select leaves_at::text, (leaves_at - $2::date)::int as days, note from leaving_soon where item_id = $1 and leaves_at >= $2::date', [subject(item), instanceToday()]),
      (async () => {
        if (!ctx.jf.mediaTraits || (item.type !== 'Movie' && item.type !== 'Series' && item.type !== 'Episode')) return null;
        const key = `traits:${id}`;
        const hit = await ctx.kv.get(key).catch(() => null);
        if (hit) { try { return JSON.parse(hit) as MediaTraits | null; } catch { /* recompute */ } }
        const t = await ctx.jf.mediaTraits(req.jfUser!, id).catch(() => null);
        await ctx.kv.set(key, JSON.stringify(t), TRAITS_TTL).catch(() => undefined);
        return t;
      })(),
    ]);
    const l = leaving.rows[0];
    return {
      fresh: badges[id]?.fresh ?? null,
      leaving: l ? { leavesAt: l.leaves_at, days: l.days, ...(req.user!.role === 'admin' && req.profile!.is_owner && l.note ? { note: l.note } : {}) } : null,
      traits,
      admin: req.user!.role === 'admin' && Boolean(req.profile?.is_owner),
    };
  }));

  // ---- home row "Bald nicht mehr verfügbar": only titles the viewer can see ----
  app.get('/api/library/leaving', pre, wrap(async (req) => leavingRow(ctx, req.jfUser!)));

  // ---- admin: list / set / clear removal dates (nothing is deleted on the media server) ----
  app.get('/api/admin/leaving', admin, wrap(async (req) => {
    const rows = (await ctx.db.query<{ item_id: string; leaves_at: string; days: number; note: string | null; by: string | null }>(
      `select l.item_id, l.leaves_at::text, (l.leaves_at - $1::date)::int as days, l.note, u.name as by
         from leaving_soon l left join users u on u.id = l.set_by where l.leaves_at >= $1::date order by l.leaves_at, l.item_id`, [instanceToday()])).rows;
    const items = new Map((await itemsByIds(ctx, req.jfUser!, rows.map((r) => r.item_id))).map((i) => [i.id, i]));
    return { items: rows.map((r) => ({ itemId: r.item_id, name: items.get(r.item_id)?.name ?? null, type: items.get(r.item_id)?.type ?? null, year: items.get(r.item_id)?.year ?? null, leavesAt: r.leaves_at, days: r.days, note: r.note, setBy: r.by })) };
  }));
  app.put('/api/admin/leaving/:id', admin, wrap(async (req, reply) => {
    const id = id32.parse((req.params as { id: string }).id);
    const b = z.object({ leavesAt: dateOnly, note: z.string().trim().max(200).nullish() }).parse(req.body);
    const item = await ctx.jf.item(req.jfUser!, id);
    if (item.type !== 'Movie' && item.type !== 'Series' && item.type !== 'BoxSet') return reply.code(400).send({ error: 'not_a_title' });
    const ok = await ctx.db.query<{ ok: boolean }>('select ($1::date >= $2::date and $1::date <= $2::date + 730) as ok', [b.leavesAt, instanceToday()]);
    if (!ok.rows[0]?.ok) return reply.code(400).send({ error: 'date_out_of_range' });
    await ctx.db.query(
      `insert into leaving_soon(item_id, leaves_at, note, set_by) values ($1, $2, $3, $4)
       on conflict (item_id) do update set leaves_at = excluded.leaves_at, note = excluded.note, set_by = excluded.set_by`,
      [id, b.leavesAt, b.note || null, req.user!.id],
    );
    await audit(ctx, req.user!.id, 'leaving.set', id, { name: item.name, leavesAt: b.leavesAt });
    await bumpHomeAll(ctx);
    return { itemId: id, leavesAt: b.leavesAt, note: b.note || null };
  }));
  app.delete('/api/admin/leaving/:id', admin, async (req) => {
    const id = id32.parse((req.params as { id: string }).id);
    const r = await ctx.db.query('delete from leaving_soon where item_id = $1', [id]);
    if (r.rowCount) { await audit(ctx, req.user!.id, 'leaving.clear', id); await bumpHomeAll(ctx); }
    return { ok: true };
  });

  // ---- browse filter 4K / HDR: candidate ids from the quality index, details (visibility, every other filter) from the media server ----
  app.get('/api/library/quality', { ...pre, config: perSession(60) }, wrap(async (req) => {
    const q = qualityQuery.parse(req.query);
    if (!ctx.jf.libraryMediaTraits) return { items: [], total: 0, unsupported: true };
    const { quality: _q, audio: _a, subs: _s, start, limit, desc: d, types, ...rest } = q;
    // The sorted list of ids THIS viewer can see is cached briefly per media-server identity (a kids profile has its own, so its
    // parental limits apply) + every filter; played / favourite filters also carry the user-data version (a new play re-scans).
    const { start: _st, limit: _l, ...shape } = q;
    const ver = q.filter ? await ctx.jf.userDataVersion(req.jfUser!).catch(() => String(Date.now())) : '';
    const key = `qlist:${req.jfUser!.jellyfin_user_id}:${ver}:${JSON.stringify(Object.entries(shape).sort(([a], [b]) => a.localeCompare(b)))}`;
    let cached: { ids: string[]; capped: boolean } | null = null;
    try { cached = JSON.parse((await ctx.kv.get(key).catch(() => null)) ?? 'null'); } catch { /* broken entry: recompute */ }
    if (cached && Array.isArray(cached.ids)) { // a page = one or a few id lookups, still with the viewer's own identity
      const page = await itemsByIds(ctx, req.jfUser!, cached.ids.slice(start, start + limit), true);
      return { items: page, total: cached.ids.length, ...(cached.capped ? { capped: true } : {}) };
    }
    const want = q.quality.split(',');
    const where = ['q.type = $1'];
    const params: unknown[] = [q.types];
    if (want.includes('4k')) where.push("q.res = '4k'");
    if (want.includes('hdr')) where.push('q.hdr is not null');
    let from = 'item_quality q';
    if (q.audio || q.subs) {
      from += ' join item_langs l on l.item_id = q.item_id';
      if (q.audio) { params.push([q.audio]); where.push(`l.audio @> $${params.length}::text[]`); }
      if (q.subs) { params.push([q.subs]); where.push(`l.subs @> $${params.length}::text[]`); }
    }
    const ids = (await ctx.db.query<{ item_id: string }>(`select q.item_id from ${from} where ${where.join(' and ')} order by q.item_id limit ${QUALITY_CAP}`, params)).rows.map((r) => r.item_id);
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += QUALITY_CHUNK) chunks.push(ids.slice(i, i + QUALITY_CHUNK));
    const parts = await inPool(chunks, QUALITY_PARALLEL, async (c) =>
      (await ctx.jf.items(req.jfUser!, { ...rest, types, desc: false, ids: c, limit: QUALITY_CHUNK, start: 0 })).items);
    const items = parts.flat();
    const date = (v?: string) => (v ? Date.parse(v) || 0 : 0);
    const desc = d === 'true';
    const cmp = q.sort === 'CommunityRating' ? (a: ItemDto, b: ItemDto) => (a.communityRating ?? 0) - (b.communityRating ?? 0)
      : q.sort === 'DateCreated' ? (a: ItemDto, b: ItemDto) => (date(a.dateCreated) || date(a.premiereDate)) - (date(b.dateCreated) || date(b.premiereDate))
      : q.sort === 'PremiereDate' ? (a: ItemDto, b: ItemDto) => date(a.premiereDate) - date(b.premiereDate)
      : (a: ItemDto, b: ItemDto) => a.name.localeCompare(b.name, 'de');
    items.sort((a, b) => (desc ? -1 : 1) * (cmp(a, b) || a.name.localeCompare(b.name, 'de')));
    const capped = ids.length >= QUALITY_CAP;
    await ctx.kv.set(key, JSON.stringify({ ids: items.map((i) => i.id), capped }), QUALITY_LIST_TTL).catch(() => undefined);
    return { items: items.slice(start, start + limit), total: items.length, ...(capped ? { capped: true } : {}) };
  }));

  // ---- "Story so far" for a series: metadata only; null when nothing applies ----
  app.get('/api/items/:id/story', pre, wrap(async (req) => {
    const id = id32.parse((req.params as { id: string }).id);
    const item = await ctx.jf.item(req.jfUser!, id);
    if (item.type !== 'Series') return { story: null };
    return { story: await storySoFar(ctx, req.jfUser!, id) };
  }));
}
