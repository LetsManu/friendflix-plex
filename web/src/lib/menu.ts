import type { TKey } from '#lib/i18n';

/** Link groups of the account menu: used by the desktop dropdown and the /me page. Labels are i18n keys (render with $t). */
export type MenuLink = [href: string, label: TKey, icon: string];

export const MENU_LINKS: MenuLink[] = [
  ['/tonight', 'shell.menu.tonight', 'star'], ['/favorites', 'shell.menu.favorites', 'heart'], ['/lists', 'shell.menu.lists', 'list'], ['/history', 'shell.menu.history', 'calendar'], ['/match', 'shell.menu.match', 'users'], ['/collections', 'shell.menu.collections', 'film'], ['/upcoming', 'shell.menu.upcoming', 'calendar'], ['/requests', 'shell.menu.requests', 'gift'], ['/party', 'shell.menu.party', 'users'], ['/vote', 'shell.menu.vote', 'vote'],
  ['/now', 'shell.menu.now', 'monitor'], ['/calendar', 'shell.menu.calendar', 'calendar'], ['/stats', 'shell.menu.stats', 'bar-chart'], ['/remote', 'shell.menu.remote', 'tv'], ['/settings', 'shell.menu.settings', 'settings'], ['/devices', 'shell.menu.devices', 'monitor'],
];
export const DOWNLOADS_LINK: MenuLink = ['/downloads', 'shell.menu.downloads', 'download'];

export const GROUPS: Array<{ title: TKey; hrefs: string[] }> = [
  { title: 'shell.menu.groups.discover', hrefs: ['/tonight', '/collections', '/upcoming', '/match', '/party', '/vote', '/now', '/calendar'] },
  { title: 'shell.menu.groups.mine', hrefs: ['/favorites', '/lists', '/history', '/downloads', '/requests', '/stats'] },
  { title: 'shell.menu.groups.account', hrefs: ['/remote', '/settings', '/devices'] },
];

/** links for a user (Downloads only when allowed, placed after "Verlauf"/the first three) */
export const linksFor = (canDownload: boolean): MenuLink[] => (canDownload ? [...MENU_LINKS.slice(0, 3), DOWNLOADS_LINK, ...MENU_LINKS.slice(3)] : MENU_LINKS);

/** every entry lands in exactly one group (unknown ones fall back to "Meine Sachen"), ordered as in GROUPS */
export function groupLinks(links: MenuLink[]): Array<{ title: TKey; items: MenuLink[] }> {
  const groups = GROUPS.map((g) => ({ title: g.title, items: [] as MenuLink[] }));
  for (const l of links) (groups.find((_, i) => GROUPS[i]!.hrefs.includes(l[0])) ?? groups[1]!).items.push(l);
  groups.forEach((g, i) => {
    const order = GROUPS[i]!.hrefs;
    const rank = (h: string) => { const x = order.indexOf(h); return x < 0 ? 99 : x; };
    g.items.sort((a, b) => rank(a[0]) - rank(b[0]));
  });
  return groups;
}

/** Small desktop footer (links in four columns; everything also lives on /me). */
export const FOOTER_COLUMNS: MenuLink[][] = [
  [['/me', 'shell.menu.me', 'user'], ['/watchlist', 'shell.menu.myList', 'plus'], ['/lists', 'shell.menu.lists', 'list'], ['/history', 'shell.menu.history', 'calendar']],
  [['/party', 'shell.menu.party', 'users'], ['/vote', 'shell.menu.vote', 'vote'], ['/match', 'shell.menu.match', 'users'], ['/tonight', 'shell.menu.tonight', 'star']],
  [['/calendar', 'shell.menu.calendar', 'calendar'], ['/upcoming', 'shell.menu.upcoming', 'calendar'], ['/requests', 'shell.menu.requests', 'gift'], ['/stats', 'shell.menu.stats', 'bar-chart']],
  [['/settings', 'shell.menu.accountSettings', 'settings'], ['/devices', 'shell.menu.devices', 'monitor'], ['/remote', 'shell.menu.remote', 'tv'], ['/collections', 'shell.menu.collections', 'film']],
];

/** Slim desktop header (Netflix-like): everything else sits in the avatar menu, the footer and on /me. */
export const HEADER_TABS: Array<[href: string, label: TKey]> = [['/', 'shell.nav.home'], ['/browse/series', 'shell.nav.series'], ['/browse/movies', 'shell.nav.movies'], ['/new', 'shell.nav.new'], ['/watchlist', 'shell.nav.myList']];

/** true when `href` is the current section (Start only on "/") */
export const isTabActive = (href: string, path: string) => (href === '/' ? path === '/' : path === href || path.startsWith(href + '/') || path.startsWith(href + '?'));
