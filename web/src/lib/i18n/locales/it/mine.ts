// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/mine';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  /** web app manifest (routes/manifest.webmanifest) */
  manifest: {
    description: 'Guardate film e serie insieme',
    resumeDesc: 'Riprendi da dove avevi lasciato',
  },
  calm: {
    title: 'Modalità tranquilla',
    hint: 'Niente parte da solo: nessun trailer nel banner, nessuna anteprima al passaggio del mouse, nessuna anteprima automatica nella scheda, nessun audio – e meno movimento in tutta l\'app. Vale per questo profilo.',
  },
  themed: {
    eyebrow: 'Lista a tema',
    mark: 'Presenta come lista a tema',
    emoji: 'Icona (emoji)',
    emojiPlaceholder: 'es. 🎃',
    color: 'Colore di copertina',
    pin: 'Mostra nella home',
    unpin: 'Rimuovi dalla home',
    pinnedHint: 'Questa lista a tema è fissata nella home.',
    unfeatured: 'Questa lista era in evidenza. Poiché è cambiato il tipo (lista a tema), non lo è più: un admin può rimetterla in evidenza.',
    tooManyPinned: 'Non si possono fissare più di {max} liste.',
    manageTitle: 'Liste a tema nella home',
    manageHint: 'Le liste a tema fissate compaiono nella home di tutti, in quest\'ordine (al massimo {max}, insieme alle liste in evidenza).',
    moveUp: 'Sposta {name} su',
    moveDown: 'Sposta {name} giù',
  },
};
export default dict;
