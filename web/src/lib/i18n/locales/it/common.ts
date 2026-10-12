import type de from '../de/common';
import type { Translation } from '../../types';

/** Italian – area "common". Missing keys fall back to German (docs/i18n.md). */
const it: Translation<typeof de> = {
  appName: 'FriendFlix',
  pageTitle: '{page} – FriendFlix',
  save: 'Salva',
  saving: 'Salvataggio…',
  saved: 'Salvato',
  saveFailed: 'Salvataggio non riuscito.',
  failed: 'Qualcosa non ha funzionato.',
  cancel: 'Annulla',
  close: 'Chiudi',
  done: 'Fatto',
  delete: 'Elimina',
  edit: 'Modifica',
  retry: 'Riprova',
  loading: 'Caricamento…',
  more: 'Altro',
  continue: 'Continua',
  later: 'Più tardi',
  preview: 'Anteprima',
  on: 'Sì',
  off: 'No',
  standard: 'Predefinito',
  unknown: 'sconosciuto',
  movies: 'Film',
  series: 'Serie TV',
  duration: { hm: '{h} h {m} min', h: '{h} h', m: '{m} min', s: '{s} s' },
  rating: {
    rate: 'Valuta',
    notForMe: 'Non fa per me',
    like: 'Mi piace',
    love: 'Lo adoro',
    rated: 'Valutazione: {label} – modifica la valutazione',
    remove: '{label} (rimuovi la valutazione)',
    saveFailed: 'Impossibile salvare la valutazione.',
  },
  language: {
    label: 'Lingua',
  },
};
export default it;
