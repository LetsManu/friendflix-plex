// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Area 'reco' (German source): the reason caption of recommendations ("Because you watched X · same director"), the profile settings "Reset my recommendations" / "Why am I seeing this?" and the admin card. */
export default {
  because: 'Weil du „{seed}“ gesehen hast',
  picked: 'Für dich ausgewählt',
  trait: {
    friends: 'Freunde haben es bewertet', friendsNamed: '{names} haben es bewertet', next: 'wird oft danach geschaut', together: 'wird oft zusammen geschaut', universe: 'gleiche Welt',
    director: 'gleiche Regie', directorNamed: 'gleiche Regie ({name})', actor: 'gleiche Besetzung', actorNamed: 'mit {name}',
    studioNamed: 'vom Studio {name}', genreNamed: 'Genre {name}',
  },
  why: { button: 'Warum sehe ich das?', heading: 'Warum diese Titel?', item: '{name}: {reason}', none: 'Passt zu deinem Geschmack.', close: 'Ausblenden' },
  settings: {
    title: 'Empfehlungen',
    reset: 'Meine Empfehlungen zurücksetzen',
    resetHint: 'Vergisst dein gelerntes Geschmacksprofil und welche Zeilen du anklickst. Merkliste, Bewertungen und Verlauf bleiben. Danach bauen sich die Empfehlungen aus deinem Verlauf neu auf.',
    resetDone: 'Zurückgesetzt. Die Empfehlungen werden neu berechnet.',
    resetFailed: 'Das Zurücksetzen hat nicht geklappt.',
    whyHint: 'Tippe auf die Zeile unter einer Empfehlung („Weil du … gesehen hast“), um zu sehen, warum ein Titel dort steht.',
  },
  admin: {
    title: 'Empfehlungs-Engine',
    intro: 'Klickrate und Abspielrate je Engine, berechnet aus den Zählern dieses Servers. Die Zähler beginnen bei jedem Neustart neu.',
    active: 'Aktiv: {engine}',
    engine: { v1: 'v1 (Jellyfin)', v2: 'v2 (eigenes Modell)', shadow: 'Shadow (v2 läuft nebenher)' },
    col: { engine: 'Engine', shown: 'Angezeigt', clicks: 'Geklickt', plays: 'Abgespielt', dismissed: 'Abgelehnt', ctr: 'Klickrate', playRate: 'Abspielrate' },
    fallbacks: 'Rückfälle auf v1: {n}',
    since: 'Gezählt seit {date}',
    empty: '–',
    loadFailed: 'Die Zahlen konnten nicht geladen werden.',
  },
} as const;
