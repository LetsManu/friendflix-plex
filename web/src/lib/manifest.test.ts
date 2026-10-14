// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { LOCALE_CODES, trIn, loadLocale } from '#lib/i18n';
import { chooseLang, manifestFor } from './manifest';
import { BRAND_NAME, BRAND_SHORT } from './brand';

describe('manifest language', () => {
  it('?lang is whitelisted to the supported codes', () => {
    expect(chooseLang('fr', 'en')).toBe('fr');
    expect(chooseLang('xx', 'pl')).toBe('pl'); // unknown code: Accept-Language decides
    expect(chooseLang('../etc', null)).toBe('de');
    expect(chooseLang('', '')).toBe('de');
  });
  it('Accept-Language: best q-weighted supported match, else German', () => {
    expect(chooseLang(null, 'ja,en-US;q=0.8,it;q=0.9')).toBe('it');
    expect(chooseLang(null, 'tr-TR,tr;q=0.9,en;q=0.5')).toBe('tr');
    expect(chooseLang(null, 'ja,zh;q=0.5')).toBe('de');
    expect(chooseLang(null, 'en;q=0,es;q=0.1')).toBe('es');
    expect(chooseLang(null, null)).toBe('de');
  });
  it.each(LOCALE_CODES)('%s: name, description and every shortcut come from the dictionary', async (l) => {
    const m = await manifestFor(l);
    await loadLocale(l);
    expect(m.lang).toBe(l);
    expect(m.name).toBe(BRAND_NAME); // fork
    expect(m.short_name).toBe(BRAND_SHORT);
    expect(m.description).toBe(trIn(l, 'mine.manifest.description'));
    expect(m.shortcuts.map((s) => s.name)).toEqual([trIn(l, 'home.rows.resume'), trIn(l, 'shell.nav.myList'), trIn(l, 'shell.mobile.search'), trIn(l, 'shell.mobile.downloads'), trIn(l, 'shell.menu.remote')]);
    expect(m.shortcuts.every((s) => s.name && s.url.startsWith('/'))).toBe(true);
    expect(m.start_url).toBe('/');
  });
  it('languages differ', async () => {
    expect((await manifestFor('en')).shortcuts[1]!.name).not.toBe((await manifestFor('de')).shortcuts[1]!.name);
  });
});
