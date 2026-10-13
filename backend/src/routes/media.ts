import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { MediaError, type ItemDto } from '../media/types.js';
import { clearLive, countLive, getLive, listLive, setLive } from '../live.js';
import { isHomeRequest } from '../netaddr.js';
import { effectiveRole, remoteBitrateCap } from '../roles.js';
import { requireGrownUp } from '../kids.js';
import { requireUser } from '../session.js';
import { playbackHooks } from '../hooks.js';
import { bumpHome } from '../homegen.js';
import { nextUpItems, resumeItems } from '../resumeRows.js';
import { createHash } from 'node:crypto';
import { itemsByIds, libraryBecause } from './discover.js';
import { id32 as itemId, wrap as sharedWrap } from './_shared.js';

const psId = z.string().regex(/^[\w-]{8,64}$/);

const listQuery = z.object({
  parentId: itemId.optional(),
  q: z.string().max(100).optional(),
  types: z.string().regex(/^[A-Za-z,]+$/).max(80).optional(),
  sort: z.enum(['SortName', 'DateCreated', 'PremiereDate', 'CommunityRating', 'Random']).optional(),
  desc: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  start: z.coerce.number().int().min(0).optional(),
  filter: z.enum(['favorites', 'unplayed', 'played']).optional(),
  genre: z.string().max(300).optional(), // several genres separated by | (Jellyfin: any of)
  studio: z.string().max(80).optional(),
  decade: z.coerce.number().int().min(1900).max(2090).refine((n) => n % 10 === 0).optional(),
  year: z.coerce.number().int().min(1900).max(2100).optional(),
  minRating: z.coerce.number().min(0).max(10).optional(),
  person: itemId.optional(),
  audio: z.string().regex(/^[a-z]{3}$/).optional(), // audio language (ISO 639-2/T), answered from the item_langs index
  subs: z.string().regex(/^[a-z]{3}$/).optional(),
});

const reportBody = z.object({
  itemId,
  playSessionId: psId,
  mediaSourceId: z.string().regex(/^[\w-]{1,64}$/),
  positionTicks: z.number().int().min(0),
  isPaused: z.boolean().default(false),
  audioIndex: z.number().int().optional(),
  subtitleIndex: z.number().int().optional(),
  playMethod: z.enum(['DirectPlay', 'DirectStream', 'Transcode']).optional(),
});

/** Maps upstream errors to a clean 502/4xx without leaking details. */
const wrap = <T extends (...a: any[]) => Promise<any>>(fn: T): T => sharedWrap(fn, { zod: 'issues', passthrough: [404, 403] });

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const LANG_CAP = 5000;
const LANG_CHUNK = 80; // ids per Jellyfin call: keeps the request line well under 8 KB
const LANG_CACHE_TTL = 120;
const LANG_RATE_MAX = 30; // language-path queries per user and minute

export function mediaRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };
  const grown = { preHandler: requireGrownUp(ctx) }; // friends' activity (now playing): not on kids profiles

  /**
   * Language path of /api/library/items: candidate ids come from the item_langs index, details (and with them visibility and every
   * other filter) from Jellyfin with the viewer's token, then sorted/paginated here. The merged id order is cached briefly.
   */
  async function itemsByLanguage(req: any, q: z.infer<typeof listQuery>): Promise<{ items: ItemDto[]; total: number; capped?: true }> {
    const start = q.start ?? 0;
    const limit = Math.min(q.limit ?? 60, 200);
    const desc = q.desc === 'true';
    const { audio, subs, start: _s, limit: _l, ...rest } = q;
    const jfUser = req.jfUser!;
    const key = `langitems:${jfUser.jellyfin_user_id}:${createHash('sha1').update(JSON.stringify(Object.entries({ ...rest, audio, subs }).sort())).digest('hex')}`;
    const hit = await ctx.kv.get(key).catch(() => null);
    if (hit) {
      try {
        const parsed = JSON.parse(hit) as string[] | { ids: string[]; capped?: boolean };
        const ids = Array.isArray(parsed) ? parsed : parsed.ids;
        const capped = !Array.isArray(parsed) && parsed.capped === true;
        const page = ids.slice(start, start + limit);
        const got: ItemDto[] = [];
        for (let i = 0; i < page.length; i += LANG_CHUNK) got.push(...(await ctx.jf.items(jfUser, { ids: page.slice(i, i + LANG_CHUNK), types: q.types ?? 'Movie,Series', limit: LANG_CHUNK })).items);
        await ctx.kv.set(key, hit, LANG_CACHE_TTL).catch(() => undefined); // paging extends the lifetime so "Mehr laden" never reshuffles mid-scroll
        const byId = new Map(got.map((i) => [i.id, i]));
        return { items: page.map((id) => byId.get(id)).filter((x): x is ItemDto => Boolean(x)), total: ids.length, ...(capped ? { capped: true as const } : {}) };
      } catch (e) {
        if (e instanceof MediaError) throw e;
        // corrupt cache entry: recompute
      }
    }
    const wanted = (q.types ?? 'Movie,Series').split(',').filter((t) => t === 'Movie' || t === 'Series');
    let ids: string[] = [];
    let capped = false;
    if (wanted.length) {
      const where: string[] = ['type = any($1)'];
      const params: unknown[] = [wanted];
      if (audio) { params.push([audio]); where.push(`audio @> $${params.length}::text[]`); }
      if (subs) { params.push([subs]); where.push(`subs @> $${params.length}::text[]`); }
      ids = (await ctx.db.query<{ item_id: string }>(`select item_id from item_langs where ${where.join(' and ')} order by item_id limit ${LANG_CAP + 1}`, params)).rows.map((r) => r.item_id);
      if (ids.length > LANG_CAP) { capped = true; ids = ids.slice(0, LANG_CAP); }
    }
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += LANG_CHUNK) chunks.push(ids.slice(i, i + LANG_CHUNK));
    const parts: ItemDto[][] = new Array(chunks.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, async () => {
      while (next < chunks.length) {
        const n = next++;
        parts[n] = (await ctx.jf.items(jfUser, { ...rest, desc: false, ids: chunks[n], limit: LANG_CHUNK, start: 0, parentId: rest.parentId })).items;
      }
    }));
    const items = parts.flat();
    const date = (s?: string) => (s ? Date.parse(s) || 0 : 0);
    const sort = q.sort ?? 'SortName';
    const ts = (i: ItemDto) => (sort === 'DateCreated' ? date(i.dateCreated) || date(i.premiereDate) : date(i.premiereDate));
    if (sort === 'Random') shuffle(items);
    else {
      const cmp = sort === 'CommunityRating' ? (a: ItemDto, b: ItemDto) => (a.communityRating ?? 0) - (b.communityRating ?? 0)
        : sort === 'PremiereDate' || sort === 'DateCreated' ? (a: ItemDto, b: ItemDto) => ts(a) - ts(b)
        : (a: ItemDto, b: ItemDto) => a.name.localeCompare(b.name, 'de');
      items.sort((a, b) => (desc ? -1 : 1) * (cmp(a, b) || a.name.localeCompare(b.name, 'de')));
    }
    await ctx.kv.set(key, JSON.stringify({ ids: items.map((i) => i.id), capped }), LANG_CACHE_TTL).catch(() => undefined);
    return { items: items.slice(start, start + limit), total: items.length, ...(capped ? { capped: true as const } : {}) };
  }

  // Audio/subtitle languages present in the library (codes + counts only, no titles -> nothing visibility-dependent leaks).
  app.get('/api/library/languages', pre, async () => {
    const hit = await ctx.kv.get('langs:summary').catch(() => null);
    if (hit) return JSON.parse(hit) as { audio: Array<{ code: string; count: number }>; subs: Array<{ code: string; count: number }> };
    const top = async (col: 'audio' | 'subs') =>
      (await ctx.db.query<{ code: string; count: number }>(`select c as code, count(*)::int as count from item_langs, unnest(${col}) c group by c order by count desc, code limit 20`)).rows;
    const out = { audio: await top('audio'), subs: await top('subs') };
    await ctx.kv.set('langs:summary', JSON.stringify(out), 600).catch(() => undefined);
    return out;
  });

  app.get('/api/library/views', pre, wrap(async (req) => ({ items: await ctx.jf.views(req.jfUser!) })));

  app.get('/api/library/items', pre, wrap(async (req, reply) => {
    const q = listQuery.parse(req.query);
    if (q.audio || q.subs) {
      // the language path fans out to many Jellyfin calls: cap it per user (Fastify's per-route limit cannot be conditional)
      if ((await ctx.kv.incr(`ratelimit:langitems:${req.user!.id}`, 60).catch(() => 0)) > LANG_RATE_MAX) return reply.code(429).send({ error: 'rate_limited' });
      return itemsByLanguage(req, q);
    }
    const { audio: _a, subs: _b, ...plain } = q;
    return ctx.jf.items(req.jfUser!, { ...plain, desc: q.desc === 'true' });
  }));

  app.get('/api/library/genres', pre, wrap(async (req) => ({ genres: await ctx.jf.genres(req.jfUser!) })));

  // "Überrasch mich": one random title, optionally by type/genre, unwatched by default.
  app.get('/api/library/random', pre, wrap(async (req, reply) => {
    const q = z.object({
      type: z.enum(['Movie', 'Series']).default('Movie'),
      genre: z.string().max(300).optional(), // several genres separated by | (Jellyfin: any of)
      unplayed: z.enum(['true', 'false']).default('true'),
    }).parse(req.query);
    const r = await ctx.jf.items(req.jfUser!, { types: q.type, genre: q.genre, sort: 'Random', limit: 1, filter: q.unplayed === 'true' ? 'unplayed' : undefined });
    return r.items[0] ? { item: r.items[0] } : reply.code(404).send({ error: 'nothing_found' });
  }));

  app.get('/api/library/resume', pre, wrap(async (req) => ({ items: await resumeItems(ctx, req.jfUser!, req.profile!.id) })));
  // "Remove from Weiterschauen": hides the item for this profile until it is played again (progress itself stays).
  app.delete('/api/library/resume/:id', pre, wrap(async (req) => {
    const id = itemId.parse((req.params as any).id);
    // tidyResume keeps one entry per series, so an episode is hidden by its series id
    const it = await ctx.jf.item(req.jfUser!, id).catch(() => null);
    await ctx.db.query(
      'insert into resume_hidden(profile_id,item_id) values ($1,$2) on conflict (profile_id,item_id) do update set hidden_at=now()',
      [req.profile!.id, it?.seriesId ?? id],
    );
    await bumpHome(ctx, req.profile!.id);
    return { ok: true };
  }));

  // Viewing history (Jellyfin played items + in-progress), removal marks unplayed.
  app.get('/api/history', pre, wrap(async (req) => {
    const q = z.object({ start: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query);
    return { items: await ctx.jf.history(req.jfUser!, q) };
  }));
  app.delete('/api/history/:id', pre, wrap(async (req) => {
    const id = itemId.parse((req.params as any).id);
    const { scope } = z.object({ scope: z.enum(['item', 'series']).default('item') }).parse(req.query);
    let target = id;
    if (scope === 'series') {
      const it = await ctx.jf.item(req.jfUser!, id);
      if (it.seriesId) target = it.seriesId;
    }
    await ctx.jf.setPlayed(req.jfUser!, target, false); // Jellyfin cascades unplayed to a series' episodes
    await ctx.db.query('delete from resume_hidden where profile_id=$1 and item_id in ($2,$3)', [req.profile!.id, id, target]);
    await bumpHome(ctx, req.profile!.id);
    return { ok: true };
  }));
  // ?seriesId= asks Jellyfin for that series' next episode directly (the global list is capped at 20, so a client-side filter can miss it)
  app.get('/api/library/nextup', pre, wrap(async (req) => {
    const { seriesId } = z.object({ seriesId: itemId.optional() }).parse(req.query);
    return { items: await nextUpItems(ctx, req.jfUser!, req.profile!.id, seriesId) };
  }));

  app.get('/api/items/:id', pre, wrap(async (req) => {
    const id = itemId.parse((req.params as any).id);
    const item = await ctx.jf.item(req.jfUser!, id);
    const inWatchlist = (await ctx.db.query('select 1 from watchlist where profile_id=$1 and item_id=$2', [req.profile!.id, id])).rowCount! > 0;
    const th = await ctx.db.query<{ value: number }>('select value from thumbs where profile_id=$1 and item_id=$2', [req.profile!.id, id]);
    const lr = (await ctx.db.query<{ audio: string[]; subs: string[] }>('select audio, subs from item_langs where item_id=$1', [item.type === 'Episode' && item.seriesId ? item.seriesId : id])).rows[0];
    return { item, inWatchlist, thumb: th.rows[0]?.value ?? 0, ...(lr ? { langs: { audio: lr.audio, subs: lr.subs } } : {}) };
  }));
  // Subtitles served by FriendFlix (capabilities.subtitleExtract: PlaybackDto subtitle URLs point here); works for every server.
  app.get('/api/items/:id/subtitle/:ms/:index/stream.vtt', pre, sharedWrap(async (req, reply) => {
    const p = z.object({ id: itemId, ms: z.string().regex(/^[\w-]{1,64}$/), index: z.coerce.number().int().min(0).max(999) }).parse(req.params);
    await ctx.jf.item(req.jfUser!, p.id); // 404/403 for items the profile cannot see
    const res = await ctx.jf.subtitleStream(req.jfUser!, p.id, p.ms, p.index, 'vtt');
    if (!res.ok) return reply.code(404).send({ error: 'not_found' });
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > 10 * 1024 * 1024) return reply.code(502).send({ error: 'jellyfin', reason: 'too_large' });
    return reply.header('content-type', 'text/vtt; charset=utf-8').header('cache-control', 'private, no-store').send(body);
  }, { zod: 'plain', notFound: [400, 403, 404] }));

  app.get('/api/items/:id/segments', pre, wrap(async (req) => ({ segments: await ctx.jf.segments(req.jfUser!, itemId.parse((req.params as any).id)) })));
  app.get('/api/items/:id/similar', pre, wrap(async (req) => ({ items: await ctx.jf.similar(req.jfUser!, itemId.parse((req.params as any).id)) })));
  app.get('/api/library/because', pre, wrap(async (req) => libraryBecause(ctx, req.jfUser!, req.profile!.id)));
  app.get('/api/items/:id/seasons', pre, wrap(async (req) => ({ items: await ctx.jf.seasons(req.jfUser!, itemId.parse((req.params as any).id)) })));
  app.get('/api/items/:id/episodes', pre, wrap(async (req) => {
    const seasonId = z.object({ seasonId: itemId.optional() }).parse(req.query).seasonId;
    return { items: await ctx.jf.episodes(req.jfUser!, itemId.parse((req.params as any).id), seasonId) };
  }));

  for (const [path, fn] of [
    ['favorite', 'setFavorite'],
    ['played', 'setPlayed'],
  ] as const) {
    app.post(`/api/items/:id/${path}`, pre, wrap(async (req) => { await ctx.jf[fn](req.jfUser!, itemId.parse((req.params as any).id), true); return { ok: true }; }));
    app.delete(`/api/items/:id/${path}`, pre, wrap(async (req) => { await ctx.jf[fn](req.jfUser!, itemId.parse((req.params as any).id), false); return { ok: true }; }));
  }

  // Watchlist lives in Postgres (Jellyfin has no equivalent).
  app.get('/api/watchlist', pre, wrap(async (req) => {
    const r = await ctx.db.query<{ item_id: string }>('select item_id from watchlist where profile_id=$1 order by added_at desc limit 200', [req.profile!.id]);
    if (!r.rows.length) return { items: [] };
    return { items: (await ctx.jf.items(req.jfUser!, { ids: r.rows.map((x) => x.item_id), types: 'Movie,Series,Episode', limit: 200 })).items };
  }));
  // Lightweight id list so cards can show the "Merkliste" state without loading every item.
  app.get('/api/watchlist/ids', pre, async (req) => ({
    ids: (await ctx.db.query<{ item_id: string }>('select item_id from watchlist where profile_id=$1', [req.profile!.id])).rows.map((r) => r.item_id),
  }));
  app.post('/api/items/:id/watchlist', pre, wrap(async (req) => {
    const id = itemId.parse((req.params as any).id);
    await ctx.db.query('insert into watchlist(profile_id,user_id,item_id) values ($1,$2,$3) on conflict do nothing', [req.profile!.id, req.user!.id, id]);
    await ctx.db.query('delete from dropped where profile_id=$1 and item_id=$2', [req.profile!.id, id]); // planning a title again ends "abgebrochen"
    return { ok: true };
  }));
  app.delete('/api/items/:id/watchlist', pre, wrap(async (req) => {
    await ctx.db.query('delete from watchlist where profile_id=$1 and item_id=$2', [req.profile!.id, itemId.parse((req.params as any).id)]);
    return { ok: true };
  }));

  // ---- Playback ----
  app.post('/api/playback/info', pre, wrap(async (req, reply) => {
    const b = z.object({
      itemId, startTicks: z.number().int().min(0).optional(), audioIndex: z.number().int().min(0).optional(), maxBitrate: z.number().int().min(300_000).max(200_000_000).optional(),
      /** preferred audio language (saved pref / detail-page pick): applied in this same request, so the player needs no second round trip */
      audioLang: z.string().max(16).optional(),
      /** why the viewer lowered maxBitrate (menu pick or auto-ABR); only used when that choice is the binding cap */
      reasonHint: z.enum(['network', 'manual']).optional(),
    }).parse(req.body);
    const role = (await effectiveRole(ctx, req.user!.role))!;
    if ((await countLive(ctx, req.user!.id)) >= role.maxStreams) return reply.code(429).send({ error: 'max_streams', max: role.maxStreams });
    // outside the home networks the role's remote cap applies on top; the viewer may lower the quality, never raise it above the limit
    const remote = !isHomeRequest(req, ctx.cfg.HOME_NETWORKS);
    const ceiling = remote ? remoteBitrateCap(role) : role.maxBitrate; // the quality menu's upper bound (the client's own pick is not a ceiling)
    const cap = Math.min(ceiling, b.maxBitrate ?? role.maxBitrate);
    const capReason: 'remoteCap' | 'roleCap' | 'manual' | 'network' = b.maxBitrate !== undefined && b.maxBitrate < ceiling ? (b.reasonHint ?? 'network') : remote && ceiling < role.maxBitrate ? 'remoteCap' : 'roleCap';
    // PlaybackInfo and the resume-position/trickplay lookup run in parallel (one Jellyfin /Items call instead of two sequential ones)
    const opts = { maxBitrate: cap, capReason, maxHeight: role.maxHeight, startTicks: b.startTicks, audioIndex: b.audioIndex, audioLang: b.audioLang, noDirect: Boolean(role.maxHeight) || (!role.download && ctx.cfg.DIRECT_PLAY_REQUIRES_DOWNLOAD === 'true') };
    const [first, meta] = await Promise.all([ctx.jf.playbackInfo(req.jfUser!, b.itemId, opts), ctx.jf.playMeta(req.jfUser!, b.itemId)]);
    let info = first;
    // optional server step before the player loads the master playlist (decision call, audio/subtitle selection); Jellyfin has none
    if (ctx.jf.preparePlayback) info = await ctx.jf.preparePlayback(req.jfUser!, info, opts);
    info.roleMaxBitrate = ceiling;
    let resume = b.startTicks ?? meta?.positionTicks;
    if (resume === undefined) {
      // The /Items lookup failed or came back empty: a silent 0 would let the first progress report overwrite the saved
      // Jellyfin position, so ask the single-item endpoint instead and make the player retry (502) when that fails too.
      resume = await ctx.jf.item(req.jfUser!, b.itemId).then((i) => i.positionTicks, () => undefined);
      if (resume === undefined) return reply.code(502).send({ error: 'jellyfin', reason: 'resume_unknown' });
    }
    info.resumeTicks = resume;
    info.trickplay = meta?.trickplay(info.mediaSourceId);
    return info;
  }));

  const report = (kind: 'Playing' | 'Playing/Progress' | 'Playing/Stopped') =>
    wrap(async (req: any, reply: any) => {
      const b = reportBody.parse(req.body);
      const user = req.user!;
      const ticks = Math.floor(b.positionTicks);
      let live = await getLive(ctx, user.id, b.playSessionId);
      let elapsed = true;
      if (!live) {
        // Start takes a stream slot. Progress/Stopped after TTL expiry are still forwarded (a sleeping tab must not lose its position)
        // and rebuild the live record without counting against maxStreams.
        if (kind === 'Playing') {
          const role = (await effectiveRole(ctx, user.role))!;
          if ((await countLive(ctx, user.id)) >= role.maxStreams) return reply.code(429).send({ error: 'max_streams', max: role.maxStreams });
        }
        const item = await ctx.jf.item(req.jfUser!, b.itemId); // access check: the user must be able to see the item
        elapsed = false;
        live = {
          userId: user.id, userName: user.name, profileName: req.profile?.is_owner ? undefined : req.profile?.name, itemId: b.itemId, title: item.name, seriesName: item.seriesName, type: item.type,
          positionTicks: ticks, runtimeTicks: item.runtimeTicks, isPaused: false, playSessionId: b.playSessionId, updatedAt: Date.now(), source: 'portal',
        };
      }
      const prev = live.updatedAt;
      live = { ...live, positionTicks: ticks, isPaused: b.isPaused, updatedAt: Date.now() };
      await ctx.jf.report(req.jfUser!, {
        event: kind === 'Playing' ? 'start' : kind === 'Playing/Stopped' ? 'stop' : 'progress',
        itemId: b.itemId, mediaSourceId: b.mediaSourceId, playSessionId: b.playSessionId, positionTicks: ticks, paused: b.isPaused,
        audioIndex: b.audioIndex, subtitleIndex: b.subtitleIndex, playMethod: b.playMethod,
      });
      if (kind === 'Playing/Stopped') await clearLive(ctx, user.id, b.playSessionId);
      else await setLive(ctx, live);
      await playbackHooks.run(ctx, { kind, user, live, elapsedMs: elapsed ? Math.min(Date.now() - prev, 30_000) : 0 });
      return { ok: true };
    });
  app.post('/api/playback/start', pre, report('Playing'));
  app.post('/api/playback/progress', pre, report('Playing/Progress'));
  app.post('/api/playback/stop', pre, report('Playing/Stopped'));

  // Own sessions plus those of accounts that opted in via "Verlauf teilen"; only titles the viewer may see. Admins use the admin endpoints.
  app.get('/api/nowplaying', grown, async (req) => {
    const me = req.user!.id;
    const live = await listLive(ctx);
    const others = [...new Set(live.filter((l) => l.userId !== me).map((l) => l.userId))];
    const sharing = new Set(others.length
      ? (await ctx.db.query<{ id: string }>(
          `select u.id from users u join user_prefs p on p.user_id = u.id
            where u.id = any($1::uuid[]) and not u.disabled and p.data->>'shareHistory' = 'true'`, [others])).rows.map((r) => r.id)
      : []);
    const shown = live.filter((l) => l.userId === me || sharing.has(l.userId));
    if (!shown.length) return { items: [] };
    const norm = (id: string) => id.replace(/-/g, '').toLowerCase(); // the Jellyfin webhook may send dashed ids
    const visible = new Set((await itemsByIds(ctx, req.jfUser!, [...new Set(shown.map((l) => norm(l.itemId)))])).map((i) => norm(i.id)));
    return {
      items: shown.filter((l) => visible.has(norm(l.itemId))).map((l) => ({
        user: l.userName, itemId: l.itemId, title: l.title, seriesName: l.seriesName,
        positionTicks: l.positionTicks, runtimeTicks: l.runtimeTicks, isPaused: l.isPaused,
      })),
    };
  });
}
