// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { BRAND_NAME, BRAND_SHORT } from './brand';
import { LOCALES, setLocale, tr } from './i18n';

afterEach(async () => { await setLocale('de'); });

describe('fork branding', () => {
  it('product name constants', () => {
    expect(BRAND_NAME).toBe('FriendFlix for Plex');
    expect(BRAND_SHORT).toBe('FriendFlix');
  });

  it('every locale renders app name and page titles with the product name', async () => {
    for (const { code: l } of LOCALES) {
      await setLocale(l);
      expect(tr('common.appName'), l).toBe(BRAND_NAME);
      expect(tr('common.pageTitle', { page: 'X' }), l).toBe(`X – ${BRAND_NAME}`);
      expect(tr('shell.footer.tagline'), l).toContain(BRAND_NAME);
    }
  });
});
