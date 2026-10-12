import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n';
import { auditArea, auditDetails, dayEnd, dayStart, deviceKind, humanizeKey, inviteStatus } from './people';

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
  it('inviteStatus', () => {
    const now = Date.parse('2026-10-12T12:00:00Z');
    expect(inviteStatus({ used_at: '2026-10-12T10:00:00Z', expires_at: '2026-10-10T00:00:00Z' }, now)).toBe('used');
    expect(inviteStatus({ used_at: null, expires_at: '2026-10-12T11:00:00Z' }, now)).toBe('expired');
    expect(inviteStatus({ used_at: null, expires_at: '2026-10-13T11:00:00Z' }, now)).toBe('open');
  });
});
