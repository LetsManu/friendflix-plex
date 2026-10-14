// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { listLive } from '../live.js';
import type { TranscodeReason } from '../media/types.js';
import { requireAdmin } from '../session.js';

/**
 * Block 22: aggregated usage per account (admin role on the owner profile only). Profiles are summed into their account.
 * Privacy: counts and durations only; no field carries a title, series name or item id (play_seconds names are only counted).
 */
export interface UsageRow {
  userId: string; name: string; role: string; disabled: boolean; lastSeen: string | null;
  seconds: number; movieSeconds: number; seriesSeconds: number; titles: number;
  streams: number; transcodes: number; topReason: TranscodeReason | null;
  devices: number; devicesUsed: number; liveNow: number;
}
export interface UsageDetail {
  userId: string; days: Array<{ day: string; seconds: number }>;
  devices: Array<{ label: string; lastSeen: string | null; streams: number; transcodes: number; app: boolean }>;
  reasons: Partial<Record<TranscodeReason, number>>; since: string | null;
}

const REASONS: readonly TranscodeReason[] = ['network', 'remoteCap', 'roleCap', 'container', 'videoCodec', 'audioCodec', 'audioTrack', 'subtitles', 'height', 'manual', 'other'];
const isReason = (k: string): k is TranscodeReason => (REASONS as readonly string[]).includes(k);
const CACHE_TTL = 60;
const daysParam = z.enum(['7', '30', '90']).default('30').transform(Number);
const listQuery = z.object({
  days: daysParam,
  sort: z.enum(['name', 'seconds', 'streams', 'transcodes', 'lastSeen']).default('name'),
  dir: z.enum(['asc', 'desc']).optional(),
});
const detailQuery = z.object({ days: daysParam });
const detailParams = z.object({ userId: z.string().uuid() });

const n = (v: unknown) => Number(v ?? 0) || 0;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);
/** "app:Infuse" → "Infuse" (the client name only) */
const appLabel = (deviceId: string) => deviceId.slice(4).replace(/[^\w .-]/g, '').slice(0, 40) || 'unknown';

async function since(ctx: Ctx): Promise<string | null> {
  const r = await ctx.db.query<{ d: string | null }>('select min(day)::text d from play_daily');
  return r.rows[0]?.d ?? null;
}

function topReasons(rows: Array<{ user_id: string; k: string; n: number }>): Map<string, TranscodeReason> {
  const best = new Map<string, { k: TranscodeReason; n: number }>();
  for (const r of rows) {
    if (!isReason(r.k)) continue;
    const b = best.get(r.user_id);
    if (!b || r.n > b.n || (r.n === b.n && r.k < b.k)) best.set(r.user_id, { k: r.k, n: r.n });
  }
  return new Map([...best].map(([u, b]) => [u, b.k]));
}

type CachedRows = { users: Array<Omit<UsageRow, 'liveNow'>>; since: string | null };

/** One grouped query per table over the period (`day > current_date - days` = the last `days` days including today). */
async function rows(ctx: Ctx, days: number): Promise<CachedRows> {
  const key = `usage:rows:${days}`;
  const cached = await ctx.kv.get(key).catch(() => null);
  if (cached) {
    try { return JSON.parse(cached) as CachedRows; } catch { /* rebuild */ }
  }
  const [users, secs, plays, reasons, first] = await Promise.all([
    ctx.db.query<{ id: string; name: string; role: string; disabled: boolean; last_seen: Date | null; devices: number }>(
      `select u.id, u.name, u.role, u.disabled,
              (select max(d.last_seen) from devices d where d.user_id = u.id) last_seen,
              (select count(*) from devices d where d.user_id = u.id and d.approved)::int devices
         from users u`),
    ctx.db.query<{ user_id: string; s: string; m: string; se: string; titles: number }>(
      `select user_id, sum(seconds) s,
              coalesce(sum(seconds) filter (where item_type = 'Movie'), 0) m,
              coalesce(sum(seconds) filter (where item_type = 'Episode' or (item_type is null and series_name is not null)), 0) se,
              count(distinct coalesce(series_name, item_name))::int titles
         from play_seconds where day > current_date - $1::int group by user_id`, [days]),
    ctx.db.query<{ user_id: string; streams: string; transcodes: string; used: number }>(
      `select user_id, sum(streams) streams, sum(transcodes) transcodes, count(distinct device_id) filter (where streams > 0)::int used
         from play_daily where day > current_date - $1::int group by user_id`, [days]),
    ctx.db.query<{ user_id: string; k: string; n: number }>(
      `select p.user_id, e.k, sum(e.v::int)::int n from play_daily p cross join lateral jsonb_each_text(p.reasons) e(k, v)
        where p.day > current_date - $1::int and e.v ~ '^[0-9]{1,9}$' group by p.user_id, e.k`, [days]),
    since(ctx),
  ]);
  const s = new Map(secs.rows.map((r) => [r.user_id, r]));
  const p = new Map(plays.rows.map((r) => [r.user_id, r]));
  const top = topReasons(reasons.rows);
  const out: CachedRows = {
    since: first,
    users: users.rows.map((u) => ({
      userId: u.id, name: u.name, role: u.role, disabled: u.disabled, lastSeen: iso(u.last_seen),
      seconds: n(s.get(u.id)?.s), movieSeconds: n(s.get(u.id)?.m), seriesSeconds: n(s.get(u.id)?.se), titles: n(s.get(u.id)?.titles),
      streams: n(p.get(u.id)?.streams), transcodes: n(p.get(u.id)?.transcodes), topReason: top.get(u.id) ?? null,
      devices: u.devices, devicesUsed: n(p.get(u.id)?.used),
    })),
  };
  await ctx.kv.set(key, JSON.stringify(out), CACHE_TTL).catch(() => undefined);
  return out;
}

const SORT: Record<'name' | 'seconds' | 'streams' | 'transcodes' | 'lastSeen', { cmp: (a: UsageRow, b: UsageRow) => number; dir: 'asc' | 'desc' }> = {
  name: { cmp: (a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }), dir: 'asc' },
  seconds: { cmp: (a, b) => a.seconds - b.seconds, dir: 'desc' },
  streams: { cmp: (a, b) => a.streams - b.streams, dir: 'desc' },
  transcodes: { cmp: (a, b) => a.transcodes - b.transcodes, dir: 'desc' },
  lastSeen: { cmp: (a, b) => (a.lastSeen ?? '').localeCompare(b.lastSeen ?? ''), dir: 'desc' },
};

export function usageRoutes(app: FastifyInstance, ctx: Ctx) {
  const admin = { preHandler: requireAdmin(ctx) };

  app.get('/api/admin/usage', admin, async (req) => {
    const q = listQuery.parse(req.query);
    const base = await rows(ctx, q.days);
    const live = new Map<string, number>();
    for (const l of await listLive(ctx)) live.set(l.userId, (live.get(l.userId) ?? 0) + 1);
    const users: UsageRow[] = base.users.map((u) => ({ ...u, liveNow: live.get(u.userId) ?? 0 }));
    const s = SORT[q.sort];
    const sign = (q.dir ?? s.dir) === 'asc' ? 1 : -1;
    users.sort((a, b) => sign * s.cmp(a, b) || a.name.localeCompare(b.name, 'de') || (a.userId < b.userId ? -1 : 1));
    return { users, since: base.since };
  });

  app.get('/api/admin/usage/:userId', admin, async (req, reply) => {
    const { userId } = detailParams.parse(req.params);
    const { days } = detailQuery.parse(req.query);
    if (!(await ctx.db.query('select 1 from users where id = $1', [userId])).rowCount) return reply.code(404).send({ error: 'not_found' });
    const [perDay, devs, used, reasons, first] = await Promise.all([
      ctx.db.query<{ day: string; seconds: string }>(
        `select g.day::date::text as day, coalesce(sum(p.seconds), 0) as seconds
           from generate_series(current_date - ($2::int - 1), current_date, interval '1 day') g(day)
           left join play_seconds p on p.user_id = $1 and p.day = g.day::date
          group by g.day order by g.day`, [userId, days]),
      ctx.db.query<{ device_id: string; label: string; last_seen: Date; approved: boolean }>(
        'select device_id, label, last_seen, approved from devices where user_id = $1', [userId]),
      ctx.db.query<{ device_id: string; streams: string; transcodes: string; last_day: string }>(
        `select device_id, sum(streams) streams, sum(transcodes) transcodes, max(day)::text last_day
           from play_daily where user_id = $1 and day > current_date - $2::int group by device_id`, [userId, days]),
      ctx.db.query<{ k: string; n: number }>(
        `select e.k, sum(e.v::int)::int n from play_daily p cross join lateral jsonb_each_text(p.reasons) e(k, v)
          where p.user_id = $1 and p.day > current_date - $2::int and e.v ~ '^[0-9]{1,9}$' group by e.k`, [userId, days]),
      since(ctx),
    ]);
    const known = new Map(devs.rows.map((d) => [d.device_id, d]));
    const usedBy = new Map(used.rows.map((u) => [u.device_id, u]));
    const ids = new Set([...devs.rows.filter((d) => d.approved).map((d) => d.device_id), ...used.rows.map((u) => u.device_id)]);
    const devices: UsageDetail['devices'] = [...ids].map((id) => {
      const d = known.get(id), u = usedBy.get(id);
      const app = id.startsWith('app:');
      return {
        // an unknown (deleted) FriendFlix device has no label: '' (the web shows a generic name)
        label: app ? appLabel(id) : d?.label ?? '',
        lastSeen: app ? u?.last_day ?? null : iso(d?.last_seen),
        streams: n(u?.streams), transcodes: n(u?.transcodes), app,
      };
    }).sort((a, b) => b.streams - a.streams || a.label.localeCompare(b.label, 'de'));
    const detail: UsageDetail = {
      userId,
      days: perDay.rows.map((r) => ({ day: r.day, seconds: n(r.seconds) })),
      devices,
      reasons: Object.fromEntries(reasons.rows.filter((r) => isReason(r.k)).map((r) => [r.k, r.n])),
      since: first,
    };
    return detail;
  });
}
