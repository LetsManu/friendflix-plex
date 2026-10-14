// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from './ctx.js';
import { isHomeRequest } from './netaddr.js';
import { requireAdmin, requireUser } from './session.js';

/**
 * Start-time measurements of the web player (web/src/lib/player/timing.ts): one row per playback session with the ms from
 * "load" to playback info, playlist, first fragment and first frame, plus seeks and stalls. Anonymous on purpose: no user,
 * profile, item, address or user agent is stored, only `home` (the same home-network check as the remote bitrate cap).
 * Rows live 14 days (pruned by healthTick).
 */
const MAX_MS = 600_000;
/** finite number, clamped to [0, max] and rounded; null/missing = not measured */
const num = (max: number, round = true) => z.number().finite().transform((n) => { const c = Math.min(Math.max(n, 0), max); return round ? Math.round(c) : Math.round(c * 10) / 10; }).nullish();

export const timingBody = z.object({
  device: z.enum(['phone', 'pc', 'tv']),
  /** null: left before the stream was attached (still a start that took too long) */
  mode: z.enum(['direct', 'hls']).nullish(),
  /** the session started for a quality switch: a re-start, never counted as a start */
  qualitySwitch: z.boolean().default(false),
  bitrate: num(200_000_000),
  targetDuration: num(60, false),
  infoMs: num(MAX_MS),
  manifestMs: num(MAX_MS),
  firstFragMs: num(MAX_MS),
  firstFragBytes: num(500_000_000),
  firstFragDlMs: num(MAX_MS),
  firstFrameMs: num(MAX_MS),
  seeks: num(10_000),
  seekMedianMs: num(MAX_MS),
  seekMaxMs: num(MAX_MS),
  stalls: num(10_000),
  stallMs: num(86_400_000),
  /** Network Information API; anything else is dropped (never a 400) */
  effectiveType: z.enum(['slow-2g', '2g', '3g', '4g']).nullish().catch(null),
});
export type TimingBody = z.infer<typeof timingBody>;

const HOURLY_LIMIT = 120;

export async function recordTiming(ctx: Pick<Ctx, 'db'>, b: TimingBody, home: boolean): Promise<void> {
  await ctx.db.query(
    `insert into playback_timings(home, device, mode, quality_switch, bitrate, target_duration, info_ms, manifest_ms, first_frag_ms, first_frag_bytes,
       first_frag_dl_ms, first_frame_ms, seeks, seek_median_ms, seek_max_ms, stalls, stall_ms, effective_type)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [home, b.device, b.mode ?? null, b.qualitySwitch, b.bitrate ?? null, b.targetDuration ?? null, b.infoMs ?? null, b.manifestMs ?? null, b.firstFragMs ?? null,
      b.firstFragBytes ?? null, b.firstFragDlMs ?? null, b.firstFrameMs ?? null, b.seeks ?? 0, b.seekMedianMs ?? null, b.seekMaxMs ?? null, b.stalls ?? 0, b.stallMs ?? 0, b.effectiveType ?? null],
  );
}

/** 14-day retention (called from healthTick, at most hourly). */
export async function pruneTimings(ctx: Pick<Ctx, 'db'>): Promise<number> {
  return (await ctx.db.query("delete from playback_timings where created_at < now() - interval '14 days'")).rowCount ?? 0;
}

export const PHASES = ['info', 'manifest', 'firstFrag', 'firstFrame'] as const;
export type Phase = (typeof PHASES)[number];
export interface Pct { p50: number | null; p90: number | null }
export interface TimingGroup {
  home: boolean;
  /** null = every device class of this side */
  device: 'phone' | 'pc' | 'tv' | null;
  /** starts (quality switches excluded) */
  n: number;
  switches: number;
  /** load -> first frame */
  total: Pct;
  /** duration of each step (info = load -> info, manifest = info -> playlist, firstFrag = playlist -> fragment, firstFrame = -> frame) */
  phases: Record<Phase, Pct>;
  targetDuration: number | null;
  seekP50: number | null;
  /** stalls per session and their total ms per session (all sessions, switches included) */
  stallsPerSession: number;
  stallMsPerSession: number;
}
export interface TimingRow {
  at: string; home: boolean; device: string; mode: string | null; qualitySwitch: boolean; bitrate: number | null; targetDuration: number | null;
  infoMs: number | null; manifestMs: number | null; firstFragMs: number | null; firstFragBytes: number | null; firstFragDlMs: number | null; firstFrameMs: number | null;
  seeks: number; seekMedianMs: number | null; seekMaxMs: number | null; stalls: number; stallMs: number; effectiveType: string | null;
}
export interface TimingView { day: TimingGroup[]; week: TimingGroup[]; recent: TimingRow[] }

const r0 = (x: unknown) => (x === null || x === undefined ? null : Math.round(Number(x)));
const pct = (col: string) =>
  `percentile_cont(0.5) within group (order by ${col}) filter (where not quality_switch) as ${col}_p50,
   percentile_cont(0.9) within group (order by ${col}) filter (where not quality_switch) as ${col}_p90`;

async function groups(ctx: Pick<Ctx, 'db'>, window: string): Promise<TimingGroup[]> {
  // step durations per row: each phase minus the last earlier phase that was measured (direct play has no playlist / fragment)
  const r = await ctx.db.query(
    `with t as (
       select home, device, quality_switch, target_duration, seek_median_ms, stalls, stall_ms, first_frame_ms as s_total, info_ms as s_info,
         case when manifest_ms is not null then greatest(manifest_ms - coalesce(info_ms, 0), 0) end as s_manifest,
         case when first_frag_ms is not null then greatest(first_frag_ms - coalesce(manifest_ms, info_ms, 0), 0) end as s_frag,
         case when first_frame_ms is not null then greatest(first_frame_ms - coalesce(first_frag_ms, manifest_ms, info_ms, 0), 0) end as s_frame
       from playback_timings where created_at > now() - $1::interval)
     select home, device, count(*) filter (where not quality_switch)::int as n, count(*) filter (where quality_switch)::int as switches,
       ${pct('s_total')}, ${pct('s_info')}, ${pct('s_manifest')}, ${pct('s_frag')}, ${pct('s_frame')},
       percentile_cont(0.5) within group (order by target_duration) as td, percentile_cont(0.5) within group (order by seek_median_ms) as seek,
       avg(stalls)::float as stalls, avg(stall_ms)::float as stall_ms
     from t group by grouping sets ((home, device), (home)) order by home desc, device nulls first`,
    [window],
  );
  const p = (row: Record<string, unknown>, c: string): Pct => ({ p50: r0(row[`${c}_p50`]), p90: r0(row[`${c}_p90`]) });
  return r.rows.map((x) => ({
    home: Boolean(x.home), device: x.device ?? null, n: Number(x.n), switches: Number(x.switches), total: p(x, 's_total'),
    phases: { info: p(x, 's_info'), manifest: p(x, 's_manifest'), firstFrag: p(x, 's_frag'), firstFrame: p(x, 's_frame') },
    targetDuration: x.td === null ? null : Math.round(Number(x.td) * 10) / 10, seekP50: r0(x.seek),
    stallsPerSession: Math.round(Number(x.stalls ?? 0) * 100) / 100, stallMsPerSession: Math.round(Number(x.stall_ms ?? 0)),
  }));
}

export async function timingView(ctx: Pick<Ctx, 'db'>): Promise<TimingView> {
  const [day, week, recent] = await Promise.all([
    groups(ctx, '24 hours'), groups(ctx, '7 days'),
    ctx.db.query(`select * from playback_timings order by created_at desc, id desc limit 30`),
  ]);
  return {
    day, week,
    recent: recent.rows.map((x) => ({
      at: (x.created_at as Date).toISOString(), home: x.home, device: x.device, mode: x.mode, qualitySwitch: x.quality_switch, bitrate: x.bitrate,
      targetDuration: x.target_duration, infoMs: x.info_ms, manifestMs: x.manifest_ms, firstFragMs: x.first_frag_ms, firstFragBytes: x.first_frag_bytes,
      firstFragDlMs: x.first_frag_dl_ms, firstFrameMs: x.first_frame_ms, seeks: x.seeks, seekMedianMs: x.seek_median_ms, seekMaxMs: x.seek_max_ms,
      stalls: x.stalls, stallMs: x.stall_ms, effectiveType: x.effective_type,
    })),
  };
}

/**
 * POST /api/playback/timing: signed in + csrf header like the other playback reports (the player sends it as a keepalive
 * fetch on stop / pagehide); rate limited per IP (30/min) and per user (120/h). GET /api/admin/playback/timing: admins only.
 */
export function playbackTimingRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/api/playback/timing', { preHandler: requireUser(ctx), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = timingBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues.map((i) => i.path.join('.')) });
    if ((await ctx.kv.incr(`ptiming:h:${req.user!.id}`, 3600)) > HOURLY_LIMIT) return reply.code(429).send({ error: 'rate_limited' });
    await recordTiming(ctx, parsed.data, isHomeRequest(req, ctx.cfg.HOME_NETWORKS));
    return reply.code(204).send();
  });
  app.get('/api/admin/playback/timing', { preHandler: requireAdmin(ctx) }, async () => timingView(ctx));
}
