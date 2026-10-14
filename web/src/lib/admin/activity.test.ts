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
