// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import type { Ctx } from '../ctx.js';
import { zscore, type NumStat } from './tfidf.js';
import type { RecoWeights } from './weights.js';

/**
 * Recommendation engine v2, R2: item vectors built from the item feature index (R1) and the sparse-vector maths on them.
 * The index stores raw features and IDF; the field weights (RECO_W_*) apply here, on read, so a changed weight needs no re-index.
 * Pure functions plus one cached loader (loadIndex).
 */

/** Sparse vector: dimension name -> value. Names carry a group prefix (g: genre, t: tag, s: studio, p: person, w: term, c: collection, n: numeric). */
export type SparseVec = Map<string, number>;

export function norm(v: SparseVec): number {
  let s = 0;
  for (const x of v.values()) s += x * x;
  return Math.sqrt(s);
}

/** L2-normalised copy (an all-zero vector stays empty). */
export function normalize(v: SparseVec): SparseVec {
  const n = norm(v);
  const out: SparseVec = new Map();
  if (n > 0) for (const [k, x] of v) if (x !== 0) out.set(k, x / n);
  return out;
}

/** dst += f * src */
export function addScaled(dst: SparseVec, src: SparseVec, f: number): void {
  if (!f) return;
  for (const [k, x] of src) dst.set(k, (dst.get(k) ?? 0) + f * x);
}

/** Dot product (iterates the smaller vector). For two normalised vectors this is the cosine. */
export function dot(a: SparseVec, b: SparseVec): number {
  if (a.size > b.size) [a, b] = [b, a];
  let s = 0;
  for (const [k, x] of a) {
    const y = b.get(k);
    if (y !== undefined) s += x * y;
  }
  return s;
}

/** Cosine of two arbitrary vectors; 0 when either is empty. */
export function cosine(a: SparseVec, b: SparseVec): number {
  const na = norm(a), nb = norm(b);
  return na > 0 && nb > 0 ? dot(a, b) / (na * nb) : 0;
}

/** The `n` largest dimensions by absolute value (a stored taste vector stays small), values rounded to 4 places. */
export function topDims(v: SparseVec, n: number): SparseVec {
  const best = [...v.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || (a[0] < b[0] ? -1 : 1)).slice(0, n);
  return new Map(best.map(([k, x]) => [k, Math.round(x * 10_000) / 10_000]));
}

export const vecToJson = (v: SparseVec): Record<string, number> => Object.fromEntries(v);
export const vecFromJson = (o: unknown): SparseVec => {
  const out: SparseVec = new Map();
  if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) if (typeof x === 'number' && Number.isFinite(x)) out.set(k, x);
  return out;
};

// ------------------------------------------------------------------------------------------------------------------ item vectors

/** One row of item_features as the engine reads it. */
export interface FeatureRow {
  item_id: string; type: 'Movie' | 'Series'; genres: string[]; tags: string[]; studios: string[]; people: string[];
  year: number | null; runtime_min: number | null; community_rating: number | null; critic_rating: number | null;
  original_language: string | null; countries: string[]; collection_id: string | null; series_status: 'continuing' | 'ended' | null;
  overview_terms: Record<string, number>;
}

export type IdfKind = 'genre' | 'tag' | 'studio' | 'person';
export interface IndexStats { year: NumStat; runtime_min: NumStat; community_rating: NumStat; critic_rating: NumStat }
/** IDF of a value the table does not know (a title added after the last nightly pass): as rare as a value seen once in a mid-sized library. */
export const UNKNOWN_IDF = 2;
const NUMERIC_CLAMP = 3;

export interface IndexData {
  rows: Map<string, FeatureRow>;
  idf: Record<IdfKind, Map<string, number>>;
  stats: IndexStats;
  /** mean community rating over the library (0 when no title has one) */
  meanRating: number;
}

/**
 * The vector of one item: per group (genres, tags, studios, people) the IDF-weighted indicator, L2-normalised and scaled by the group weight
 * (so a rare director outweighs the genre "Drama" and a long cast list does not drown a short genre list); the overview terms (already
 * TF-IDF, L2-normalised) times the text weight; the collection as one dimension; year / runtime / ratings as z-scores. The result is
 * L2-normalised, so dot() is the cosine.
 */
export function itemVector(row: FeatureRow, data: Pick<IndexData, 'idf' | 'stats'>, w: RecoWeights): SparseVec {
  const v: SparseVec = new Map();
  const group = (prefix: string, kind: IdfKind, values: readonly string[], weight: number) => {
    if (weight <= 0 || !values.length) return;
    const g: SparseVec = new Map();
    for (const val of values) g.set(prefix + val, data.idf[kind].get(val) ?? UNKNOWN_IDF);
    addScaled(v, normalize(g), weight);
  };
  group('g:', 'genre', row.genres, w.genres);
  group('t:', 'tag', row.tags, w.tags);
  group('s:', 'studio', row.studios, w.studios);
  group('p:', 'person', row.people, w.people);
  if (w.text > 0) for (const [t, x] of Object.entries(row.overview_terms)) v.set('w:' + t, x * w.text);
  if (w.collection > 0 && row.collection_id) v.set('c:' + row.collection_id, w.collection);
  if (w.numeric > 0) {
    const n = (name: string, x: number | null, s: NumStat) => {
      const z = Math.max(-NUMERIC_CLAMP, Math.min(NUMERIC_CLAMP, zscore(x, s)));
      if (z !== 0) v.set('n:' + name, (z / NUMERIC_CLAMP) * w.numeric * 0.5);
    };
    n('year', row.year, data.stats.year);
    n('runtime', row.runtime_min, data.stats.runtime_min);
    n('rating', row.community_rating, data.stats.community_rating);
    n('critic', row.critic_rating, data.stats.critic_rating);
  }
  return normalize(v);
}

// ----------------------------------------------------------------------------------------------------------------------- loader

export interface Index extends IndexData {
  /** item_id -> normalised vector */
  vecs: Map<string, SparseVec>;
  /** collection_id -> item ids */
  byCollection: Map<string, string[]>;
  /**
   * Inverted index for the nearest-neighbour search: dimension (prefixed `-` for negative values) -> item ids, strongest value first,
   * at most POSTING_CAP per key.
   */
  postings: Map<string, string[]>;
  /** ids with a community rating, best first, at most TOP_RATED (the cold-start prior reads it instead of sorting the library) */
  topRated: string[];
  builtAt: number;
}

const TTL_MS = 5 * 60_000;
/** ids kept per dimension of the inverted index (the strongest ones) */
export const POSTING_CAP = 400;
export const TOP_RATED = 1000;
/** kv key the index job writes after every pass: a change means the index changed, so a cached copy is stale on every replica */
export const INDEX_GEN_KEY = 'reco:idx:lastDone';

interface CacheEntry { sig: string; gen: string; at: number; promise: Promise<Index> }
const cache = new WeakMap<object, CacheEntry>();
let loads = 0;

/** Forgets the in-process index of this ctx (tests, and the index job after a pass in this process). */
export function resetIndexCache(ctx: Pick<Ctx, 'db'>): void {
  cache.delete(ctx.db);
}
/** How many times the item_features table was read into memory in this process (tests: concurrent callers share one load). */
export const indexLoads = (): number => loads;

export const weightsSignature = (w: RecoWeights): string => createHash('sha1').update(JSON.stringify(w)).digest('hex').slice(0, 10);

const EMPTY_STAT: NumStat = { mean: 0, std: 0, n: 0 };

/** Posting key of a dimension value: the dimension for a positive value, `-` + dimension for a negative one (both raise a dot product). */
const postingKey = (dim: string, x: number): string => (x > 0 ? dim : '-' + dim);

/** Builds the inverted index of `vecs` (pure; exported for tests). */
export function buildPostings(vecs: ReadonlyMap<string, SparseVec>, cap = POSTING_CAP): Map<string, string[]> {
  const lists = new Map<string, Array<[string, number]>>();
  for (const [id, v] of vecs) {
    for (const [dim, x] of v) {
      if (x === 0) continue;
      const k = postingKey(dim, x);
      let l = lists.get(k);
      if (!l) lists.set(k, (l = []));
      l.push([id, Math.abs(x)]);
    }
  }
  const out = new Map<string, string[]>();
  for (const [dim, l] of lists) {
    l.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    out.set(dim, (l.length > cap ? l.slice(0, cap) : l).map((x) => x[0]));
  }
  return out;
}

/** Ids with a community rating, best first (ties by id), at most TOP_RATED. */
export const topRatedOf = (rows: ReadonlyMap<string, FeatureRow>): string[] => [...rows.values()].filter((r) => r.community_rating !== null)
  .sort((a, b) => (b.community_rating ?? 0) - (a.community_rating ?? 0) || (a.item_id < b.item_id ? -1 : 1)).slice(0, TOP_RATED).map((r) => r.item_id);

/** The nearest-neighbour search scores at most about this many vectors per call. */
export const NN_MAX_SCAN = 4000;

/**
 * Bounded nearest neighbours of `q`: the inverted index lists, per dimension and sign, the POSTING_CAP titles with the strongest value;
 * the query's dimensions are walked strongest first and their titles pooled until the pool holds NN_MAX_SCAN, and only the pool is
 * scored. One call therefore scores at most NN_MAX_SCAN + POSTING_CAP vectors, whatever the size of the library; on a small library the
 * pool is every title that shares a dimension of the same sign with q, so the answer equals a full scan.
 * Returns [id, cosine] for scores > 0, best first, at most `k`. `stats.scanned` reports how many vectors were scored.
 */
export function nearest(index: Pick<Index, 'vecs' | 'postings'>, q: SparseVec, k: number, skip: (id: string) => boolean = () => false, stats?: { scanned: number }): Array<[string, number]> {
  const dims = [...q].filter(([, x]) => x !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || (a[0] < b[0] ? -1 : 1));
  const pool = new Set<string>();
  for (const [d, x] of dims) {
    if (pool.size >= NN_MAX_SCAN) break;
    for (const id of index.postings.get(postingKey(d, x)) ?? []) pool.add(id);
  }
  const scored: Array<[string, number]> = [];
  for (const id of pool) {
    if (skip(id)) continue;
    const v = index.vecs.get(id);
    if (!v) continue;
    const s = dot(q, v);
    if (s > 0) scored.push([id, s]);
  }
  if (stats) stats.scanned = pool.size;
  scored.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return scored.slice(0, k);
}

async function readIndex(ctx: Pick<Ctx, 'db'>, w: RecoWeights, now: number): Promise<Index> {
  loads++;
  const [rows, idf, stats] = await Promise.all([
    ctx.db.query<FeatureRow>('select item_id, type, genres, tags, studios, people, year, runtime_min, community_rating, critic_rating, original_language, countries, collection_id, series_status, overview_terms from item_features'),
    ctx.db.query<{ kind: string; value: string; idf: number }>("select kind, value, idf from item_feature_idf where kind <> 'term'"),
    ctx.db.query<{ name: string; mean: number; std: number; n: number }>('select name, mean, std, n from item_feature_stats'),
  ]);
  const idfs: Record<IdfKind, Map<string, number>> = { genre: new Map(), tag: new Map(), studio: new Map(), person: new Map() };
  for (const r of idf.rows) idfs[r.kind as IdfKind]?.set(r.value, Number(r.idf));
  const st = new Map(stats.rows.map((r) => [r.name, { mean: Number(r.mean), std: Number(r.std), n: r.n }]));
  const data: IndexData = {
    rows: new Map(rows.rows.map((r) => [r.item_id, r])),
    idf: idfs,
    stats: { year: st.get('year') ?? EMPTY_STAT, runtime_min: st.get('runtime_min') ?? EMPTY_STAT, community_rating: st.get('community_rating') ?? EMPTY_STAT, critic_rating: st.get('critic_rating') ?? EMPTY_STAT },
    meanRating: 0,
  };
  data.meanRating = data.stats.community_rating.n > 0 ? data.stats.community_rating.mean : 0;
  const vecs = new Map<string, SparseVec>();
  const byCollection = new Map<string, string[]>();
  for (const [id, r] of data.rows) {
    vecs.set(id, itemVector(r, data, w));
    if (r.collection_id) (byCollection.get(r.collection_id) ?? byCollection.set(r.collection_id, []).get(r.collection_id)!).push(id);
  }
  return { ...data, vecs, byCollection, postings: buildPostings(vecs), topRated: topRatedOf(data.rows), builtAt: now };
}

/**
 * The whole index in memory (rows, IDF, statistics, item vectors, inverted index). Cached per process and shared: concurrent callers
 * wait for one in-flight load instead of each reading the table. Rebuilt after 5 minutes, when the weights change, or when the index
 * job finished a pass (its `reco:idx:lastDone` stamp in kv changed, so every replica notices). A failed load is not cached.
 */
export async function loadIndex(ctx: Pick<Ctx, 'db'> & Partial<Pick<Ctx, 'kv'>>, w: RecoWeights, now = Date.now()): Promise<Index> {
  const sig = weightsSignature(w);
  const gen = (ctx.kv ? await ctx.kv.get(INDEX_GEN_KEY).catch(() => null) : null) ?? '';
  const hit = cache.get(ctx.db);
  if (hit && hit.sig === sig && hit.gen === gen && now - hit.at < TTL_MS) return hit.promise;
  // set before the first await of the load, so every caller that arrives meanwhile shares this promise
  const entry: CacheEntry = { sig, gen, at: now, promise: readIndex(ctx, w, now) };
  cache.set(ctx.db, entry);
  entry.promise.catch(() => { if (cache.get(ctx.db) === entry) cache.delete(ctx.db); });
  return entry.promise;
}
