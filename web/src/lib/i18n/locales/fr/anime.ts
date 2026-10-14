// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/anime';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  simulcast: {
    title: 'Simulcast',
    intro: 'Séries en cours avec de nouveaux épisodes ces quatre dernières semaines et les quatre prochaines, par jour de la semaine.',
    onlyAnime: 'Animés uniquement',
    season: { winter: 'Hiver {year}', spring: 'Printemps {year}', summer: 'Été {year}', fall: 'Automne {year}' },
    none: 'Aucune série avec de nouveaux épisodes pour l’instant.',
    loadFailed: 'Impossible de charger le simulcast.',
    today: 'Aujourd’hui',
    latest: 'Dernier : {ep}',
    next: 'Prochain : {ep} le {date}',
    airsAt: 'à {time}',
    link: 'Simulcast',
  },
  settings: {
    original: 'Anime : version originale sous-titrée',
    originalHint: 'Les séries d’animation japonaises démarrent en japonais avec des sous-titres dans ta langue, sauf si tu as choisi autre chose pour cette série. Sans piste audio japonaise, tes réglages habituels s’appliquent.',
  },
  comments: {
    show: 'Commentaires',
    hide: 'Masquer les commentaires',
    title: 'Commentaires des amis',
    count: { one: '{n} commentaire', many: '{n} commentaires', other: '{n} commentaires' },
    placeholder: 'Écris quelque chose sur cet épisode …',
    label: 'Ton commentaire',
    send: 'Publier',
    empty: 'Pas encore de commentaires d’amis.',
    spoiler: 'Spoiler',
    reveal: 'Spoiler – afficher quand même',
    hint: 'Tu n’as pas encore vu cet épisode – les commentaires des autres sont masqués.',
    delete: 'Supprimer',
    deleteAria: 'Supprimer le commentaire de {name}',
    failed: 'Le commentaire n’a pas pu être enregistré.',
    loadFailed: 'Impossible de charger les commentaires.',
    tooMany: 'Tu as beaucoup commenté aujourd’hui. Réessaie demain.',
    chars: '{n} / {max}',
    you: 'Toi',
  },
};
export default dict;
