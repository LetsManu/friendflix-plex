// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Audit log entries as readable sentences ("Tester hat Anna gesperrt") for the overview and the audit page. */
import { hasKey, trDynamic, tr } from '#lib/i18n';

export interface AuditEntry {
  id: number | string;
  at: string;
  action: string;
  target?: string | null;
  meta?: Record<string, unknown> | null;
  /** actor name (null = system) */
  actor?: string | null;
  /** name of the user/list the target id points to (backend join) */
  target_name?: string | null;
}

const ICONS: Record<string, string> = {
  user: 'user', device: 'monitor', invite: 'mail', request: 'inbox', poll: 'vote', list: 'list', hub: 'star', role: 'key',
  profile: 'users', download: 'download', digest: 'calendar', settings: 'globe', system: 'refresh', session: 'log-out',
  tv: 'tv', party: 'users', subtitle: 'subtitles', login: 'user', leaving: 'calendar', preview: 'film',
};

const roleText = (k: unknown): string => {
  const s = typeof k === 'string' ? k : '';
  return s && hasKey(`admin.roleNames.${s}`) ? trDynamic(`admin.roleNames.${s}`) : s;
};

/** i18n key of an action ('user.role' → 'admin.activity.user.role'); null when unknown */
export function activityKey(action: string): string | null {
  if (!/^[a-z_]+(\.[a-z_]+)?$/.test(action)) return null;
  const k = `admin.activity.${action}`;
  return hasKey(k) ? k : null;
}

export function describeActivity(e: AuditEntry): { text: string; icon: string } {
  const meta = e.meta ?? {};
  const actor = e.actor || tr('admin.audit.system');
  const isRole = e.action.startsWith('role.');
  const target = isRole ? roleText(e.target) : e.target_name || (e.action.startsWith('request.') && e.target ? `#${e.target}` : tr('admin.activity.someone'));
  const params = { actor, target, role: roleText(meta.role ?? (isRole ? e.target : '')), to: roleText(meta.to), from: roleText(meta.from) };
  const key = activityKey(e.action);
  const icon = ICONS[e.action.split('.')[0]!] ?? 'info';
  return { text: key ? trDynamic(key, params) : tr('admin.activity.unknown', { actor }), icon };
}
