// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/anime';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  simulcast: {
    title: 'Simulcast',
    intro: 'Running series with new episodes in the last and next four weeks, by weekday.',
    onlyAnime: 'Anime only',
    season: { winter: 'Winter {year}', spring: 'Spring {year}', summer: 'Summer {year}', fall: 'Fall {year}' },
    none: 'No series with new episodes are running right now.',
    loadFailed: 'Could not load simulcast.',
    today: 'Today',
    latest: 'Latest: {ep}',
    next: 'Next: {ep} on {date}',
    airsAt: 'at {time}',
    link: 'Simulcast',
  },
  settings: {
    original: 'Anime: original audio with subtitles',
    originalHint: 'Anime series start in Japanese with subtitles in your language – unless you picked something else for that series. Without a Japanese audio track your usual settings apply.',
  },
  comments: {
    show: 'Comments',
    hide: 'Hide comments',
    title: 'Comments from friends',
    count: { one: '{n} comment', other: '{n} comments' },
    placeholder: 'Write something about this episode …',
    label: 'Your comment',
    send: 'Post',
    empty: 'No comments from friends yet.',
    spoiler: 'Spoiler',
    reveal: 'Spoiler – show anyway',
    hint: 'You have not watched this episode yet – other people’s comments are hidden.',
    delete: 'Delete',
    deleteAria: 'Delete comment by {name}',
    failed: 'The comment could not be saved.',
    loadFailed: 'Could not load comments.',
    tooMany: 'You have commented a lot today. Try again tomorrow.',
    chars: '{n} / {max}',
    you: 'You',
  },
};
export default dict;
