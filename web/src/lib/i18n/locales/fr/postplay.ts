// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/postplay';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  card: { title: 'Terminé ? Découvrez la suite', open: 'Et ensuite ?', close: 'Masquer ce message' },
  head: {
    movieEnd: 'Vous avez vu « {title} »',
    seriesFinished: 'Vous avez terminé « {title} »',
    caughtUp: 'Vous êtes à jour',
    gap: 'L’épisode {n} n’a pas encore été vu',
    nextPart: 'Ensuite dans « {name} » : {title}',
    nextEpisode: 'Ensuite : {title}',
  },
  sub: {
    caughtUp: 'Vous avez vu tous les épisodes disponibles de « {title} ».',
    nextAir: 'Prochain épisode le {date}',
    noDate: 'Le prochain épisode n’a pas encore de date.',
    gap: '« {title} » : vous avez sauté cet épisode.',
  },
  justWatched: 'Vu à l’instant',
  hero: 'Notre suggestion pour vous',
  action: {
    play: 'Lecture',
    playTitle: 'Lire « {title} »',
    jumpBack: 'Revenir à l’épisode {n}',
    remind: 'Me le rappeler',
    reminded: 'Rappel activé',
    remindFailed: 'Le rappel n’a pas pu être enregistré.',
    wish: 'Demander la saison manquante',
    wished: 'Demandé',
    wishLeft: { one: 'Encore {n} demande ce mois-ci', many: 'Encore {n} de demandes ce mois-ci', other: 'Encore {n} demandes ce mois-ci' },
    wishLimit: 'La limite mensuelle de demandes est atteinte.',
    wishFailed: 'La demande n’a pas abouti.',
    addList: 'Ajouter à ma liste',
    onList: 'Dans ma liste',
    listFailed: 'Votre liste n’a pas pu être enregistrée.',
    notInterested: 'Pas intéressé',
    notInterestedDone: 'Compris : nous ne vous proposerons plus « {title} ».',
    undo: 'Annuler',
    undone: 'Annulé.',
    back: 'Retour au titre',
    details: 'Détails',
  },
  row: {
    continuation: 'La suite',
    transition: 'Ce que les autres regardent après « {name} »',
    universe: 'Le même univers : {name}',
    because: 'Parce que vous avez regardé « {name} »',
    friends: 'Vos amis ont aimé',
    taste: 'Selon vos goûts',
  },
  why: { seed: 'À cause de « {name} »', friends: 'Bien noté par vos amis' },
  spoiler: 'Épisode non vu : aperçu masqué',
  episode: 'S{s}:É{e} · {name}',
  pageTitle: 'Et ensuite ?',
  loading: 'Chargement des suggestions …',
  error: 'Les suggestions n’ont pas pu être chargées.',
  empty: 'Nous n’avons pas de suggestion pour vous pour le moment.',
  settings: {
    label: 'Afficher des suggestions après le dernier épisode',
    hint: 'Après un film ou le dernier épisode disponible : la suite, des titres similaires et des conseils. Rien ne démarre tout seul.',
  },
};
export default dict;
