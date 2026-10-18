// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { setLocale, t } from '#lib/i18n';
import type { Item } from '#lib/api';
import { END_SHARE, headline, postplayStart, postplayWanted, rowOf, rowTitle, rowWhy, type Postplay, type PostplayRow } from './postplay';

const item = (o: Partial<Item>): Item => ({ id: 'a', name: 'Film', type: 'Movie', genres: [], image: true, backdrop: true, logo: false, played: false, favorite: false, positionTicks: 0, ...o });
const pp = (o: Partial<Postplay>): Postplay => ({ state: 'movie_end', current: item({}), next: null, nextAirDate: null, sequel: null, canWish: false, remind: null, rows: [], hero: null, suggestions: true, ...o });

describe('when the "Done? See what\'s next" card shows', () => {
  it('outro segment, else the last chapter (in the last 20 %), else 95 %', () => {
    expect(postplayStart([{ type: 'outro', start: 5000 }], [{ start: 5200 }], 5400)).toBe(5000);
    expect(postplayStart([{ type: 'credits', start: 5100 }], [], 5400)).toBe(5100);
    expect(postplayStart([{ type: 'outro', start: 100 }], [{ start: 5200 }], 5400)).toBe(5200); // an "outro" in the first half is no end credits
    expect(postplayStart([], [{ start: 0 }, { start: 3000 }, { start: 5250 }], 5400)).toBe(5250);
    expect(postplayStart([], [{ start: 0 }, { start: 2000 }], 5400)).toBe(5400 * END_SHARE); // a final-act chapter is not the credits
    expect(postplayStart([{ type: 'intro', start: 5300 }], [], 1000)).toBe(950);
    expect(postplayStart([], [], 0)).toBe(Infinity);
    expect(postplayStart([], [], NaN)).toBe(Infinity);
  });
  it('only without a next episode, with the feature and the profile setting on, never while a TV plays', () => {
    const on = { type: 'Episode', hasNextEpisode: false, feature: true, pref: true, remote: false };
    expect(postplayWanted(on)).toBe(true);
    expect(postplayWanted({ ...on, type: 'Movie' })).toBe(true);
    expect(postplayWanted({ ...on, hasNextEpisode: true })).toBe(false);
    expect(postplayWanted({ ...on, feature: false })).toBe(false);
    expect(postplayWanted({ ...on, pref: false })).toBe(false);
    expect(postplayWanted({ ...on, remote: true })).toBe(false);
    expect(postplayWanted({ ...on, type: 'Trailer' })).toBe(false);
  });
});

describe('texts', () => {
  it('headline per state (series name for episodes; never "finished" for caught up)', async () => {
    await setLocale('en');
    const tt = get(t);
    const ep = item({ id: 'e', type: 'Episode', name: 'Pilot', seriesName: 'Bright Valley', indexNumber: 3 });
    expect(headline(pp({ state: 'movie_end', current: item({ name: 'Inkwell' }) }), tt)).toBe('You finished “Inkwell”');
    expect(headline(pp({ state: 'series_finished', current: ep }), tt)).toBe('You finished “Bright Valley”');
    expect(headline(pp({ state: 'caught_up', current: ep }), tt)).toBe('You’re caught up');
    expect(headline(pp({ state: 'gap', current: ep, next: item({ id: 'g', type: 'Episode', name: 'One', indexNumber: 1 }) }), tt)).toBe('Episode 1 is still unwatched');
    const cont: PostplayRow = { kind: 'continuation', title: 'Dune Collection', reason: {}, items: [] };
    expect(headline(pp({ state: 'next', next: item({ id: 'd2', name: 'Dune Part Two' }), rows: [cont] }), tt)).toBe('Next in “Dune Collection”: Dune Part Two');
    await setLocale('de');
  });
  it('row headings and reasons', async () => {
    await setLocale('en');
    const tt = get(t);
    const r = (o: Partial<PostplayRow>): PostplayRow => ({ kind: 'because', title: 'X', reason: {}, items: [], ...o });
    expect(rowTitle(r({ reason: { seed: { id: 's', name: 'Inkwell' } } }), tt)).toBe('Because you watched “Inkwell”');
    expect(rowTitle(r({ kind: 'universe', title: 'Dune Collection' }), tt)).toBe('Same universe: Dune Collection');
    expect(rowTitle(r({ kind: 'friends' }), tt)).toBe('Your friends liked this');
    expect(rowTitle(r({ kind: 'taste' }), tt)).toBe('Fits your taste');
    expect(rowWhy(r({ kind: 'taste', reason: { seed: { id: 's', name: 'Meridian' } } }), tt)).toBe('Because of “Meridian”');
    expect(rowWhy(r({ kind: 'friends' }), tt)).toBe('Rated highly by friends');
    expect(rowWhy(r({ reason: { seed: { id: 's', name: 'Inkwell' } } }), tt)).toBe(''); // the heading already says it
    await setLocale('de');
  });
  it('rowOf: telemetry label of a title', () => {
    const p = pp({ rows: [{ kind: 'universe', title: 'U', reason: {}, items: [item({ id: 'u1' })] }, { kind: 'taste', title: '', reason: {}, items: [item({ id: 't1' })] }] });
    expect(rowOf(p, 't1')).toBe('taste');
    expect(rowOf(p, 'zz')).toBe('because');
  });
});
