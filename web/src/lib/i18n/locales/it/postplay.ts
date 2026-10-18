// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/postplay';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  card: { title: 'Finito? Scopri cosa viene dopo', open: 'E adesso?', close: 'Nascondi questo avviso' },
  head: {
    movieEnd: 'Hai visto “{title}”',
    seriesFinished: 'Hai finito “{title}”',
    caughtUp: 'Sei in pari',
    gap: 'L’episodio {n} non è ancora stato visto',
    nextPart: 'Il prossimo in “{name}”: {title}',
    nextEpisode: 'Prossimo: {title}',
  },
  sub: {
    caughtUp: 'Hai visto tutti gli episodi disponibili di “{title}”.',
    nextAir: 'Prossimo episodio il {date}',
    noDate: 'Il prossimo episodio non ha ancora una data.',
    gap: '“{title}”: hai saltato questo episodio.',
  },
  justWatched: 'Appena visto',
  hero: 'Il nostro consiglio per te',
  action: {
    play: 'Riproduci',
    playTitle: 'Riproduci “{title}”',
    jumpBack: 'Torna all’episodio {n}',
    remind: 'Ricordamelo',
    reminded: 'Promemoria attivo',
    remindFailed: 'Non è stato possibile salvare il promemoria.',
    wish: 'Richiedi la stagione mancante',
    wished: 'Richiesto',
    wishLeft: { one: 'Ancora {n} richiesta questo mese', many: 'Ancora {n} di richieste questo mese', other: 'Ancora {n} richieste questo mese' },
    wishLimit: 'Hai raggiunto il limite mensile di richieste.',
    wishFailed: 'La richiesta non è andata a buon fine.',
    addList: 'Aggiungi alla lista',
    onList: 'Nella tua lista',
    listFailed: 'Non è stato possibile salvare la lista.',
    notInterested: 'Non mi interessa',
    notInterestedDone: 'Ricevuto: non ti proporremo più “{title}”.',
    undo: 'Annulla',
    undone: 'Annullato.',
    back: 'Torna al titolo',
    details: 'Dettagli',
  },
  row: {
    continuation: 'Continua',
    transition: 'Cosa guardano gli altri dopo “{name}”',
    universe: 'Stesso universo: {name}',
    because: 'Perché hai guardato “{name}”',
    friends: 'Ai tuoi amici è piaciuto',
    taste: 'Adatto ai tuoi gusti',
  },
  why: { seed: 'Per “{name}”', friends: 'Molto apprezzato dai tuoi amici' },
  spoiler: 'Episodio non visto: anteprima nascosta',
  episode: 'S{s}:E{e} · {name}',
  pageTitle: 'E adesso?',
  loading: 'Caricamento dei suggerimenti …',
  error: 'Non è stato possibile caricare i suggerimenti.',
  empty: 'Al momento non abbiamo suggerimenti per te.',
  settings: {
    label: 'Mostra suggerimenti dopo l’ultimo episodio',
    hint: 'Dopo un film o l’ultimo episodio disponibile: cosa viene dopo, titoli simili e consigli. Niente parte da solo.',
  },
};
export default dict;
