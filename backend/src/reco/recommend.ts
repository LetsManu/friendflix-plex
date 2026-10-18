// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
import type { ItemDto } from '../media/types.js';
import { recoExplorePropensity, recoExploreSlots, recoShadowOverlap, recoShadowRuns, recoShadowScoreDelta } from '../metrics.js';
import type { JfUser } from '../types.js';
import { gatherCandidates, resolveVisible, type CandidateSource, type SourceName } from './candidates.js';
import { contextFor, type DeviceClass, type RecoContext } from './context.js';
import { explain, type Reason } from './explain.js';
import { explore } from './explore.js';
import type { RowKind } from './rows.js';
import { RECO_SOURCES } from './sources.js';
import { tasteProfile, type RecoProfile } from './profile.js';
import { mmr, type RankItem } from './rank.js';
import { filterReason, scoreCandidate, type Marks, type ScoreParts, type Scored } from './score.js';
import { loadIndex } from './vectors.js';
import { recoCoefficients, recoExplore, recoWeights, type Surface } from './weights.js';

/**
 * Recommendation engine v2, R2: recommend() ties the steps together (taste profile -> candidates -> score -> MMR). It always resolves
 * titles with the viewer's token (so library permissions and the kids age cap of the media server apply), applies the kids age cap
 * itself as well, and never runs social sources for a kids profile.
 */

export interface RecoItem { item: ItemDto; score: number; sources: SourceName[]; parts: ScoreParts; /** the seed that contributed most plus up to two shared traits (explain.ts) */ reason: Reason; /** R3b: this slot was filled by exploration with a medium-score candidate */ explored?: boolean; /** R3b: logged propensity of the slot (only when exploration is on) */ propensity?: number }
export interface RecoResult {
  surface: Surface;
  /** the taste profile had too few interactions: the quality prior carried the ranking */
  cold: boolean;
  items: RecoItem[];
  /** v2 score of every candidate that survived the filters, before re-ranking (shadow mode compares v1's titles against it) */
  pool: Map<string, number>;
}
export interface RecommendOptions {
  seed?: string; surface: Surface; limit: number; now?: number; sources?: readonly CandidateSource[];
  /** context of the request (hour, device, language); default: derived from `now`, the profile's language and the instance's device mix */
  context?: RecoContext;
  /** the caller's device class, when it knows it (the web app does) */
  device?: DeviceClass;
  /** R3b: the row kind this list becomes (label of the exploration counters); default by surface */
  row?: RowKind;
  /** R3b: false switches exploration off for this call (shadow comparisons) */
  explore?: boolean;
  /** R3b: random numbers in [0, 1) for exploration (tests, replay); default Math.random. Never drawn while RECO_EXPLORE is 0. */
  rng?: () => number;
}

/** The row kind (metric label) a surface feeds. */
export const ROW_OF_SURFACE: Record<Surface, RowKind> = { because: 'because', taste: 'top_picks', home_rows: 'top_picks', postplay: 'postplay', detail_similar: 'detail' };

const rootItem = async (ctx: Pick<Ctx, 'jf'>, user: JfUser, id: string): Promise<ItemDto | undefined> => {
  const it = await ctx.jf.item(user, id).catch(() => null);
  if (!it) return undefined;
  if (it.type === 'Episode' && it.seriesId) return (await ctx.jf.item(user, it.seriesId).catch(() => null)) ?? undefined;
  return it;
};

async function loadMarks(ctx: Pick<Ctx, 'db'>, profileId: string): Promise<Marks> {
  const [t, d, w] = await Promise.all([
    ctx.db.query<{ item_id: string }>('select item_id from thumbs where profile_id=$1 and value=-1', [profileId]),
    ctx.db.query<{ item_id: string }>('select item_id from dropped where profile_id=$1', [profileId]),
    ctx.db.query<{ item_id: string }>('select item_id from watchlist where profile_id=$1', [profileId]),
  ]);
  const ids = (r: { rows: Array<{ item_id: string }> }) => new Set(r.rows.map((x) => x.item_id));
  return { thumbsDown: ids(t), dropped: ids(d), watchlist: ids(w) };
}

export async function recommend(ctx: Pick<Ctx, 'cfg' | 'db' | 'kv' | 'jf'>, user: JfUser, profile: RecoProfile, o: RecommendOptions): Promise<RecoResult> {
  const now = o.now ?? Date.now();
  const c = recoCoefficients(ctx.cfg);
  const w = recoWeights(ctx.cfg);
  const index = await loadIndex(ctx, w, now);
  const [taste, marks, seed] = await Promise.all([
    tasteProfile(ctx, user, profile, index, c, w, now),
    loadMarks(ctx, profile.id),
    o.seed ? rootItem(ctx, user, o.seed) : Promise.resolve(undefined),
  ]);
  const context = o.context ?? (await contextFor(ctx, profile, now, o.device).catch((): RecoContext | undefined => undefined));
  const cands = await gatherCandidates({ ctx, user, profile, taste, index, c, surface: o.surface, now, ...(seed ? { seed } : {}) }, o.sources ?? RECO_SOURCES);

  // titles the sources did not bring resolved are looked up with the viewer's token; invisible ones drop out here
  const missing = [...cands.values()].filter((x) => !x.item).map((x) => x.id);
  const found = missing.length ? await resolveVisible(ctx, user, missing) : new Map<string, ItemDto>();
  const sc = { surface: o.surface, c, taste, index, profile, marks, ...(seed ? { seed } : {}), ...(context ? { context } : {}), now };
  const scored: Scored[] = [];
  for (const cand of cands.values()) {
    const item = cand.item ?? found.get(cand.id);
    if (!item || filterReason(item, sc)) continue;
    scored.push(scoreCandidate(cand, item, sc));
  }

  const rankable = scored.map((s) => Object.assign(s, { franchise: s.row?.collection_id ?? null, genre: s.row?.genres[0] ?? s.item.genres[0]?.trim().toLowerCase() ?? null }));
  let ranked = mmr<Scored & RankItem>(rankable, o.limit, c);

  // R3b exploration (RECO_EXPLORE, default 0 = off: no random number is drawn, nothing is counted): about 1 slot in 10 after the best 3 is
  // swapped for a medium-score candidate; the propensity of every eligible slot is counted by row kind and arm, nothing else
  const rate = o.explore === false ? 0 : recoExplore(ctx.cfg);
  const slotOf = new Map<string, { arm: string; propensity: number }>();
  if (rate > 0) {
    const row = o.row ?? ROW_OF_SURFACE[o.surface];
    const x = explore(ranked, rankable, rate, c, o.rng ?? Math.random, (cand, rest) => !cand.franchise || rest.filter((r) => r.franchise === cand.franchise).length < c.rank.perFranchise);
    ranked = x.items;
    for (const sl of x.slots) {
      slotOf.set(sl.id, sl);
      recoExploreSlots.inc({ row, arm: sl.arm });
      recoExplorePropensity.inc({ row, arm: sl.arm }, sl.propensity);
    }
  }
  const reasons = await explain(ctx, user, ranked, { ...(seed ? { seed: { id: seed.id, name: seed.name } } : {}), taste, index, c }).catch(() => new Map<string, Reason>());
  return {
    surface: o.surface, cold: taste.cold, pool: new Map(scored.map((s) => [s.id, s.score])),
    items: ranked.map((s) => {
      const sl = slotOf.get(s.id);
      return { item: s.item, score: s.score, sources: s.sources, parts: s.parts, reason: reasons.get(s.id) ?? { seed: null, traits: [] }, ...(sl ? { propensity: sl.propensity, ...(sl.arm === 'explore' ? { explored: true } : {}) } : {}) };
    }),
  };
}

// ------------------------------------------------------------------------------------------------------------------------ shadow

export const SHADOW_TOP = 10;
const shadowRuns = new Set<Promise<void>>();
/** Resolves when no shadow comparison is running in this process (tests). */
export async function shadowIdle(): Promise<void> {
  while (shadowRuns.size) await Promise.all([...shadowRuns]);
}

/** Share of the v1 top list that the v2 top list also holds (0 when v1 is empty). */
export function overlap(v1: readonly string[], v2: readonly string[], n = SHADOW_TOP): number {
  const a = v1.slice(0, n);
  if (!a.length) return 0;
  const b = new Set(v2.slice(0, n));
  return a.filter((id) => b.has(id)).length / a.length;
}

/**
 * Mean v2 score of the v2 list minus the mean v2 score of the v1 titles that v2 also scored (positive = v2 prefers its own list).
 * Titles v2 never saw as candidates do not count; null when none of v1's titles was scored.
 */
export function scoreDelta(v1: readonly string[], v2: readonly RecoItem[], pool: ReadonlyMap<string, number>, n = SHADOW_TOP): number | null {
  const own = v2.slice(0, n);
  const theirs = v1.slice(0, n).map((id) => pool.get(id)).filter((x): x is number => x !== undefined);
  if (!own.length || !theirs.length) return null;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  return mean(own.map((i) => i.score)) - mean(theirs);
}

/**
 * Shadow mode: runs v2 for the same seed as v1 and records the overlap of the two top-10 lists and the score delta as metrics. Titles,
 * profiles and users appear nowhere (labels: surface, result). Never throws; the caller does not wait for it. Runs once per profile,
 * user-data version and seed (kv guard), so the extra work is not repeated on every request.
 */
export function shadowCompare(ctx: Pick<Ctx, 'cfg' | 'db' | 'kv' | 'jf'>, user: JfUser, profile: RecoProfile, o: { seed: string; surface: Surface; v1: readonly string[]; guardKey: string }): Promise<void> {
  const run = (async () => {
    try {
      if (!(await ctx.kv.setnx(`reco:shadow:${o.guardKey}`, '1', 600).catch(() => true))) return;
      const r = await recommend(ctx, user, profile, { seed: o.seed, surface: o.surface, limit: SHADOW_TOP, explore: false });
      recoShadowOverlap.observe({ surface: o.surface }, overlap(o.v1, r.items.map((i) => i.item.id)));
      const d = scoreDelta(o.v1, r.items, r.pool);
      if (d !== null) recoShadowScoreDelta.observe({ surface: o.surface }, d);
      recoShadowRuns.inc({ surface: o.surface, result: 'ok' });
    } catch {
      recoShadowRuns.inc({ surface: o.surface, result: 'error' }); // no message: it could carry a server URL
    }
  })();
  shadowRuns.add(run);
  void run.finally(() => shadowRuns.delete(run));
  return run;
}
