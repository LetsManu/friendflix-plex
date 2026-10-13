/** Admin navigation model (AdminShell sidebar, phone list, titles, badges). */
import type { TKey } from '#lib/i18n';
import type { AdminSummary } from './summary';

export type BadgeKey = 'requests' | 'devices' | 'polls' | 'previews';
export interface NavItem { href: string; label: TKey; icon: string; badge?: BadgeKey }
export interface NavGroup { id: 'people' | 'content' | 'operations'; label: TKey; items: NavItem[] }

export const OVERVIEW: NavItem = { href: '/admin', label: 'admin.nav.overview', icon: 'grid' };
export const GROUPS: NavGroup[] = [
  { id: 'people', label: 'admin.nav.groups.people', items: [
    { href: '/admin/users', label: 'admin.tabs.users', icon: 'users' },
    { href: '/admin/roles', label: 'admin.tabs.roles', icon: 'key' },
    { href: '/admin/devices', label: 'admin.tabs.devices', icon: 'monitor', badge: 'devices' },
    { href: '/admin/invites', label: 'admin.tabs.invites', icon: 'mail' },
  ] },
  { id: 'content', label: 'admin.nav.groups.content', items: [
    { href: '/admin/requests', label: 'admin.tabs.requests', icon: 'inbox', badge: 'requests' },
    { href: '/admin/polls', label: 'admin.tabs.polls', icon: 'vote', badge: 'polls' },
    { href: '/admin/lists', label: 'admin.tabs.lists', icon: 'list' },
    { href: '/admin/hubs', label: 'hubs.admin.tab', icon: 'star' },
    { href: '/admin/leaving', label: 'fresh.admin.tab', icon: 'calendar' },
    { href: '/admin/previews', label: 'admin.tabs.previews', icon: 'film', badge: 'previews' },
  ] },
  { id: 'operations', label: 'admin.nav.groups.operations', items: [
    { href: '/admin/playback', label: 'admin.tabs.playback', icon: 'play' },
    { href: '/admin/digest', label: 'admin.tabs.digest', icon: 'calendar' },
    { href: '/admin/sources', label: 'admin.tabs.sources', icon: 'link' },
    { href: '/admin/status', label: 'admin.tabs.status', icon: 'activity' },
    { href: '/admin/audit', label: 'admin.tabs.audit', icon: 'shield' },
    { href: '/admin/update', label: 'admin.tabs.update', icon: 'refresh' },
  ] },
];
export const ALL_ITEMS: NavItem[] = [OVERVIEW, ...GROUPS.flatMap((g) => g.items)];

const clean = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);
/** nav item of a path (sub-paths like /admin/users/x belong to /admin/users); null outside /admin */
export function activeItem(path: string): NavItem | null {
  const p = clean(path);
  if (p === '/admin') return OVERVIEW;
  return GROUPS.flatMap((g) => g.items).find((i) => p === i.href || p.startsWith(i.href + '/')) ?? null;
}
export function groupOf(item: NavItem | null): NavGroup | null {
  return item ? GROUPS.find((g) => g.items.includes(item)) ?? null : null;
}
/** badge number for a nav item (0 = no badge; null summary = no badge yet) */
export function badgeCount(s: AdminSummary | null, key: BadgeKey | undefined): number {
  if (!s || !key) return 0;
  const v = key === 'previews' ? s.pending.previewsFailed : s.pending[key];
  return typeof v === 'number' && v > 0 ? v : 0;
}
/** failures (red) vs. waiting for a decision (amber) */
export const badgeTone = (key: BadgeKey): 'err' | 'warn' => (key === 'previews' ? 'err' : 'warn');
