import type de from '../de/common';
import type { Translation } from '../../types';

/** French – area "common". Missing keys fall back to German (docs/i18n.md). */
const fr: Translation<typeof de> = {
  appName: 'FriendFlix',
  pageTitle: '{page} – FriendFlix',
  save: 'Enregistrer',
  saving: 'Enregistrement …',
  saved: 'Enregistré',
  saveFailed: 'Enregistrement impossible.',
  failed: 'Cela n’a pas fonctionné.',
  cancel: 'Annuler',
  close: 'Fermer',
  done: 'Terminé',
  delete: 'Supprimer',
  edit: 'Modifier',
  retry: 'Recharger',
  loading: 'Chargement …',
  more: 'Plus',
  continue: 'Continuer',
  later: 'Plus tard',
  preview: 'Aperçu',
  on: 'Activé',
  off: 'Désactivé',
  standard: 'Par défaut',
  unknown: 'inconnu',
  movies: 'Films',
  series: 'Séries',
  duration: { hm: '{h} h {m} min', h: '{h} h', m: '{m} min', s: '{s} s' },
  rating: {
    rate: 'Noter',
    notForMe: 'Pas pour moi',
    like: 'J’aime',
    love: 'J’adore !',
    rated: 'Noté : {label} – modifier la note',
    remove: '{label} (supprimer la note)',
    saveFailed: 'Impossible d’enregistrer la note.',
  },
  language: {
    label: 'Langue',
  },
};
export default fr;
