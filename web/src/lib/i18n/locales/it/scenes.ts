// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/scenes';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  info: {
    title: 'Cast e info',
    open: 'Cast e info',
    openKey: 'Cast e info (I)',
    close: 'Chiudi cast e info',
    cast: 'Cast',
    guests: 'Guest star',
    facts: 'Retroscena',
    as: 'nel ruolo di {role}',
    directors: 'Regia',
    writers: 'Sceneggiatura',
    creators: 'Ideatori',
    studio: 'Studio',
    year: 'Anno',
    rating: 'Classificazione',
    score: 'Valutazione',
    genres: 'Generi',
    tags: 'Tag',
    loading: 'Caricamento del cast…',
    failed: 'Impossibile caricare cast e info.',
    none: 'Nessuna informazione sul cast per questo titolo.',
    person: '{name}, mostra altri titoli',
  },
  peek: {
    label: 'Il cast in breve',
    more: 'Tutte le info',
    hintKey: 'Altro: {key}',
    hintTv: 'Altro: OK',
  },
  person: {
    role: 'interpreta {role}',
    more: 'Altro con {name}',
    loading: 'Caricamento dei titoli…',
    none: 'Nessun altro titolo nella tua libreria.',
    failed: 'Impossibile caricare i titoli.',
    page: 'Tutti i titoli e le info',
    back: 'Torna al cast',
  },
  chapters: {
    title: 'Scene',
    open: 'Scene',
    close: 'Chiudi le scene',
    chapter: 'Capitolo {n}',
    current: 'In riproduzione',
    jump: '{name}, da {t}',
    count: { one: '{n} scena', many: '{n} scene', other: '{n} scene' },
  },
  audio: {
    title: 'Audio',
    voice: 'Voci chiare',
    voiceHint: 'Mette in risalto i dialoghi',
    night: 'Modalità notte',
    nightHint: 'Parti forti più basse, parti deboli più alte',
    on: '{name} attivo',
    off: '{name} disattivato',
    unsupported: 'Non disponibile su questo dispositivo',
    casting: 'Non disponibile durante la trasmissione su un altro dispositivo',
    needsTap: 'Tocca l’immagine o premi un tasto una volta e «{name}» si attiva.',
  },
  shortcuts: {
    peek: 'Uno sguardo veloce al cast',
  },
};
export default dict;
