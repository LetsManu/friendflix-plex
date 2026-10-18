// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/reco';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  because: 'Perché hai guardato «{seed}»',
  picked: 'Scelto per te',
  trait: {
    friends: 'valutato dai tuoi amici', friendsNamed: 'valutato da {names}', next: 'di solito si guarda dopo', together: 'spesso guardato insieme', universe: 'stesso universo',
    director: 'stesso regista', directorNamed: 'stesso regista ({name})', actor: 'stesso cast', actorNamed: 'con {name}',
    studioNamed: 'di {name}', genreNamed: 'genere: {name}',
  },
  why: { button: 'Perché vedo questo?', heading: 'Perché questi titoli?', item: '{name}: {reason}', none: 'È in linea con i tuoi gusti.', close: 'Nascondi' },
  settings: {
    title: 'Consigli',
    reset: 'Reimposta i miei consigli',
    resetHint: 'Dimentica il profilo di gusti appreso e le righe su cui clicchi. La tua lista, le valutazioni e la cronologia restano. Poi i consigli vengono ricostruiti dalla tua cronologia.',
    resetDone: 'Reimpostato. I consigli vengono ricalcolati.',
    resetFailed: 'Il ripristino non è riuscito.',
    whyHint: 'Tocca la riga sotto un consiglio («Perché hai guardato …») per vedere perché c’è un titolo.',
  },
  admin: {
    title: 'Motore dei consigli',
    intro: 'Percentuale di clic e di riproduzione per motore, calcolate dai contatori di questo server. I contatori ripartono da zero a ogni riavvio.',
    active: 'Attivo: {engine}',
    engine: { v1: 'v1 (Jellyfin)', v2: 'v2 (modello proprio)', shadow: 'Shadow (v2 in parallelo)' },
    col: { engine: 'Motore', shown: 'Mostrate', clicks: 'Cliccate', plays: 'Riprodotte', dismissed: 'Scartate', ctr: 'Percentuale di clic', playRate: 'Percentuale di riproduzione' },
    fallbacks: 'Ripieghi su v1: {n}',
    since: 'Conteggio dal {date}',
    empty: '–',
    loadFailed: 'Impossibile caricare i numeri.',
  },
};

export default dict;
