// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/fresh';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  label: {
    newEpisode: 'New episode',
    newSeason: 'New season',
    finale: 'Season finale',
    newSeries: 'New series',
    new: 'New',
  },
  leaving: {
    days: { one: 'Only {n} day left', other: 'Only {n} days left' },
    today: 'Last day',
    until: 'Available until {date}',
  },
  row: { leaving: 'Leaving soon' },
  q: {
    label: 'Picture and sound',
    '4k': '4K',
    hd: 'HD',
    dolbyvision: 'Dolby Vision',
    hdr10plus: 'HDR10+',
    hdr: 'HDR',
    atmos: 'Dolby Atmos',
    surround: '5.1 surround',
    stereo: 'Stereo',
  },
  browse: { quality: 'Picture quality' },
  story: {
    title: 'The story so far',
    newSeason: 'Season {n} is about to start – here is what happened.',
    longBreak: { one: 'You have not watched for {n} week – a quick reminder.', other: 'You have not watched for {n} weeks – a quick reminder.' },
    season: 'Season {n}',
    lastEpisode: 'Last watched: S{s}:E{e} “{name}”',
    dismiss: 'Hide this card',
  },
  admin: {
    tab: 'Leaving soon',
    title: 'Leaving soon',
    intro: 'These titles have a date on which they leave the library. Two weeks before, the cards show a notice; a week and a day before, everyone who has the title on your watchlist or in Continue Watching gets a notification. Nothing is deleted – the date is only an announcement, and expired entries disappear on their own.',
    addTitle: 'Add a title',
    search: 'Search for a title',
    searchPlaceholder: 'Movie or series …',
    results: 'Search results',
    noHits: 'Nothing found.',
    change: 'Pick another title',
    date: 'Leaves on',
    note: 'Note (admins only)',
    notePlaceholder: 'e.g. licence ends',
    hint: 'Nothing is deleted. People only see “Only N days left”.',
    save: 'Save',
    clear: 'Remove date',
    saved: 'Saved.',
    cleared: 'Date removed.',
    saveFailed: 'Could not be saved.',
    loadFailed: 'The list could not be loaded.',
    dateRange: 'The date must be today or later (two years ahead at most).',
    empty: 'No title has a date right now.',
    colTitle: 'Title',
    colSetBy: 'Set by',
    menu: 'Set removal date …',
    dialogTitle: 'No longer available from',
  },
};
export default dict;
