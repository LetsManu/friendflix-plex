// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n';
import { langLabel, langLine, isKnownLang } from '#lib/langs';
import { ageText, moodTags } from './format';
import { toAbout } from './about';
import { initials, strings, toPeople, uniqueBy } from './safe';

/**
 * "Internal Error" on one movie's detail page: every shape of odd data below threw while rendering before (a TypeError, or Svelte's
 * each_key_duplicate for a keyed list). Each helper must now give something the page can render.
 */
afterEach(async () => { await setLocale('de'); });

describe('uniqueBy (keyed lists: MoreLikeThis, Extras, FriendsStrip, collection parts)', () => {
  it('the same title twice -> once, first wins, order kept', () => {
    const l = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'a', n: 3 }];
    expect(uniqueBy(l, (x) => x.id)).toEqual([{ id: 'a', n: 1 }, { id: 'b', n: 2 }]);
  });
  it('entries without a key, null entries and a non-array are dropped', () => {
    expect(uniqueBy([{ id: '' }, null, undefined, { id: 'x' }, { id: null }] as Array<{ id: string | null }>, (x) => x.id)).toEqual([{ id: 'x' }]);
    expect(uniqueBy(null, (x) => x)).toEqual([]);
    expect(uniqueBy({} as unknown as string[], (x) => x)).toEqual([]);
  });
});

describe('initials (cast row avatar without a photo)', () => {
  it('a person without a name (Jellyfin Name null) -> "" instead of a TypeError', () => {
    expect(initials(undefined)).toBe('');
    expect(initials(null)).toBe('');
    expect(initials('')).toBe('');
    expect(initials('   ')).toBe('');
  });
  it('first letters of the first two words; astral characters stay whole', () => {
    expect(initials('lena doria smith')).toBe('LD');
    expect(initials('𝒜lpha beta')).toBe('𝒜B');
  });
});

describe('toPeople (GET /people answer)', () => {
  it('keeps entries with an id; missing name -> "", missing or empty type -> Actor, empty role dropped', () => {
    expect(toPeople([{ id: 'p1' }, { id: 'p2', name: 'Lena', type: '', role: '' }, { id: 'p3', name: 'Carl', type: 'Director', role: 'x', image: 1 }])).toEqual([
      { id: 'p1', name: '', type: 'Actor', image: false },
      { id: 'p2', name: 'Lena', type: 'Actor', image: false },
      { id: 'p3', name: 'Carl', role: 'x', type: 'Director', image: true },
    ]);
  });
  it('drops entries without an id and anything that is not a list', () => {
    expect(toPeople([null, 'x', { name: 'No Id' }, { id: 5 }])).toEqual([]);
    expect(toPeople(undefined)).toEqual([]);
    expect(toPeople({ people: [] })).toEqual([]);
  });
});

describe('strings', () => {
  it('only non-empty strings', () => {
    expect(strings(['Drama', null, '', 3, 'Krimi'])).toEqual(['Drama', 'Krimi']);
    expect(strings(null)).toEqual([]);
  });
});

describe('toAbout (GET /about answer)', () => {
  const base = { ratings: [], countries: [], studios: [], tags: [], keywords: [], links: [], collection: null, canRequest: false, sources: ['jellyfin'] };

  it('a regular answer passes unchanged', () => {
    const a = {
      ...base, tagline: 'T', originalTitle: 'O', releaseDate: '1986-07-18', canRequest: true, sources: ['jellyfin', 'tmdb'],
      ratings: [{ key: 'community', value: 7.9, max: 10, from: 'jellyfin' }],
      links: [{ kind: 'imdb', url: 'https://www.imdb.com/title/tt0078748/' }],
      collection: { name: 'C', from: 'tmdb', parts: [
        { id: 'a', tmdbId: 1, name: 'Eins', year: 1979, image: true, played: true, current: false, inLibrary: true, from: 'jellyfin' },
        { tmdbId: 2, name: 'Zwei', poster: '/api/seerr/image/p.jpg', image: true, played: false, current: false, inLibrary: false, from: 'tmdb' },
      ] },
    };
    expect(toAbout(a)).toEqual(a);
  });

  it('missing lists -> [] (ratings.some / studios.length / parts.length threw)', () => {
    expect(toAbout({ ratings: null, collection: { name: 'X', parts: null } })).toEqual({ ...base, sources: [] });
    expect(toAbout(null)).toEqual({ ...base, sources: [] });
    expect(toAbout('nope')).toEqual({ ...base, sources: [] });
  });

  it('duplicate keys are dropped: ratings by source, links by kind, collection parts by library id / TMDB id', () => {
    const part = (o: object) => ({ image: false, played: false, current: false, inLibrary: true, from: 'jellyfin', name: 'n', ...o });
    const a = toAbout({
      ...base,
      ratings: [{ key: 'community', value: 7, max: 10, from: 'jellyfin' }, { key: 'community', value: 8, max: 10, from: 'jellyfin' }, { key: 'imdb', value: 7.5, max: 10, from: 'omdb' }],
      links: [{ kind: 'imdb', url: 'https://a/' }, { kind: 'imdb', url: 'https://b/' }],
      collection: { name: 'C', from: 'tmdb', parts: [part({ id: 'a', current: true }), part({ id: 'b' }), part({ id: 'b', tmdbId: 3 }), part({ tmdbId: 9, inLibrary: false }), part({ tmdbId: 9, inLibrary: false })] },
    });
    expect(a.ratings.map((r) => [r.key, r.value])).toEqual([['community', 7], ['imdb', 7.5]]);
    expect(a.links.map((l) => l.url)).toEqual(['https://a/']);
    expect(a.collection!.parts.map((p) => p.id ?? p.tmdbId)).toEqual(['a', 'b', 9]);
  });

  it('bad entries are dropped: unknown rating key, non-finite value, non-https link, part without id and TMDB id', () => {
    const a = toAbout({
      ...base,
      ratings: [{ key: 'letterboxd', value: 4 }, { key: 'rt', value: NaN }, { key: 'mc', value: '81' }, null],
      links: [{ kind: 'imdb', url: 'javascript:alert(1)' }, { kind: 'wiki', url: 'https://x/' }, { kind: 'tmdb' }],
      collection: { parts: [{ name: 'no id' }, 'x', { id: 'a', year: 'neunzehn' }, { id: 'b', inLibrary: true, from: 'other' }] },
    });
    expect(a.ratings).toEqual([]);
    expect(a.links).toEqual([]);
    expect(a.collection).toEqual({ name: '', from: 'jellyfin', parts: [
      { id: 'a', name: '', image: false, played: false, current: false, inLibrary: false, from: 'jellyfin' },
      { id: 'b', name: '', image: false, played: false, current: false, inLibrary: true, from: 'jellyfin' },
    ] });
  });

  it('a collection without usable parts -> null; a release date that is not YYYY-MM-DD is dropped', () => {
    expect(toAbout({ ...base, collection: { name: 'C', parts: [] } }).collection).toBeNull();
    expect(toAbout({ ...base, releaseDate: 'unknown' }).releaseDate).toBeUndefined();
    expect(toAbout({ ...base, releaseDate: '1986-07-18T00:00:00Z' }).releaseDate).toBeUndefined();
    expect(toAbout({ ...base, sources: ['tmdb', 'imdb', 3] }).sources).toEqual(['tmdb']);
  });
});

describe('language line and mood tags with odd values', () => {
  it('langLine skips codes that are not strings (null threw on .trim())', async () => {
    expect(langLine({ audio: ['deu', null as unknown as string], subs: [null as unknown as string] })).toBe('Ton: Deutsch');
    expect(langLine({ audio: 'deu' as unknown as string[] })).toBe('');
    expect(langLabel(undefined as unknown as string)).toBe('');
    expect(isKnownLang(null as unknown as string)).toBe(false);
    await setLocale('en');
    expect(langLine({ audio: ['', 'qaa', 'zz-ZZ'] })).toBe('Audio: QAA, ZZ-ZZ');
  });
  it('moodTags / ageText ignore non-strings', () => {
    expect(moodTags(['Drama', null as unknown as string, 7 as unknown as string])).toEqual(['Emotional']);
    expect(moodTags(null as unknown as string[])).toEqual([]);
    expect(ageText(12 as unknown as string)).toBe('');
  });
});
