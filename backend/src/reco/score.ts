// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ItemDto } from '../media/types.js';
import type { Candidate, HitMeta, SourceName } from './candidates.js';
import { contextFit, type RecoContext } from './context.js';
import type { RecoProfile, Taste } from './profile.js';
import { dot, type FeatureRow, type Index, type SparseVec } from './vectors.js';
import type { RecoCoefficients, Surface, SurfaceWeights } from './weights.js';

/**
 * Recommendation engine v2, R2: scoring (spec 4.5).
 *   score = context * (a*affinity + b*seed + c*cooccurrence + t*transition + d*friends + e*quality + f*fresh) + trending(capped) - penalties
 * with one weight set per surface (weights.ts). Thumbs-down and the kids age cap are hard filters, not penalties. `context` (R3,
 * context.ts) is a soft multiplier around 1 (time of day, device, language, runtime budget, series status), never a filter.
 * Trending is capped so that it is at most `trendingCap` (10 %) of the score before penalties, on every surface.
 */

const DAY_MS = 86_400_000;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** What the profile has said about titles, read fresh from the database on every request (never from the cache). */
export interface Marks { thumbsDown: ReadonlySet<string>; dropped: ReadonlySet<string>; watchlist: ReadonlySet<string> }

// ---------------------------------------------------------------------------------------------------------------------- age cap

/**
 * Age in years of an official rating ("FSK 12", "DE-6", "12", "PG-13", "TV-Y7" ...) or null for unrated / unknown spellings.
 * US labels use a cautious table of our own (PG = 10, PG-13 = 13, R = 17); the media server's policy is the authority, this is a second check.
 */
export function ratingAge(rating: string | undefined | null): number | null {
  const r = (rating ?? '').trim().toUpperCase();
  if (!r) return null;
  const m = /^(?:FSK|DE)?[\s-]*(\d{1,2})$/.exec(r);
  if (m) return Number(m[1]);
  const US: Record<string, number> = { G: 0, PG: 10, 'PG-13': 13, R: 17, 'NC-17': 18, 'TV-Y': 0, 'TV-Y7': 7, 'TV-G': 0, 'TV-PG': 10, 'TV-14': 14, 'TV-MA': 17 };
  return US[r] ?? null;
}

/** A kids profile sees a title only when its rating is known and at most the profile's cap; the media server enforces the same on the viewer's token. */
export function withinAgeCap(item: Pick<ItemDto, 'rating'>, profile: Pick<RecoProfile, 'kids' | 'kids_max_rating'>): boolean {
  if (!profile.kids) return true;
  const age = ratingAge(item.rating);
  return age !== null && age <= profile.kids_max_rating;
}

// -------------------------------------------------------------------------------------------------------------------- components

/** Bayesian average: (m*mean + n*r) / (m + n). Few votes pull the rating towards the library mean, so 10.0 from 2 votes does not win. */
export function bayesRating(rating: number, votes: number, mean: number, priorVotes: number): number {
  return (priorVotes * mean + votes * rating) / (priorVotes + votes);
}

/** Quality prior in [0, 1]. The index holds no vote counts, so `ratingAssumedVotes` stands in; a community and a critic score are blended 70/30. */
export function qualityPrior(item: Pick<ItemDto, 'communityRating'>, row: Pick<FeatureRow, 'community_rating' | 'critic_rating'> | undefined, libraryMean: number, c: RecoCoefficients): number {
  const community = item.communityRating ?? row?.community_rating ?? null;
  const critic = row?.critic_rating != null ? row.critic_rating / 10 : null;
  const s = c.score;
  const mean = libraryMean > 0 ? libraryMean : s.ratingPriorMean;
  let r: number | null = community !== null && critic !== null ? 0.7 * community + 0.3 * critic : community ?? critic;
  if (r === null || !Number.isFinite(r)) r = mean;
  const smoothed = bayesRating(Math.max(0, Math.min(10, r)), s.ratingAssumedVotes, mean, s.ratingPriorVotes);
  return clamp01((smoothed - s.ratingFloor) / (s.ratingCeil - s.ratingFloor));
}

/** 0.5^(age/halfLife) of the day the title was added to the library (premiere date as a fallback); 0 when unknown. */
export function freshness(item: Pick<ItemDto, 'dateCreated' | 'premiereDate'>, now: number, c: RecoCoefficients): number {
  const t = Date.parse(item.dateCreated ?? item.premiereDate ?? '');
  if (!Number.isFinite(t)) return 0;
  return 0.5 ** (Math.max(0, now - t) / DAY_MS / c.score.freshHalfLifeDays);
}

/** cos(pos) - negWeight * cos(neg); both vectors and the item vector are normalised, so dot() is the cosine. */
export function contentAffinity(taste: Pick<Taste, 'pos' | 'neg'>, vec: SparseVec | undefined, c: RecoCoefficients): number {
  if (!vec) return 0;
  return dot(taste.pos, vec) - c.profile.negWeight * dot(taste.neg, vec);
}

// ----------------------------------------------------------------------------------------------------------------------- scoring

export type FilterReason = 'seed' | 'thumbs_down' | 'age_cap' | 'type';

export interface ScoreParts {
  affinity: number; seed: number; cooccurrence: number; transition: number; friends: number; quality: number; fresh: number; trending: number;
  /** the context multiplier applied to the sum of the other parts (1 = neutral, or no context given) */
  context: number;
  penalties: { played: number; dropped: number; watchlist: number };
}

export interface Scored {
  id: string;
  item: ItemDto;
  score: number;
  parts: ScoreParts;
  sources: SourceName[];
  meta: HitMeta;
  vec?: SparseVec;
  row?: FeatureRow;
}

export interface ScoreContext {
  surface: Surface;
  c: RecoCoefficients;
  taste: Taste;
  index: Index;
  profile: Pick<RecoProfile, 'kids' | 'kids_max_rating'>;
  marks: Marks;
  seed?: ItemDto;
  now: number;
  /** R3: time of day, device, language; absent = no context multiplier (the offline engine has none) */
  context?: RecoContext;
}

/** Hard filters: the seed itself, thumbs-down, anything but films and series, and (kids) anything above the age cap or unrated. */
export function filterReason(item: ItemDto, x: Pick<ScoreContext, 'marks' | 'profile' | 'seed'>): FilterReason | null {
  if (item.type !== 'Movie' && item.type !== 'Series') return 'type';
  if (x.seed && item.id === x.seed.id) return 'seed';
  if (x.marks.thumbsDown.has(item.id)) return 'thumbs_down';
  if (!withinAgeCap(item, x.profile)) return 'age_cap';
  return null;
}

export function scoreCandidate(cand: Candidate, item: ItemDto, x: ScoreContext): Scored {
  const w: SurfaceWeights = x.c.surface[x.surface];
  const vec = x.index.vecs.get(item.id);
  const row = x.index.rows.get(item.id);
  const seedVec = x.seed ? x.index.vecs.get(x.seed.id) : undefined;

  const affinity = x.taste.cold ? 0 : contentAffinity(x.taste, vec, x.c);
  let seed = 0;
  if (x.seed) {
    const cos = vec && seedVec ? dot(vec, seedVec) : null;
    const jf = cand.jfRank ?? null;
    seed = cos !== null && jf !== null ? (1 - x.c.score.jfRankShare) * cos + x.c.score.jfRankShare * jf : cos ?? jf ?? 0;
  }
  const quality = qualityPrior(item, row, x.index.meanRating, x.c);
  // a title the media server labels new (fresh.ts) counts as fresh whatever its library date says
  const fresh = Math.max(freshness(item, x.now, x.c), cand.meta.fresh ? x.c.score.freshLabelBoost : 0);
  const sig = (k: 'cooccurrence' | 'transition' | 'friends') => clamp01(cand.signals[k] ?? 0);

  const ctxFit = x.context ? contextFit(item, row, x.taste, x.context, x.c).factor : 1;
  const rest = ctxFit * (w.affinity * affinity + w.seed * seed + w.cooccurrence * sig('cooccurrence') + w.transition * sig('transition') + w.friends * sig('friends') + w.quality * quality + w.fresh * fresh);
  // trending may be at most trendingCap of the whole score: t <= cap/(1-cap) * rest
  const cap = x.c.score.trendingCap;
  const trending = Math.min(w.trending * clamp01(cand.signals.trending ?? 0), (cap / (1 - cap)) * Math.max(0, rest));

  const p = x.c.penalty;
  const rewatchFriendly = x.taste.prefs.rewatchShare >= p.rewatchFriendlyShare;
  // a new season of a series the profile watches is new content, not a repeat
  const newSeason = cand.meta.fresh === 'newSeason' && item.type === 'Series';
  const played = !newSeason && (item.played || x.taste.seen.has(item.id)) ? (rewatchFriendly ? p.playedRewatchFriendly : p.played) : 0;
  const penalties = { played, dropped: x.marks.dropped.has(item.id) ? p.dropped : 0, watchlist: x.marks.watchlist.has(item.id) ? p.watchlist : 0 };

  const score = rest + trending - penalties.played - penalties.dropped - penalties.watchlist;
  return {
    id: item.id, item, score, sources: [...cand.sources], meta: cand.meta, ...(vec ? { vec } : {}), ...(row ? { row } : {}),
    parts: { affinity, seed, cooccurrence: sig('cooccurrence'), transition: sig('transition'), friends: sig('friends'), quality, fresh, trending, context: ctxFit, penalties },
  };
}
