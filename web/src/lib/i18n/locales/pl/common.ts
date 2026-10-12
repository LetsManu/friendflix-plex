import type de from '../de/common';
import type { Translation } from '../../types';

/** Polish – area "common". Missing keys fall back to German (docs/i18n.md). */
const pl: Translation<typeof de> = {
  appName: '{brand}',
  pageTitle: '{page} – {brand}',
  save: 'Zapisz',
  saving: 'Zapisuję …',
  saved: 'Zapisano',
  saveFailed: 'Nie udało się zapisać.',
  failed: 'Coś poszło nie tak.',
  cancel: 'Anuluj',
  close: 'Zamknij',
  done: 'Gotowe',
  delete: 'Usuń',
  edit: 'Edytuj',
  retry: 'Spróbuj ponownie',
  loading: 'Ładowanie …',
  more: 'Więcej',
  continue: 'Dalej',
  later: 'Później',
  preview: 'Podgląd',
  on: 'Wł.',
  off: 'Wył.',
  standard: 'Domyślnie',
  unknown: 'nieznane',
  movies: 'Filmy',
  series: 'Seriale',
  duration: { hm: '{h} godz. {m} min', h: '{h} godz.', m: '{m} min', s: '{s} s' },
  rating: {
    rate: 'Oceń',
    notForMe: 'Takie sobie',
    like: 'Dobre',
    love: 'Uwielbiam',
    rated: 'Oceniono: {label} – zmień ocenę',
    remove: '{label} (usuń ocenę)',
    saveFailed: 'Nie udało się zapisać oceny.',
  },
  language: {
    label: 'Język',
  },
};
export default pl;
