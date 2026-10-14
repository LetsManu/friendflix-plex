// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Block 15 area 'anime': simulcast view and friends-only episode comments (German source). */
export default {
  simulcast: {
    title: 'Simulcast',
    intro: 'Laufende Serien mit neuen Folgen in den letzten und kommenden vier Wochen, nach Wochentag.',
    onlyAnime: 'Nur Anime',
    season: { winter: 'Winter {year}', spring: 'Frühling {year}', summer: 'Sommer {year}', fall: 'Herbst {year}' },
    none: 'Zurzeit laufen keine Serien mit neuen Folgen.',
    loadFailed: 'Simulcast konnte nicht geladen werden.',
    today: 'Heute',
    latest: 'Zuletzt: {ep}',
    next: 'Nächste: {ep} am {date}',
    airsAt: 'um {time} Uhr',
    link: 'Simulcast',
  },
  settings: {
    original: 'Anime: Originalton mit Untertiteln',
    originalHint: 'Anime-Serien starten auf Japanisch mit Untertiteln in deiner Sprache – solange du für die Serie nichts anderes gewählt hast. Gibt es keine japanische Tonspur, gelten deine normalen Einstellungen.',
  },
  comments: {
    show: 'Kommentare',
    hide: 'Kommentare ausblenden',
    title: 'Kommentare von Freunden',
    count: { one: '{n} Kommentar', other: '{n} Kommentare' },
    placeholder: 'Schreib etwas zur Folge …',
    label: 'Dein Kommentar',
    send: 'Senden',
    empty: 'Noch keine Kommentare von Freunden.',
    spoiler: 'Spoiler',
    reveal: 'Spoiler – trotzdem zeigen',
    hint: 'Du hast diese Folge noch nicht gesehen – Kommentare anderer sind verborgen.',
    delete: 'Löschen',
    deleteAria: 'Kommentar von {name} löschen',
    failed: 'Der Kommentar konnte nicht gespeichert werden.',
    loadFailed: 'Kommentare konnten nicht geladen werden.',
    tooMany: 'Du hast heute schon sehr viel kommentiert. Versuch es morgen wieder.',
    chars: '{n} / {max}',
    you: 'Du',
  },
} as const;
