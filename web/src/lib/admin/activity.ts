// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Audit log entries as readable sentences ("Tester hat Anna gesperrt") for the overview and the audit page. */
import { fmtDate, hasKey, trDynamic, tr } from '#lib/i18n';

export interface AuditEntry {
  id: number | string;
  at: string;
  action: string;
  target?: string | null;
  meta?: Record<string, unknown> | null;
  /** actor name (null = system) */
  actor?: string | null;
  /** actor's user id (the audit endpoints send it): actor = target marks a person's own action */
  actor_id?: string | null;
  /** name of the user/list the target id points to (backend join) */
  target_name?: string | null;
}

const ICONS: Record<string, string> = {
  user: 'user', device: 'monitor', invite: 'mail', request: 'inbox', poll: 'vote', list: 'list', hub: 'star', role: 'key',
  profile: 'users', download: 'download', digest: 'calendar', settings: 'globe', system: 'refresh', session: 'log-out',
  tv: 'tv', party: 'users', subtitle: 'subtitles', login: 'user', leaving: 'calendar', preview: 'film', account: 'user', setup: 'check',
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
  // deletion entries: the scheduled date and the failed cleanup step (a small number only, never raw meta)
  const step = typeof meta.step === 'number' && Number.isInteger(meta.step) && meta.step >= 1 && meta.step <= 6 ? String(meta.step) : '?';
  const date = typeof meta.deletionAt === 'string' ? fmtDate(meta.deletionAt, { dateStyle: 'medium' }) : '';
  const params = { actor, target, role: roleText(meta.role ?? (isRole ? e.target : '')), to: roleText(meta.to), from: roleText(meta.from), step, date };
  const icon = ICONS[e.action.split('.')[0]!] ?? 'info';
  // a failed recovery attempt is audited under the same action with ok: false (and the error code, never Authentik's answer)
  if (e.action === 'user.recovery_email' && meta.ok === false) {
    const code = typeof meta.error === 'string' && /^[a-z_]+$/.test(meta.error) && hasKey(`admin.activity.failReason.${meta.error}`) ? meta.error : 'unknown';
    return { text: tr('admin.activity.user.recovery_email_failed', { ...params, reason: trDynamic(`admin.activity.failReason.${code}`) }), icon };
  }
  // a person deleting or restoring their own account (meta.by, or the actor is the target); a restore of ended access stays locked
  const self = meta.by === 'self' || (Boolean(e.actor_id) && e.actor_id === e.target);
  if (e.action === 'user.deletion_requested' && self) return { text: tr('admin.activity.user.deletion_requested_self', params), icon };
  if (e.action === 'user.deletion_restored') {
    const locked = meta.lockedReason === 'expired';
    const k = self ? (locked ? 'deletion_restored_self_locked' : 'deletion_restored_self') : locked ? 'deletion_restored_locked' : 'deletion_restored';
    return { text: tr(`admin.activity.user.${k}`, params), icon };
  }
  const key = activityKey(e.action);
  return { text: key ? trDynamic(key, params) : tr('admin.activity.unknown', { actor }), icon };
}
