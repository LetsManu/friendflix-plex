// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n';
import { ApiError } from '#lib/api';
import { accessPreset, accountGuardText, auditArea, deletionErrorText, restoredText, auditDetails, bulkSummary, dayEnd, dayStart, deviceKind, futureDayEnd, humanizeKey, inviteStatus, today } from './people';

afterEach(async () => { await setLocale('de'); });

describe('deviceKind', () => {
  it('recognises TVs, phones and desktops from the label', () => {
    expect(deviceKind('LG webOS TV')).toEqual({ kind: 'tv', icon: 'tv' });
    expect(deviceKind('Safari auf iPhone').kind).toBe('phone');
    expect(deviceKind('Chrome auf Windows').kind).toBe('desktop');
    expect(deviceKind('Safari auf iPad').kind).toBe('tablet');
    expect(deviceKind(null).kind).toBe('other');
  });
});

describe('auditDetails', () => {
  it('translates keys and values, hides ids and empty values, never prints JSON', () => {
    const rows = auditDetails({ from: 'guest', to: 'friend', transcoding: true, maxHeight: 1080, userId: '00000000-0000-4000-a000-000000000002', note: '', gone: null, authentik: 'failed' });
    expect(rows).toEqual([
      { label: 'Vorher', value: 'Gast' }, { label: 'Nachher', value: 'Freund' }, { label: 'Umwandeln erlaubt', value: 'Ja' },
      { label: 'Max. Auflösung', value: '1080p' }, { label: 'Authentik', value: 'Fehlgeschlagen' },
    ]);
    expect(rows.every((r) => !/[{}"]/.test(r.value))).toBe(true);
  });
  it('unlimited height, unknown keys get a readable label, lists and objects are flattened', async () => {
    expect(auditDetails({ maxHeight: null })).toEqual([{ label: 'Max. Auflösung', value: 'Unbegrenzt' }]);
    expect(auditDetails({ some_new_key: 'x', libs: ['a', 'b'], nested: { download: false } })).toEqual([
      { label: 'Some new key', value: 'x' }, { label: 'Libs', value: 'a und b' }, { label: 'Nested', value: 'Downloads erlaubt: Nein' },
    ]);
    expect(auditDetails(null)).toEqual([]);
    await setLocale('en');
    expect(auditDetails({ requestsPerMonth: 3, download: true })).toEqual([{ label: 'Requests per month', value: '3' }, { label: 'Downloads allowed', value: 'Yes' }]);
  });
  it('humanizeKey', () => { expect(humanizeKey('maxDownloadsPerDay')).toBe('Max downloads per day'); });
});

describe('helpers', () => {
  it('auditArea only for known areas', () => {
    expect(auditArea('user.role')).toEqual({ id: 'user', label: 'Nutzer' });
    expect(auditArea('zzz.x')).toBeNull();
  });
  it('day bounds are ISO times of the local day; invalid input gives an empty string', () => {
    expect(new Date(dayStart('2026-10-12')).getTime()).toBe(new Date('2026-10-12T00:00:00').getTime());
    expect(new Date(dayEnd('2026-10-12')).getTime()).toBe(new Date('2026-10-12T23:59:59.999').getTime());
    expect(dayStart('')).toBe('');
    expect(dayEnd('12.10.2026')).toBe('');
  });
  it('inviteStatus counts uses: partly used stays open, all uses taken is used (a revoked invite is closed that way)', () => {
    const now = Date.parse('2026-10-12T12:00:00Z');
    expect(inviteStatus({ uses: 1, max_uses: 1, expires_at: '2026-10-10T00:00:00Z' }, now)).toBe('used');
    expect(inviteStatus({ uses: 1, max_uses: 3, expires_at: '2026-10-13T11:00:00Z' }, now)).toBe('open');
    expect(inviteStatus({ uses: 2, max_uses: 2, expires_at: '2026-10-13T11:00:00Z' }, now)).toBe('used');
    expect(inviteStatus({ uses: 0, max_uses: 1, expires_at: '2026-10-12T11:00:00Z' }, now)).toBe('expired');
    expect(inviteStatus({ uses: 1, max_uses: 3, expires_at: '2026-10-12T11:00:00Z' }, now)).toBe('expired');
    expect(inviteStatus({ uses: 0, max_uses: 1, expires_at: '2026-10-13T11:00:00Z' }, now)).toBe('open');
  });
});

describe('bulk helpers', () => {
  it('bulkSummary lists the first names and counts the rest', () => {
    expect(bulkSummary(['A', 'B', 'C', 'D', 'E'], 3)).toBe('A, B, C +2');
    expect(bulkSummary(['A', 'B'])).toBe('A, B');
    const twelve = Array.from({ length: 12 }, (_, i) => `N${i + 1}`);
    expect(bulkSummary(twelve)).toBe('N1, N2, N3, N4, N5, N6, N7, N8, N9, N10 +2');
    expect(bulkSummary([])).toBe('');
  });
  it('accessPreset: +30 / +90 days from now as ISO date-time, unlimited is null', () => {
    const now = Date.parse('2026-10-14T09:30:00Z');
    expect(accessPreset('+30', now)).toBe('2026-11-13T09:30:00.000Z');
    expect(accessPreset('+90', now)).toBe('2027-01-12T09:30:00.000Z');
    expect(accessPreset('unlimited', now)).toBeNull();
  });
});

describe('access-until dates', () => {
  it('today: the local calendar day as YYYY-MM-DD', () => {
    expect(today(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });
  it('futureDayEnd: the end of the day only when it lies in the future (a past one would lock at the next expiry tick)', () => {
    const now = new Date('2026-10-14T12:00:00').getTime();
    expect(futureDayEnd('2026-10-14', now)).toBe(dayEnd('2026-10-14')); // today ends tonight
    expect(futureDayEnd('2026-10-20', now)).toBe(dayEnd('2026-10-20'));
    expect(futureDayEnd('2026-10-13', now)).toBe('');
    expect(futureDayEnd('', now)).toBe('');
  });
});

describe('accountGuardText', () => {
  const err = (status: number, error: string) => new ApiError(status, { error });
  it('explains the account guards; null for anything else', async () => {
    await setLocale('en');
    expect(accountGuardText(err(409, 'access_expired'))).toBe('Access has ended – extend access instead.');
    expect(accountGuardText(err(400, 'last_admin'))).toBe('Not possible: there would be no active admin left.');
    expect(accountGuardText(err(400, 'cannot_lock_yourself_out'))).toBe('You cannot lock or demote yourself.');
    expect(accountGuardText(err(500, 'internal'))).toBeNull();
    expect(accountGuardText(new Error('x'))).toBeNull();
  });
});

describe('scheduled deletion texts', () => {
  const err = (status: number, error: string) => new ApiError(status, { error });
  it('restore / delete now errors, and the restore toast with ended access (F8)', async () => {
    await setLocale('en');
    expect(deletionErrorText(err(409, 'deletion_in_progress'))).toBe('The deletion is already running – it can no longer be stopped.');
    expect(deletionErrorText(err(409, 'not_scheduled'))).toBe('No deletion is scheduled for this account.');
    expect(deletionErrorText(err(400, 'last_admin'))).toBe('Not possible: there would be no active admin left.');
    expect(deletionErrorText(err(500, 'x'))).toBe('Server error. Please try again later.');
    const now = Date.parse('2026-10-14T12:00:00Z');
    expect(restoredText('Anna', null, now)).toBe('Anna restored.');
    expect(restoredText('Anna', '2026-10-20T00:00:00Z', now)).toBe('Anna restored.');
    expect(restoredText('Anna', '2026-10-13T00:00:00Z', now)).toBe('Anna restored – stays locked because the access has ended.');
  });
});
