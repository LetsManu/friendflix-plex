// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { buildPairTables, coocSignals, finished, transitionSignals, type TableFacts, type TitleSpan } from '../src/reco/aggregates.js';
import { contextFit, deviceFit, hourIn, timeBudget, timeBucket, type RecoContext } from '../src/reco/context.js';
import type { Taste } from '../src/reco/profile.js';
import type { FeatureRow } from '../src/reco/vectors.js';
import { DEFAULT_RECO_COEFFICIENTS, recoCoefficients, SURFACES } from '../src/reco/weights.js';
import { dto } from './reco-fixture.js';

// R3, pure parts: the cross-user aggregates (support, opt-in shape, transitions) and the context multipliers.

const c = recoCoefficients();
const day = (n: number) => Date.UTC(2026, 0, 1 + n);
const RT = 6000; // every title is 100 minutes
const facts: TableFacts = { runtimeSec: () => RT, isSeries: (id) => id.startsWith('S') };
const sp = (acct: string, root: string, first: number, last = first, secs = RT): TitleSpan => ({ acct, root, first: day(first), last: day(last), secs });

describe('aggregates: co-occurrence', () => {
  it('a pair needs at least 2 distinct accounts; the signal is the cosine over accounts', () => {
    const t = buildPairTables([
      sp('A', 'm1', 0), sp('A', 'm2', 1), sp('B', 'm1', 0), sp('B', 'm2', 3), sp('C', 'm1', 0), sp('C', 'm3', 2),
    ], c, facts);
    expect(t.n.m1).toBe(3);
    expect(t.cooc.m1).toEqual([['m2', 2]]); // m3 was seen with m1 by one account only
    expect(t.cooc.m3).toBeUndefined();
    expect(coocSignals(t, 'm1').get('m2')).toBeCloseTo(2 / Math.sqrt(3 * 2), 10);
    expect(coocSignals(t, 'm1').has('m3')).toBe(false);
  });

  it('the minimum support never goes below 2, whatever RECO_COEFFS says', () => {
    const low = recoCoefficients({ RECO_COEFFS: '{"social.minSupport":1}' });
    expect(low.social.minSupport).toBe(2);
    expect(recoCoefficients({ RECO_COEFFS: '{"social.minSupport":0}' }).social.minSupport).toBe(2);
    const t = buildPairTables([sp('A', 'm1', 0), sp('A', 'm2', 1)], low, facts);
    expect(t.cooc).toEqual({});
    expect(t.trans).toEqual({});
  });

  it('a title watched for less than minSeconds does not count as watched', () => {
    const t = buildPairTables([sp('A', 'm1', 0), sp('A', 'm2', 1, 1, 100), sp('B', 'm1', 0), sp('B', 'm2', 1, 1, 100)], c, facts);
    expect(t.n.m2).toBeUndefined();
    expect(t.cooc).toEqual({});
  });

  it('the tables hold counts of titles only: no account id anywhere', () => {
    const t = buildPairTables([sp('acct-secret-1', 'm1', 0), sp('acct-secret-1', 'm2', 1), sp('acct-secret-2', 'm1', 0), sp('acct-secret-2', 'm2', 1)], c, facts);
    expect(JSON.stringify(t)).not.toContain('acct-secret');
    expect(Object.keys(t).sort()).toEqual(['builtAt', 'cooc', 'done', 'n', 'trans', 'v']);
  });
});

describe('aggregates: transitions (started right after finishing X, within 7 days)', () => {
  const spans = [
    sp('A', 'X', 0), sp('A', 'Y', 3), // yes
    sp('B', 'X', 0), sp('B', 'Y', 7), // yes: exactly 7 days after the last play of X
    sp('C', 'X', 0), sp('C', 'Y', 9), // too late
    sp('D', 'X', 0), sp('D', 'Z', 1), sp('D', 'Y', 2), // the next title was Z, not Y
    sp('E', 'Y', 0), sp('E', 'X', 5), // Y came before X
    sp('F', 'X', 0, 0, 1000), sp('F', 'Y', 1), // X not finished (a sixth of it), no transition
    sp('G', 'X', 0, 4), sp('G', 'Y', 2), // Y started while X was still being watched: not "after"
  ];
  const t = buildPairTables(spans, c, facts);

  it('counts distinct accounts per pair, the first title started after X only, within the window, X finished', () => {
    expect(t.trans.X).toEqual([['Y', 2]]); // A and B; Z has only D
    expect(t.done.X).toBe(6); // A B C D E G finished it; F did not
  });
  it('the signal is the smoothed share of the accounts that finished X', () => {
    const s = transitionSignals(t, 'X').get('Y')!;
    expect(s.support).toBe(2);
    expect(s.p).toBeCloseTo(2 / 7, 10);
    expect(transitionSignals(t, 'Y').size).toBe(0);
  });
  it('finishing: a film at 70 % of its runtime, a series after three episodes of viewing time', () => {
    expect(finished(sp('A', 'm', 0, 0, 0.7 * RT), facts, c)).toBe(true);
    expect(finished(sp('A', 'm', 0, 0, 0.69 * RT), facts, c)).toBe(false);
    expect(finished(sp('A', 'S1', 0, 0, 3 * RT), facts, c)).toBe(true);
    expect(finished(sp('A', 'S1', 0, 0, 2 * RT), facts, c)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------ context

const row = (o: Partial<FeatureRow> = {}): FeatureRow => ({
  item_id: 'x', type: 'Movie', genres: ['drama'], tags: [], studios: [], people: [], year: 2010, runtime_min: 100, community_rating: 7, critic_rating: null,
  original_language: null, countries: [], collection_id: null, series_status: null, overview_terms: {}, ...o,
});
const taste = (prefs: Partial<Taste['prefs']> = {}): Pick<Taste, 'prefs'> => ({ prefs: { animeShare: 0, runtimeBand: null, genres: {}, rewatchShare: 0, ...prefs } });
const noon: RecoContext = { hour: 12 };
const fit = (r: FeatureRow, t: Pick<Taste, 'prefs'>, x: RecoContext) => contextFit(dto('saga1'), r, t, x, c);

describe('context features', () => {
  it('buckets and budgets follow the hour', () => {
    expect([5, 11, 12, 16, 17, 22, 23, 0, 4].map(timeBucket)).toEqual(['morning', 'morning', 'afternoon', 'afternoon', 'evening', 'evening', 'night', 'night', 'night']);
    expect([12, 18, 21, 23, 3].map((h) => timeBudget(h, c))).toEqual([240, 180, 120, 90, 90]);
    expect(hourIn(Date.UTC(2026, 9, 1, 12, 30), 'UTC')).toBe(12);
    expect(hourIn(Date.UTC(2026, 9, 1, 12, 30), 'Europe/Vienna')).toBe(14);
    expect(hourIn(Date.UTC(2026, 9, 1, 12, 30), 'Not/AZone')).toBe(12); // unknown zone: UTC
  });

  it('is neutral without data, and soft: always inside [min, max]', () => {
    expect(fit(row(), taste(), noon).factor).toBe(1);
    const worst = fit(row({ runtime_min: 400, series_status: 'continuing', type: 'Series', original_language: 'ja' }), taste({ dropRate: 1, languages: { en: 1 } }), { hour: 23, device: 'phone' });
    expect(worst.factor).toBeGreaterThanOrEqual(c.context.min);
    expect(worst.factor).toBeLessThan(1);
    const best = fit(row({ runtime_min: 30 }), taste(), { hour: 23, device: 'phone' });
    expect(best.factor).toBeLessThanOrEqual(c.context.max);
  });

  it('runtime against the time budget: a long film late at night is nudged down, nothing else changes', () => {
    const long = row({ runtime_min: 180 });
    expect(fit(long, taste(), noon).parts.runtime).toBe(1);
    const late = fit(long, taste(), { hour: 23 });
    expect(late.parts.runtime).toBeCloseTo(1 - c.context.runtime * 1, 10); // twice the budget of 90 minutes: the full penalty
    expect(late.factor).toBeCloseTo(0.85, 10); // soft: 15 % at most for the runtime alone
    expect(fit(row({ runtime_min: 80 }), taste(), { hour: 23 }).parts.runtime).toBe(1);
  });

  it('device class: short titles suit phones, long ones TVs; an unknown device uses the instance mix', () => {
    expect(deviceFit('phone', 30)).toBe(1);
    expect(deviceFit('phone', 200)).toBe(-1);
    expect(deviceFit('tv', 150)).toBe(0.5);
    expect(deviceFit('pc', 90)).toBe(0);
    const short = row({ runtime_min: 25 }), long = row({ runtime_min: 140 });
    expect(fit(short, taste(), { hour: 12, device: 'phone' }).parts.device).toBeGreaterThan(1);
    expect(fit(long, taste(), { hour: 12, device: 'phone' }).parts.device).toBeLessThan(1);
    expect(fit(long, taste(), { hour: 12, device: 'tv' }).parts.device).toBeGreaterThan(1);
    const mixed = fit(long, taste(), { hour: 12, deviceMix: { phone: 0.5, pc: 0, tv: 0.5 } }).parts.device;
    expect(mixed).toBeCloseTo(1 + c.context.device * (0.5 * deviceFit('phone', 140) + 0.5 * deviceFit('tv', 140)), 10);
  });

  it('language: the language the profile mostly likes lifts, others dip; the UI language is the fallback without history', () => {
    const t = taste({ languages: { en: 0.8, de: 0.2 } });
    expect(fit(row({ original_language: 'en' }), t, noon).parts.language).toBeGreaterThan(1);
    expect(fit(row({ original_language: 'ja' }), t, noon).parts.language).toBeLessThan(1);
    expect(fit(row({ original_language: null }), t, noon).parts.language).toBe(1);
    expect(fit(row({ original_language: 'de' }), taste(), { hour: 12, uiLanguage: 'de' }).parts.language).toBeGreaterThan(1);
    expect(fit(row({ original_language: 'en' }), taste(), { hour: 12, uiLanguage: 'de' }).parts.language).toBe(1);
  });

  it('series status against drop behaviour: a profile that drops series meets fewer unfinished ones', () => {
    const cont = row({ type: 'Series', series_status: 'continuing' }), ended = row({ type: 'Series', series_status: 'ended' });
    expect(fit(cont, taste({ dropRate: 0.8 }), noon).parts.status).toBeLessThan(1);
    expect(fit(ended, taste({ dropRate: 0.8 }), noon).parts.status).toBeGreaterThan(1);
    expect(fit(cont, taste({ dropRate: 0.05 }), noon).parts.status).toBe(1);
    expect(fit(cont, taste({ dropRate: null }), noon).parts.status).toBe(1);
    expect(fit(row({ series_status: 'continuing' }), taste({ dropRate: 0.8 }), noon).parts.status).toBe(1); // a film
  });

  it('time of day: genres the profile watches in this bucket lift, once there are enough plays', () => {
    const tod = {
      n: { morning: 0, afternoon: 0, evening: 12, night: 2 },
      genres: { morning: {}, afternoon: {}, evening: { comedy: 0.8, drama: 0.2 }, night: { horror: 1 } },
      overall: { comedy: 0.4, drama: 0.4, horror: 0.2 },
    };
    const t = taste({ timeOfDay: tod });
    expect(fit(row({ genres: ['comedy'] }), t, { hour: 20 }).parts.timeOfDay).toBeGreaterThan(1);
    expect(fit(row({ genres: ['drama'] }), t, { hour: 20 }).parts.timeOfDay).toBeLessThan(1);
    expect(fit(row({ genres: ['horror'] }), t, { hour: 1 }).parts.timeOfDay).toBe(1); // only 2 plays at night: no evidence
  });

  it('every surface keeps its own weight set; post-play weighs transitions and seed similarity more', () => {
    const w = DEFAULT_RECO_COEFFICIENTS.surface;
    for (const s of SURFACES) {
      if (s !== 'postplay') expect(w.postplay.transition, s).toBeGreaterThan(w[s].transition);
    }
    expect(w.postplay.seed).toBeGreaterThan(w.taste.seed);
    expect(w.postplay.seed).toBeGreaterThan(w.home_rows.seed);
    expect(w.taste.seed).toBe(0); // taste has no seed
    expect(w.detail_similar.seed).toBeGreaterThan(w.because.seed);
    for (const s of SURFACES) expect(Object.keys(w[s]).sort(), s).toEqual(['affinity', 'cooccurrence', 'fresh', 'friends', 'quality', 'seed', 'transition', 'trending']);
    expect(new Set(SURFACES.map((s) => JSON.stringify(w[s]))).size).toBe(SURFACES.length);
  });
});
