// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/fresh';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  label: {
    newEpisode: 'Nouvel épisode',
    newSeason: 'Nouvelle saison',
    finale: 'Final de saison',
    newSeries: 'Nouvelle série',
    new: 'Nouveau',
  },
  leaving: {
    days: { one: 'Plus que {n} jour', many: 'Plus que {n} jours', other: 'Plus que {n} jours' },
    today: 'Dernier jour',
    until: 'Disponible jusqu’au {date}',
  },
  row: { leaving: 'Bientôt indisponible' },
  q: {
    label: 'Image et son',
    '4k': '4K',
    hd: 'HD',
    dolbyvision: 'Dolby Vision',
    hdr10plus: 'HDR10+',
    hdr: 'HDR',
    atmos: 'Dolby Atmos',
    surround: 'Surround 5.1',
    stereo: 'Stéréo',
  },
  browse: { quality: 'Qualité d’image' },
  story: {
    title: 'Auparavant',
    newSeason: 'La saison {n} commence – voici un rappel.',
    longBreak: { one: 'Vous n’avez rien regardé depuis {n} semaine – petit rappel.', many: 'Vous n’avez rien regardé depuis {n} semaines – petit rappel.', other: 'Vous n’avez rien regardé depuis {n} semaines – petit rappel.' },
    season: 'Saison {n}',
    lastEpisode: 'Dernier épisode vu : S{s}:E{e} « {name} »',
    dismiss: 'Masquer cette carte',
  },
  admin: {
    tab: 'Bientôt retiré',
    title: 'Bientôt indisponible',
    intro: 'Ces titres ont une date à laquelle ils quittent la médiathèque. Deux semaines avant, les cartes affichent un avis ; une semaine et un jour avant, toutes les personnes qui ont le titre dans « Mes envies » ou dans « Reprendre » reçoivent une notification. Rien n’est supprimé – la date n’est qu’une annonce, et les entrées échues disparaissent d’elles-mêmes.',
    addTitle: 'Ajouter un titre',
    search: 'Rechercher un titre',
    searchPlaceholder: 'Film ou série …',
    results: 'Résultats de la recherche',
    noHits: 'Aucun résultat.',
    change: 'Choisir un autre titre',
    date: 'Retiré le',
    note: 'Note (admins uniquement)',
    notePlaceholder: 'p. ex. licence expirée',
    hint: 'Rien n’est supprimé. Les gens voient seulement « Plus que N jours ».',
    save: 'Enregistrer',
    clear: 'Retirer la date',
    saved: 'Enregistré.',
    cleared: 'Date retirée.',
    saveFailed: 'Échec de l’enregistrement.',
    loadFailed: 'Impossible de charger la liste.',
    dateRange: 'La date doit être aujourd’hui ou plus tard (deux ans maximum).',
    empty: 'Aucun titre n’a de date pour le moment.',
    colTitle: 'Titre',
    colSetBy: 'Défini par',
    menu: 'Définir une date de retrait …',
    dialogTitle: 'Plus disponible à partir du',
  },
};
export default dict;
