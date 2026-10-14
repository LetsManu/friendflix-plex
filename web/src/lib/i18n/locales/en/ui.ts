// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/ui';
import type { Translation } from '../../types';

/** English – area "ui" (shared UI kit). */
const dict: Translation<typeof de> = {
  done: 'Done.',
  undo: 'Undo',
  undone: 'Undone.',
  retry: 'Try again',
  dismiss: 'Dismiss notification',
  notifications: 'Notifications',
  errorPrefix: 'Error:',
  percent: '{n}%',
  confirm: {
    ok: 'Confirm',
    cancel: 'Cancel',
    delete: 'Delete',
    typeToConfirm: 'Type “{word}” to confirm',
  },
  error: {
    generic: 'That did not work.',
    network: 'No connection to the server.',
    forbidden: 'You are not allowed to do that.',
    notFound: 'This does not exist (any more).',
    conflict: 'Not possible right now – something changed in the meantime.',
    tooMany: 'Too many attempts. Please wait a moment.',
    server: 'Server error. Please try again later.',
  },
  table: {
    filter: 'Filter table',
    filterPlaceholder: 'Search…',
    clearFilter: 'Clear filter',
    sortAsc: '(sorted ascending)',
    sortDesc: '(sorted descending)',
    empty: 'Nothing here yet.',
    noMatch: 'No results for “{q}”.',
    loading: 'Loading…',
    range: '{from}–{to} of {total}',
    pages: 'Pages',
    prev: 'Previous page',
    next: 'Next page',
    actions: 'Actions',
    actionsFor: 'Actions for {name}',
  },
  copy: {
    copy: 'Copy',
    copied: 'Copied to clipboard.',
    failed: 'Could not copy – please select the text and copy it manually.',
    qr: 'QR code',
    qrShow: 'Show QR code',
    qrHide: 'Hide QR code',
  },
};
export default dict;
