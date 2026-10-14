// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '#lib/i18n';
import { collectionView, defaultTab, detailTabs, ratingParts, withFriends, type About, type AboutCollection, type AboutPart, type AboutRating } from './about';

const about = (ratings: AboutRating[]): About => ({
  ratings, countries: [], studios: [], tags: [], keywords: [], links: [], collection: null, canRequest: false, sources: ['jellyfin'],
});
const texts = (a: About | null) => ratingParts(a).map((p) => p.text);

afterEach(async () => { await setLocale('de'); });

describe('ratingParts', () => {
  it('null -> []', () => {
    expect(ratingParts(null)).toEqual([]);
    expect(ratingParts(about([]))).toEqual([]);
  });

  it('all six ratings -> order community, critic, imdb, rt, mc, friends texts (German number format)', () => {
    const a = about([
      { key: 'community', value: 7.8, max: 10, from: 'jellyfin' },
      { key: 'critic', value: 92, max: 100, from: 'jellyfin' },
      { key: 'imdb', value: 8.1, max: 10, from: 'omdb' },
      { key: 'rt', value: 92, max: 100, from: 'omdb' },
      { key: 'mc', value: 81, max: 100, from: 'omdb' },
      { key: 'friends', value: 4.5, max: 5, from: 'friends' },
    ]);
    expect(ratingParts(a).map((p) => p.key)).toEqual(['community', 'critic', 'imdb', 'rt', 'mc', 'friends']);
    expect(texts(a)).toEqual(['★ 7,8', 'Kritiker 92 %', 'IMDb 8,1', 'RT 92 %', 'MC 81', 'Freunde 4,5 ★']);
  });

  it('one decimal for /10 and /5, whole numbers for /100', () => {
    expect(texts(about([{ key: 'community', value: 8, max: 10, from: 'jellyfin' }, { key: 'friends', value: 4, max: 5, from: 'friends' }]))).toEqual(['★ 8,0', 'Freunde 4,0 ★']);
    expect(texts(about([{ key: 'rt', value: 91.6, max: 100, from: 'omdb' }]))).toEqual(['RT 92 %']);
  });

  it('only friends -> one part', () => {
    expect(texts(about([{ key: 'friends', value: 4.5, max: 5, from: 'friends' }]))).toEqual(['Freunde 4,5 ★']);
  });

  it('critic absent when rt present: keeps the order with gaps', () => {
    const a = about([
      { key: 'community', value: 6.9, max: 10, from: 'jellyfin' },
      { key: 'imdb', value: 7, max: 10, from: 'omdb' },
      { key: 'rt', value: 55, max: 100, from: 'omdb' },
      { key: 'friends', value: 3, max: 5, from: 'friends' },
    ]);
    expect(ratingParts(a).map((p) => p.key)).toEqual(['community', 'imdb', 'rt', 'friends']);
  });

  it('English labels and number format', async () => {
    await setLocale('en');
    expect(texts(about([{ key: 'community', value: 7.8, max: 10, from: 'jellyfin' }, { key: 'critic', value: 92, max: 100, from: 'jellyfin' }, { key: 'friends', value: 4.5, max: 5, from: 'friends' }])))
      .toEqual(['★ 7.8', 'Critics 92 %', 'Friends 4.5 ★']);
  });
});

describe('tabs', () => {
  it('detailTabs', () => {
    expect(detailTabs('Series', false)).toEqual(['episodes', 'details', 'more']);
    expect(detailTabs('Movie', true)).toEqual(['details', 'more', 'extras']);
    expect(detailTabs('Movie', false)).toEqual(['details', 'more']);
    expect(detailTabs('Series', true)).toEqual(['episodes', 'details', 'more', 'extras']);
  });
  it('defaultTab', () => {
    expect(defaultTab('Series')).toBe('episodes');
    expect(defaultTab('Movie')).toBe('details');
    expect(defaultTab('Episode')).toBe('details');
  });
});

describe('loadAbout', () => {
  it('caches per profile and swallows errors', async () => {
    vi.resetModules();
    const calls: string[] = [];
    let fail = false;
    vi.doMock('#lib/api', () => ({ api: async (u: string) => { calls.push(u); if (fail) throw new Error('x'); return about([{ key: 'friends', value: 4, max: 5, from: 'friends' }]); } }));
    const { loadAbout } = await import('./about');
    const got: About[] = [];
    await loadAbout('a1', 'p1', (a) => got.push(a));
    await loadAbout('a1', 'p1', (a) => got.push(a)); // fresh cache hit: no request
    expect(calls).toEqual(['/api/items/a1/about']);
    fail = true;
    await expect(loadAbout('a1', 'p3', (a) => got.push(a))).resolves.toBeUndefined(); // other profile: own key, error swallowed
    expect(calls).toHaveLength(2);
    expect(got).toHaveLength(2);
    vi.doUnmock('#lib/api');
  });
});

describe('withFriends (final review M4)', () => {
  it('replaces the friends\' rating, appends it when there was none, drops it for null; other ratings untouched', () => {
    const base = about([{ key: 'community', value: 7.8, max: 10, from: 'jellyfin' }, { key: 'friends', value: 4.5, max: 5, from: 'friends' }]);
    expect(texts(withFriends(base, 3.75))).toEqual(['★ 7,8', 'Freunde 3,8 ★']);
    expect(texts(withFriends(about([{ key: 'community', value: 7.8, max: 10, from: 'jellyfin' }]), 5))).toEqual(['★ 7,8', 'Freunde 5,0 ★']);
    expect(texts(withFriends(base, null))).toEqual(['★ 7,8']);
    expect(base.ratings).toHaveLength(2);
  });
});

describe('refreshFriends (final review M4)', () => {
  it('patches the cached entry at once, then revalidates from the server even though the entry is fresh', async () => {
    vi.resetModules();
    const calls: string[] = [];
    let friends = 4.5;
    vi.doMock('#lib/api', () => ({ api: async (u: string) => { calls.push(u); return about([{ key: 'friends', value: friends, max: 5, from: 'friends' }]); } }));
    const { loadAbout, refreshFriends } = await import('./about');
    await loadAbout('r1', 'p1', () => undefined);
    friends = 4;
    const got: number[] = [];
    await refreshFriends('r1', 'p1', 3.9, (a) => got.push(a.ratings[0]!.value));
    expect(got).toEqual([3.9, 4]);
    expect(calls).toEqual(['/api/items/r1/about', '/api/items/r1/about']);
    const later: number[] = [];
    await loadAbout('r1', 'p1', (a) => later.push(a.ratings[0]!.value)); // the server's answer is cached
    expect(later).toEqual([4]);
    expect(calls).toHaveLength(2);
    vi.doUnmock('#lib/api');
  });
});

const part = (n: number, o: Partial<AboutPart> = {}): AboutPart => ({ id: 'p' + n, name: 'Teil ' + n, image: true, played: false, current: false, inLibrary: true, from: 'jellyfin', ...o });
const coll = (parts: AboutPart[]): AboutCollection => ({ name: 'Matrix-Reihe', parts, from: 'jellyfin' });

describe('collectionView', () => {
  it('current 2 of 4, next part 3 in library unwatched -> next = part 3', () => {
    const v = collectionView(coll([part(1, { played: true }), part(2, { current: true }), part(3), part(4)]));
    expect(v.index).toBe(2);
    expect(v.total).toBe(4);
    expect(v.next?.id).toBe('p3');
  });
  it('next watched -> null', () => {
    expect(collectionView(coll([part(1), part(2, { current: true }), part(3, { played: true })])).next).toBeNull();
  });
  it('next missing -> null', () => {
    expect(collectionView(coll([part(1), part(2, { current: true }), part(3, { inLibrary: false, id: undefined, tmdbId: 3, from: 'tmdb' })])).next).toBeNull();
  });
  it('current last -> null', () => {
    const v = collectionView(coll([part(1), part(2, { current: true })]));
    expect(v.next).toBeNull();
    expect(v.index).toBe(2);
  });
  it('no current part -> index 0, next null', () => {
    const v = collectionView(coll([part(1), part(2), part(3)]));
    expect(v.index).toBe(0);
    expect(v.total).toBe(3);
    expect(v.next).toBeNull();
  });
});
