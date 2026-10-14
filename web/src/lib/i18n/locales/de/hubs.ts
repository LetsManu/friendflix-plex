// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Block 15 area 'hubs': Marken-Kacheln unter dem Billboard, Marken-Seite, Admin-Verwaltung und Bonusmaterial-Reiter.
 * German is the typed source (see docs/i18n.md).
 */
export default {
  /** Kachelreihe auf der Startseite */
  strip: {
    label: 'Marken und Sammlungen',
    open: 'Alles aus {name} ansehen',
  },
  /** Seite einer Marke (/hub/[id]) */
  page: {
    new: 'Neu bei {name}',
    popular: 'Beliebt bei {name}',
    movies: 'Filme',
    series: 'Serien',
    az: 'Alle Titel von A bis Z',
    count: { one: '{n} Titel', other: '{n} Titel' },
    more: 'Mehr laden',
    loading: 'Wird geladen …',
    loadFailed: 'Die Marke konnte nicht geladen werden.',
    retry: 'Erneut versuchen',
    missing: 'Diese Marke gibt es nicht (mehr) oder du hast keinen Zugriff auf ihre Titel.',
    home: 'Zur Startseite',
    filter: 'Typ',
    all: 'Alle',
  },
  /** Reiter „Extras“ in der Detailansicht */
  extras: {
    tabs: 'Weitere Inhalte',
    tab: 'Extras',
    trailer: 'Trailer',
    extra: 'Bonus',
    play: '{name} abspielen',
  },
  /** Admin → Marken */
  admin: {
    tab: 'Marken',
    pageTitle: 'Marken – Admin',
    title: 'Marken-Kacheln',
    intro: 'Bis zu {max} Kacheln unter dem Billboard der Startseite. Jede Kachel zeigt die Titel eines Studios, einer Kollektion, eines Tags oder eines Genres aus deiner Bibliothek. Aktuell: {count}.',
    loading: 'Wird geladen …',
    loadFailed: 'Die Marken konnten nicht geladen werden.',
    empty: 'Noch keine Marken. Lege eine an oder übernimm einen Vorschlag.',
    add: 'Marke anlegen',
    editTitle: 'Marke bearbeiten',
    newTitle: 'Neue Marke',
    edit: 'Bearbeiten',
    name: 'Name',
    source: 'Quelle',
    value: 'Name in Jellyfin',
    valueHint: 'Genau so geschrieben wie in Jellyfin (Studio, Tag oder Genre).',
    collection: 'Kollektion',
    collectionPick: 'Kollektion wählen',
    accent: 'Akzentfarbe',
    accentAuto: 'Automatisch',
    image: 'Bild',
    imageNone: 'Kein Bild: Farbverlauf mit Namen',
    imageSearch: 'Titel oder Kollektion suchen',
    imagePicked: 'Bild von: {name}',
    imageClear: 'Bild entfernen',
    enabled: 'Auf der Startseite zeigen',
    hidden: 'Ausgeblendet',
    save: 'Speichern',
    cancel: 'Abbrechen',
    remove: 'Löschen',
    removeName: '{name} löschen',
    confirmRemove: '„{name}“ wirklich löschen?',
    up: '{name} nach vorne',
    down: '{name} nach hinten',
    suggestions: 'Vorschläge aus deiner Bibliothek',
    suggestionsEmpty: 'Keine Vorschläge gefunden.',
    suggestionsLoading: 'Vorschläge werden gesucht …',
    use: '{name} übernehmen',
    used: 'schon angelegt',
    saved: '„{name}“ gespeichert.',
    removed: '„{name}“ gelöscht.',
    tooMany: 'Mehr als {max} Kacheln passen nicht in die Reihe.',
    badSource: 'Die Quelle oder das Bild wurde in Jellyfin nicht gefunden.',
    sources: {
      studio: 'Studio',
      collection: 'Kollektion',
      tag: 'Tag',
      genre: 'Genre',
    },
  },
} as const;
