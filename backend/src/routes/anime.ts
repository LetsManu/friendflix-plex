import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { JellyfinError } from '../jellyfin/client.js';
import { toItemDto, type ItemDto } from '../jellyfin/dto.js';
import { requireGrownUp } from '../kids.js';
import { requireUser } from '../session.js';
import type { JfUser } from '../types.js';
import { id32, wrap as sharedWrap } from './_shared.js';

/** Block 15 anime pack: series audio/subtitle preference, simulcast season view, friends-only episode comments. */

const wrap = <T extends (...a: any[]) => Promise<any>>(fn: T): T => sharedWrap(fn, { zod: 'plain', notFound: [404, 403, 400] });

const isWatched = (i: ItemDto) => i.played || (i.playedPercentage ?? 0) >= 85;
/** Jellyfin language code as the player uses it (ISO 639-2 'jpn', 'ger' or a short 'ja'/'pt-BR'); 'und' stays out */
const LANG = z.string().trim().toLowerCase().regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/);
const COMMENT_MAX = 1000;
/** a profile may post this many comments per rolling 24 h (on top of the per-minute limit) */
export const COMMENTS_PER_DAY = 200;
const COMMENT_LIST_MAX = 100;

export type SimulcastSeason = 'winter' | 'spring' | 'summer' | 'fall';
/** anime season by calendar month (Jan-Mar winter ... Oct-Dec fall) */
export const seasonOf = (d: Date): { season: SimulcastSeason; year: number } => ({
  season: (['winter', 'spring', 'summer', 'fall'] as const)[Math.floor(d.getUTCMonth() / 3)]!,
  year: d.getUTCFullYear(),
});

/** Anime = genre "Anime", or "Animation" produced in Japan, or tagged "anime". */
export function isAnime(i: { Genres?: string[]; Tags?: string[]; ProductionLocations?: string[] }): boolean {
  const g = (i.Genres ?? []).map((x) => x.toLowerCase());
  if (g.includes('anime') || (i.Tags ?? []).some((x) => x.toLowerCase() === 'anime')) return true;
  return g.includes('animation') && (i.ProductionLocations ?? []).some((x) => /^(japan|jp|jpn)$/i.test(x.trim()));
}

/** Plain text comment: no control characters (newlines are kept, at most two in a row), trimmed. */
export function cleanComment(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

const SIM_WINDOW_DAYS = 28;
const SIM_TTL = 300;

export function animeRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };
  /** comments are social: kids profiles get 403 kids_profile */
  const social = { preHandler: requireGrownUp(ctx) };
  const writeLimit = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } });

  /** The visible item (series / episode ids are accepted where `types` allows), else a thrown JellyfinError -> 404. */
  const visible = (req: any, id: string) => ctx.jf.item(req.jfUser!, id);

  // ---- per-series audio / subtitle preference ----
  /** `id` may be a series or one of its episodes (the player only knows the episode id when it starts); null for movies. */
  const seriesIdOf = async (req: any, id: string): Promise<string | null> => {
    const it = await visible(req, id);
    if (it.type === 'Series') return it.id;
    if (it.type === 'Episode' && it.seriesId) {
      await visible(req, it.seriesId); // the whole series must be visible too
      return it.seriesId;
    }
    return null;
  };
  const prefView = (r?: { audio: string | null; subtitle: string | null }) => ({ audio: r?.audio ?? null, subtitle: r?.subtitle ?? null });

  /** isAnime() of a (visible) series; the genres/tags of a series rarely change: cached for an hour */
  const seriesIsAnime = async (req: any, sid: string): Promise<boolean> => {
    const key = `isanime:${sid}`;
    const hit = await ctx.kv.get(key);
    if (hit) return hit === '1';
    const qs = new URLSearchParams({ userId: req.jfUser!.jellyfin_user_id, ids: sid, includeItemTypes: 'Series', recursive: 'true', fields: 'Genres,Tags,ProductionLocations', enableImages: 'false', enableUserData: 'false' });
    const r = await ctx.jf.json<{ Items?: any[] }>(req.jfUser!, `/Items?${qs}`);
    const s = (r.Items ?? []).find((x) => String(x.Id).replace(/-/g, '').toLowerCase() === sid);
    const anime = Boolean(s && isAnime(s));
    await ctx.kv.set(key, anime ? '1' : '0', 3600);
    return anime;
  };

  // `?anime=1`: also tell whether the series is an anime (the player's "Anime: Originalton mit Untertiteln" setting needs it)
  app.get('/api/series/:id/langpref', pre, wrap(async (req) => {
    const sid = await seriesIdOf(req, id32.parse((req.params as { id: string }).id));
    const withAnime = z.object({ anime: z.enum(['0', '1']).optional() }).parse(req.query).anime === '1';
    if (!sid) return withAnime ? { ...prefView(), anime: false } : prefView();
    const r = await ctx.db.query<{ audio: string | null; subtitle: string | null }>('select audio, subtitle from series_langprefs where profile_id=$1 and series_id=$2', [req.profile!.id, sid]);
    return withAnime ? { ...prefView(r.rows[0]), anime: await seriesIsAnime(req, sid) } : prefView(r.rows[0]);
  }));

  app.put('/api/series/:id/langpref', { ...pre, config: writeLimit(60) }, wrap(async (req, reply) => {
    const b = z.object({ audio: LANG.nullable().optional(), subtitle: z.union([LANG, z.literal('off')]).nullable().optional() }).refine((x) => x.audio !== undefined || x.subtitle !== undefined).parse(req.body);
    const sid = await seriesIdOf(req, id32.parse((req.params as { id: string }).id));
    if (!sid) return reply.code(400).send({ error: 'unsupported_type' });
    // only the sent fields change (the player sends audio and subtitle choices separately); null clears one
    const r = await ctx.db.query<{ audio: string | null; subtitle: string | null }>(
      `insert into series_langprefs(profile_id, series_id, audio, subtitle) values ($1,$2,$3,$4)
       on conflict (profile_id, series_id) do update set
         audio = case when $5 then excluded.audio else series_langprefs.audio end,
         subtitle = case when $6 then excluded.subtitle else series_langprefs.subtitle end,
         updated_at = now()
       returning audio, subtitle`,
      [req.profile!.id, sid, b.audio ?? null, b.subtitle ?? null, b.audio !== undefined, b.subtitle !== undefined]);
    return prefView(r.rows[0]);
  }));

  app.delete('/api/series/:id/langpref', { ...pre, config: writeLimit(60) }, wrap(async (req) => {
    const sid = await seriesIdOf(req, id32.parse((req.params as { id: string }).id));
    if (sid) await ctx.db.query('delete from series_langprefs where profile_id=$1 and series_id=$2', [req.profile!.id, sid]);
    return prefView();
  }));

  // ---- simulcast: continuing series with episodes in the last / next 4 weeks, by weekday ----
  app.get('/api/simulcast', { ...pre, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, wrap(async (req) => {
    const only = z.object({ anime: z.enum(['0', '1']).optional() }).parse(req.query).anime === '1';
    const user = req.jfUser!;
    const key = `simulcast:${user.jellyfin_user_id}`;
    let all: SimulcastEntry[] | null = null;
    const hit = await ctx.kv.get(key).catch(() => null);
    if (hit) {
      try { all = JSON.parse(hit) as SimulcastEntry[]; } catch { all = null; }
    }
    if (!all) {
      all = await buildSimulcast(user);
      await ctx.kv.set(key, JSON.stringify(all), SIM_TTL).catch(() => undefined);
    }
    const list = only ? all.filter((e) => e.anime) : all;
    const days = Array.from({ length: 7 }, (_, weekday) => ({ weekday, items: list.filter((e) => e.weekday === weekday) }));
    // the running season = the one most episodes aired in
    const counts = new Map<string, { season: SimulcastSeason; year: number; n: number }>();
    for (const e of list) {
      const k = `${e.seasonYear}-${e.season}`;
      const c = counts.get(k) ?? { season: e.season, year: e.seasonYear, n: 0 };
      c.n++;
      counts.set(k, c);
    }
    const top = [...counts.values()].sort((a, b) => b.n - a.n)[0] ?? { ...seasonOf(new Date()), n: 0 };
    return { season: top.season, year: top.year, total: list.length, anime: only, days };
  }));

  interface SimulcastEntry {
    item: ItemDto;
    anime: boolean;
    weekday: number;
    /** the air time has a time of day (else only the date is known and the weekday is the UTC one) */
    timed: boolean;
    airsAt: string;
    season: SimulcastSeason;
    seasonYear: number;
    latest?: { id: string; name: string; season?: number; index?: number; premiereDate: string };
    next?: { id: string; name: string; season?: number; index?: number; premiereDate: string };
  }

  async function buildSimulcast(user: JfUser): Promise<SimulcastEntry[]> {
    const now = Date.now();
    const from = new Date(now - SIM_WINDOW_DAYS * 86_400_000).toISOString();
    const to = new Date(now + SIM_WINDOW_DAYS * 86_400_000).toISOString();
    const uid = user.jellyfin_user_id;
    const sp = new URLSearchParams({
      userId: uid, recursive: 'true', includeItemTypes: 'Series', seriesStatus: 'Continuing', limit: '300', sortBy: 'SortName',
      fields: 'Overview,Genres,Tags,ProductionLocations,OfficialRating,CommunityRating,PremiereDate,ProductionYear,ChildCount',
    });
    const ep = new URLSearchParams({
      userId: uid, recursive: 'true', includeItemTypes: 'Episode', minPremiereDate: from, maxPremiereDate: to, sortBy: 'PremiereDate', sortOrder: 'Descending', limit: '600',
      fields: 'PremiereDate', enableUserData: 'false', enableImages: 'false', enableTotalRecordCount: 'false',
    });
    const [series, eps] = await Promise.all([
      ctx.jf.json<{ Items: any[] }>(user, `/Items?${sp}`),
      ctx.jf.json<{ Items: any[] }>(user, `/Items?${ep}`),
    ]);
    const bySeries = new Map<string, any[]>();
    for (const e of eps.Items ?? []) {
      if (!e.SeriesId || !e.PremiereDate || !Number.isFinite(Date.parse(e.PremiereDate))) continue;
      const l = bySeries.get(String(e.SeriesId).replace(/-/g, '').toLowerCase()) ?? [];
      l.push(e);
      bySeries.set(String(e.SeriesId).replace(/-/g, '').toLowerCase(), l);
    }
    const mini = (e: any) => ({ id: e.Id as string, name: e.Name as string, season: e.ParentIndexNumber as number | undefined, index: e.IndexNumber as number | undefined, premiereDate: e.PremiereDate as string });
    const out: SimulcastEntry[] = [];
    for (const s of series.Items ?? []) {
      const list = bySeries.get(String(s.Id).replace(/-/g, '').toLowerCase());
      if (!list?.length) continue;
      const aired = list.filter((e) => Date.parse(e.PremiereDate) <= now); // list is newest first
      const upcoming = list.filter((e) => Date.parse(e.PremiereDate) > now);
      const latest = aired[0];
      const next = upcoming[upcoming.length - 1]; // soonest upcoming
      const ref = latest ?? next!;
      const d = new Date(ref.PremiereDate);
      const timed = d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0;
      const { season, year } = seasonOf(d);
      out.push({
        item: toItemDto(s), anime: isAnime(s), weekday: d.getUTCDay(), timed, airsAt: d.toISOString(), season, seasonYear: year,
        ...(latest ? { latest: mini(latest) } : {}), ...(next ? { next: mini(next) } : {}),
      });
    }
    return out;
  }

  // ---- friends-only comments on episodes / movies ----
  /** Visible Movie/Episode, or the reply that was sent instead. */
  const loadItem = async (req: any, reply: any): Promise<ItemDto | null> => {
    const id = id32.parse((req.params as { id: string }).id);
    let item: ItemDto;
    try {
      item = await ctx.jf.item(req.jfUser!, id);
    } catch (e) {
      if (e instanceof JellyfinError) {
        if (e.status === 404 || e.status === 403 || e.status === 400) reply.code(404).send({ error: 'not_found' });
        else reply.code(502).send({ error: 'jellyfin', status: e.status });
        return null;
      }
      throw e;
    }
    if (item.type !== 'Movie' && item.type !== 'Episode') {
      reply.code(400).send({ error: 'unsupported_type' });
      return null;
    }
    return item;
  };
  /** guests are not part of the friend circle: they neither see nor write comments */
  const isGuest = (req: any) => req.user!.role === 'guest';

  interface CommentRow { id: string; profile_id: string; name: string; body: string; spoiler: boolean; created_at: Date }
  const commentSelect = `select c.id, c.profile_id, case when p.is_owner then u.name else p.name end as name, c.body, c.spoiler, c.created_at
      from episode_comments c join users u on u.id = c.user_id join profiles p on p.id = c.profile_id
     where c.item_id = $1 and c.deleted_at is null and not u.disabled and u.role <> 'guest'`;

  /** moderation: an admin account acting as its owner profile (another profile of an admin's account is a normal reader) */
  const moderator = (req: any) => req.user!.role === 'admin' && Boolean(req.profile?.is_owner);
  /**
   * Every comment of somebody else is hidden from a reader who has not watched the title – whatever the author's own watched
   * state was (a comment written after watching is exactly the one that spoils). Own comments are never hidden.
   */
  const view = (row: CommentRow, req: any, watched: boolean, reveal: boolean) => {
    const mine = row.profile_id === req.profile!.id;
    const hidden = !mine && !watched;
    return {
      id: row.id, name: row.name, mine, spoiler: hidden, createdAt: row.created_at.toISOString(),
      // a hidden body only leaves the server when the reader asks for it ("Spoiler – trotzdem zeigen")
      ...(hidden && !reveal ? {} : { body: row.body }),
      canDelete: mine || moderator(req),
    };
  };

  app.get('/api/items/:id/comments', { ...social, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const item = await loadItem(req, reply);
    if (!item) return;
    if (isGuest(req)) return { watched: isWatched(item), comments: [] };
    const reveal = z.object({ reveal: z.enum(['0', '1']).optional() }).safeParse(req.query).data?.reveal === '1';
    const watched = isWatched(item);
    const rows = (await ctx.db.query<CommentRow>(`${commentSelect} order by c.created_at desc limit ${COMMENT_LIST_MAX}`, [item.id])).rows;
    return { watched, comments: rows.map((r) => view(r, req, watched, reveal)) };
  });

  app.post('/api/items/:id/comments', { ...social, config: writeLimit(10) }, async (req, reply) => {
    const parsed = z.object({ body: z.string().max(COMMENT_MAX * 2) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });
    const body = cleanComment(parsed.data.body);
    if (!body || body.length > COMMENT_MAX) return reply.code(400).send({ error: 'bad_request' });
    if (isGuest(req)) return reply.code(403).send({ error: 'forbidden' });
    const item = await loadItem(req, reply);
    if (!item) return;
    const day = Number((await ctx.db.query<{ n: string }>("select count(*) n from episode_comments where profile_id=$1 and created_at > now() - interval '24 hours'", [req.profile!.id])).rows[0]!.n);
    if (day >= COMMENTS_PER_DAY) return reply.code(429).send({ error: 'rate_limited' });
    const watched = isWatched(item);
    const r = await ctx.db.query<CommentRow>(
      `insert into episode_comments(item_id, profile_id, user_id, body, spoiler) values ($1,$2,$3,$4,$5)
       returning id, profile_id, $6::text as name, body, spoiler, created_at`,
      [item.id, req.profile!.id, req.user!.id, body, !watched, req.profile!.is_owner ? req.user!.name : req.profile!.name]);
    return view(r.rows[0]!, req, watched, true);
  });

  app.delete('/api/comments/:cid', { ...social, config: writeLimit(30) }, async (req, reply) => {
    const cid = z.string().uuid().safeParse((req.params as { cid: string }).cid);
    if (!cid.success) return reply.code(404).send({ error: 'not_found' });
    const row = (await ctx.db.query<{ profile_id: string }>('select profile_id from episode_comments where id=$1 and deleted_at is null', [cid.data])).rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    // author (the profile that wrote it) or an admin on the owner profile
    if (row.profile_id !== req.profile!.id && !moderator(req)) return reply.code(403).send({ error: 'forbidden' });
    await ctx.db.query('update episode_comments set deleted_at = now() where id=$1', [cid.data]);
    return { ok: true };
  });
}
