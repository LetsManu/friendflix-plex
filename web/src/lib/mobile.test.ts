// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { categoryHref, dateBlock, genreLine, itemPath, kindFromPath, playPath, releaseLabel, runtimeLabel, shareData, showsChips, sortUpcoming } from './mobile';
import { DOWNLOADS_LINK, groupLinks, linksFor, MENU_LINKS } from './menu';

describe('mobile helpers', () => {
  it('genreLine joins max 3', () => {
    expect(genreLine(['Spannend', 'Krimi', 'Drama', 'Mehr'])).toBe('Spannend • Krimi • Drama');
    expect(genreLine(undefined)).toBe('');
  });
  it('runtimeLabel', () => {
    expect(runtimeLabel({ type: 'Movie', runtimeTicks: 112 * 600_000_000 })).toBe('1 Std. 52 Min.');
    expect(runtimeLabel({ type: 'Movie', runtimeTicks: 120 * 600_000_000 })).toBe('2 Std.');
    expect(runtimeLabel({ type: 'Movie', runtimeTicks: 45 * 600_000_000 })).toBe('45 Min.');
    expect(runtimeLabel({ type: 'Movie' })).toBe('');
    expect(runtimeLabel({ type: 'Series', childCount: 3 })).toBe('3 Staffeln');
    expect(runtimeLabel({ type: 'Series', childCount: 1 })).toBe('1 Staffel');
    expect(runtimeLabel({ type: 'Series' })).toBe('Serie');
  });
  it('share + paths', () => {
    expect(itemPath({ id: 'e1', type: 'Episode', seriesId: 's1' })).toBe('/item/s1');
    expect(itemPath({ id: 'm1', type: 'Movie' })).toBe('/item/m1');
    expect(shareData({ id: 'm1', name: 'Dunmoor', type: 'Movie' }, 'https://x.test')).toEqual({ title: 'Dunmoor', text: 'Dunmoor auf FriendFlix', url: 'https://x.test/item/m1' });
    expect(playPath({ id: 's', type: 'Series' })).toBe('/item/s');
    expect(playPath({ id: 'm', type: 'Movie' })).toBe('/watch/m');
  });
  it('kind / categories / chips', () => {
    expect(kindFromPath('/browse/series')).toBe('series');
    expect(kindFromPath('/')).toBe('movies');
    expect(categoryHref('series', 'Sci-Fi & Fantasy')).toBe('/browse/series?genre=Sci-Fi%20%26%20Fantasy');
    expect(showsChips('/')).toBe(true);
    expect(showsChips('/browse/movies')).toBe(true);
    expect(showsChips('/new')).toBe(false);
  });
  it('upcoming dates', () => {
    expect(dateBlock('2026-10-12T00:00:00Z')).toEqual({ month: 'OKT', day: '12' });
    expect(dateBlock(undefined)).toBeNull();
    expect(dateBlock('nope')).toBeNull();
    expect(releaseLabel('2026-03-05T00:00:00Z')).toBe('Erscheint am 5. März 2026');
    expect(releaseLabel(undefined)).toBe('Termin offen');
    expect(sortUpcoming([{ releaseDate: undefined }, { releaseDate: '2026-12-01' }, { releaseDate: '2026-11-01' }]).map((x) => x.releaseDate)).toEqual(['2026-11-01', '2026-12-01', undefined]);
  });
});

describe('menu groups', () => {
  it('puts every link into exactly one group', () => {
    const g = groupLinks(linksFor(true));
    expect(g.flatMap((x) => x.items).length).toBe(MENU_LINKS.length + 1);
    expect(g.find((x) => x.title === 'shell.menu.groups.mine')!.items.map((i) => i[0])).toContain('/downloads');
  });
  it('omits downloads when not allowed and falls back for unknown links', () => {
    expect(linksFor(false)).not.toContainEqual(DOWNLOADS_LINK);
    const g = groupLinks([['/zzz', 'shell.menu.tonight', 'star'], ['/settings', 'shell.menu.settings', 'settings']]);
    expect(g[1]!.items[0]![0]).toBe('/zzz');
    expect(g[2]!.items[0]![0]).toBe('/settings');
  });
});
