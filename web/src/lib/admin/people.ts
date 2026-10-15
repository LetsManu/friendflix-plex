// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Helpers of the People admin pages (users, roles, devices, invites, audit): device kinds, audit details, date filters, bulk texts. */
import { ApiError } from '#lib/api';
import { fmtList, fmtNumber, hasKey, tr, trDynamic } from '#lib/i18n';
import { errorText } from '#lib/ui/action';

export type DeviceKind = 'tv' | 'phone' | 'tablet' | 'desktop' | 'other';
/** icon + kind of a device from its label ("Chrome auf Windows", "LG webOS TV" …) */
export function deviceKind(label: string | null | undefined): { kind: DeviceKind; icon: string } {
  const s = (label ?? '').toLowerCase();
  if (/\btv\b|webos|tizen|android ?tv|fire ?tv|roku|apple ?tv|chromecast|bravia|vidaa|console|playstation|xbox/.test(s)) return { kind: 'tv', icon: 'tv' };
  if (/ipad|tablet/.test(s)) return { kind: 'tablet', icon: 'monitor' };
  if (/iphone|android|phone|mobile/.test(s)) return { kind: 'phone', icon: 'monitor' };
  if (/windows|mac|linux|chrome|firefox|safari|edge|browser/.test(s)) return { kind: 'desktop', icon: 'monitor' };
  return { kind: 'other', icon: 'monitor' };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEIGHT_KEYS = new Set(['maxHeight', 'downloadMaxHeight']);

/** "someSnake_key" → "Some snake key" (fallback label of an audit detail without a translation) */
export function humanizeKey(k: string): string {
  const s = k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function valueText(key: string, v: unknown): string | null {
  if (v === null || v === undefined || v === '') return HEIGHT_KEYS.has(key) && v === null ? tr('adminPeople.audit.values.unlimited') : null;
  if (typeof v === 'boolean') return tr(v ? 'adminPeople.audit.values.yes' : 'adminPeople.audit.values.no');
  if (typeof v === 'number') return HEIGHT_KEYS.has(key) ? (v ? `${v}p` : tr('adminPeople.audit.values.unlimited')) : fmtNumber(v);
  if (typeof v === 'string') {
    if (UUID.test(v)) return null; // never show raw ids
    const role = `admin.roleNames.${v}`;
    if (hasKey(role)) return trDynamic(role);
    const val = `adminPeople.audit.values.${v}`;
    return hasKey(val) ? trDynamic(val) : v;
  }
  if (Array.isArray(v)) { const parts = v.map((x) => valueText(key, x)).filter((x): x is string => x !== null); return parts.length ? fmtList(parts) : null; }
  if (typeof v === 'object') {
    const parts = Object.entries(v as Record<string, unknown>).map(([k, x]) => { const t = valueText(k, x); return t === null ? null : `${detailLabel(k)}: ${t}`; }).filter((x): x is string => x !== null);
    return parts.length ? parts.join(', ') : null;
  }
  return String(v);
}
export const detailLabel = (k: string): string => (hasKey(`adminPeople.audit.keys.${k}`) ? trDynamic(`adminPeople.audit.keys.${k}`) : humanizeKey(k));

/** the `meta` of an audit entry as label/value pairs (translated, no JSON, no ids; empty values are left out) */
export function auditDetails(meta: Record<string, unknown> | null | undefined): Array<{ label: string; value: string }> {
  if (!meta || typeof meta !== 'object') return [];
  const out: Array<{ label: string; value: string }> = [];
  for (const [k, v] of Object.entries(meta)) {
    const value = valueText(k, v);
    if (value !== null) out.push({ label: detailLabel(k), value });
  }
  return out;
}

/** audit area of an action ("user.role" → "user") when it has a label */
export function auditArea(action: string): { id: string; label: string } | null {
  const id = action.split('.')[0] ?? '';
  const key = `adminPeople.audit.areas.${id}`;
  return id && hasKey(key) ? { id, label: trDynamic(key) } : null;
}

/** start / end of a local calendar day (`YYYY-MM-DD` from <input type=date>) as ISO time for the audit filter; '' when invalid */
export function dayStart(day: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T00:00:00`) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : '';
}
export function dayEnd(day: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T23:59:59.999`) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : '';
}

/** today as YYYY-MM-DD (local): the earliest access end a date field offers (`min`) */
export function today(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
/** end of the chosen day as ISO time when it lies in the future, else '' (a past end would lock the account at the next expiry tick) */
export function futureDayEnd(day: string, now = Date.now()): string {
  const end = dayEnd(day);
  return end && Date.parse(end) > now ? end : '';
}

/** clear texts for the account guards of the user actions (single and bulk); null for any other error */
export function accountGuardText(e: unknown): string | null {
  const code = e instanceof ApiError ? (e.body as { error?: string } | null)?.error : undefined;
  if (code === 'last_admin') return tr('adminPeople.bulk.lastAdmin');
  if (code === 'cannot_lock_yourself_out') return tr('adminPeople.users.selfNote');
  if (code === 'access_expired') return tr('adminPeople.users.accessExpired');
  return null;
}

/** a scheduled deletion's restore / delete now: the claim already won, nothing scheduled, else the account guards */
export function deletionErrorText(e: unknown): string {
  const code = e instanceof ApiError ? (e.body as { error?: string } | null)?.error : undefined;
  if (code === 'deletion_in_progress') return tr('adminPeople.detail.actions.deletionRunning');
  if (code === 'not_scheduled') return tr('adminPeople.detail.actions.notScheduled');
  return accountGuardText(e) ?? errorText(e);
}

/** the restore toast: an account whose access has ended stays locked (as expired) after the restore (F8) */
export function restoredText(name: string, accessUntil: string | null, now = Date.now()): string {
  const ended = accessUntil !== null && Date.parse(accessUntil) <= now;
  return tr(ended ? 'adminPeople.detail.actions.restoredLocked' : 'adminPeople.detail.actions.restored', { name });
}

/** invite lifetimes offered in the form (hours) */
export const EXPIRY_PRESETS = [{ id: 'h6', hours: 6 }, { id: 'd1', hours: 24 }, { id: 'd2', hours: 48 }, { id: 'd7', hours: 168 }, { id: 'd14', hours: 336 }] as const;

export type InviteStatus = 'open' | 'used' | 'expired';
/** used = every use taken (a revoked, partly used invite is closed that way); a partly used one stays open until it expires */
export const inviteStatus = (i: { uses: number; max_uses: number; expires_at: string }, now = Date.now()): InviteStatus =>
  (i.uses >= i.max_uses ? 'used' : new Date(i.expires_at).getTime() < now ? 'expired' : 'open');

/** names for a bulk confirmation: the first `max`, then "+n" for the rest ("A, B, C +2") */
export function bulkSummary(names: readonly string[], max = 10): string {
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown} +${names.length - max}` : shown;
}

export type AccessPreset = '+30' | '+90' | 'unlimited';
/** access-until for a preset as ISO date-time (the API wants one with offset); unlimited = null */
export function accessPreset(p: AccessPreset, now = Date.now()): string | null {
  if (p === 'unlimited') return null;
  return new Date(now + Number(p.slice(1)) * 86_400_000).toISOString();
}
