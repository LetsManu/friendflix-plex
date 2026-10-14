// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/scenes';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  info: {
    title: 'Distribution et infos',
    open: 'Distribution et infos',
    openKey: 'Distribution et infos (I)',
    close: 'Fermer distribution et infos',
    cast: 'Distribution',
    guests: 'Invités',
    facts: 'En coulisses',
    as: 'dans le rôle de {role}',
    directors: 'Réalisation',
    writers: 'Scénario',
    creators: 'Création',
    studio: 'Studio',
    year: 'Année',
    rating: 'Classification',
    score: 'Note',
    genres: 'Genres',
    tags: 'Mots-clés',
    loading: 'Chargement de la distribution…',
    failed: 'Impossible de charger la distribution et les infos.',
    none: 'Aucune information sur la distribution pour ce titre.',
    person: '{name}, voir d’autres titres',
  },
  peek: {
    label: 'La distribution en un coup d’œil',
    more: 'Toutes les infos',
    hintKey: 'Plus : {key}',
    hintTv: 'Plus : OK',
  },
  person: {
    role: 'joue {role}',
    more: 'Plus avec {name}',
    loading: 'Chargement des titres…',
    none: 'Aucun autre titre dans ta bibliothèque.',
    failed: 'Impossible de charger les titres.',
    page: 'Tous les titres et infos',
    back: 'Retour à la distribution',
  },
  chapters: {
    title: 'Scènes',
    open: 'Scènes',
    close: 'Fermer les scènes',
    chapter: 'Chapitre {n}',
    current: 'En cours',
    jump: '{name}, à partir de {t}',
    count: { one: '{n} scène', many: '{n} scènes', other: '{n} scènes' },
  },
  audio: {
    title: 'Son',
    voice: 'Voix claires',
    voiceHint: 'Mettre les dialogues en avant',
    night: 'Mode nuit',
    nightHint: 'Passages forts adoucis, passages calmes renforcés',
    on: '{name} activé',
    off: '{name} désactivé',
    unsupported: 'Non disponible sur cet appareil',
    casting: 'Non disponible pendant la diffusion sur un autre appareil',
    needsTap: 'Touche l’image ou appuie sur une touche une fois pour activer « {name} ».',
  },
  shortcuts: {
    peek: 'Aperçu rapide de la distribution',
  },
};
export default dict;
