// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '#lib/api';
import { setLocale } from '#lib/i18n';
import { akError, detailTab, limitsForm, limitsPatch, lockAction, mfaChips, roleHint, statusPills, type Limits } from './detail';

afterEach(async () => { await setLocale('de'); });

const saved: Limits = { maxStreams: 2, remoteBitrate: 8_000_000, maxDownloads: null, downloadMaxHeight: null, requestsPerMonth: null };

describe('limits form', () => {
  it('shows overrides in form units (bitrate in Mbit/s) and empty for "as role"', () => {
    expect(limitsForm(saved)).toEqual({ maxStreams: '2', remoteBitrate: '8', maxDownloads: '', downloadMaxHeight: '', requestsPerMonth: '' });
  });

  it('sends only the changed fields; empty goes back to the role (null)', () => {
    expect(limitsPatch(saved, limitsForm(saved))).toEqual({});
    expect(limitsPatch(saved, { ...limitsForm(saved), maxStreams: '3', requestsPerMonth: '5' })).toEqual({ maxStreams: 3, requestsPerMonth: 5 });
    expect(limitsPatch(saved, { ...limitsForm(saved), maxStreams: '', remoteBitrate: '12.5' })).toEqual({ maxStreams: null, remoteBitrate: 12_500_000 });
    expect(limitsPatch(saved, { ...limitsForm(saved), maxStreams: ' 2 ' })).toEqual({});
  });

  it('rejects values outside the API bounds (null = invalid form)', () => {
    expect(limitsPatch(saved, { ...limitsForm(saved), maxStreams: '0' })).toBeNull();
    expect(limitsPatch(saved, { ...limitsForm(saved), maxStreams: '1.5' })).toBeNull();
    expect(limitsPatch(saved, { ...limitsForm(saved), remoteBitrate: '0.1' })).toBeNull();
    expect(limitsPatch(saved, { ...limitsForm(saved), requestsPerMonth: '101' })).toBeNull();
    expect(limitsPatch(saved, { ...limitsForm(saved), downloadMaxHeight: 'abc' })).toBeNull();
  });

  it('role value as placeholder text', () => {
    expect(roleHint('maxStreams', 2)).toBe('wie Rolle: 2');
    expect(roleHint('remoteBitrate', 4_000_000)).toBe('wie Rolle: 4');
    expect(roleHint('requestsPerMonth', null)).toBe('wie Rolle: unbegrenzt');
    expect(roleHint('downloadMaxHeight', 0)).toBe('wie Rolle: keine Downloads');
    expect(roleHint('downloadMaxHeight', 1080)).toBe('wie Rolle: 1080');
  });
});

describe('akError', () => {
  const err = (status: number, error: string) => new ApiError(status, { error });
  it('maps the Authentik codes to clear texts', () => {
    expect(akError(err(409, 'recovery_not_configured'))).toMatch(/kein Ablauf/);
    expect(akError(err(404, 'authentik_user_not_found'))).toMatch(/keinen Nutzer/);
    expect(akError(err(501, 'not_supported'))).toMatch(/keine Schnittstelle/);
    expect(akError(err(503, 'authentik_unavailable'))).toMatch(/nicht erreichbar/);
    expect(akError(err(500, 'x'))).toBe('Serverfehler. Bitte später noch einmal versuchen.');
  });
});

describe('header', () => {
  const base = { disabled: false, lockedReason: null, accessUntil: null };
  it('status: active, locked with reason, access end', () => {
    expect(statusPills(base)).toEqual([{ tone: 'ok', label: 'Aktiv' }]);
    expect(statusPills({ ...base, disabled: true, lockedReason: 'expired' })[0]).toEqual({ tone: 'err', label: 'Gesperrt: Zugang abgelaufen', icon: 'lock' });
    expect(statusPills({ ...base, disabled: true, lockedReason: 'manual' })[0]!.label).toBe('Gesperrt: von Hand');
    expect(statusPills({ ...base, disabled: true, lockedReason: null })[0]!.label).toBe('Gesperrt');
    const now = Date.parse('2026-10-14T12:00:00Z');
    const soon = statusPills({ ...base, accessUntil: '2026-10-16T12:00:00Z' }, now);
    expect(soon[1]!.tone).toBe('warn');
    expect(soon[1]!.label).toMatch(/^Zugang bis /);
    expect(statusPills({ ...base, accessUntil: '2027-01-01T00:00:00Z' }, now)[1]!.tone).toBe('info');
  });

  it('status: a scheduled deletion shows its date (F17)', async () => {
    const del = { ...base, disabled: true, lockedReason: 'deletion', deletionAt: '2026-10-21T12:00:00Z' };
    expect(statusPills(del)[0]).toEqual({ tone: 'err', label: 'Löschung am 21.10.2026', icon: 'lock' });
    expect(statusPills({ ...del, deletionAt: null })[0]!.label).toBe('Gesperrt: wird gelöscht');
    await setLocale('en');
    expect(statusPills(del)[0]!.label).toBe('Deletion on 21 Oct 2026');
  });

  it('lock action: lock, unlock, or extend access when the access has ended (an unlock would not last)', () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    expect(lockAction(base, now)).toBe('lock');
    expect(lockAction({ ...base, disabled: true, lockedReason: 'manual' }, now)).toBe('unlock');
    expect(lockAction({ ...base, disabled: true, lockedReason: 'manual', accessUntil: '2026-10-20T00:00:00Z' }, now)).toBe('unlock');
    expect(lockAction({ ...base, disabled: true, lockedReason: 'expired', accessUntil: '2026-10-13T00:00:00Z' }, now)).toBe('extend');
    expect(lockAction({ ...base, disabled: true, lockedReason: 'manual', accessUntil: '2026-10-13T00:00:00Z' }, now)).toBe('extend');
    expect(lockAction({ ...base, disabled: true, lockedReason: 'expired' }, now)).toBe('extend');
  });

  it('lock action: a deletion lock is restored (also when the access has ended: the backend keeps it locked as expired)', () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    expect(lockAction({ ...base, disabled: true, lockedReason: 'deletion' }, now)).toBe('restore');
    expect(lockAction({ ...base, disabled: true, lockedReason: 'deletion', accessUntil: '2026-10-13T00:00:00Z' }, now)).toBe('restore');
  });

  it('2FA chips from the Authentik state (null = unknown)', () => {
    expect(mfaChips(null)).toEqual([{ tone: 'muted', label: '2FA unbekannt' }]);
    expect(mfaChips({ totp: false, webauthn: false, static: false })).toEqual([{ tone: 'warn', label: 'Keine Zwei-Faktor-Anmeldung' }]);
    expect(mfaChips({ totp: true, webauthn: true, static: false }).map((c) => c.label)).toEqual(['Authenticator-App', 'Passkey / Sicherheitsschlüssel']);
  });

  it('tab from the URL, overview by default', () => {
    expect(detailTab('limits')).toBe('limits');
    expect(detailTab('nope')).toBe('overview');
    expect(detailTab(null)).toBe('overview');
  });
});
