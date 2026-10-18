// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/postplay';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  card: { title: 'Done? See what’s next', open: 'What’s next?', close: 'Hide this hint' },
  head: {
    movieEnd: 'You finished “{title}”',
    seriesFinished: 'You finished “{title}”',
    caughtUp: 'You’re caught up',
    gap: 'Episode {n} is still unwatched',
    nextPart: 'Next in “{name}”: {title}',
    nextEpisode: 'Up next: {title}',
  },
  sub: {
    caughtUp: 'You have seen every available episode of “{title}”.',
    nextAir: 'Next episode on {date}',
    noDate: 'There is no date for the next episode yet.',
    gap: '“{title}”: you skipped this episode.',
  },
  justWatched: 'Just watched',
  hero: 'Our pick for you',
  action: {
    play: 'Play',
    playTitle: 'Play “{title}”',
    jumpBack: 'Jump back to episode {n}',
    remind: 'Remind me',
    reminded: 'Reminder on',
    remindFailed: 'The reminder could not be saved.',
    wish: 'Wish for the missing season',
    wished: 'Wished',
    wishLeft: { one: '{n} wish left this month', other: '{n} wishes left this month' },
    wishLimit: 'You have reached this month’s wish limit.',
    wishFailed: 'The wish did not go through.',
    addList: 'Add to list',
    onList: 'On your list',
    listFailed: 'Your list could not be saved.',
    notInterested: 'Not interested',
    notInterestedDone: 'Got it: we won’t suggest “{title}” again.',
    undo: 'Undo',
    undone: 'Undone.',
    back: 'Back to the title',
    details: 'Details',
  },
  row: {
    continuation: 'Keep going',
    transition: 'What people watch after “{name}”',
    universe: 'Same universe: {name}',
    because: 'Because you watched “{name}”',
    friends: 'Your friends liked this',
    taste: 'Fits your taste',
  },
  why: { seed: 'Because of “{name}”', friends: 'Rated highly by friends' },
  spoiler: 'Unwatched episode: preview hidden',
  episode: 'S{s}:E{e} · {name}',
  pageTitle: 'What’s next?',
  loading: 'Loading suggestions …',
  error: 'The suggestions could not be loaded.',
  empty: 'We have no suggestions for you right now.',
  settings: {
    label: 'Show suggestions after the last episode',
    hint: 'After a film or the last available episode: what comes next, similar titles and tips. Nothing starts by itself.',
  },
};
export default dict;
