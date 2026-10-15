// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Settings API (backend/src/routes/adminSettings.ts). Secrets are write-only: a SettingView never carries their value, and the
 * only secret that ever comes back is a generated webhook secret (shown once). Refusals arrive as ApiError (400 invalid_settings with
 * per-key codes, 400 probe_failed with the probe result, 401 reauth_required); probeFailure / fieldErrors read them.
 */
import { api, ApiError } from '#lib/api';

export type SettingKind = 'string' | 'url' | 'secret' | 'int' | 'number' | 'bool' | 'enum' | 'cidrList' | 'json';
export type SettingGroup = 'general' | 'signin' | 'media' | 'requests' | 'notifications' | 'push' | 'sources'
  | 'downloads' | 'playback' | 'updates' | 'health' | 'sessions';
export type Source = 'env' | 'db' | 'bootstrap' | 'default' | 'unset';
export type ProbeCode = 'ok' | 'unreachable' | 'timeout' | 'unauthorized' | 'invalid' | 'not_admin' | 'issuer_mismatch' | 'wizard_pending' | 'warning';
export type Generate = 'webhookSecret' | 'vapidPair';

export interface SettingView {
  key: string;
  kind: SettingKind;
  source: Source;
  /** null for secrets (and for unset values) */
  value: unknown;
  set: boolean;
  last4?: string;
  apply: 'live' | 'restart';
  restartPending: boolean;
  /** a stored value that cannot be decrypted or fails its schema */
  invalid: boolean;
  /** the environment names that set this key (KEY, KEY_FILE and legacy names) */
  envNames: string[];
  updatedAt: string | null;
  options?: readonly string[];
  min?: number;
  max?: number;
  generate?: Generate;
}
export interface SettingsGroupView { id: SettingGroup | 'server'; items: SettingView[] }
export interface SettingsView { rev: number; pendingRestart: string[]; groups: SettingsGroupView[] }
export interface ProbeResult { ok: boolean; code: ProbeCode; detail?: string }

/** The groups whose settings have a live check (registry `probe`): they get a "Test" button. */
export const PROBE_GROUPS: ReadonlySet<SettingGroup> = new Set(['general', 'signin', 'media', 'requests', 'sources', 'updates']);
/** Probe failures that "Save anyway" (force) may override; every other failure blocks (backend probes.ts HARD). */
export const SOFT_PROBE_CODES: ReadonlySet<ProbeCode> = new Set(['unreachable', 'timeout']);

export const loadSettings = (): Promise<SettingsView> => api<SettingsView>('/api/admin/settings');

/** Saves only the given keys (null clears one); `force` saves past an unreachable / timed-out probe. */
export const saveSettings = (values: Record<string, unknown>, force?: boolean): Promise<{ rev: number }> =>
  api<{ rev: number }>('/api/admin/settings', { method: 'PUT', body: force ? { values, force: true } : { values } });

/** Runs a group's probes against the unsaved values (omitted secrets are the saved ones). */
export const testGroup = (group: SettingGroup, values: Record<string, unknown> = {}): Promise<ProbeResult> =>
  api<ProbeResult>('/api/admin/settings/test', { method: 'POST', body: { group, values } });

/** Copies env values into the database (env still wins until it is removed). */
export const importEnv = (keys: string[] | 'all'): Promise<{ moved: string[] }> =>
  api<{ moved: string[] }>('/api/admin/settings/import-env', { method: 'POST', body: { keys } });

/** Generates and saves a webhook secret (answered once) or a VAPID pair (only the public key comes back). */
export function generate(what: 'webhookSecret'): Promise<{ secret: string }>;
export function generate(what: 'vapidPair'): Promise<{ publicKey: string }>;
export function generate(what: Generate): Promise<{ secret: string } | { publicKey: string }> {
  return api('/api/admin/settings/generate', { method: 'POST', body: { what } });
}

/** Per-key error codes of a 400 invalid_settings answer, else null. */
export function fieldErrors(e: unknown): Record<string, string> | null {
  if (!(e instanceof ApiError) || e.status !== 400) return null;
  const b = e.body as { error?: unknown; errors?: unknown } | null;
  return b?.error === 'invalid_settings' && b.errors && typeof b.errors === 'object' ? (b.errors as Record<string, string>) : null;
}

/** The probe result of a 400 probe_failed answer, else null. */
export function probeFailure(e: unknown): ProbeResult | null {
  if (!(e instanceof ApiError) || e.status !== 400) return null;
  const b = e.body as { error?: unknown; probe?: unknown } | null;
  return b?.error === 'probe_failed' && b.probe && typeof b.probe === 'object' ? (b.probe as ProbeResult) : null;
}
