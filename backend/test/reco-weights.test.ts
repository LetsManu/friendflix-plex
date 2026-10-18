// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/config.js';
import { COEFFICIENT_NAMES, DEFAULT_RECO_COEFFICIENTS, parseCoeffOverrides, recoCoefficients, SURFACES } from '../src/reco/weights.js';

// R2: every coefficient lives in reco/weights.ts with the spec defaults and an env override.
describe('coefficients', () => {
  it('defaults are the spec table (4.3 signals, 4.5 MMR lambda)', () => {
    const c = recoCoefficients();
    expect(c.signal).toMatchObject({
      thumbUp2: 3, thumbUp1: 1.5, thumbDown: -4, star5: 2.5, star4: 1.5, star3: 0, star2: -1, star1: -2,
      finishedMovie: 1, seriesCompletion: 2, rewatch: 1, favorite: 1, watchlist: 0.5, abandonedEarly: -1, dropped: -2, halfLifeDays: 120,
    });
    expect(c.profile).toMatchObject({ coldStart: 5, abandonPct: 15, abandonDays: 14, negWeight: 0.5 });
    expect(c.candidates.knn).toBe(200);
    expect(c.rank).toMatchObject({ lambda: 0.7, perFranchise: 2 });
    expect(c.score.trendingCap).toBe(0.1);
    // the spec's ceiling: RECO_COEFFS can lower the trending cap, never raise it above 10 %
    expect(recoCoefficients({ RECO_COEFFS: '{"score.trendingCap":0.5}' }).score.trendingCap).toBe(0.1);
    expect(recoCoefficients({ RECO_COEFFS: '{"score.trendingCap":0.05}' }).score.trendingCap).toBe(0.05);
    expect(Object.keys(c.surface)).toEqual([...SURFACES]);
  });

  it('every number is addressable by its dotted name', () => {
    expect(COEFFICIENT_NAMES).toContain('signal.thumbUp2');
    expect(COEFFICIENT_NAMES).toContain('surface.because.seed');
    expect(new Set(COEFFICIENT_NAMES).size).toBe(COEFFICIENT_NAMES.length);
    // an override for each name changes exactly that number
    for (const name of COEFFICIENT_NAMES) {
      const c = recoCoefficients({ RECO_COEFFS: JSON.stringify({ [name]: 0.5 }) });
      const get = (o: any) => name.split('.').reduce((x, k) => x[k], o);
      if (!['rank.lambda', 'rank.genreShare', 'rank.perFranchise', 'profile.historyLimit', 'profile.coldStart', 'profile.topDims', 'score.trendingCap', 'score.ratingFloor', 'candidates.knn', 'candidates.similar', 'signal.halfLifeDays',
        // R3: clamped or rounded on read (the privacy floor of 2 accounts among them)
        'social.minSupport', 'social.lookbackDays', 'social.transitionDays', 'social.topPerItem', 'social.anchors', 'social.maxRows', 'context.min', 'context.max', 'explore.from', 'explore.to', 'explore.protectTop', 'rows.minSize', 'rows.fixedSlot', 'rows.currentShare'].includes(name)) {
        expect(get(c), name).toBe(0.5);
      }
    }
  });

  it('RECO_COEFFS: overrides apply, unknown names, non-numbers and bad JSON are ignored, values are clamped', () => {
    expect(recoCoefficients({ RECO_COEFFS: '{"signal.thumbUp2":5,"surface.taste.affinity":0.9}' }).signal.thumbUp2).toBe(5);
    expect(recoCoefficients({ RECO_COEFFS: '{"surface.taste.affinity":0.9}' }).surface.taste.affinity).toBe(0.9);
    expect(parseCoeffOverrides('{"nope":1,"signal.thumbUp2":"3","signal.favorite":null}').size).toBe(0);
    expect(parseCoeffOverrides('not json').size).toBe(0);
    expect(parseCoeffOverrides('[1,2]').size).toBe(0);
    expect(parseCoeffOverrides('{"signal.thumbUp2":1e9}').get('signal.thumbUp2')).toBe(1000);
    expect(recoCoefficients({ RECO_COEFFS: 'not json' })).toEqual(recoCoefficients());
  });

  it('RECO_HALF_LIFE_DAYS sets the decay; sanity bounds keep the maths valid', () => {
    expect(recoCoefficients({ RECO_HALF_LIFE_DAYS: 30 }).signal.halfLifeDays).toBe(30);
    expect(recoCoefficients({ RECO_COEFFS: '{"rank.lambda":3,"rank.perFranchise":0,"profile.coldStart":-4}' }).rank).toMatchObject({ lambda: 1, perFranchise: 1 });
    expect(recoCoefficients({ RECO_COEFFS: '{"profile.coldStart":-4}' }).profile.coldStart).toBe(0);
  });

  it('defaults are not mutated by callers', () => {
    const c = recoCoefficients();
    c.signal.thumbUp2 = 99;
    expect(DEFAULT_RECO_COEFFICIENTS.signal.thumbUp2).toBe(3);
    expect(recoCoefficients().signal.thumbUp2).toBe(3);
  });
});

describe('config keys', () => {
  const parse = (env: Record<string, string>) => configSchema.shape.RECO_ENGINE.parse(env.RECO_ENGINE);
  it('RECO_ENGINE defaults to v1, accepts v1|v2|shadow, empty counts as unset', () => {
    expect(parse({})).toBe('v1');
    expect(parse({ RECO_ENGINE: '' })).toBe('v1');
    for (const v of ['v1', 'v2', 'shadow']) expect(parse({ RECO_ENGINE: v })).toBe(v);
    expect(() => parse({ RECO_ENGINE: 'v3' })).toThrow();
  });
  it('RECO_HALF_LIFE_DAYS defaults to 120; RECO_COEFFS must be a JSON object', () => {
    expect(configSchema.shape.RECO_HALF_LIFE_DAYS.parse(undefined)).toBe(120);
    expect(configSchema.shape.RECO_HALF_LIFE_DAYS.parse('')).toBe(120);
    expect(configSchema.shape.RECO_HALF_LIFE_DAYS.parse('60')).toBe(60);
    expect(() => configSchema.shape.RECO_HALF_LIFE_DAYS.parse('0')).toThrow();
    expect(configSchema.shape.RECO_COEFFS.parse('')).toBeUndefined();
    expect(configSchema.shape.RECO_COEFFS.parse('{"a":1}')).toBe('{"a":1}');
    expect(() => configSchema.shape.RECO_COEFFS.parse('[1]')).toThrow();
    expect(() => configSchema.shape.RECO_COEFFS.parse('oops')).toThrow();
  });
});
