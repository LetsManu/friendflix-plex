import type de from '../de/common';
import type { Translation } from '../../types';

const en: Translation<typeof de> = {
  appName: 'FriendFlix',
  pageTitle: '{page} – FriendFlix',
  save: 'Save',
  saving: 'Saving …',
  saved: 'Saved',
  saveFailed: 'Could not save.',
  failed: 'That didn’t work.',
  cancel: 'Cancel',
  close: 'Close',
  done: 'Done',
  delete: 'Delete',
  edit: 'Edit',
  retry: 'Try again',
  loading: 'Loading …',
  more: 'More',
  continue: 'Continue',
  later: 'Later',
  preview: 'Preview',
  on: 'On',
  off: 'Off',
  standard: 'Default',
  unknown: 'unknown',
  movies: 'Movies',
  series: 'TV Shows',
  duration: { hm: '{h} h {m} min', h: '{h} h', m: '{m} min', s: '{s} sec' },
  rating: {
    rate: 'Rate',
    notForMe: 'Not for me',
    like: 'I like this',
    love: 'Love this!',
    rated: 'Rated: {label} – change rating',
    remove: '{label} (remove rating)',
    saveFailed: 'Could not save your rating.',
  },
  language: {
    label: 'Language',
  },
};
export default en;
