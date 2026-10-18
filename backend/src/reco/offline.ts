// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ItemDto } from '../media/types.js';
import { buildPairTables, coocSignals, transitionSignals, type TitleSpan } from './aggregates.js';
import type { SourceName } from './candidates.js';
import { explore as exploreFn } from './explore.js';
import { buildTaste, type Signal } from './profile.js';
import { mmr } from './rank.js';
import { scoreCandidate, type Marks, type ScoreContext } from './score.js';
import { idf as idfOf, numStat } from './tfidf.js';
import { buildPostings, dot, itemVector, topRatedOf, type FeatureRow, type Index, type SparseVec } from './vectors.js';
import { DEFAULT_RECO_WEIGHTS, recoCoefficients, type RecoCoefficients, type RecoWeights, type Surface } from './weights.js';

/**
 * Recommendation engine v2 for the offline evaluation (scripts/reco-eval.mjs, spec 4.7): the same taste maths, vectors, scoring and MMR
 * as the live engine, fed from a dataset instead of the database and the media server. Pure, no I/O. The script imports the compiled
 * file (`npm run build -w backend`). Differences to the live engine, by necessity: the item index is built from the dataset's own
 * item features (IDF over the dataset), "similar()" comes from the dataset's recorded answers (or is left out), and the signals are
 * what a dataset knows: played (+finished movie weight), liked (+thumbs-up weight), disliked (thumbs-down).
 *
 * R3 adds, from the training profiles of the dataset: item-item co-occurrence and transitions (the same aggregate code as the live
 * engine, with the same minimum support of 2 profiles) and a trending signal (profiles that played a title in the last 7 days before the
 * query), and switches (`off`) to leave one component out for the ablation table. Not evaluable offline, because a dataset has no such
 * data: context features (time of day, device, language, runtime budget, series status), the friends signal and the fresh labels.
 */

/** The components of the score the ablation can switch off one by one. */
export const OFFLINE_COMPONENTS = ['affinity', 'seed', 'cooccurrence', 'transition', 'quality', 'fresh', 'trending', 'mmr'] as const;
export type OfflineComponent = (typeof OFFLINE_COMPONENTS)[number];
export interface OfflineOptions {
  /** the other profiles of the dataset (never kids profiles): their sequences feed co-occurrence, transitions and trending */
  train?: ReadonlyArray<{ seq: ReadonlyArray<{ item: string; t: number }> }>;
  /** components left out of the score (affinity, seed ... as weights set to 0; mmr = plain score order) */
  off?: ReadonlyArray<OfflineComponent>;
}
const TREND_WINDOW_MS = 7 * 86_400_000;

export interface OfflineItem {
  id: string; genres?: string[]; tags?: string[]; studios?: string[]; people?: string[]; year?: number; runtime?: number; rating?: number; collection?: string;
  /** when the title was added (ms), for freshness; absent = unknown */
  added?: number;
}
export interface OfflineEvent { item: string; t: number; liked?: boolean; likedAt?: number }
export interface OfflineQuery { surface: 'home' | 'next'; history: readonly OfflineEvent[]; seed?: string; k: number; disliked?: ReadonlySet<string> }

const lower = (xs: readonly string[] | undefined) => (xs ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean);

/** Builds the index structures (rows, IDF, statistics, vectors) from dataset items. */
export function offlineIndex(items: readonly OfflineItem[], w: RecoWeights = DEFAULT_RECO_WEIGHTS): Index {
  const rows = new Map<string, FeatureRow>();
  for (const i of items) {
    rows.set(i.id, {
      item_id: i.id, type: 'Movie', genres: lower(i.genres), tags: lower(i.tags), studios: lower(i.studios), people: [...(i.people ?? [])], year: i.year ?? null, runtime_min: i.runtime ?? null,
      community_rating: i.rating ?? null, critic_rating: null, original_language: null, countries: [], collection_id: i.collection ?? null, series_status: null, overview_terms: {},
    });
  }
  const n = rows.size;
  const df = (pick: (r: FeatureRow) => string[]) => {
    const m = new Map<string, number>();
    for (const r of rows.values()) for (const v of new Set(pick(r))) m.set(v, (m.get(v) ?? 0) + 1);
    return new Map([...m].map(([k, d]) => [k, idfOf(n, d)]));
  };
  const all = [...rows.values()];
  const idf = { genre: df((r) => r.genres), tag: df((r) => r.tags), studio: df((r) => r.studios), person: df((r) => r.people) };
  const stats = { year: numStat(all.map((r) => r.year)), runtime_min: numStat(all.map((r) => r.runtime_min)), community_rating: numStat(all.map((r) => r.community_rating)), critic_rating: numStat([]) };
  const data = { idf, stats };
  const vecs = new Map<string, SparseVec>();
  const byCollection = new Map<string, string[]>();
  for (const [id, r] of rows) {
    vecs.set(id, itemVector(r, data, w));
    if (r.collection_id) (byCollection.get(r.collection_id) ?? byCollection.set(r.collection_id, []).get(r.collection_id)!).push(id);
  }
  return { rows, idf, stats, meanRating: stats.community_rating.n ? stats.community_rating.mean : 0, vecs, byCollection, postings: buildPostings(vecs), topRated: topRatedOf(rows), builtAt: 0 };
}

const NO_MARKS: Marks = { thumbsDown: new Set(), dropped: new Set(), watchlist: new Set() };

export function offlineEngine(items: readonly OfflineItem[], similar: Readonly<Record<string, readonly string[]>> = {}, c0: RecoCoefficients = recoCoefficients(), opts: OfflineOptions = {}) {
  const off = new Set(opts.off ?? []);
  const c = structuredClone(c0);
  for (const sw of Object.values(c.surface)) {
    if (off.has('affinity')) sw.affinity = 0;
    if (off.has('seed')) sw.seed = 0;
    if (off.has('cooccurrence')) sw.cooccurrence = 0;
    if (off.has('transition')) sw.transition = 0;
    if (off.has('quality')) sw.quality = 0;
    if (off.has('fresh')) sw.fresh = 0;
    if (off.has('trending')) sw.trending = 0;
  }
  const index = offlineIndex(items);
  // cross-profile aggregates from the training profiles: one span per profile and title (a day each), all counted as finished
  const tables = opts.train?.length ? buildPairTables(
    opts.train.flatMap((p, n) => p.seq.map((e): TitleSpan => ({ acct: String(n), root: e.item, first: e.t, last: e.t, secs: 1e9 }))), c,
    { runtimeSec: () => null, isSeries: () => false },
  ) : null;
  const added = new Map(items.map((i) => [i.id, i.added]));
  const asItem = (id: string, seen: ReadonlySet<string>): ItemDto => {
    const r = index.rows.get(id);
    const a = added.get(id);
    return {
      id, name: '', type: 'Movie', genres: r?.genres ?? [], image: false, backdrop: false, logo: false, trailers: 0, played: seen.has(id), favorite: false, positionTicks: 0,
      ...(r?.community_rating != null ? { communityRating: r.community_rating } : {}), ...(a !== undefined ? { dateCreated: new Date(a).toISOString() } : {}),
    };
  };

  return {
    name: 'v2',
    recommend(q: OfflineQuery): string[] {
      return run(q).ranked.map((x) => x.id);
    },
    /** The ranked list and the whole scored pool (what exploration draws its medium-score titles from), for the replay. */
    slate(q: OfflineQuery): { ranked: ScoredOffline[]; pool: ScoredOffline[] } {
      return run(q);
    },
  };

  function run(q: OfflineQuery): { ranked: ScoredOffline[]; pool: ScoredOffline[] } {
    {
      const last = q.history.reduce((m, e) => Math.max(m, e.t), 0);
      const now = last + 86_400_000;
      const signals: Signal[] = [];
      for (const e of q.history) {
        signals.push({ item: e.item, kind: 'finishedMovie', weight: c.signal.finishedMovie, at: e.t });
        if (e.liked) signals.push({ item: e.item, kind: 'thumbUp1', weight: c.signal.thumbUp1, at: e.likedAt ?? e.t });
      }
      for (const id of q.disliked ?? []) signals.push({ item: id, kind: 'thumbDown', weight: c.signal.thumbDown, at: last });
      const seen = new Set(q.history.map((e) => e.item));
      const taste = buildTaste(signals, seen, { vec: (id) => index.vecs.get(id), row: (id) => index.rows.get(id) }, c, now);

      const surface: Surface = q.surface === 'next' ? 'postplay' : 'home_rows';
      const seedId = q.surface === 'next' ? q.seed : undefined;
      const seed = seedId ? asItem(seedId, seen) : undefined;
      const cands = new Map<string, { id: string; sources: Set<SourceName>; jfRank?: number; signals: Record<string, number>; meta: Record<string, never> }>();
      const add = (id: string, src: SourceName, jfRank?: number, signal?: [string, number]) => {
        if (!index.rows.has(id) || id === seedId) return;
        let x = cands.get(id);
        if (!x) cands.set(id, (x = { id, sources: new Set(), signals: {}, meta: {} }));
        x.sources.add(src);
        if (jfRank !== undefined) x.jfRank = Math.max(x.jfRank ?? 0, jfRank);
        if (signal) x.signals[signal[0]] = Math.max(x.signals[signal[0]] ?? 0, signal[1]);
      };
      if (seedId) {
        const list = (similar[seedId] ?? []).filter((id) => id !== seedId).slice(0, c.candidates.similar);
        list.forEach((id, n) => add(id, 'similar', list.length > 1 ? 1 - n / (list.length - 1) : 1));
        const row = index.rows.get(seedId);
        if (row?.collection_id) for (const id of index.byCollection.get(row.collection_id) ?? []) add(id, 'universe');
        // without recorded similar() answers the seed's nearest neighbours stand in for them
        if (!list.length && index.vecs.get(seedId)) {
          const sv = index.vecs.get(seedId)!;
          [...index.vecs].filter(([id]) => id !== seedId).map(([id, v]) => [id, dot(sv, v)] as const).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, c.candidates.similar).forEach(([id], n, a) => add(id, 'similar', a.length > 1 ? 1 - n / (a.length - 1) : 1));
        }
      }
      if (!taste.cold && taste.pos.size) {
        [...index.vecs].filter(([id]) => !seen.has(id)).map(([id, v]) => [id, dot(taste.pos, v)] as const).filter(([, s]) => s > 0)
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, c.candidates.knn).forEach(([id]) => add(id, 'taste_nn'));
      }
      if (taste.cold && !seedId) {
        [...index.rows.values()].filter((r) => r.community_rating !== null).sort((a, b) => b.community_rating! - a.community_rating! || (a.item_id < b.item_id ? -1 : 1))
          .slice(0, c.candidates.prior).forEach((r) => add(r.item_id, 'prior'));
      }
      // R3 sources: co-occurrence with the seed (post-play) or with the profile's strongest titles (home), transitions out of the seed,
      // trending = profiles that played the title in the week before the query
      const w = c.surface[surface];
      if (tables && w.cooccurrence > 0) {
        for (const a of seedId ? [{ id: seedId, w: 1 }] : (taste.anchors ?? []).slice(0, c.social.anchors)) {
          for (const [id, cos] of coocSignals(tables, a.id)) add(id, 'cooccurrence', undefined, ['cooccurrence', Math.min(1, cos * a.w)]);
        }
      }
      if (tables && seedId && w.transition > 0) for (const [id, t] of transitionSignals(tables, seedId)) add(id, 'transition', undefined, ['transition', t.p]);
      if (opts.train?.length && w.trending > 0) {
        const per = new Map<string, number>();
        opts.train.forEach((p) => {
          for (const it of new Set(p.seq.filter((e) => e.t <= now && e.t > now - TREND_WINDOW_MS).map((e) => e.item))) per.set(it, (per.get(it) ?? 0) + 1);
        });
        const top = Math.max(3, ...per.values());
        for (const [id, n] of per) if (n >= c.social.minSupport) add(id, 'trending', undefined, ['trending', Math.min(1, Math.log1p(n) / Math.log1p(top))]);
      }
      const marks: Marks = { ...NO_MARKS, thumbsDown: new Set(q.disliked ?? []) };
      const sc: ScoreContext = { surface, c, taste, index, profile: { kids: false, kids_max_rating: 12 }, marks, ...(seed ? { seed } : {}), now };
      const scored = [...cands.values()].filter((x) => !marks.thumbsDown.has(x.id)).map((x) => scoreCandidate(x, asItem(x.id, seen), sc));
      const pool: ScoredOffline[] = scored.map((s) => Object.assign(s, { franchise: s.row?.collection_id ?? null, genre: s.row?.genres[0] ?? null }));
      if (off.has('mmr')) return { ranked: [...pool].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, q.k), pool };
      return { ranked: mmr(pool, q.k, c), pool };
    }
  }
}

/** A scored candidate of the offline engine: id, score, franchise (collection) for the per-franchise cap. */
export interface ScoredOffline { id: string; score: number; franchise: string | null; genre: string | null }
export { seededRng } from './explore.js';

/**
 * Exploration for the replay: the same draw as the live engine (explore.ts), over the offline ranked list and pool, keeping the per-franchise
 * cap. Returns the logged slate (item per slot) and, per slot, the propensity of the item that ended up there (1 for the protected top).
 */
export function exploreSlate(ranked: readonly ScoredOffline[], pool: readonly ScoredOffline[], rate: number, rng: () => number, c: RecoCoefficients = recoCoefficients()): { ids: string[]; propensity: number[] } {
  const x = exploreFn(ranked, pool, rate, c, rng, (cand, rest) => !cand.franchise || rest.filter((r) => r.franchise === cand.franchise).length < c.rank.perFranchise);
  const p = x.items.map(() => 1);
  for (const sl of x.slots) p[sl.index] = sl.propensity;
  return { ids: x.items.map((i) => i.id), propensity: p };
}
