// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/reco';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  because: 'Parce que vous avez regardé « {seed} »',
  picked: 'Choisi pour vous',
  trait: {
    friends: 'noté par vos amis', friendsNamed: 'noté par {names}', next: 'souvent regardé ensuite', together: 'souvent regardé avec', universe: 'même univers',
    director: 'même réalisateur', directorNamed: 'même réalisateur ({name})', actor: 'même distribution', actorNamed: 'avec {name}',
    studioNamed: 'de {name}', genreNamed: 'genre : {name}',
  },
  why: { button: 'Pourquoi je vois ça ?', heading: 'Pourquoi ces titres ?', item: '{name} : {reason}', none: 'Correspond à vos goûts.', close: 'Masquer' },
  settings: {
    title: 'Recommandations',
    reset: 'Réinitialiser mes recommandations',
    resetHint: 'Oublie votre profil de goûts appris et les rangées sur lesquelles vous cliquez. Votre liste, vos notes et votre historique restent. Ensuite, les recommandations sont reconstruites à partir de votre historique.',
    resetDone: 'Réinitialisé. Les recommandations sont recalculées.',
    resetFailed: 'La réinitialisation a échoué.',
    whyHint: 'Touchez la ligne sous une recommandation (« Parce que vous avez regardé … ») pour voir pourquoi un titre s’y trouve.',
  },
  admin: {
    title: 'Moteur de recommandations',
    intro: 'Taux de clic et taux de lecture par moteur, calculés à partir des compteurs de ce serveur. Les compteurs repartent de zéro à chaque redémarrage.',
    active: 'Actif : {engine}',
    engine: { v1: 'v1 (Jellyfin)', v2: 'v2 (modèle propre)', shadow: 'Shadow (v2 tourne en parallèle)' },
    col: { engine: 'Moteur', shown: 'Affichées', clicks: 'Cliquées', plays: 'Lues', dismissed: 'Écartées', ctr: 'Taux de clic', playRate: 'Taux de lecture' },
    fallbacks: 'Replis sur v1 : {n}',
    since: 'Compté depuis le {date}',
    empty: '–',
    loadFailed: 'Les chiffres n’ont pas pu être chargés.',
  },
};

export default dict;
