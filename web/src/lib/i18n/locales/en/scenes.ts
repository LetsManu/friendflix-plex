// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/scenes';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  info: {
    title: 'Cast & info',
    open: 'Cast & info',
    openKey: 'Cast & info (I)',
    close: 'Close cast & info',
    cast: 'Cast',
    guests: 'Guest stars',
    facts: 'Background',
    as: 'as {role}',
    directors: 'Director',
    writers: 'Writers',
    creators: 'Created by',
    studio: 'Studio',
    year: 'Year',
    rating: 'Age rating',
    score: 'Rating',
    genres: 'Genres',
    tags: 'Tags',
    loading: 'Loading cast …',
    failed: 'Couldn’t load cast & info.',
    none: 'No cast details for this title.',
    person: '{name}, show more titles',
  },
  peek: {
    label: 'Cast at a glance',
    more: 'All info',
    hintKey: 'More: {key}',
    hintTv: 'More: OK',
  },
  person: {
    role: 'plays {role}',
    more: 'More with {name}',
    loading: 'Loading titles …',
    none: 'No other titles in your library.',
    failed: 'Couldn’t load the titles.',
    page: 'All titles and info',
    back: 'Back to the cast',
  },
  chapters: {
    title: 'Scenes',
    open: 'Scenes',
    close: 'Close scenes',
    chapter: 'Chapter {n}',
    current: 'Now playing',
    jump: '{name}, from {t}',
    count: { one: '{n} scene', other: '{n} scenes' },
  },
  audio: {
    title: 'Sound',
    voice: 'Clear voices',
    voiceHint: 'Bring dialogue forward',
    night: 'Night mode',
    nightHint: 'Loud parts quieter, quiet parts louder',
    on: '{name} on',
    off: '{name} off',
    unsupported: 'Not available on this device',
    casting: 'Not available while casting to another device',
    needsTap: 'Tap the picture or press a key once and “{name}” kicks in.',
  },
  shortcuts: {
    peek: 'Quick look at the cast',
  },
};
export default dict;
