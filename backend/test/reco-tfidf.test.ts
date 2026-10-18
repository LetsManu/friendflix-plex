// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DEFAULT_RECO_WEIGHTS, recoWeights } from '../src/reco/weights.js';
import { TOP_TERMS, documentFrequencies, idf, normList, normValue, numStat, termCounts, tokenize, topTerms, zscore } from '../src/reco/tfidf.js';

// R1: the maths behind the item feature index.
const BASE = {
  PUBLIC_URL: 'https://tv.example.com', DATABASE_URL: 'x', REDIS_URL: 'x', APP_ENC_KEY: 'k'.repeat(44), INTERNAL_SECRET: 'i'.repeat(20), OIDC_ISSUER: 'https://auth.example.com',
  OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', JELLYFIN_URL: 'http://j', JELLYFIN_ADMIN_API_KEY: 'k', REQUESTS_URL: 'http://s', REQUESTS_API_KEY: 'k', WEBHOOK_SECRET: 'w'.repeat(20),
};

describe('tokenize', () => {
  it('lower-cases, splits on non-letters, keeps umlauts and other scripts', () => {
    expect(tokenize('Ein Mörder-Duo jagt „Öl-Barone“  in Zürich')).toEqual(['mörder', 'duo', 'jagt', 'barone', 'zürich']);
    expect(tokenize('Ελλάδα και 東京タワー')).toEqual(['ελλάδα', 'και', '東京タワー']);
  });
  it('drops stop words, short words and bare numbers but keeps words with digits', () => {
    expect(tokenize('The siege of 1812 and the R2D2 droid, it is an end')).toEqual(['siege', 'r2d2', 'droid', 'end']);
    expect(tokenize('')).toEqual([]);
  });
});

describe('idf', () => {
  it('is smoothed, at least 1 and falls as the term gets common', () => {
    expect(idf(100, 0)).toBeCloseTo(Math.log(101) + 1, 10);
    expect(idf(100, 1)).toBeCloseTo(Math.log(101 / 2) + 1, 10);
    expect(idf(100, 100)).toBe(1);
    expect(idf(100, 1)).toBeGreaterThan(idf(100, 10));
    expect(idf(100, 10)).toBeGreaterThan(idf(100, 90));
  });
});

describe('topTerms (TF-IDF)', () => {
  const doc = (s: string) => termCounts(tokenize(s));
  it('weights a rare term above a common one with the same count', () => {
    const docs = [doc('heist vault heist crew'), doc('vault crew'), doc('crew robot'), doc('crew garden')];
    const df = documentFrequencies(docs);
    expect(df.get('crew')).toBe(4);
    expect(df.get('heist')).toBe(1);
    const v = topTerms(docs[0]!, docs.length, (t) => df.get(t) ?? 0);
    expect(v.heist).toBeGreaterThan(v.vault!);
    expect(v.vault).toBeGreaterThan(v.crew!);
    // sublinear tf: two mentions count more than one, but less than twice as much
    const c = termCounts(['aaa', 'aaa', 'bbb']);
    const w = topTerms(c, 4, () => 1);
    expect(w.aaa).toBeGreaterThan(w.bbb!);
    expect(w.aaa! / w.bbb!).toBeCloseTo(1 + Math.log(2), 3);
  });
  it('is L2-normalised, so a dot product is the cosine', () => {
    const docs = [doc('alpha beta gamma alpha'), doc('beta delta')];
    const df = documentFrequencies(docs);
    const v = topTerms(docs[0]!, 2, (t) => df.get(t) ?? 0);
    expect(Math.sqrt(Object.values(v).reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 3);
  });
  it('keeps the best 40 terms, ties alphabetically, and is empty for an empty text', () => {
    const many = termCounts(Array.from({ length: 100 }, (_, i) => `term${String(i).padStart(3, '0')}`));
    const v = topTerms(many, 5, () => 1);
    expect(Object.keys(v)).toHaveLength(TOP_TERMS);
    expect(Object.keys(v).sort()[0]).toBe('term000');
    expect(Object.keys(v)).not.toContain('term040');
    expect(topTerms(new Map(), 5, () => 0)).toEqual({});
  });
  it('skips terms of one item only once the corpus is large enough to share terms', () => {
    const c = termCounts(['unique', 'shared']);
    const df = (t: string) => (t === 'shared' ? 5 : 1);
    expect(Object.keys(topTerms(c, 10, df)).sort()).toEqual(['shared', 'unique']);
    expect(Object.keys(topTerms(c, 500, df))).toEqual(['shared']);
  });
});

describe('categorical values and numeric statistics', () => {
  it('normalises case, spaces and duplicates; caps the list', () => {
    expect(normValue('  Sci-Fi ')).toBe('sci-fi');
    expect(normList(['Drama', 'drama ', '', 'Crime', 'Action'], 2)).toEqual(['drama', 'crime']);
  });
  it('standardises with the sample standard deviation; no spread or no value is the average', () => {
    const s = numStat([2000, 2010, 2020, null, undefined, NaN]);
    expect(s).toEqual({ mean: 2010, std: 10, n: 3 });
    expect(zscore(2020, s)).toBeCloseTo(1, 10);
    expect(zscore(2000, s)).toBeCloseTo(-1, 10);
    expect(zscore(null, s)).toBe(0);
    expect(zscore(5, numStat([7, 7]))).toBe(0);
    expect(numStat([])).toEqual({ mean: 0, std: 0, n: 0 });
  });
});

describe('RECO_W_* weights', () => {
  it('default to DEFAULT_RECO_WEIGHTS; compose passing empty values keeps the defaults', () => {
    expect(recoWeights(loadConfig(BASE))).toEqual(DEFAULT_RECO_WEIGHTS);
    expect(recoWeights(loadConfig({ ...BASE, RECO_W_GENRES: '', RECO_W_TEXT: '' }))).toEqual(DEFAULT_RECO_WEIGHTS);
  });
  it('can be set, 0 switches a group off, out-of-range or non-numeric values are rejected', () => {
    expect(recoWeights(loadConfig({ ...BASE, RECO_W_PEOPLE: '2.5', RECO_W_TAGS: '0' }))).toMatchObject({ people: 2.5, tags: 0 });
    expect(() => loadConfig({ ...BASE, RECO_W_GENRES: '-1' })).toThrow();
    expect(() => loadConfig({ ...BASE, RECO_W_GENRES: '11' })).toThrow();
    expect(() => loadConfig({ ...BASE, RECO_W_GENRES: 'lots' })).toThrow();
  });
});
