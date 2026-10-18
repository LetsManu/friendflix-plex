// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/reco';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  because: 'Bo oglądasz „{seed}”',
  picked: 'Wybrane dla Ciebie',
  trait: {
    friends: 'ocenili to znajomi', friendsNamed: 'ocenili to: {names}', next: 'ludzie oglądają to potem', together: 'często oglądane razem', universe: 'to samo uniwersum',
    director: 'ten sam reżyser', directorNamed: 'ten sam reżyser ({name})', actor: 'ta sama obsada', actorNamed: 'z {name}',
    studioNamed: 'od {name}', genreNamed: 'gatunek: {name}',
  },
  why: { button: 'Dlaczego to widzę?', heading: 'Dlaczego te tytuły?', item: '{name}: {reason}', none: 'Pasuje do Twojego gustu.', close: 'Ukryj' },
  settings: {
    title: 'Rekomendacje',
    reset: 'Zresetuj moje rekomendacje',
    resetHint: 'Zapomina wyuczony profil gustu i to, w które rzędy klikasz. Lista, oceny i historia zostają. Potem rekomendacje budują się od nowa z Twojej historii.',
    resetDone: 'Zresetowano. Rekomendacje są liczone na nowo.',
    resetFailed: 'Nie udało się zresetować.',
    whyHint: 'Stuknij wiersz pod rekomendacją („Bo oglądasz …”), aby zobaczyć, dlaczego tytuł tam jest.',
  },
  admin: {
    title: 'Silnik rekomendacji',
    intro: 'Współczynnik kliknięć i odtworzeń dla każdego silnika, liczony z liczników tego serwera. Liczniki zaczynają od zera po każdym restarcie.',
    active: 'Aktywny: {engine}',
    engine: { v1: 'v1 (Jellyfin)', v2: 'v2 (własny model)', shadow: 'Shadow (v2 działa równolegle)' },
    col: { engine: 'Silnik', shown: 'Wyświetlone', clicks: 'Kliknięte', plays: 'Odtworzone', dismissed: 'Odrzucone', ctr: 'Współczynnik kliknięć', playRate: 'Współczynnik odtworzeń' },
    fallbacks: 'Powroty do v1: {n}',
    since: 'Liczone od {date}',
    empty: '–',
    loadFailed: 'Nie udało się wczytać liczb.',
  },
};

export default dict;
