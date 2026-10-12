import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { JellyfinError } from '../jellyfin/client.js';
import type { ItemDto } from '../jellyfin/dto.js';
import { m } from '../i18n.js';
import { notify } from '../notify.js';
import { clipPath, previews } from '../previews.js';
import { loadPrefs } from './prefs.js';
import { requireUser } from '../session.js';
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
  const parts: ItemDto[][] = new Array(chunks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, async () => {
    while (next < chunks.length) {
      const n = next++;
      parts[n] = (await ctx.jf.items(user, { ids: chunks[n], types: 'Movie,Series,Episode,BoxSet', limit: 40 }).catch((e) => { if (strict) throw e; return { items: [] as ItemDto[] }; })).items;
    }
  }));
  const byId = new Map(parts.flat().map((i) => [i.id, i]));
  return ids.map((i) => byId.get(i)).filter((x): x is ItemDto => Boolean(x));
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

export function discoverRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };

  // ---- Group matcher: "what has none of us watched yet?" (opt-in per participant) ----
  app.get('/api/friends', pre, async (req) => {
    const r = await ctx.db.query<{ id: string; name: string; share: boolean | null }>(
      `select u.id, u.name, (p.data->>'shareHistory')::boolean as share from users u left join user_prefs p on p.user_id = u.id where u.id <> $1 and not u.disabled order by u.name`,
      [req.user!.id],
    );
    return { friends: r.rows.map((f) => ({ id: f.id, name: f.name, sharesHistory: f.share === true })) };
  });

  app.post('/api/match', { ...pre, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, wrap(async (req, reply) => {
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
  app.post('/api/recommend', pre, wrap(async (req, reply) => {
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

  app.get('/api/recommendations', pre, wrap(async (req) => {
    const rows = (await ctx.db.query<{ id: string; item_id: string; note: string | null; from_name: string }>(
      `select r.id, r.item_id, r.note, u.name from_name from recommendations r join users u on u.id=r.from_user
        where r.to_user=$1 and r.created_at > now() - interval '60 days' order by r.seen, r.created_at desc limit 30`, [req.user!.id])).rows;
    const items = await itemsByIds(ctx, req.jfUser!, [...new Set(rows.map((r) => r.item_id))]);
    const meta = new Map(rows.map((r) => [r.item_id, `Von ${r.from_name}${r.note ? `: ${r.note}` : ''}`]));
    const shown = new Set(items.map((i) => i.id));
    return { items: items.map((i) => ({ ...i, caption: meta.get(i.id) })), recIds: rows.filter((r) => shown.has(r.item_id)).map((r) => Number(r.id)) }; // recIds: send back to /seen
  }));
  app.post('/api/recommendations/seen', pre, async (req) => {
    const b = z.object({ ids: z.array(z.union([z.number().int().positive(), z.string().regex(/^\d{1,15}$/)])).max(200).optional() }).nullish().parse(req.body);
    if (b?.ids) await ctx.db.query('update recommendations set seen = true where to_user = $1 and id = any($2::bigint[])', [req.user!.id, b.ids.map(String)]);
    else await ctx.db.query('update recommendations set seen = true where to_user = $1', [req.user!.id]); // legacy: no body marks everything
    return { ok: true };
  });

  app.get('/api/library/friends-rated', pre, wrap(async (req) => {
    const rows = (await ctx.db.query<{ item_id: string; names: string[]; avg: string }>(
      `select r.item_id, array_agg(u.name || ' ' || r.stars || '★' order by r.created_at desc) names, avg(r.stars) avg
         from ratings r join users u on u.id = r.user_id left join user_prefs p on p.user_id = r.user_id
        where r.user_id <> $1 and r.stars >= 4 and r.created_at > now() - interval '90 days' and not u.disabled
          and coalesce((p.data->>'shareRatings')::boolean, true)
          and r.item_id not in (select item_id from ratings where user_id = $1)
          and r.item_id not in (select item_id from thumbs where profile_id = $2 and value = -1)
        group by r.item_id order by max(r.created_at) desc limit 24`, [req.user!.id, req.profile!.id])).rows;
    const items = await itemsByIds(ctx, req.jfUser!, rows.map((r) => r.item_id));
    const cap = new Map(rows.map((r) => [r.item_id, r.names.slice(0, 2).join(', ')]));
    return { items: items.filter((i) => !i.played).map((i) => ({ ...i, caption: cap.get(i.id) })) };
  }));

  // ---- Thumbs: -1 Nicht mein Fall, 1 Gefällt mir, 2 Super (>= 1 feeds "Weil du ... gesehen hast") ----
  app.put('/api/items/:id/thumb', pre, wrap(async (req) => {
    const id = id32.parse((req.params as { id: string }).id);
    const { value } = z.object({ value: z.union([z.literal(-1), z.literal(0), z.literal(1), z.literal(2)]) }).parse(req.body);
    if (value === 0) {
      await ctx.db.query('delete from thumbs where profile_id=$1 and item_id=$2', [req.profile!.id, id]);
      return { value: 0 };
    }
    const item = await ctx.jf.item(req.jfUser!, id);
    await ctx.db.query(
      `insert into thumbs(profile_id,user_id,item_id,value,item_name) values ($1,$2,$3,$4,$5)
       on conflict (profile_id,item_id) do update set value = excluded.value, created_at = now()`,
      [req.profile!.id, req.user!.id, id, value, item.name],
    );
    return { value };
  }));

  // ---- X-Ray (cast), extras, hover trailer, collections, studios ----
  app.get('/api/items/:id/people', pre, wrap(async (req) => ({ people: await ctx.jf.people(req.jfUser!, id32.parse((req.params as { id: string }).id)) })));
  app.get('/api/items/:id/extras', pre, wrap(async (req) => ({ items: await ctx.jf.extras(req.jfUser!, id32.parse((req.params as { id: string }).id)) })));
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
      if (e instanceof JellyfinError && (e.status === 404 || e.status === 403)) return null;
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
  app.get('/api/seerr/upcoming', pre, wrap(async (req) => {
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
