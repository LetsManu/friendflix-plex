import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n';
import { roleName } from './roles';

afterEach(async () => { await setLocale('de'); });

describe('roleName (admin pages)', () => {
  it('translates only labels that are the built-in default; ROLES_JSON renames stay as configured', async () => {
    await setLocale('en');
    expect(roleName('guest', { label: 'Gast', builtinLabel: true })).toBe('Guest');
    expect(roleName('guest', { label: 'Besucher', builtinLabel: false })).toBe('Besucher');
    expect(roleName('vip', { label: 'VIP', builtinLabel: false })).toBe('VIP');
    expect(roleName('vip', { label: 'VIP', builtinLabel: true })).toBe('VIP'); // no translation for the key
    expect(roleName('friend', { label: 'Kumpel' })).toBe('Kumpel'); // flag missing: as configured
    expect(roleName('friend', undefined)).toBe('friend');
  });
});
