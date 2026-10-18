// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
import type { ItemDto } from '../media/types.js';
import { recoFallback, recoClicks, recoDismiss, recoImpressions, recoPlays } from '../metrics.js';
import type { JfUser } from '../types.js';
import type { Reason } from './explain.js';
import { tasteProfile, type RecoProfile } from './profile.js';
import type { RecoItem } from './recommend.js';
import { loadRowStats, rankRows, type RowIn, type RowKind, type RowOut } from './rows.js';
import { loadIndex } from './vectors.js';
import { recoCoefficients, recoWeights } from './weights.js';

/**
 * R4 rollout glue (RECO_ENGINE=v2): which engine answers, the v1 fallback counter, the reason that travels with an item to the web,
 * the home row ranking and the per-engine numbers of the admin card. Nothing here is user-specific in a metric or a log.
 */

export type EngineName = 'v1' | 'v2';
/** Only `v2` routes requests through recommend(); `shadow` computes it beside v1 (recommend.ts) and answers v1. */
export const v2Active = (cfg: Pick<Ctx['cfg'], 'RECO_ENGINE'>): boolean => cfg.RECO_ENGINE === 'v2';

/** Closed label set of friendflix_reco_fallback_total. */
export const FALLBACK_SURFACES = ['because', 'because_more', 'postplay', 'taste', 'transition', 'home'] as const;
export type FallbackSurface = (typeof FALLBACK_SURFACES)[number];
/** v2 threw: v1 answers, and the failure is counted (no message, it could carry a server URL). */
export const countFallback = (surface: FallbackSurface): void => { recoFallback.inc({ surface }); };

/** An item as the web receives it from a v2 row: the item plus why it is there. */
export type WithReason = ItemDto & { reason: Reason };
export const withReason = (r: Pick<RecoItem, 'item' | 'reason'>): WithReason => ({ ...r.item, reason: r.reason });

/** The profile columns recommend() needs; undefined when the profile does not exist (then v1 answers). */
export async function recoProfileOf(ctx: Pick<Ctx, 'db'>, profileId: string): Promise<RecoProfile | undefined> {
  const r = await ctx.db.query<RecoProfile>('select id, user_id, is_owner, kids, kids_max_rating from profiles where id=$1', [profileId]).catch(() => ({ rows: [] as RecoProfile[] }));
  return r.rows[0];
}

// ------------------------------------------------------------------------------------------------------------------------ home rows

export interface HomeRowIn { key: string; kind: RowKind; items: ItemDto[] }
export interface HomeRowOut { key: string; kind: RowKind; items: ItemDto[] }

/**
 * Row order and cleaning of the home page recommendation rows (spec 4.5, layer 2). The rows come in as they were built; rankRows orders
 * them by the profile's click / play history per row kind, drops rows that are too small, series the profile has seen and
 * current-season excess, and lets a title appear in one row only. Returns the surviving rows in display order.
 */
export async function rankHomeRows(ctx: Pick<Ctx, 'cfg' | 'db' | 'kv' | 'jf'>, user: JfUser, profile: RecoProfile, rows: readonly HomeRowIn[], now = Date.now()): Promise<HomeRowOut[]> {
  const c = recoCoefficients(ctx.cfg);
  const w = recoWeights(ctx.cfg);
  const [stats, taste] = await Promise.all([
    loadRowStats(ctx, profile.id),
    loadIndex(ctx, w, now).then((index) => tasteProfile(ctx, user, profile, index, c, w, now)),
  ]);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const input: RowIn[] = rows.map((r) => ({ kind: r.kind, key: r.key, items: r.items.map((item) => ({ item })) }));
  const out: RowOut[] = rankRows(input, { c, stats, seen: taste.seen, kids: profile.kids, now });
  return out.map((r) => ({ key: r.key, kind: r.kind, items: r.items.map((x) => x.item) })).filter((r) => byKey.has(r.key));
}

// ------------------------------------------------------------------------------------------------------------------------ admin card

export interface EngineStats { impressions: number; clicks: number; plays: number; dismisses: number; ctr: number | null; playRate: number | null }
export interface RecoStats {
  /** the configured RECO_ENGINE (live: Admin -> Settings, group recommendations, or env) */
  engine: string;
  /** RECO_ENGINE comes from the environment: env wins, Admin -> Settings shows it locked */
  locked: boolean;
  engines: Record<EngineName, EngineStats>;
  /** requests where v2 failed and v1 answered */
  fallbacks: number;
  /** the counters live in this process only: they restart from zero with the backend */
  since: string;
}
const STARTED = new Date().toISOString();
const rate = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 10_000) / 10_000 : null);

/**
 * CTR = clicks / impressions, play rate = plays / impressions (a row shown that led to a started play), per engine, summed over all rows.
 * Computed from the Prometheus counters; they are per process, so the numbers restart with the backend (Prometheus keeps the history).
 */
export async function recoStats(cfg: Pick<Ctx['cfg'], 'RECO_ENGINE'>, opts: { locked?: boolean } = {}): Promise<RecoStats> {
  const sum = async (m: { get(): Promise<{ values: Array<{ value: number; labels: Record<string, unknown> }> }> }, engine?: EngineName) =>
    (await m.get()).values.filter((v) => !engine || v.labels.engine === engine).reduce((a, v) => a + v.value, 0);
  const one = async (engine: EngineName): Promise<EngineStats> => {
    const [impressions, clicks, plays, dismisses] = await Promise.all([recoImpressions, recoClicks, recoPlays, recoDismiss].map((m) => sum(m, engine)));
    return { impressions: impressions!, clicks: clicks!, plays: plays!, dismisses: dismisses!, ctr: rate(clicks!, impressions!), playRate: rate(plays!, impressions!) };
  };
  return { engine: cfg.RECO_ENGINE, locked: opts.locked === true, engines: { v1: await one('v1'), v2: await one('v2') }, fallbacks: await sum(recoFallback), since: STARTED };
}
