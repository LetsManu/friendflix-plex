// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Block 17 area 'mine' (German source): calm mode, themed lists. */
export default {
  /** web app manifest (routes/manifest.webmanifest) */
  manifest: {
    description: 'Gemeinsam Filme und Serien schauen',
    resumeDesc: 'Dort weiterschauen, wo du aufgehört hast',
  },
  calm: {
    title: 'Ruhiger Modus',
    hint: 'Nichts startet von selbst: kein Trailer im Hauptbild, keine Vorschau beim Überfahren, keine automatische Vorschau in der Detailansicht, kein Ton dazu – und weniger Bewegung auf der ganzen Seite. Gilt für dieses Profil.',
  },
  themed: {
    eyebrow: 'Themenliste',
    mark: 'Als Themenliste gestalten',
    emoji: 'Symbol (Emoji)',
    emojiPlaceholder: 'z. B. 🎃',
    color: 'Titelfarbe',
    pin: 'Auf der Startseite zeigen',
    unpin: 'Von der Startseite nehmen',
    pinnedHint: 'Diese Themenliste ist auf der Startseite angeheftet.',
    unfeatured: 'Die Liste war hervorgehoben. Weil sich die Art (Themenliste) geändert hat, ist sie es nicht mehr – ein Admin kann sie erneut hervorheben.',
    tooManyPinned: 'Es können höchstens {max} Listen angeheftet werden.',
    manageTitle: 'Themenlisten auf der Startseite',
    manageHint: 'Angeheftete Themenlisten erscheinen für alle auf der Startseite, in dieser Reihenfolge (höchstens {max}, gemeinsam mit den hervorgehobenen Listen).',
    moveUp: '{name} nach oben',
    moveDown: '{name} nach unten',
  },
} as const;
