// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
import type { FreshLabel } from '../fresh.js';
import type { ItemDto } from '../media/types.js';
import type { RecoCoefficients } from './weights.js';

/**
 * Recommendation engine v2, R3b: the row ranker, layer 2 of the spec (4.5). It orders the rows that are available for the home page or
 * the post-play screen and cleans their contents. Rule-based:
 *
 *  1. "Continue watching" (kind `continue`; on post-play the continuation) is always first.
 *  2. One fixed slot (default position 3 of the list, `rows.fixedSlot`) holds "leaving soon" or else "new".
 *  3. The other rows follow by the profile's past click / play rate per row kind (shrunk towards a prior, so a row kind with little history
 *     keeps its default place); ties keep the order the caller passed.
 *  4. A row with fewer titles than its kind's minimum is dropped: `rows.minSize` (4) for most kinds, but `continue` and `universe` need 1
 *     and `transition` 2 (ROW_MIN_SIZE): a trilogy leaves 1 or 2 other parts, and every transition already rests on >= 2 accounts.
 *  5. No series the profile has already watched in any row but `continue` (Crunchyroll's anti-pattern, spec 2.3 item 11); the one exception
 *     is a new season of a watched series in the "new" slot.
 *  6. No row of current-season titles only: at most `rows.currentShare` (1 in 3) of a row (the "new" slot excepted) may be series that
 *     are airing now, the rest must be back catalog.
 *  7. A title appears in one row only (the first).
 *  8. A kids profile never gets the social kinds (`friends`, `popular`, `transition`).
 * The per-profile statistics are a bounded kv aggregate (one small JSON object of counts per row kind, no titles, halved when it grows).
 */

export const ROW_KINDS = ['continue', 'because', 'because_more', 'top_picks', 'popular', 'friends', 'postplay', 'new', 'leaving', 'transition', 'universe', 'detail'] as const;
export type RowKind = (typeof ROW_KINDS)[number];
/** Row kinds built on other accounts' data: never for kids. */
export const SOCIAL_ROWS: ReadonlySet<RowKind> = new Set<RowKind>(['friends', 'popular', 'transition']);
const FIXED: readonly RowKind[] = ['leaving', 'new'];
/** Row kinds with their own minimum size; every other kind needs `rows.minSize`. */
export const ROW_MIN_SIZE: Readonly<Partial<Record<RowKind, number>>> = { continue: 1, universe: 1, transition: 2 };
export const minSizeOf = (kind: RowKind, c: Pick<RecoCoefficients, 'rows'>): number => ROW_MIN_SIZE[kind] ?? c.rows.minSize;

export interface RowItem { item: ItemDto; /** fresh.ts label, when known */ fresh?: FreshLabel | null }
export interface RowIn { kind: RowKind; /** distinguishes several rows of one kind (because_more); defaults to the kind */ key?: string; items: RowItem[] }
export interface RowOut { kind: RowKind; key: string; items: RowItem[] }

/** counts per row kind: shown, clicked, played, dismissed */
export type RowStats = Partial<Record<RowKind, [number, number, number, number]>>;

export interface RankRowsOptions {
  c: RecoCoefficients;
  stats: RowStats;
  /** films and series the profile has seen (Taste.seen) */
  seen: ReadonlySet<string>;
  kids: boolean;
  now: number;
}

const DAY_MS = 86_400_000;
const ms = (iso?: string) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };

/** Is the title a series that is airing now: labelled new by fresh.ts, or a series that arrived or premiered within `rows.currentDays`. */
export function isCurrentSeason(r: RowItem, now: number, c: Pick<RecoCoefficients, 'rows'>): boolean {
  if (r.item.type !== 'Series') return false;
  if (r.fresh === 'newEpisode' || r.fresh === 'newSeason' || r.fresh === 'newSeries' || r.fresh === 'finale') return true;
  const cut = now - c.rows.currentDays * DAY_MS;
  return [r.item.lastAdded, r.item.premiereDate].some((d) => { const t = ms(d); return t !== null && t >= cut; });
}

/** Smoothed engagement of a row kind: (clicks + playWeight * plays - dismisses + prior * k) / (shown + k). */
export function rowRate(s: RowStats[RowKind], c: Pick<RecoCoefficients, 'rows'>): number {
  const [imp, clk, ply, dis] = s ?? [0, 0, 0, 0];
  const k = c.rows.priorImpressions;
  return (Math.max(0, clk + c.rows.playWeight * ply - dis) + c.rows.priorRate * k) / (imp + k);
}

export function rankRows(rows: readonly RowIn[], o: RankRowsOptions): RowOut[] {
  const { c } = o;
  const avail = rows.filter((r) => !(o.kids && SOCIAL_ROWS.has(r.kind)));
  const keyOf = (r: RowIn) => r.key ?? r.kind;
  const rate = (r: RowIn) => rowRate(o.stats[r.kind], c);

  // order: continue, then the rest by rate (stable); the fixed slot is placed afterwards
  const cont = avail.filter((r) => r.kind === 'continue');
  const rest = avail.filter((r) => r.kind !== 'continue');
  const order = [...rest].sort((a, b) => rate(b) - rate(a)); // Array.sort is stable: ties keep the caller's order
  const slotKind = FIXED.find((k) => rest.some((r) => r.kind === k && r.items.length >= minSizeOf(k, c)));
  const slotRow = slotKind ? order.find((r) => r.kind === slotKind && r.items.length >= minSizeOf(slotKind, c)) : undefined;
  const ranked = [...cont, ...order.filter((r) => r !== slotRow)];
  if (slotRow) ranked.splice(Math.min(c.rows.fixedSlot, ranked.length), 0, slotRow);

  const used = new Set<string>();
  const out: RowOut[] = [];
  for (const r of ranked) {
    const isCont = r.kind === 'continue', isNew = r.kind === 'new';
    let items = r.items.filter((x) => !used.has(x.item.id));
    if (!isCont) {
      items = items.filter((x) => {
        if (x.item.type !== 'Series' || !o.seen.has(x.item.id)) return true;
        return isNew && x.fresh === 'newSeason'; // a new season of a series you watch is news, not a repeat
      });
      if (!isNew) {
        // current <= share of the row that is left: current <= back * share / (1 - share)
        const back = items.filter((x) => !isCurrentSeason(x, o.now, c)).length;
        const max = c.rows.currentShare >= 1 ? Infinity : Math.floor((back * c.rows.currentShare) / (1 - c.rows.currentShare) + 1e-9);
        let current = 0;
        items = items.filter((x) => !isCurrentSeason(x, o.now, c) || ++current <= max);
      }
    }
    if (items.length < minSizeOf(r.kind, c)) continue;
    for (const x of items) used.add(x.item.id);
    out.push({ kind: r.kind, key: keyOf(r), items });
  }
  return out;
}

// ----------------------------------------------------------------------------------------------------------- per-profile statistics

const statsKey = (profileId: string) => `reco:rows:${profileId}`;
const STATS_TTL = 180 * 86_400;

/** The profile's row statistics (an empty object when there are none). */
export async function loadRowStats(ctx: Pick<Ctx, 'kv'>, profileId: string): Promise<RowStats> {
  try {
    const raw = await ctx.kv.get(statsKey(profileId));
    const o = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const out: RowStats = {};
    for (const k of ROW_KINDS) {
      const v = o[k];
      if (Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) out[k] = v as [number, number, number, number];
    }
    return out;
  } catch {
    return {};
  }
}

export interface RowEvent { row: RowKind; impressions?: number; clicks?: number; plays?: number; dismisses?: number }

/**
 * Adds counts to the profile's statistics. Bounded: one entry per row kind, four numbers each, and all counts are halved as soon as one
 * row kind has more than `rows.statsCap` impressions, so recent behaviour weighs more and the object stays small. Counts only.
 */
export async function recordRowStats(ctx: Pick<Ctx, 'kv'>, profileId: string, events: readonly RowEvent[], c: Pick<RecoCoefficients, 'rows'>): Promise<void> {
  try {
    const s = await loadRowStats(ctx, profileId);
    for (const e of events) {
      const cur = s[e.row] ?? [0, 0, 0, 0];
      s[e.row] = [cur[0] + (e.impressions ?? 0), cur[1] + (e.clicks ?? 0), cur[2] + (e.plays ?? 0), cur[3] + (e.dismisses ?? 0)];
    }
    if (Object.values(s).some((v) => v[0] > c.rows.statsCap)) for (const k of ROW_KINDS) if (s[k]) s[k] = s[k]!.map((n) => Math.round(n / 2)) as [number, number, number, number];
    await ctx.kv.set(statsKey(profileId), JSON.stringify(s), STATS_TTL);
  } catch {
    // statistics are a convenience: a failing store never fails the request
  }
}

/** "Reset my recommendations" forgets them too. */
export async function resetRowStats(ctx: Pick<Ctx, 'kv'>, profileId: string): Promise<void> {
  await ctx.kv.del(statsKey(profileId)).catch(() => undefined);
}
