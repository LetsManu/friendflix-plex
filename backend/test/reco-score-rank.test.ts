// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Candidate } from '../src/reco/candidates.js';
import type { Taste } from '../src/reco/profile.js';
import { mmr, type RankItem } from '../src/reco/rank.js';
import { bayesRating, filterReason, freshness, qualityPrior, ratingAge, scoreCandidate, withinAgeCap, type Marks, type ScoreContext } from '../src/reco/score.js';
import { loadIndex, resetIndexCache, type Index, type SparseVec } from '../src/reco/vectors.js';
import { recoCoefficients, recoWeights } from '../src/reco/weights.js';
import { buildIndex, dto, DAY, H, NOW } from './reco-fixture.js';
import { makeEnv, type TestEnv } from './helpers.js';

// R2: scoring (penalties, hard filters, quality prior, age cap) and MMR re-ranking (caps, duplicates).
const c = recoCoefficients();
const none: Marks = { thumbsDown: new Set(), dropped: new Set(), watchlist: new Set() };
const marks = (m: Partial<Record<keyof Marks, string[]>>): Marks => ({ thumbsDown: new Set(m.thumbsDown), dropped: new Set(m.dropped), watchlist: new Set(m.watchlist) });
const taste = (o: Partial<Taste> = {}): Taste => ({ pos: new Map(), neg: new Map(), weighted: 10, cold: false, seen: new Set(), prefs: { animeShare: 0, runtimeBand: null, genres: {}, rewatchShare: 0 }, ...o });
const cand = (key: string, o: Partial<Candidate> = {}): Candidate => ({ id: H(key), sources: new Set(['similar']), signals: {}, meta: {}, ...o });

describe('quality prior and age cap', () => {
  it('Bayesian smoothing: 10.0 from two votes does not beat a solid 8.4', () => {
    expect(bayesRating(10, 2, 6.5, 25)).toBeCloseTo((25 * 6.5 + 2 * 10) / 27, 10);
    expect(bayesRating(10, 2, 6.5, 25)).toBeLessThan(bayesRating(8.4, 2000, 6.5, 25));
    expect(bayesRating(7, 1e9, 6.5, 25)).toBeCloseTo(7, 4);
  });
  it('qualityPrior stays within [0, 1], a perfect 10 is damped, an unrated title is neutral', () => {
    const q = (r: number | undefined, row?: { community_rating: number | null; critic_rating: number | null }) => qualityPrior({ communityRating: r }, row, 6.5, c);
    expect(q(10)).toBeLessThan(1);
    expect(q(10)).toBeGreaterThan(q(8));
    expect(q(0)).toBeGreaterThanOrEqual(0);
    expect(q(undefined)).toBeCloseTo(q(6.5), 10);
    expect(q(7, { community_rating: 7, critic_rating: 90 })).toBeGreaterThan(q(7, { community_rating: 7, critic_rating: 20 }));
  });
  it('freshness halves every 120 days since the title was added', () => {
    expect(freshness({ dateCreated: new Date(NOW).toISOString() }, NOW, c)).toBe(1);
    expect(freshness({ dateCreated: new Date(NOW - 120 * DAY).toISOString() }, NOW, c)).toBeCloseTo(0.5, 10);
    expect(freshness({}, NOW, c)).toBe(0);
    expect(freshness({ premiereDate: new Date(NOW - 240 * DAY).toISOString() }, NOW, c)).toBeCloseTo(0.25, 10);
  });
  it('ratingAge reads FSK, DE, bare numbers and US labels; unknown spellings are null', () => {
    const r = ['FSK 12', 'FSK-6', 'DE-16', '0', 'PG', 'PG-13', 'TV-Y7', 'TV-MA', 'NR', '', undefined].map((x) => ratingAge(x));
    expect(r).toEqual([12, 6, 16, 0, 10, 13, 7, 17, null, null, null]);
  });
  it('a kids profile needs a known rating at or below its cap; others are not capped here', () => {
    const kid = { kids: true, kids_max_rating: 6 };
    expect(withinAgeCap({ rating: 'FSK 6' }, kid)).toBe(true);
    expect(withinAgeCap({ rating: 'FSK 0' }, kid)).toBe(true);
    expect(withinAgeCap({ rating: 'FSK 12' }, kid)).toBe(false);
    expect(withinAgeCap({}, kid)).toBe(false); // unrated
    expect(withinAgeCap({ rating: 'wat' }, kid)).toBe(false);
    expect(withinAgeCap({}, { kids: false, kids_max_rating: 6 })).toBe(true);
  });
});

describe('scoring', () => {
  let env: TestEnv;
  let index: Index;
  beforeAll(async () => {
    env = await makeEnv();
    await buildIndex(env);
    resetIndexCache(env.ctx);
    index = await loadIndex(env.ctx, recoWeights(env.ctx.cfg), NOW);
  });
  afterAll(() => env.close());
  const ctxOf = (o: Partial<ScoreContext> = {}): ScoreContext => ({ surface: 'because', c, taste: taste(), index, profile: { kids: false, kids_max_rating: 12 }, marks: none, now: NOW, ...o });
  const score = (key: string, o: Partial<ScoreContext> = {}, cd: Partial<Candidate> = {}, item = {}) => scoreCandidate(cand(key, cd), dto(key, item), ctxOf(o));

  it('a new season of a watched series is new content: no played penalty; the fresh label counts as fresh', () => {
    const seen = taste({ seen: new Set([H('signal')]) });
    const plain = score('signal', { taste: seen });
    const labelled = score('signal', { taste: seen }, { meta: { fresh: 'newSeason' } });
    expect(plain.parts.penalties.played).toBe(c.penalty.played);
    expect(labelled.parts.penalties.played).toBe(0);
    // a label on a film does not waive anything
    expect(score('noir2', { taste: taste({ seen: new Set([H('noir2')]) }) }, { meta: { fresh: 'new' } }).parts.penalties.played).toBe(c.penalty.played);
    expect(score('rom2', {}, { meta: { fresh: 'newSeries' } }).parts.fresh).toBeGreaterThanOrEqual(c.score.freshLabelBoost);
    expect(score('rom2').parts.fresh).toBeLessThan(c.score.freshLabelBoost);
  });

  it('penalties: played, dropped and on the watchlist subtract their coefficients exactly', () => {
    const base = score('noir2').score;
    expect(base - score('noir2', {}, {}, { played: true }).score).toBeCloseTo(c.penalty.played, 10);
    expect(base - score('noir2', { taste: taste({ seen: new Set([H('noir2')]) }) }).score).toBeCloseTo(c.penalty.played, 10); // seen but not marked played (a series in progress)
    expect(base - score('noir2', { marks: marks({ dropped: [H('noir2')] }) }).score).toBeCloseTo(c.penalty.dropped, 10);
    expect(base - score('noir2', { marks: marks({ watchlist: [H('noir2')] }) }).score).toBeCloseTo(c.penalty.watchlist, 10);
    const both = score('noir2', { marks: marks({ dropped: [H('noir2')], watchlist: [H('noir2')] }) }, {}, { played: true });
    expect(base - both.score).toBeCloseTo(c.penalty.played + c.penalty.dropped + c.penalty.watchlist, 10);
    expect(both.parts.penalties).toEqual({ played: c.penalty.played, dropped: c.penalty.dropped, watchlist: c.penalty.watchlist });
  });

  it('a rewatch-friendly profile is penalised less for played titles', () => {
    const friendly = taste({ prefs: { animeShare: 0, runtimeBand: null, genres: {}, rewatchShare: 0.3 } });
    const base = score('noir2', { taste: friendly }).score;
    expect(base - score('noir2', { taste: friendly }, {}, { played: true }).score).toBeCloseTo(c.penalty.playedRewatchFriendly, 10);
  });

  it('thumbs-down is a hard filter, so are the seed, other types and (kids) titles above the cap', () => {
    const x = ctxOf({ marks: marks({ thumbsDown: [H('noir2')] }) });
    expect(filterReason(dto('noir2'), x)).toBe('thumbs_down');
    expect(filterReason(dto('noir1'), x)).toBeNull();
    expect(filterReason(dto('saga1'), { ...x, seed: dto('saga1') })).toBe('seed');
    expect(filterReason({ ...dto('saga1'), type: 'Episode' }, x)).toBe('type');
    const kid = ctxOf({ profile: { kids: true, kids_max_rating: 6 } });
    expect(filterReason(dto('rom1'), kid)).toBeNull();
    expect(filterReason(dto('noir1'), kid)).toBe('age_cap');
    expect(filterReason(dto('unrated'), kid)).toBe('age_cap');
  });

  it('affinity is cos(pos) - 0.5 cos(neg); a cold profile has none', () => {
    const v = index.vecs.get(H('noir2'))!;
    const pos: SparseVec = new Map(v), neg: SparseVec = new Map(index.vecs.get(H('rom1'))!);
    const a = score('noir2', { taste: taste({ pos }) }).parts.affinity;
    expect(a).toBeCloseTo(1, 6); // identical direction
    const b = score('rom1', { taste: taste({ pos: new Map(v), neg }) }).parts.affinity;
    const plain = score('rom1', { taste: taste({ pos: new Map(v) }) }).parts.affinity;
    expect(plain - b).toBeCloseTo(0.5, 6); // rom1 is the negative direction: cos 1 * 0.5
    expect(score('noir2', { taste: taste({ pos, cold: true }) }).parts.affinity).toBe(0);
  });

  it('seed similarity blends the index cosine with the media server rank; the same collection beats a stranger', () => {
    const seed = dto('saga1');
    const mate = score('saga2', { seed }, { jfRank: 0.5 });
    const stranger = score('rom3', { seed }, { jfRank: 0.5 });
    expect(mate.parts.seed).toBeGreaterThan(stranger.parts.seed);
    const cos = mate.parts.seed;
    const noRank = score('saga2', { seed }).parts.seed;
    expect(cos).toBeCloseTo((1 - c.score.jfRankShare) * noRank + c.score.jfRankShare * 0.5, 10);
    expect(score('saga2').parts.seed).toBe(0); // no seed (taste surface)
  });

  it('surfaces weigh differently: post-play leans on transitions, taste ignores the seed', () => {
    const seed = dto('saga1');
    const withTransition = { signals: { transition: 1 } };
    const post = score('saga2', { seed, surface: 'postplay' }, withTransition).score - score('saga2', { seed, surface: 'postplay' }).score;
    const because = score('saga2', { seed, surface: 'because' }, withTransition).score - score('saga2', { seed, surface: 'because' }).score;
    expect(post).toBeCloseTo(c.surface.postplay.transition, 10);
    expect(because).toBe(0);
    expect(c.surface.taste.seed).toBe(0);
    expect(score('saga2', { seed, surface: 'taste' }).score).toBeCloseTo(score('saga2', { surface: 'taste' }).score, 10); // a seed changes nothing there
  });

  it('trending can never be more than 10 % of the score', () => {
    const plain = score('saga2').score;
    const hot = score('saga2', {}, { signals: { trending: 1 } });
    expect(hot.parts.trending).toBeLessThanOrEqual(plain * (c.score.trendingCap / (1 - c.score.trendingCap)) + 1e-12);
    expect(hot.parts.trending / hot.score).toBeLessThanOrEqual(0.1 + 1e-9);
  });
});

describe('MMR', () => {
  const it_ = (id: string, score: number, o: Partial<RankItem> = {}): RankItem => ({ id, score, ...o });
  const v = (o: Record<string, number>): SparseVec => new Map(Object.entries(o));
  const ids = (xs: RankItem[]) => xs.map((x) => x.id);

  it('lambda 0.7: with equal relevance the more different title wins', () => {
    const items = [it_('a', 1, { vec: v({ x: 1 }) }), it_('b', 0.9, { vec: v({ x: 1 }) }), it_('c', 0.85, { vec: v({ y: 1 }) })];
    expect(ids(mmr(items, 3, c))).toEqual(['a', 'c', 'b']);
    expect(c.rank.lambda).toBe(0.7);
  });

  it('at most 2 per franchise / collection, however good the rest of the franchise scores', () => {
    const items = [
      ...['f1', 'f2', 'f3', 'f4'].map((id, n) => it_(id, 1 - n * 0.01, { franchise: 'saga' })),
      ...['o1', 'o2', 'o3'].map((id, n) => it_(id, 0.5 - n * 0.01, { franchise: null })),
    ];
    const out = ids(mmr(items, 5, c));
    expect(out.filter((i) => i.startsWith('f'))).toEqual(['f1', 'f2']);
    expect(out).toEqual(['f1', 'f2', 'o1', 'o2', 'o3']);
    // the cap never gets relaxed: with nothing else, the row stays short
    expect(ids(mmr(items.slice(0, 4), 4, c))).toEqual(['f1', 'f2']);
  });

  it('cap per dominant genre: no more than ceil(limit * 0.5) of one genre while other genres are available', () => {
    const items = [
      ...Array.from({ length: 8 }, (_, n) => it_(`d${n}`, 1 - n * 0.01, { genre: 'drama' })),
      ...Array.from({ length: 4 }, (_, n) => it_(`c${n}`, 0.4 - n * 0.01, { genre: 'comedy' })),
    ];
    const out = ids(mmr(items, 6, c));
    expect(out.filter((i) => i.startsWith('d'))).toHaveLength(3); // ceil(6 * 0.5)
    expect(out.filter((i) => i.startsWith('c'))).toHaveLength(3);
  });

  it('the genre cap is relaxed to fill a short row', () => {
    const items = Array.from({ length: 6 }, (_, n) => it_(`d${n}`, 1 - n * 0.01, { genre: 'drama' }));
    expect(mmr(items, 6, c)).toHaveLength(6);
  });

  it('a near-duplicate of a chosen title is pushed behind a different one', () => {
    const items = [it_('a', 1, { vec: v({ x: 1 }) }), it_('dup', 0.99, { vec: v({ x: 1, y: 0.01 }) }), it_('other', 0.6, { vec: v({ z: 1 }) })];
    expect(ids(mmr(items, 3, c))).toEqual(['a', 'other', 'dup']);
  });

  it('is deterministic: equal scores order by id; empty and zero limits are fine', () => {
    const items = [it_('b', 1), it_('a', 1), it_('c', 1)];
    expect(ids(mmr(items, 3, c))).toEqual(['a', 'b', 'c']);
    expect(mmr([], 5, c)).toEqual([]);
    expect(mmr(items, 0, c)).toEqual([]);
  });
});
