// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FOOTER_COLUMNS, HEADER_TABS, MENU_LINKS, groupLinks, isTabActive, linksFor } from './menu';

describe('menu', () => {
  it('every account link stays reachable on /me (grouped)', () => {
    const all = groupLinks(linksFor(true)).flatMap((g) => g.items.map((l) => l[0]));
    for (const [href] of MENU_LINKS) expect(all).toContain(href);
    expect(all).toContain('/downloads');
    expect(groupLinks(linksFor(false)).flatMap((g) => g.items.map((l) => l[0]))).not.toContain('/downloads');
  });
  it('footer only links to pages that exist in the account menu or header', () => {
    const known = new Set([...MENU_LINKS.map((l) => l[0]), ...HEADER_TABS.map((t) => t[0]), '/me']);
    for (const [href] of FOOTER_COLUMNS.flat()) expect(known.has(href)).toBe(true);
  });
  it('header tab activity', () => {
    expect(isTabActive('/', '/')).toBe(true);
    expect(isTabActive('/', '/new')).toBe(false);
    expect(isTabActive('/browse/series', '/browse/series')).toBe(true);
    expect(isTabActive('/new', '/newsletter')).toBe(false);
    expect(isTabActive('/watchlist', '/watchlist')).toBe(true);
  });
});
