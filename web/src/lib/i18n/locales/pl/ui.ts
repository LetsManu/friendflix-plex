// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/ui';
import type { Translation } from '../../types';

/** Polski – obszar „ui” (wspólny zestaw interfejsu). */
const dict: Translation<typeof de> = {
  done: 'Gotowe.',
  undo: 'Cofnij',
  undone: 'Cofnięto.',
  retry: 'Spróbuj ponownie',
  dismiss: 'Zamknij powiadomienie',
  notifications: 'Powiadomienia',
  errorPrefix: 'Błąd:',
  percent: '{n}%',
  confirm: {
    ok: 'Potwierdź',
    cancel: 'Anuluj',
    delete: 'Usuń',
    typeToConfirm: 'Wpisz „{word}”, aby potwierdzić',
  },
  error: {
    generic: 'To się nie udało.',
    network: 'Brak połączenia z serwerem.',
    forbidden: 'Nie masz do tego uprawnień.',
    notFound: 'To nie istnieje (już).',
    conflict: 'Teraz to niemożliwe – w międzyczasie coś się zmieniło.',
    tooMany: 'Zbyt wiele prób. Poczekaj chwilę.',
    server: 'Błąd serwera. Spróbuj ponownie później.',
  },
  table: {
    filter: 'Filtruj tabelę',
    filterPlaceholder: 'Szukaj…',
    clearFilter: 'Wyczyść filtr',
    sortAsc: '(sortowanie rosnąco)',
    sortDesc: '(sortowanie malejąco)',
    empty: 'Brak wpisów.',
    noMatch: 'Brak wyników dla „{q}”.',
    loading: 'Ładowanie…',
    range: '{from}–{to} z {total}',
    pages: 'Strony',
    prev: 'Poprzednia strona',
    next: 'Następna strona',
    actions: 'Akcje',
    actionsFor: 'Akcje dla: {name}',
  },
  copy: {
    copy: 'Kopiuj',
    copied: 'Skopiowano do schowka.',
    failed: 'Nie można skopiować – zaznacz tekst i skopiuj go ręcznie.',
    qr: 'Kod QR',
    qrShow: 'Pokaż kod QR',
    qrHide: 'Ukryj kod QR',
  },
};
export default dict;
