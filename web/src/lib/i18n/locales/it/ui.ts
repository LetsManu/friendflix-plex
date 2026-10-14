// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/ui';
import type { Translation } from '../../types';

/** Italiano – area "ui" (kit di interfaccia condiviso). */
const dict: Translation<typeof de> = {
  done: 'Fatto.',
  undo: 'Annulla',
  undone: 'Annullato.',
  retry: 'Riprova',
  dismiss: 'Chiudi notifica',
  notifications: 'Notifiche',
  errorPrefix: 'Errore:',
  percent: '{n}%',
  confirm: {
    ok: 'Conferma',
    cancel: 'Annulla',
    delete: 'Elimina',
    typeToConfirm: 'Digita «{word}» per confermare',
  },
  error: {
    generic: 'Non ha funzionato.',
    network: 'Nessuna connessione al server.',
    forbidden: 'Non hai il permesso per farlo.',
    notFound: 'Non esiste (più).',
    conflict: 'Al momento non è possibile: nel frattempo qualcosa è cambiato.',
    tooMany: 'Troppi tentativi. Attendi un momento.',
    server: 'Errore del server. Riprova più tardi.',
  },
  table: {
    filter: 'Filtra tabella',
    filterPlaceholder: 'Cerca…',
    clearFilter: 'Rimuovi filtro',
    sortAsc: '(ordine crescente)',
    sortDesc: '(ordine decrescente)',
    empty: 'Nessuna voce.',
    noMatch: 'Nessun risultato per «{q}».',
    loading: 'Caricamento…',
    range: '{from}–{to} di {total}',
    pages: 'Pagine',
    prev: 'Pagina precedente',
    next: 'Pagina successiva',
    actions: 'Azioni',
    actionsFor: 'Azioni per {name}',
  },
  copy: {
    copy: 'Copia',
    copied: 'Copiato negli appunti.',
    failed: 'Impossibile copiare: seleziona il testo e copialo a mano.',
    qr: 'Codice QR',
    qrShow: 'Mostra codice QR',
    qrHide: 'Nascondi codice QR',
  },
};
export default dict;
