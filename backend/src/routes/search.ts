import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { MediaError, type ItemDto } from '../media/types.js';
import { requireUser } from '../session.js';
import { id32, wrap as sharedWrap } from './_shared.js';


const wrap = <T extends (...a: any[]) => Promise<any>>(fn: T): T => sharedWrap(fn, { notFound: [404, 400] });

export function searchRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };

  // Grouped search: titles, episodes, people, genres. Sub-requests run in parallel; a failing one only empties its section.
  app.get('/api/search', { ...pre, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { q } = z.object({ q: z.string().trim().min(2).max(100) }).parse(req.query);
    const user = req.jfUser!;
    const year = /^\d{4}$/.test(q) && Number(q) >= 1900 && Number(q) <= 2100 ? Number(q) : null;
    const titlesP = year
      ? ctx.jf.items(user, { year, types: 'Movie,Series', sort: 'CommunityRating', desc: true, limit: 24 })
      : ctx.jf.items(user, { q, types: 'Movie,Series', limit: 24 });
    const real = [
      titlesP,
      ...(year ? [] : [ctx.jf.items(user, { q, types: 'Episode', limit: 8 })]),
      ctx.jf.searchPeople(user, q, 12),
      ctx.jf.genres(user),
    ] as Array<Promise<unknown>>;
    const settled = await Promise.allSettled(real);
    const bad = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];
    for (const b of bad) if (!(b.reason instanceof MediaError)) throw b.reason;
    if (bad.length === settled.length) return reply.code(502).send({ error: 'jellyfin', status: (bad[0]!.reason as MediaError).status });
    const ok = <T>(i: number, fallback: T): T => (settled[i]!.status === 'fulfilled' ? (settled[i] as PromiseFulfilledResult<T>).value : fallback);
    const off = year ? 0 : 1; // no episode request for a year query
    const needle = q.toLowerCase();
    return {
      q,
      titles: ok<{ items: ItemDto[] }>(0, { items: [] }).items,
      episodes: year ? [] : ok<{ items: ItemDto[] }>(1, { items: [] }).items,
      people: ok<Array<{ id: string; name: string; image: boolean }>>(1 + off, []),
      genres: ok<string[]>(2 + off, []).filter((g) => g.toLowerCase().includes(needle)).slice(0, 6),
      partial: bad.length > 0,
    };
  });

  app.get('/api/people/:id', pre, wrap(async (req, reply) => {
    const id = id32.parse((req.params as { id: string }).id);
    const person = await ctx.jf.person(req.jfUser!, id);
    if (!person) return reply.code(404).send({ error: 'not_found' });
    // persons only present in libraries the viewer cannot see have no visible items -> not revealed
    const { items } = await ctx.jf.items(req.jfUser!, { person: id, types: 'Movie,Series', sort: 'PremiereDate,SortName', desc: true, limit: 100 });
    if (!items.length) return reply.code(404).send({ error: 'not_found' });
    return { person, items };
  }));
}
