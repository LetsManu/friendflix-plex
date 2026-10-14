// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { digestSchedule, sendDigest, type DigestData } from '../digest.js';
import { requireGrownUp } from '../kids.js';
import { requireAdmin } from '../session.js';
import type { ItemDto } from '../media/types.js';
import type { JfUser } from '../types.js';

/** Items the viewer's own Jellyfin user may see (library permissions of the active profile apply), by id. */
async function visibleItems(ctx: Ctx, user: JfUser, ids: string[]): Promise<Map<string, ItemDto>> {
  const ok = new Map<string, ItemDto>();
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 40) {
    const r = await ctx.jf.items(user, { ids: uniq.slice(i, i + 40), types: 'Movie,Series,Episode,BoxSet', limit: 40 }).catch(() => ({ items: [] as ItemDto[] }));
    for (const it of r.items) ok.set(it.id, it);
  }
  return ok;
}

/** Drops everything the viewer may not see (names and counts) and returns the visible ItemDtos so the page needs no per-item requests. */
export async function filterDigest(ctx: Ctx, user: JfUser, d: DigestData): Promise<{ data: DigestData; items: Record<string, ItemDto> }> {
  const ids = [
    ...(d.movieIds ?? []),
    ...d.newMovies.map((m) => m.id),
    ...Object.keys(d.seriesCounts ?? {}),
    ...d.newEpisodes.flatMap((g) => [g.seriesId, ...g.episodes.map((e) => e.id)]),
    ...d.available.flatMap((a) => (a.itemId ? [a.itemId] : [])),
    ...d.recommendations.map((r) => r.itemId),
  ];
  const ok = await visibleItems(ctx, user, ids);
  const movies = d.newMovies.filter((m) => ok.has(m.id));
  // count only titles the viewer can see; movies beyond the stored id list are assumed visible
  const stored = d.movieIds ?? d.newMovies.map((m) => m.id);
  const newMovieCount = stored.filter((i) => ok.has(i)).length + Math.max(0, d.newMovieCount - stored.length);
  let hiddenEps = 0;
  const newEpisodes = d.newEpisodes.filter((g) => ok.has(g.seriesId)).map((g) => {
    const episodes = g.episodes.filter((e) => ok.has(e.id));
    const gone = g.episodes.length - episodes.length;
    hiddenEps += gone;
    return { ...g, episodes, count: Math.max(episodes.length, g.count - gone) };
  });
  const newEpisodeCount = d.seriesCounts
    ? Object.entries(d.seriesCounts).reduce((n, [sid, c]) => n + (ok.has(sid) ? c : 0), 0) - hiddenEps
    : newEpisodes.reduce((n, g) => n + g.count, 0);
  const available = d.available.filter((a) => !a.itemId || ok.has(a.itemId));
  const recommendations = d.recommendations.filter((r) => ok.has(r.itemId));
  const data: DigestData = { ...d, newMovies: movies, newMovieCount, newEpisodes, newEpisodeCount: Math.max(0, newEpisodeCount), available, recommendations };
  delete data.movieIds;
  delete data.seriesCounts;
  const shown = new Set([...movies.map((m) => m.id), ...newEpisodes.map((g) => g.seriesId), ...available.flatMap((a) => (a.itemId ? [a.itemId] : [])), ...recommendations.map((r) => r.itemId)]);
  return { data, items: Object.fromEntries([...shown].flatMap((i) => (ok.has(i) ? [[i, ok.get(i)!] as const] : []))) };
}

const settingsSchema = z.object({ enabled: z.boolean(), day: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23) });

export function digestRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireGrownUp(ctx) }; // the weekly digest is social (friends' activity)
  const admin = { preHandler: requireAdmin(ctx) };

  app.get('/api/digest/latest', pre, async (req) => {
    const r = await ctx.db.query<{ week: Date | string; sent_at: Date; data: DigestData }>(
      'select to_char(week, \'YYYY-MM-DD\') as week, sent_at, data from digests where user_id=$1 order by week desc limit 1', [req.user!.id]);
    const row = r.rows[0];
    if (!row) return { digest: null };
    return { digest: { week: row.week, sentAt: row.sent_at.toISOString(), ...(await filterDigest(ctx, req.jfUser!, row.data)) } };
  });

  const settings = async () => {
    const s = await digestSchedule(ctx);
    const last = (await ctx.db.query<{ week: string; sent_at: Date; n: string }>(
      `select to_char(week, 'YYYY-MM-DD') as week, max(sent_at) as sent_at, count(*) as n from digests
        where week = (select max(week) from digests) group by week`)).rows[0];
    return { ...s, lastRun: last ? { week: last.week, sentAt: last.sent_at.toISOString(), count: Number(last.n) } : null };
  };
  app.get('/api/admin/digest', admin, async () => settings());
  app.put('/api/admin/digest', admin, async (req) => {
    const b = settingsSchema.parse(req.body);
    await ctx.db.query(
      "insert into app_settings(key, value) values ('digest', $1) on conflict (key) do update set value = excluded.value, updated_at = now()", [JSON.stringify(b)]);
    await audit(ctx, req.user!.id, 'digest.settings', undefined, b);
    return settings();
  });
  app.post('/api/admin/digest/test', { ...admin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const until = new Date();
    const since = new Date(until.getTime() - 7 * 24 * 3600_000);
    const r = await sendDigest(ctx, req.user!, { key: 'test', since, until }, true);
    return { sent: r.sent, data: r.data };
  });
}
