// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { MediaError, type CreditDto, type ItemCreditsDto, type MediaUser } from '../media/types.js';
import { requireUser } from '../session.js';
import { id32, wrap as sharedWrap } from './_shared.js';

/** media server 404 / 400 (unknown or invisible item) -> 404 {error:'not_found'} */
const wrap = <T extends (...a: any[]) => Promise<any>>(fn: T): T => sharedWrap(fn, { notFound: [404, 400] });
/** credits / chapters change rarely: cached per server identity (= per profile, so visibility stays per profile) */
const INFO_TTL = 300;
const CAST_MAX = 40, GUEST_MAX = 30, CREW_MAX = 8;

type Person = Pick<CreditDto, 'id' | 'name' | 'image'> & { role?: string };
const slim = (p: CreditDto): Person => ({ id: p.id, name: p.name, image: p.image, ...(p.role ? { role: p.role } : {}) });
/** first occurrence wins (a person credited twice, e.g. as actor and as guest star) */
const uniq = (list: CreditDto[]) => { const seen = new Set<string>(); return list.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true))); };
const ofType = (list: CreditDto[], ...types: string[]) => list.filter((p) => types.includes(p.type));

export function sceneRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };

  // ---- Scene bookmarks (share link = /watch/<id>?t=<seconds>) ----
  app.get('/api/bookmarks', pre, async (req) => {
    const itemId = id32.parse((req.query as { itemId?: string }).itemId);
    const r = await ctx.db.query('select id, position_sec as position, note, created_at from bookmarks where profile_id=$1 and item_id=$2 order by position_sec', [req.profile!.id, itemId]);
    return { bookmarks: r.rows };
  });
  app.post('/api/bookmarks', pre, async (req, reply) => {
    const b = z.object({ itemId: id32, position: z.number().int().min(0).max(86_400), note: z.string().trim().max(140).optional() }).parse(req.body);
    const n = await ctx.db.query<{ c: string }>('select count(*) c from bookmarks where profile_id=$1', [req.profile!.id]);
    if (Number(n.rows[0]!.c) >= 500) return reply.code(409).send({ error: 'too_many_bookmarks' });
    let name: string;
    try {
      name = (await ctx.jf.item(req.jfUser!, b.itemId)).name;
    } catch {
      return reply.code(404).send({ error: 'item_not_found' });
    }
    const id = randomUUID();
    await ctx.db.query('insert into bookmarks(id,user_id,profile_id,item_id,item_name,position_sec,note) values ($1,$2,$3,$4,$5,$6,$7)', [id, req.user!.id, req.profile!.id, b.itemId, name, b.position, b.note || null]);
    return { id };
  });
  app.delete('/api/bookmarks/:id', pre, async (req) => {
    await ctx.db.query('delete from bookmarks where id=$1 and profile_id=$2', [z.guid().parse((req.params as { id: string }).id), req.profile!.id]);
    return { ok: true };
  });

  // ---- Find subtitles (Jellyfin remote subtitle providers, e.g. OpenSubtitles plugin) ----
  const guard = (role: string) => role !== 'guest';
  app.get('/api/items/:id/subtitles/search', { ...pre, config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!guard(req.user!.role)) return reply.code(403).send({ error: 'forbidden' });
    const id = id32.parse((req.params as { id: string }).id);
    const lang = z.string().regex(/^[a-z]{3}$/).parse((req.query as { lang?: string }).lang);
    try {
      await ctx.jf.item(req.jfUser!, id); // access check with the user's own token
      return { results: await ctx.jf.searchSubtitles(id, lang) };
    } catch (e) {
      if (e instanceof MediaError && e.status === 404) return reply.code(404).send({ error: 'not_found' });
      return reply.code(502).send({ error: 'subtitle_provider_unavailable' });
    }
  });
  app.post('/api/items/:id/subtitles/download', { ...pre, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!guard(req.user!.role)) return reply.code(403).send({ error: 'forbidden' });
    const id = id32.parse((req.params as { id: string }).id);
    const { subtitleId } = z.object({ subtitleId: z.string().regex(/^[\w.%=+-]{1,300}$/) }).parse(req.body);
    try {
      await ctx.jf.item(req.jfUser!, id);
      await ctx.jf.downloadSubtitle(id, subtitleId);
    } catch {
      return reply.code(502).send({ error: 'subtitle_download_failed' });
    }
    await audit(ctx, req.user!.id, 'subtitle.download', id);
    return { ok: true };
  });

  // ---- Block 17: "Besetzung & Infos" (cast with character names, guest stars, background facts) ----
  /** credits of one item: the server's credits() when it has it, else people() + tags from itemTraits() */
  async function creditsOf(user: MediaUser, id: string): Promise<ItemCreditsDto> {
    const key = `castinfo:v1:${user.jellyfin_user_id}:${id}`;
    const hit = await ctx.kv.get(key).catch(() => null);
    if (hit) return JSON.parse(hit) as ItemCreditsDto;
    const c: ItemCreditsDto = ctx.jf.credits
      ? await ctx.jf.credits(user, id)
      : { people: await ctx.jf.people(user, id), studios: [], tags: (await ctx.jf.itemTraits(user, id).catch(() => null))?.tags ?? [] };
    await ctx.kv.set(key, JSON.stringify(c), INFO_TTL).catch(() => undefined);
    return c;
  }

  app.get('/api/items/:id/castinfo', pre, wrap(async (req) => {
    const id = id32.parse((req.params as { id: string }).id);
    const user = req.jfUser!;
    const item = await ctx.jf.item(user, id); // access check (fresh, memoised briefly): never served from the credits cache alone
    const series = item.type === 'Episode' && item.seriesId ? item.seriesId : null;
    const [own, ser, serItem] = await Promise.all([
      creditsOf(user, id),
      series ? creditsOf(user, series).catch(() => null) : null,
      series && !item.genres.length ? ctx.jf.item(user, series).catch(() => null) : null,
    ]);
    // episodes: the series' regulars are the cast, everyone credited only on the episode is a guest star
    const regulars = ser ? ofType(ser.people, 'Actor') : ofType(own.people, 'Actor');
    const regularIds = new Set(regulars.map((p) => p.id));
    const guests = ser ? uniq(ofType(own.people, 'GuestStar', 'Actor').filter((p) => !regularIds.has(p.id))) : uniq(ofType(own.people, 'GuestStar'));
    const crew = (types: string[]) => {
      const mine = uniq(ofType(own.people, ...types));
      return (mine.length || !ser ? mine : uniq(ofType(ser.people, ...types))).slice(0, CREW_MAX).map(slim);
    };
    return {
      item: {
        id: item.id, name: item.name, type: item.type,
        ...(item.year ? { year: item.year } : {}), ...(item.rating ? { rating: item.rating } : {}),
        ...(item.communityRating ? { communityRating: item.communityRating } : {}),
        ...(item.seriesId ? { seriesId: item.seriesId, seriesName: item.seriesName } : {}),
      },
      cast: uniq(regulars).slice(0, CAST_MAX).map(slim),
      guests: guests.slice(0, GUEST_MAX).map(slim),
      directors: crew(['Director']),
      writers: crew(['Writer']),
      creators: ser ? uniq(ofType(ser.people, 'Creator')).slice(0, CREW_MAX).map(slim) : uniq(ofType(own.people, 'Creator')).slice(0, CREW_MAX).map(slim),
      studios: own.studios.length ? own.studios : ser?.studios ?? [],
      genres: item.genres.length ? item.genres : serItem?.genres ?? [],
      tags: (own.tags.length ? own.tags : ser?.tags ?? []).slice(0, 12),
    };
  }));

  // ---- Block 17: chapters ("Szenen" panel + seek bar marks); capability `chapters` ----
  app.get('/api/items/:id/chapters', pre, wrap(async (req) => {
    const id = id32.parse((req.params as { id: string }).id);
    const user = req.jfUser!;
    if (!(ctx.jf.capabilities.chapters ?? false) || !ctx.jf.chapters) {
      await ctx.jf.item(user, id); // same answer for invisible items whatever the server supports
      return { supported: false, chapters: [] };
    }
    const key = `chapters:v1:${user.jellyfin_user_id}:${id}`;
    const hit = await ctx.kv.get(key).catch(() => null);
    if (hit) {
      await ctx.jf.item(user, id); // a cached answer still needs the access check
      return { supported: true, chapters: JSON.parse(hit) };
    }
    const chapters = await ctx.jf.chapters(user, id); // 404 when not visible
    await ctx.kv.set(key, JSON.stringify(chapters), INFO_TTL).catch(() => undefined);
    return { supported: true, chapters };
  }));
}

