// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n';
import { activityKey, describeActivity } from './activity';
import { activeItem, badgeCount, groupOf } from './nav';

afterEach(async () => { await setLocale('de'); });

describe('describeActivity', () => {
  it('humanises known actions with names instead of ids', () => {
    expect(describeActivity({ id: 1, at: '', action: 'user.disable', target: 'uuid', actor: 'Tester', target_name: 'Anna' }).text).toBe('Tester hat Anna gesperrt');
    expect(describeActivity({ id: 2, at: '', action: 'user.role', target: 'uuid', actor: 'Tester', target_name: 'Ben', meta: { from: 'guest', to: 'friend' } }).text).toBe('Tester hat Ben die Rolle Freund gegeben');
    expect(describeActivity({ id: 3, at: '', action: 'request.decline', target: '17', actor: null }).text).toBe('System hat Wunsch #17 abgelehnt');
    expect(describeActivity({ id: 4, at: '', action: 'role.playback', target: 'family', actor: 'Tester' }).text).toContain('Familie');
  });
  it('describes preview clip and removal-date actions', async () => {
    expect(describeActivity({ id: 6, at: '', action: 'preview.clear', target: 'ab'.repeat(16), actor: 'Tester' })).toEqual({ text: 'Tester hat einen Vorschau-Clip gelöscht', icon: 'film' });
    expect(describeActivity({ id: 7, at: '', action: 'preview.regenerate', actor: 'Tester' }).text).toBe('Tester hat einen Vorschau-Clip neu erzeugen lassen');
    expect(describeActivity({ id: 8, at: '', action: 'leaving.set', actor: 'Tester' })).toEqual({ text: 'Tester hat ein Entfernungsdatum gesetzt', icon: 'calendar' });
    await setLocale('en');
    expect(describeActivity({ id: 6, at: '', action: 'preview.clear', actor: 'Tester' }).text).toBe('Tester deleted a preview clip');
  });
  it('one-device sign-out and failed password links say what happened', async () => {
    const base = { id: 9, at: '', target: 'uuid', actor: 'Tester', target_name: 'Anna' };
    expect(describeActivity({ ...base, action: 'user.revoke_device', meta: { deviceId: 'dev-a', sessions: 2 } })).toEqual({ text: 'Tester hat Anna auf einem Gerät abgemeldet', icon: 'user' });
    expect(describeActivity({ ...base, action: 'user.recovery_email', meta: { ok: true } }).text).toBe('Tester hat Anna einen Passwort-Link geschickt');
    expect(describeActivity({ ...base, action: 'user.recovery_email', meta: { ok: false, error: 'recovery_not_configured' } }).text)
      .toBe('Tester wollte Anna einen Passwort-Link schicken – fehlgeschlagen (kein Ablauf zum Zurücksetzen eingerichtet)');
    // unknown or odd codes never leak into the text
    expect(describeActivity({ ...base, action: 'user.recovery_email', meta: { ok: false, error: 'constructor' } }).text).toMatch(/fehlgeschlagen \(Fehler\)$/);
    await setLocale('en');
    expect(describeActivity({ ...base, action: 'user.recovery_email', meta: { ok: false, error: 'authentik_unavailable' } }).text)
      .toBe('Tester tried to send Anna a password link – failed (Authentik unreachable)');
  });
  it('re-authentication and own profile changes (Block 23 self-service)', async () => {
    const base = { id: 10, at: '', target: 'uuid', actor: 'Tester', target_name: 'Tester', meta: { ip: '10.0.0.1' } };
    expect(describeActivity({ ...base, action: 'session.reauth' })).toEqual({ text: 'Tester hat sich erneut angemeldet (für eine Kontoaktion)', icon: 'log-out' });
    expect(describeActivity({ ...base, action: 'session.reauth_mismatch' }).text).toBe('Tester: erneute Anmeldung mit einem anderen Konto abgelehnt');
    expect(describeActivity({ ...base, action: 'session.revoke_device', meta: { sessions: 1 } }).text).toBe('Tester hat ein eigenes Gerät abgemeldet');
    expect(describeActivity({ ...base, action: 'account.profile', meta: { fields: ['name'] } })).toEqual({ text: 'Tester hat Name oder Farbe des eigenen Kontos geändert', icon: 'user' });
    await setLocale('en');
    expect(describeActivity({ ...base, action: 'session.reauth_mismatch' }).text).toBe('Tester: a new sign-in with a different account was refused');
  });
  it('data export and account deletion (Block 23 self-service)', async () => {
    const base = { id: 11, at: '', target: 'uuid', actor: 'Tester', target_name: 'Anna' };
    expect(describeActivity({ ...base, actor: 'Anna', action: 'account.export' })).toEqual({ text: 'Anna hat die eigenen Daten heruntergeladen', icon: 'user' });
    expect(describeActivity({ ...base, actor: 'Anna', action: 'user.deletion_requested', meta: { deletionAt: '2026-10-21T12:00:00Z', by: 'self' } }).text)
      .toBe('Anna hat die Löschung des eigenen Kontos beantragt (am 21.10.2026)');
    expect(describeActivity({ ...base, action: 'user.deletion_requested', meta: { deletionAt: '2026-10-21T12:00:00Z', by: 'admin' } }).text)
      .toBe('Tester hat die Löschung von Anna beantragt (am 21.10.2026)');
    expect(describeActivity({ ...base, action: 'user.deletion_restored' }).text).toBe('Tester hat die Löschung von Anna aufgehoben');
    // self variants: meta.by, or the actor is the target (a restore by signing in again)
    expect(describeActivity({ ...base, actor: 'Anna', actor_id: 'uuid', action: 'user.deletion_restored' }).text).toBe('Anna hat die Löschung des eigenen Kontos aufgehoben');
    expect(describeActivity({ ...base, actor: 'Anna', action: 'user.deletion_restored', meta: { by: 'self' } }).text).toBe('Anna hat die Löschung des eigenen Kontos aufgehoben');
    expect(describeActivity({ ...base, actor: 'Anna', actor_id: 'uuid', action: 'user.deletion_requested', meta: { deletionAt: '2026-10-21T12:00:00Z' } }).text)
      .toBe('Anna hat die Löschung des eigenen Kontos beantragt (am 21.10.2026)');
    expect(describeActivity({ ...base, actor_id: 'other', action: 'user.deletion_restored' }).text).toBe('Tester hat die Löschung von Anna aufgehoben');
    // restored while the access had ended: it stays locked
    expect(describeActivity({ ...base, action: 'user.deletion_restored', meta: { lockedReason: 'expired' } }).text)
      .toBe('Tester hat die Löschung von Anna aufgehoben – bleibt gesperrt, der Zugang ist abgelaufen');
    expect(describeActivity({ ...base, actor: 'Anna', actor_id: 'uuid', action: 'user.deletion_restored', meta: { lockedReason: 'expired' } }).text)
      .toBe('Anna hat die Löschung des eigenen Kontos aufgehoben – bleibt gesperrt, der Zugang ist abgelaufen');
    expect(describeActivity({ ...base, action: 'user.deletion_now', meta: { from: 'a', to: 'b' } }).text).toBe('Tester hat Anna sofort löschen lassen');
    expect(describeActivity({ ...base, actor: null, target_name: 'deleted-1a2b3c4d', action: 'user.deletion_started', meta: { pseudonym: 'deleted-1a2b3c4d' } }).text)
      .toBe('Die Löschung von deleted-1a2b3c4d hat begonnen');
    expect(describeActivity({ ...base, actor: null, target_name: 'deleted-1a2b3c4d', action: 'user.deletion_failed', meta: { step: 3, error: 'media_error' } }).text)
      .toBe('Die Löschung von deleted-1a2b3c4d ist bei Schritt 3 von 6 fehlgeschlagen');
    expect(describeActivity({ ...base, actor: null, target_name: 'deleted-1a2b3c4d', action: 'user.deleted' }).text).toBe('deleted-1a2b3c4d wurde gelöscht');
    // a step that is not a small number never reaches the text
    expect(describeActivity({ ...base, actor: null, action: 'user.deletion_failed', meta: { step: '<b>' } }).text).not.toContain('<b>');
    await setLocale('en');
    expect(describeActivity({ ...base, action: 'user.deletion_now' }).text).toBe('Tester had Anna deleted right away');
    expect(describeActivity({ ...base, actor: 'Anna', actor_id: 'uuid', action: 'user.deletion_restored' }).text).toBe('Anna cancelled the deletion of their own account');
    expect(describeActivity({ ...base, action: 'user.deletion_restored', meta: { lockedReason: 'expired' } }).text)
      .toBe('Tester cancelled the deletion of Anna – stays locked, the access has ended');
    expect(describeActivity({ ...base, actor: 'Anna', action: 'user.deletion_requested', meta: { deletionAt: '2026-10-21T12:00:00Z', by: 'self' } }).text)
      .toBe('Anna asked to delete their own account (on 21 Oct 2026)');
  });
  it('never shows raw keys or JSON for unknown actions', async () => {
    const d = describeActivity({ id: 5, at: '', action: 'weird.thing', actor: 'Tester', meta: { a: 1 } });
    expect(d.text).not.toContain('weird');
    expect(d.text).not.toContain('{');
    expect(activityKey('constructor')).toBeNull();
    await setLocale('en');
    expect(describeActivity({ id: 1, at: '', action: 'user.enable', actor: 'Tester', target_name: 'Anna' }).text).toBe('Tester unlocked Anna');
  });
});

describe('admin nav', () => {
  it('finds the active item and its group', () => {
    expect(activeItem('/admin')?.href).toBe('/admin');
    expect(activeItem('/admin/')?.href).toBe('/admin');
    expect(activeItem('/admin/users')?.label).toBe('admin.tabs.users');
    expect(activeItem('/admin/users/x')?.href).toBe('/admin/users');
    expect(groupOf(activeItem('/admin/hubs'))?.id).toBe('content');
    expect(activeItem('/adminx')).toBeNull();
    expect(activeItem('/admin/hygiene')?.label).toBe('admin.tabs.hygiene');
    expect(groupOf(activeItem('/admin/hygiene'))?.id).toBe('content');
    expect(activeItem('/admin/usage')?.label).toBe('admin.tabs.usage');
    expect(groupOf(activeItem('/admin/usage'))?.id).toBe('people');
  });
  it('badge counts ignore zero and unknown', () => {
    const s = { pending: { requests: null, devices: 2, polls: 0, invites: 1, previewsFailed: 3 } } as never;
    expect(badgeCount(s, 'devices')).toBe(2);
    expect(badgeCount(s, 'requests')).toBe(0);
    expect(badgeCount(s, 'previews')).toBe(3);
    expect(badgeCount(null, 'devices')).toBe(0);
  });
});
