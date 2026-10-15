// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Admin user detail page (/admin/users/<id>): API shapes (backend/src/routes/adminUsers.ts), tabs, header pills, limits form, Authentik errors. */
import { ApiError } from '#lib/api';
import { fmtDate, fmtNumber, tr } from '#lib/i18n';
import { errorText } from '#lib/ui/action';
import type { Tone } from '#lib/ui/StatusPill.svelte';

export interface MfaState { totp: boolean; webauthn: boolean; static: boolean }
export interface DetailUser {
  id: string; name: string; email: string | null; role: string; disabled: boolean; lockedReason: string | null
  accessUntil: string | null; createdAt: string; lastActive: string | null; avatar: string | null
  /** scheduled deletion (locked as 'deletion' until then); null = none */
  deletionAt: string | null
}
export interface DetailProfile { id: string; name: string; kids: boolean; maxRating: string | null; avatar: string | null; lastUsed: string | null; isOwner: boolean; hasPin: boolean }
export interface DetailDevice { id: string; name: string | null; lastSeen: string; approved: boolean; sessions: number }
export interface DetailLicense {
  id: string; status: string; title: string; seriesName: string | null; season: number | null; episode: number | null; profileId: string; validUntil: string
}
export interface Totals { hours: number; streams: number }
/** linked account health: ok null = cannot be checked (unknown, never "broken") */
export interface LinkHealth { ok: boolean | null }
export interface UserDetail {
  user: DetailUser;
  /** null = no Authentik API (or Authentik down) */
  mfa: MfaState | null;
  /** which Authentik actions the backend can do */
  authentik: { recovery: boolean; mfaSetup: boolean };
  totals: { d7: Totals; d30: Totals; all: Totals; downloads: number; requests: number };
  linked: { jellyfin: LinkHealth & { username: string | null }; requests: LinkHealth & { id: number | null } };
  profiles: DetailProfile[];
  devices: DetailDevice[];
  licenses: DetailLicense[];
}

export const DETAIL_TABS = ['overview', 'profiles', 'devices', 'downloads', 'activity', 'limits', 'audit'] as const;
export type DetailTab = typeof DETAIL_TABS[number];
export const detailTab = (v: string | null): DetailTab => (DETAIL_TABS.includes(v as DetailTab) ? (v as DetailTab) : 'overview');

export interface Pill { tone: Tone; label: string; icon?: string }
const LOCK_LABEL: Record<string, string> = { manual: 'lockedManual', expired: 'lockedExpired', deletion: 'lockedDeletion' };
const WEEK = 7 * 86_400_000;

/** "Deletion on {date}" (header and user list) */
export const deletionLabel = (at: string): string => tr('adminPeople.detail.status.deletionOn', { date: fmtDate(at, { dateStyle: 'medium' }) });

/** status pills of the header: active | locked (with reason; a scheduled deletion with its date), plus the access end when there is one */
export function statusPills(u: Pick<DetailUser, 'disabled' | 'lockedReason' | 'accessUntil'> & { deletionAt?: string | null }, now = Date.now()): Pill[] {
  const out: Pill[] = u.disabled && u.lockedReason === 'deletion' && u.deletionAt
    ? [{ tone: 'err', label: deletionLabel(u.deletionAt), icon: 'lock' }]
    : u.disabled
      ? [{ tone: 'err', label: tr(`adminPeople.detail.status.${(u.lockedReason && LOCK_LABEL[u.lockedReason]) || 'locked'}` as 'adminPeople.detail.status.locked'), icon: 'lock' }]
      : [{ tone: 'ok', label: tr('adminPeople.detail.status.active') }];
  if (u.accessUntil) {
    const soon = Date.parse(u.accessUntil) - now <= WEEK;
    out.push({ tone: soon ? 'warn' : 'info', label: tr('adminPeople.detail.status.until', { date: fmtDate(u.accessUntil, { dateStyle: 'medium' }) }), icon: 'calendar' });
  }
  return out;
}

/**
 * The header's lock action: lock an active account, unlock a locked one; when its access has ended, extend access
 * instead (an unlock would not last: the backend refuses it with 409 access_expired, the expiry tick would lock again).
 * A deletion lock is restored (deletion/restore; an account whose access has ended stays locked as expired).
 */
export function lockAction(u: Pick<DetailUser, 'disabled' | 'lockedReason' | 'accessUntil'>, now = Date.now()): 'lock' | 'unlock' | 'extend' | 'restore' {
  if (!u.disabled) return 'lock';
  if (u.lockedReason === 'deletion') return 'restore';
  const ended = u.accessUntil !== null && Date.parse(u.accessUntil) <= now;
  return u.lockedReason === 'expired' || ended ? 'extend' : 'unlock';
}

/** 2FA chips: one per method; none = warning; null = unknown */
export function mfaChips(mfa: MfaState | null): Pill[] {
  if (!mfa) return [{ tone: 'muted', label: tr('adminPeople.detail.mfa.unknown') }];
  const on = (['totp', 'webauthn', 'static'] as const).filter((k) => mfa[k]);
  if (!on.length) return [{ tone: 'warn', label: tr('adminPeople.detail.mfa.none') }];
  return on.map((k) => ({ tone: 'ok', label: tr(`adminPeople.detail.mfa.${k}`) }));
}

/** clear texts for the Authentik actions (recovery e-mail, 2FA setup) */
export function akError(e: unknown): string {
  if (e instanceof ApiError) {
    const code = (e.body as { error?: string } | null)?.error;
    if (code === 'recovery_not_configured') return tr('adminPeople.detail.ak.notConfigured');
    if (code === 'authentik_user_not_found') return tr('adminPeople.detail.ak.noUser');
    if (e.status === 501) return tr('adminPeople.detail.ak.notSupported');
    if (e.status === 503) return tr('adminPeople.detail.ak.unavailable');
  }
  return errorText(e);
}

// ---- limits ----
export interface Limits { maxStreams: number | null; remoteBitrate: number | null; maxDownloads: number | null; downloadMaxHeight: number | null; requestsPerMonth: number | null }
export type LimitKey = keyof Limits;
export type LimitsForm = Record<LimitKey, string>;
/** the form fields: bounds in form units (same as the API's limitsBody); the bitrate is edited in Mbit/s */
export const LIMIT_FIELDS: ReadonlyArray<{ key: LimitKey; min: number; max: number; scale: number; step: number }> = [
  { key: 'maxStreams', min: 1, max: 50, scale: 1, step: 1 },
  { key: 'remoteBitrate', min: 0.3, max: 200, scale: 1_000_000, step: 0.1 },
  { key: 'maxDownloads', min: 0, max: 200, scale: 1, step: 1 },
  { key: 'downloadMaxHeight', min: 0, max: 2160, scale: 1, step: 1 },
  { key: 'requestsPerMonth', min: 0, max: 100, scale: 1, step: 1 },
];
const field = (k: LimitKey) => LIMIT_FIELDS.find((f) => f.key === k)!;

/** saved overrides as form values ('' = as role) */
export function limitsForm(l: Limits): LimitsForm {
  const out = {} as LimitsForm;
  for (const f of LIMIT_FIELDS) { const v = l[f.key]; out[f.key] = v === null ? '' : String(v / f.scale); }
  return out;
}

/** one form value in API units: null = as role, undefined = invalid */
export function parseLimit(k: LimitKey, s: string): number | null | undefined {
  const t = s.trim();
  if (!t) return null;
  const f = field(k), n = Number(t.replace(',', '.'));
  if (!Number.isFinite(n) || n < f.min || n > f.max) return undefined;
  const v = Math.round(n * f.scale);
  return f.scale === 1 && !Number.isInteger(n) ? undefined : v;
}

/** the fields that differ from the saved overrides (PUT body); null when a field is invalid */
export function limitsPatch(saved: Limits, form: LimitsForm): Partial<Limits> | null {
  const out: Partial<Limits> = {};
  for (const f of LIMIT_FIELDS) {
    const v = parseLimit(f.key, form[f.key]);
    if (v === undefined) return null;
    if (v !== saved[f.key]) out[f.key] = v;
  }
  return out;
}

/** placeholder and hint of a limit field: the role's value ("wie Rolle: 2"); null = unlimited, download height 0 = no downloads */
export function roleHint(k: LimitKey, roleValue: number | null): string {
  // download height 0: the role allows no downloads at all
  if (k === 'downloadMaxHeight' && roleValue === 0) return tr('adminPeople.detail.limits.asRole', { value: tr('adminPeople.detail.limits.noDownloads') });
  return tr('adminPeople.detail.limits.asRole', { value: roleValue === null ? tr('adminPeople.detail.limits.unlimited') : fmtNumber(roleValue / field(k).scale, { useGrouping: false }) });
}
