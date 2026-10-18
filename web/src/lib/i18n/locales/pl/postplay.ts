// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/postplay';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  card: { title: 'Koniec? Zobacz, co dalej', open: 'Co dalej?', close: 'Ukryj tę wskazówkę' },
  head: {
    movieEnd: 'Obejrzano „{title}”',
    seriesFinished: 'Ukończono „{title}”',
    caughtUp: 'Wszystko obejrzane',
    gap: 'Odcinek {n} jest jeszcze nieobejrzany',
    nextPart: 'Dalej w „{name}”: {title}',
    nextEpisode: 'Następny: {title}',
  },
  sub: {
    caughtUp: 'Obejrzano wszystkie dostępne odcinki „{title}”.',
    nextAir: 'Następny odcinek {date}',
    noDate: 'Następny odcinek nie ma jeszcze daty.',
    gap: '„{title}”: ten odcinek został pominięty.',
  },
  justWatched: 'Właśnie obejrzane',
  hero: 'Nasz wybór dla ciebie',
  action: {
    play: 'Odtwórz',
    playTitle: 'Odtwórz „{title}”',
    jumpBack: 'Wróć do odcinka {n}',
    remind: 'Przypomnij mi',
    reminded: 'Przypomnienie włączone',
    remindFailed: 'Nie udało się zapisać przypomnienia.',
    wish: 'Poproś o brakujący sezon',
    wished: 'Wysłano prośbę',
    wishLeft: { one: 'W tym miesiącu została {n} prośba', few: 'W tym miesiącu zostały {n} prośby', many: 'W tym miesiącu zostało {n} próśb', other: 'W tym miesiącu zostało {n} prośby' },
    wishLimit: 'Osiągnięto miesięczny limit próśb.',
    wishFailed: 'Nie udało się wysłać prośby.',
    addList: 'Dodaj do listy',
    onList: 'Na twojej liście',
    listFailed: 'Nie udało się zapisać listy.',
    notInterested: 'Nie interesuje mnie',
    notInterestedDone: 'Rozumiemy: nie będziemy już proponować „{title}”.',
    undo: 'Cofnij',
    undone: 'Cofnięto.',
    back: 'Wróć do tytułu',
    details: 'Szczegóły',
  },
  row: {
    continuation: 'Oglądaj dalej',
    transition: 'Co inni oglądają po „{name}”',
    universe: 'To samo uniwersum: {name}',
    because: 'Ponieważ obejrzano „{name}”',
    friends: 'Twoim znajomym się podobało',
    taste: 'W twoim guście',
  },
  why: { seed: 'Z powodu „{name}”', friends: 'Wysoko ocenione przez znajomych' },
  spoiler: 'Nieobejrzany odcinek: podgląd ukryty',
  episode: 'S{s}:O{e} · {name}',
  pageTitle: 'Co dalej?',
  loading: 'Ładowanie propozycji …',
  error: 'Nie udało się wczytać propozycji.',
  empty: 'Na razie nie mamy dla ciebie propozycji.',
  settings: {
    label: 'Pokazuj propozycje po ostatnim odcinku',
    hint: 'Po filmie lub ostatnim dostępnym odcinku: co dalej, podobne tytuły i wskazówki. Nic nie startuje samo.',
  },
};
export default dict;
