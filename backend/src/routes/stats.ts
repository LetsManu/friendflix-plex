// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFS, evaluate, wireStats } from '../achievements.js';
import { wirePlayStats } from '../playstats.js';
import type { Ctx } from '../ctx.js';
import { requireGrownUp } from '../kids.js';
import { itemsByIds } from './discover.js';

const MAX_CANDIDATES = 300;

export function statsRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireGrownUp(ctx) }; // stats/achievements/community: not on kids profiles
  wireStats(ctx);
  wirePlayStats(); // Block 22: streams / transcodes per day and device

  app.get('/api/stats/me', pre, async (req) => {
    const year = z.coerce.number().int().min(2020).max(2100).default(new Date().getFullYear()).parse((req.query as { year?: string }).year);
    const u = req.user!.id;
    const range = [u, `${year}-01-01`, `${year + 1}-01-01`];
    const q = (sql: string) => ctx.db.query(sql, range).then((r) => r.rows);
    const [tot] = await q(`select coalesce(sum(seconds),0)::int s, count(distinct coalesce(series_name,item_name))::int titles from play_seconds where user_id=$1 and day >= $2 and day < $3`);
    const top = await q(`select coalesce(series_name,item_name) name, sum(seconds)::int seconds from play_seconds where user_id=$1 and day >= $2 and day < $3 group by 1 order by 2 desc limit 5`);
    const months = await q(`select extract(month from day)::int m, (sum(seconds)/60)::int minutes from play_seconds where user_id=$1 and day >= $2 and day < $3 group by 1 order by 1`);
    const wd = await q(`select extract(dow from day)::int d, (sum(seconds)/60)::int minutes from play_seconds where user_id=$1 and day >= $2 and day < $3 group by 1 order by 2 desc limit 1`);
    const movies = await q(`select count(distinct item_id)::int n from play_seconds where user_id=$1 and day >= $2 and day < $3 and item_type='Movie'`);
    const episodes = await q(`select count(distinct item_id)::int n from play_seconds where user_id=$1 and day >= $2 and day < $3 and item_type='Episode'`);
    await evaluate(ctx, u);
    const earned = new Map((await ctx.db.query<{ key: string; earned_at: Date }>('select key, earned_at from achievements where user_id=$1', [u])).rows.map((r) => [r.key, r.earned_at]));
    return {
      year,
      totalMinutes: Math.round(Number(tot.s) / 60),
      titles: tot.titles,
      movies: movies[0].n,
      episodes: episodes[0].n,
      topItems: top.map((t) => ({ name: t.name, minutes: Math.round(t.seconds / 60) })),
      byMonth: months,
      favoriteWeekday: wd[0] ? ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'][wd[0].d] : null,
      achievements: DEFS.map((d) => ({ key: d.key, icon: d.icon, title: d.title, desc: d.desc, earnedAt: earned.get(d.key) ?? null })),
    };
  });

  app.get('/api/achievements', pre, async (req) => ({
    earned: (await ctx.db.query<{ key: string }>('select key from achievements where user_id=$1', [req.user!.id])).rows.map((r) => r.key),
  }));

  // Group stats: leaderboard + most watched titles (names only, no per-user history)
  app.get('/api/stats/community', pre, async (req) => {
    const lb = await ctx.db.query(`select u.name, (sum(p.seconds)/60)::int minutes from play_seconds p join users u on u.id=p.user_id where p.day >= date_trunc('month', current_date) group by u.name order by 2 desc limit 10`);
    // Top titles: only plays of users who share their history (plus the viewer's own), and only titles the viewer may see in Jellyfin.
    const rows = (await ctx.db.query<{ name: string; item_id: string; users: string[]; secs: string }>(
      `select coalesce(p.series_name,p.item_name) name, p.item_id, array_agg(distinct p.user_id::text) users, sum(p.seconds) secs
         from play_seconds p left join user_prefs pr on pr.user_id = p.user_id
        where p.day >= date_trunc('month', current_date)
          and (p.user_id = $2 or coalesce((pr.data->>'shareHistory')::boolean, false))
        group by 1, 2 order by sum(p.seconds) desc limit $1`, [MAX_CANDIDATES, req.user!.id])).rows;
    const visible = new Set((await itemsByIds(ctx, req.jfUser!, rows.map((r) => r.item_id))).map((i) => i.id));
    const groups = new Map<string, { name: string; users: Set<string>; secs: number }>();
    for (const r of rows) {
      if (!visible.has(r.item_id)) continue;
      const g = groups.get(r.name) ?? { name: r.name, users: new Set<string>(), secs: 0 };
      for (const u of r.users) g.users.add(u);
      g.secs += Number(r.secs);
      groups.set(r.name, g);
    }
    const topTitles = [...groups.values()].sort((a, b) => b.secs - a.secs).slice(0, 10).map((g) => ({ name: g.name, viewers: g.users.size, minutes: Math.round(g.secs / 60) }));
    return { month: new Date().toISOString().slice(0, 7), leaderboard: lb.rows, topTitles };
  });
}
