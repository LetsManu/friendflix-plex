// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale, tr } from './index';
import de from './locales/de/index';
import en from './locales/en/index';

afterEach(async () => { await setLocale('de'); });

/** every dotted key of a nested dictionary (plural objects count as one key) */
function keys(o: object, p = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' || (v && typeof v === 'object' && 'other' in v) ? [p + k] : keys(v as object, `${p}${k}.`)));
}

describe('areas social + admin', () => {
  it('English covers every key', () => {
    for (const area of ['social', 'admin'] as const) expect(keys(en[area] ?? {}), area).toEqual(keys(de[area]));
  });
  it('plurals and placeholders', async () => {
    expect(tr('social.lists.memberCount', { n: 1 })).toBe('1 Person');
    expect(tr('social.lists.memberCount', { n: 3 })).toBe('3 Personen');
    expect(tr('admin.users.sessionsEnded', { n: 2 })).toBe('2 Sitzungen beendet.');
    expect(tr('social.digest.moreMovies', { n: 1 })).toBe('… und 1 weiterer neuer Film.');
    await setLocale('en');
    expect(tr('social.lists.hidden', { n: 1 })).toBe('1 title is not visible to this profile.');
    expect(tr('social.match.notShared', { names: 'Anna and Ben', n: 2 })).toBe('Anna and Ben have not allowed matching yet (Settings → “Group matcher”).');
    expect(tr('admin.update.unreachable', { detail: ' (ENOTFOUND)' })).toBe('Portainer not reachable (ENOTFOUND). Details in the backend log.');
  });
});
