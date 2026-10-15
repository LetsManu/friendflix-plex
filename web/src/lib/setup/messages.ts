// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the wizard tells the person for every answer of the setup API: the codes of backend/src/routes/setup.ts (unlock, session,
 * busy), the probe results (settings/probes.ts, the media server's automatic key) and the Authentik steps (setup/authentikSetup.ts).
 * Every code maps to a sentence that says what to do; an unknown code falls back to a generic sentence, never to the raw answer.
 */
import { ApiError } from '#lib/api';
import { hasKey, tr, trDynamic } from '#lib/i18n';
import type { ProbeResult } from '#lib/admin/settings/api';
import { errorText as fieldText, keyLabel } from '#lib/admin/settings/form';
import type { AkStep } from './api';

/** Probe failures "Save anyway" may override (backend probes.ts: everything else is HARD). */
const SOFT = new Set(['unreachable', 'timeout']);
const word = (s: unknown): s is string => typeof s === 'string' && /^[a-z_]+$/.test(s);

/** Text of a probe result: the code's sentence plus the detail's (the wizard's own wording first, then Admin → Settings'). */
export function probeText(r: ProbeResult): string {
  const pick = (area: 'probe' | 'probeDetail', code: string): string =>
    hasKey(`setup.${area}.${code}`) ? trDynamic(`setup.${area}.${code}`) : hasKey(`settings.${area}.${code}`) ? trDynamic(`settings.${area}.${code}`) : '';
  const code = (word(r.code) && pick('probe', r.code)) || tr('settings.probe.invalid');
  const detail = word(r.detail) ? pick('probeDetail', r.detail) : '';
  return detail ? `${code} ${detail}` : code;
}

/** Text of a failed Authentik step's code. */
export const akFailText = (code: string | undefined): string =>
  word(code) && hasKey(`setup.ak.fail.${code}`) ? trDynamic(`setup.ak.fail.${code}`) : tr('setup.ak.fail.unexpected');

/** The first failed step of an Authentik plan or apply, or null. */
export const failedStep = (steps: readonly AkStep[]): AkStep | null => steps.find((s) => s.state === 'failed') ?? null;

/** Text of a top-level error code of the setup API (`unknown` with the status for anything else). */
export function errorText(code: unknown, status = 0): string {
  const params = { status: String(status) };
  return word(code) && hasKey(`setup.errors.${code}`) ? trDynamic(`setup.errors.${code}`, params) : tr('setup.errors.unknown', params);
}

/**
 * What a refused call means for the wizard:
 * - `session`: no (or another) setup session: back to the code step;
 * - `complete`: someone finished setup meanwhile: go to /;
 * - `message`: stay, show `text`; `fields` (per-key codes), `probe` (+ `soft`: "Save anyway" may help) and `steps` when the answer had them.
 */
export type Failure =
  | { kind: 'session' }
  | { kind: 'complete' }
  | { kind: 'message'; text: string; fields?: Record<string, string>; probe?: ProbeResult; soft?: boolean; steps?: AkStep[] };

export function failure(e: unknown): Failure {
  if (!(e instanceof ApiError)) return { kind: 'message', text: errorText('unknown') };
  const b = (e.body && typeof e.body === 'object' ? e.body : {}) as { error?: unknown; errors?: unknown; probe?: unknown; steps?: unknown; ok?: unknown; code?: unknown; detail?: unknown };
  const steps = Array.isArray(b.steps) ? (b.steps as AkStep[]) : undefined;
  const withSteps = steps ? { steps } : {};
  if (e.status === 409 && b.error === 'setup_complete') return { kind: 'complete' };
  // 401 setup_session_required, 403 csrf (the cookie is gone or belongs to another session): the code opens a new one
  if ((e.status === 401 && b.error !== 'wrong_code') || (e.status === 403 && b.error === 'csrf')) return { kind: 'session' };
  if (e.status === 429) return { kind: 'message', text: errorText('rate_limited') };
  if (b.error === 'probe_failed' && b.probe && typeof b.probe === 'object') {
    const probe = b.probe as ProbeResult;
    return { kind: 'message', text: probeText(probe), probe, soft: SOFT.has(probe.code), ...withSteps };
  }
  if (b.error === 'invalid_settings' && b.errors && typeof b.errors === 'object') {
    return { kind: 'message', text: errorText('invalid_settings'), fields: b.errors as Record<string, string>, ...withSteps };
  }
  // a refusal in the shape of a probe result: { ok: false, code: 'invalid', detail: 'invalid_url' | 'env_locked' | 'env_key_locked' | 'public_url_missing' }
  if (b.ok === false && word(b.code)) {
    const probe: ProbeResult = { ok: false, code: b.code as ProbeResult['code'], ...(word(b.detail) ? { detail: b.detail } : {}) };
    return { kind: 'message', text: probeText(probe), probe, soft: false };
  }
  return { kind: 'message', text: errorText(b.error, e.status), ...withSteps };
}

export type Message = Extract<Failure, { kind: 'message' }>;
/** The page's handler for a refused call: it acts on `session` / `complete` itself (null) and hands back what the step shows. */
export type Handle = (e: unknown) => Message | null;

/** The non-empty, trimmed values of a form (an empty field leaves the setting as it is, a secret keeps the saved one). */
export function filled(values: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (v.trim()) out[k] = v.trim();
  return out;
}

/** Registry keys that hold a credential (shown as password fields, emptied after a save). */
export const isSecretKey = (key: string): boolean => /(_KEY|_TOKEN|_SECRET|_PASSWORD)$/.test(key);

/** Field errors for keys the form does not show (locked, not allowed …), as "Label: reason" lines: they would be invisible otherwise. */
export const otherFieldErrors = (fields: Readonly<Record<string, string>> | undefined, shown: readonly string[]): string[] =>
  Object.entries(fields ?? {}).filter(([k]) => !shown.includes(k)).map(([k, code]) => `${keyLabel(k)}: ${fieldText(code)}`);
