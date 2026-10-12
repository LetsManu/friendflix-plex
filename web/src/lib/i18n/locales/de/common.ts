/** Shared words and building blocks used by every area (buttons, states, units). German = source of truth. */
export default {
  appName: 'FriendFlix',
  /** browser tab title of a page */
  pageTitle: '{page} – FriendFlix',
  save: 'Speichern',
  saving: 'Speichere …',
  saved: 'Gespeichert',
  saveFailed: 'Speichern fehlgeschlagen.',
  failed: 'Das hat nicht geklappt.',
  cancel: 'Abbrechen',
  close: 'Schließen',
  done: 'Fertig',
  delete: 'Löschen',
  edit: 'Bearbeiten',
  retry: 'Erneut laden',
  loading: 'Lade …',
  more: 'Mehr',
  continue: 'Weiter',
  later: 'Später',
  preview: 'Vorschau',
  on: 'An',
  off: 'Aus',
  standard: 'Standard',
  unknown: 'unbekannt',
  movies: 'Filme',
  series: 'Serien',
  /** run times, see fmtDuration() */
  duration: { hm: '{h} Std. {m} Min.', h: '{h} Std.', m: '{m} Min.', s: '{s} Sek.' },
  /** Netflix-style rating (RatingButton, rating.ts) */
  rating: {
    rate: 'Bewerten',
    notForMe: 'Nicht mein Fall',
    like: 'Gefällt mir',
    love: 'Super',
    rated: 'Bewertet: {label} – Bewertung ändern',
    remove: '{label} (Bewertung entfernen)',
    saveFailed: 'Bewertung konnte nicht gespeichert werden.',
  },
  /** language names for UI pickers are native names (see LOCALES); these are used in surrounding sentences */
  language: {
    label: 'Sprache',
  },
} as const;
