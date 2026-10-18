// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/reco';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  because: 'Because you watched “{seed}”',
  picked: 'Picked for you',
  trait: {
    friends: 'friends rated it', friendsNamed: '{names} rated it', next: 'people watch this next', together: 'often watched together', universe: 'same universe',
    director: 'same director', directorNamed: 'same director ({name})', actor: 'same cast', actorNamed: 'with {name}',
    studioNamed: 'from {name}', genreNamed: 'genre: {name}',
  },
  why: { button: 'Why am I seeing this?', heading: 'Why these titles?', item: '{name}: {reason}', none: 'Fits your taste.', close: 'Hide' },
  settings: {
    title: 'Recommendations',
    reset: 'Reset my recommendations',
    resetHint: 'Forgets your learned taste profile and which rows you click. Your list, ratings and history stay. Afterwards the recommendations are rebuilt from your history.',
    resetDone: 'Reset. The recommendations are being recalculated.',
    resetFailed: 'The reset did not work.',
    whyHint: 'Tap the line under a recommendation (“Because you watched …”) to see why a title is there.',
  },
  admin: {
    title: 'Recommendation engine',
    intro: 'Click rate and play rate per engine, calculated from this server’s counters. The counters start again with every restart.',
    active: 'Active: {engine}',
    engine: { v1: 'v1 (Jellyfin)', v2: 'v2 (own model)', shadow: 'Shadow (v2 runs alongside)' },
    col: { engine: 'Engine', shown: 'Shown', clicks: 'Clicked', plays: 'Played', dismissed: 'Dismissed', ctr: 'Click rate', playRate: 'Play rate' },
    fallbacks: 'Fallbacks to v1: {n}',
    since: 'Counted since {date}',
    empty: '–',
    loadFailed: 'The numbers could not be loaded.',
  },
};

export default dict;
