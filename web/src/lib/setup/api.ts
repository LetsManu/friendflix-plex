// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The setup wizard's API (backend/src/routes/setup.ts). Its own fetch wrapper, not api(): nobody is signed in yet, so a 401 means the
 * setup session ran out (back to the code step), never "go to the sign-in"; and every write carries x-ff-setup-csrf, read from the
 * ff_setup_csrf cookie the unlock set. Refusals arrive as ApiError (status + body) like everywhere else, so the settings helpers
 * (fieldErrors, probeFailure) read them; a network error or the client timeout is ApiError(0, { error: 'network' | 'timeout' }).
 * Nothing here keeps a credential: the code, the media server password and the Authentik admin token live only in the request.
 */
import { ApiError } from '#lib/api';
import type { ProbeResult } from '#lib/admin/settings/api';

export type StepState = 'todo' | 'done' | 'env';
export type AutoField = 'url' | 'username' | 'password';
export interface SetupState {
  complete: false;
  /** this browser holds a valid setup session */
  unlocked: boolean;
  mediaKind: string;
  /** the media step's fields (registry keys, labels settings.keys.<KEY>) and the automatic setup's fields, null = manual only */
  media: { keys: string[]; auto: AutoField[] | null };
  steps: { publicUrl: StepState; media: StepState; signin: StepState; admin: StepState };
  /** the saved (or environment) public URL, else the origin the browser used (a suggestion for step 2); null when neither */
  prefill: { publicUrl: string | null };
  /** 'authentik' once the Authentik automation saved the sign-in (and no sign-in key was typed by hand since); absent on older backends */
  signinVia?: 'authentik' | null;
}
export type AkStepId = 'check' | 'groups' | 'provider' | 'serviceAccount' | 'enrollment' | 'recovery' | 'brand' | 'readback' | 'adminMember' | 'extraFlows';
export interface AkStep { id: AkStepId; state: 'create' | 'update' | 'exists' | 'skip' | 'ok' | 'failed'; detail?: string }
export type WizardGroup = 'general' | 'media' | 'signin';

export const CSRF_COOKIE = 'ff_setup_csrf';
export const CSRF_HEADER = 'x-ff-setup-csrf';
const TIMEOUT_MS = 30_000;
/** the media server's automatic API key: sign-in, key, list, logout, then the probe */
const AUTO_TIMEOUT_MS = 90_000;
/** a plan only reads, but each of its calls may take the backend's 10 s */
const PLAN_TIMEOUT_MS = 120_000;
/** an apply takes ~30 s, blueprint imports up to 60 s each on a busy Authentik (the backend's lock outlasts a run's worst case) */
export const APPLY_TIMEOUT_MS = 600_000;

/** A cookie's value from document.cookie ('' when it is not there). */
export function readCookie(name: string, cookies: string = typeof document === 'undefined' ? '' : document.cookie): string {
  for (const part of cookies.split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return part.slice(i + 1).trim(); }
  }
  return '';
}

const isTimeout = (e: unknown) => {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
};

async function call<T>(path: string, opts: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers[CSRF_HEADER] = readCookie(CSRF_COOKIE);
  let res: Response;
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin', headers, cache: 'no-store', signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (e) {
    throw new ApiError(0, { error: isTimeout(e) ? 'timeout' : 'network' });
  }
  const text = await res.text().catch(() => '');
  let json: unknown;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; } // a proxy's error page
  if (!res.ok) throw new ApiError(res.status, json ?? {});
  return json as T;
}

/** GET /api/setup/state: the wizard's state during setup; once setup is complete only `{ complete: true }` */
export type SetupAnswer = SetupState | { complete: true };
export const setupState = (): Promise<SetupAnswer> => call<SetupAnswer>('/api/setup/state');

/** Opens the setup session (the cookies ff_setup and ff_setup_csrf). */
export const unlock = (code: string): Promise<{ ok: true }> => call('/api/setup/unlock', { method: 'POST', body: { code } });

/** Saves the wizard's keys (steps 2-4); `force` saves past an unreachable / timed-out probe. */
export const saveSetup = (values: Record<string, unknown>, force?: boolean): Promise<{ rev: number }> =>
  call('/api/setup/settings', { method: 'PUT', body: force ? { values, force: true } : { values } });

/** Runs a wizard group's probes against unsaved values. */
export const testSetup = (group: WizardGroup, values?: Record<string, unknown>): Promise<ProbeResult> =>
  call('/api/setup/test', { method: 'POST', body: values ? { group, values } : { group } });

/** The media server's automatic API key: { ok: true } once it is saved, or the probe result of the failure (answered with 200). */
export const mediaAuto = (input: { url: string; username: string; password: string }): Promise<{ ok: true } | ProbeResult> =>
  call('/api/setup/media/auto', { method: 'POST', body: input, timeoutMs: AUTO_TIMEOUT_MS });

/** What the Authentik automation would do (read only). */
export const akPlan = (input: { url: string; token: string }): Promise<{ steps: AkStep[] }> =>
  call('/api/setup/authentik/plan', { method: 'POST', body: input, timeoutMs: PLAN_TIMEOUT_MS });

/**
 * Runs the Authentik automation and saves the sign-in settings; `ok: false` with the steps up to the failed one. `envKept`: the sign-in
 * keys the environment sets with other values than Authentik now has (kept, not saved; key names only).
 */
export interface AkResult { ok: boolean; steps: AkStep[]; envKept?: string[] }
export const akApply = (input: { url: string; token: string; addMeToAdmins: boolean }): Promise<AkResult> =>
  call('/api/setup/authentik/apply', { method: 'POST', body: input, timeoutMs: APPLY_TIMEOUT_MS });

/** The step to open: the first one that still needs something (2 public URL, 3 media, 4 sign-in, else 5 first admin). */
export function firstOpenStep(s: Pick<SetupState, 'steps'>): 2 | 3 | 4 | 5 {
  if (s.steps.publicUrl === 'todo') return 2;
  if (s.steps.media === 'todo') return 3;
  if (s.steps.signin === 'todo') return 4;
  return 5;
}

/** Whether a URL typed into a field starts with http:// (cookies not secure; for the issuer OIDC_ALLOW_INSECURE is needed). */
export const isPlainHttp = (url: string): boolean => /^\s*http:\/\//i.test(url);

/** The OIDC redirect URI for a public URL (the provider's strict redirect URI). */
export const redirectUri = (publicUrl: string): string => `${publicUrl.trim().replace(/\/+$/, '')}/auth/callback`;
