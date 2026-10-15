// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The in-app sign-in client (Block 23 phase 3): talks to the backend's `/auth/flow/*` routes, which drive Authentik's flow executor and
 * answer sanitised steps. Its own fetch wrapper, not api(): nobody is signed in yet, so a 401 is never "go to the sign-in".
 *
 * - CSRF: double submit. Every POST carries `x-ff-flow-csrf` with the value of the readable `ff_flow_csrf` cookie, which
 *   `GET /auth/flow/config` sets. A refusal for a stale cookie (403 csrf) fetches the config once more and retries once; cancel clears the
 *   cookie, so `cancelFlow()` fetches a fresh one right away.
 * - Replies: a step (the next stage, or the same stage with a new step id and `errors`), or a notice stage. Transport errors are mapped to
 *   stages too, so the screens only ever render a `FlowReply`: `409 step_used` → expired, `409 classic` → classic, 5xx / network /
 *   garbage → unavailable, field errors → the shown step with `errors`.
 * - `503 setup_required` (a new install: the flow routes are gated) → `/setup`, like the layout does for `/api/me`.
 * - Nothing here logs or keeps a password, code or credential: they live only in the request.
 */
import { goto } from '$app/navigation';
import { getCsrf } from '#lib/api';
import type { TKey } from '#lib/i18n';
import { readCookie } from '#lib/setup/api';

// ---------------------------------------------------------------------------------------------------------------------------
// The step DTOs: a copy of backend/src/flowSteps.ts (Task 2), not an import (the web does not import backend code). flow.test.ts holds
// one literal sample per stage from the backend fixtures, so a drift fails the typecheck (preflight P11).

export type FlowError = 'invalid' | 'code_invalid' | 'password_mismatch' | 'required' | 'rate_limited' | 'email_in_use';
export interface PasskeyCredentialDescriptor { id: string; type: 'public-key'; transports?: string[] }
export interface PasskeyGet {
  challenge: string;
  rpId: string;
  allowCredentials: PasskeyCredentialDescriptor[];
  userVerification?: string;
  timeout?: number;
}
export interface PasskeyCreate {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: unknown[];
  excludeCredentials?: unknown[];
  authenticatorSelection?: unknown;
  attestation?: string;
  timeout?: number;
}
export type PromptFieldType = 'text' | 'username' | 'email' | 'password';
export interface PromptField { key: string; type: PromptFieldType; label: string; required: boolean }
export type ClassicReason = 'unsupported_stage' | 'external_redirect' | 'consent' | 'passkey_origin';

export type FlowStep =
  | { stage: 'identify'; step: string; passwordInline: boolean; canRecover: boolean; canEnroll: boolean; passkey: PasskeyGet | null }
  | { stage: 'password'; step: string; identity: string; canRecover: boolean }
  | { stage: 'mfa'; step: string; totp: boolean; recovery: boolean; passkey: PasskeyGet | null; passkeyClassic: boolean }
  | { stage: 'passkey-setup'; step: string; options: PasskeyCreate }
  | { stage: 'email-sent'; step: string; to: string | null }
  | { stage: 'prompt'; step: string; fields: PromptField[] }
  | { stage: 'totp-setup'; step: string; otpauth: string }
  | { stage: 'recovery-codes'; step: string; codes: string[] }
  | { stage: 'denied' }
  | { stage: 'classic'; reason: ClassicReason }
  | { stage: 'expired' } | { stage: 'unavailable' }
  | { stage: 'locked' }
  | { stage: 'done'; next: string };
export type FlowStage = FlowStep['stage'];
/** a step that takes an answer (it has a step id) */
export type AnswerableStep = Extract<FlowStep, { step: string }>;
/** what the screens render: a step (maybe with the field errors of the last answer) or a notice */
export type FlowReply = (AnswerableStep & { errors?: FlowError[] }) | Exclude<FlowStep, { step: string }>;
export type FlowKind = 'login' | 'recovery' | 'enroll' | 'reauth';
/** what a re-authentication may continue with (the follow-up flow runs in the same Authentik session) */
export type ThenKind = 'setup-totp' | 'setup-static' | 'setup-webauthn' | 'change-password' | 'change-email';
export interface FlowConfig { mode: 'app' | 'authentik'; recovery: boolean; enroll: boolean }

/** a WebAuthn credential as JSON (RegistrationResponseJSON / AuthenticationResponseJSON), in the strict shape the backend accepts */
export interface Credential {
  id: string;
  rawId: string;
  type: 'public-key';
  response: {
    clientDataJSON: string;
    authenticatorData?: string;
    signature?: string;
    userHandle?: string | null;
    attestationObject?: string;
    transports?: string[];
  };
  clientExtensionResults: Record<string, never>;
  authenticatorAttachment?: string | null;
}

export const FLOW_CSRF_COOKIE = 'ff_flow_csrf';
export const FLOW_CSRF_HEADER = 'x-ff-flow-csrf';
const FLOW_ERRORS: ReadonlySet<string> = new Set<FlowError>(['invalid', 'code_invalid', 'password_mismatch', 'required', 'rate_limited', 'email_in_use']);

// ---------------------------------------------------------------------------------------------------------------------------
// transport

type Raw = { status: number; body: any } | null;

async function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Raw> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method === 'POST') {
    headers['content-type'] = 'application/json';
    headers[FLOW_CSRF_HEADER] = readCookie(FLOW_CSRF_COOKIE);
    // a flow of a signed-in person (re-authentication, security setup) also needs that session's csrf token; the sign-in page has none
    const session = getCsrf();
    if (session) headers['x-csrf-token'] = session;
  }
  let res: Response;
  try {
    res = await fetch(path, { method, credentials: 'same-origin', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    return null; // offline, DNS, reset
  }
  let json: any = null;
  try {
    const text = await res.text();
    json = text ? JSON.parse(text) : null;
  } catch { /* a proxy's HTML page: the status decides */ }
  return { status: res.status, body: json };
}

const setupRequired = (r: Raw) => r !== null && r.status === 503 && r.body?.error === 'setup_required';
/** a new install: the flow routes are gated until the wizard is done; the wizard is the only way on (the page never resolves here) */
async function toSetup(): Promise<never> {
  await goto('/setup', { replaceState: true });
  return new Promise<never>(() => undefined);
}

/** POST with the double-submit header; a stale csrf cookie is renewed once (flowConfig) and the request repeated */
async function post(path: string, body: unknown): Promise<Raw> {
  let r = await request('POST', path, body);
  if (r?.status === 403 && r.body?.error === 'csrf') {
    try {
      await flowConfig();
    } catch {
      return null;
    }
    r = await request('POST', path, body);
    if (r?.status === 403 && r.body?.error === 'csrf') return { status: 409, body: { error: 'step_used' } }; // → expired
  }
  if (setupRequired(r)) return toSetup();
  return r;
}

/** the step shape the server answered, or null when it is not one (an older or broken answer) */
function asReply(v: unknown): FlowReply | null {
  if (typeof v !== 'object' || v === null || typeof (v as { stage?: unknown }).stage !== 'string') return null;
  const r = v as FlowReply & { errors?: unknown };
  if ('errors' in r && r.errors !== undefined) {
    const errors = Array.isArray(r.errors) ? r.errors.filter((e): e is FlowError => typeof e === 'string' && FLOW_ERRORS.has(e)) : [];
    return { ...r, errors } as FlowReply;
  }
  return r;
}

/** a server answer (or none) as a reply; `shown` is the step that was answered, kept for field errors */
function toReply(r: Raw, shown?: AnswerableStep): FlowReply {
  const unavailable: FlowReply = { stage: 'unavailable' };
  if (!r) return unavailable;
  const withErrors = (errors: FlowError[]): FlowReply => (shown ? { ...shown, errors } : unavailable);
  if (r.status === 200) return asReply(r.body) ?? unavailable;
  if (r.status === 400) {
    const errors = Array.isArray(r.body?.errors) ? r.body.errors.filter((e: unknown): e is FlowError => typeof e === 'string' && FLOW_ERRORS.has(e)) : [];
    return withErrors(errors.length ? errors : ['invalid']);
  }
  if (r.status === 409 && r.body?.error === 'step_used') return { stage: 'expired' };
  if (r.status === 409 && r.body?.error === 'classic') return { stage: 'classic', reason: 'unsupported_stage' };
  if (r.status === 429) return withErrors(['rate_limited']);
  return unavailable;
}

/** a refusal the page acts on itself (`410 invite_invalid` on start) */
export class FlowRefused extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

/**
 * What the sign-in page needs first: the mode, whether "forgot password" and enrolment exist; also sets a fresh `ff_flow_csrf` cookie.
 * Rejects when the backend cannot answer (the page shows "unavailable"); during setup it goes to `/setup` and never resolves.
 */
export async function flowConfig(): Promise<FlowConfig> {
  const r = await fetch('/auth/flow/config', { credentials: 'same-origin', headers: { accept: 'application/json' } });
  let body: any = null;
  try {
    const text = await r.text();
    body = text ? JSON.parse(text) : null;
  } catch { /* not JSON */ }
  if (setupRequired({ status: r.status, body })) return toSetup();
  if (!r.ok) throw new Error(`flow_config_${r.status}`);
  return { mode: body?.mode === 'app' ? 'app' : 'authentik', recovery: body?.recovery === true, enroll: body?.enroll === true };
}

/** starts a flow; `invite` keeps a portal invite to the end (login, enroll), `identifier` answers a recovery's identification */
export async function startFlow(kind: FlowKind, extra: { invite?: string; identifier?: string; then?: ThenKind } = {}): Promise<FlowReply> {
  const r = await post('/auth/flow/start', { kind, ...extra });
  if (r?.status === 410) throw new FlowRefused(410, typeof r.body?.error === 'string' ? r.body.error : 'invite_invalid');
  // a re-authentication that cannot start: no passkeys in-app (`passkey_classic`), no such flow (`flow_not_configured`)
  if (kind === 'reauth' && r && r.status >= 400 && r.status < 500 && r.status !== 429 && typeof r.body?.error === 'string') throw new FlowRefused(r.status, r.body.error);
  return toReply(r);
}

/**
 * Continues a flow with the token of an e-mail link. Without a kind: Authentik's recovery flow (the /reset button); with
 * `email-confirm`: the e-mail change's flow (the /confirm-email button, no session needed). The token goes to the backend in the body
 * only: not stored, not logged, not part of any URL. `done`, `expired` or `unavailable` come back as stages.
 */
export async function resumeFlow(token: string, kind?: 'email-confirm'): Promise<FlowReply> {
  return toReply(await post('/auth/flow/resume', kind ? { token, kind } : { token }));
}

/** answers the shown step; the reply is the next step, the same stage with `errors`, or a notice */
export async function answer(step: AnswerableStep, body: Record<string, unknown>): Promise<FlowReply> {
  return toReply(await post('/auth/flow/answer', { ...body, step: step.step, stage: step.stage }), step);
}

/** gives up the attempt (Authentik's session too); cancel clears the csrf cookie, so a fresh one is fetched for the next start */
export async function cancelFlow(): Promise<void> {
  await post('/auth/flow/cancel', {});
  try {
    await flowConfig();
  } catch { /* the next start renews it */ }
}

// ---------------------------------------------------------------------------------------------------------------------------
// small helpers for the screens

/** Authentik's own sign-in page (the fallback, always reachable), keeping a portal invite */
export const classicHref = (invite?: string | null): string => `/auth/login?classic=1${invite ? `&invite=${encodeURIComponent(invite)}` : ''}`;

/** where `done` may send the browser: a same-origin path only (never `//host` or `/\host`) */
export const safeNext = (next: unknown): string => (typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/');

const INVITE_TOKEN = /^[A-Za-z0-9_-]{6,128}$/;
/** an invite token from what someone pasted: the token itself or an invite link (`…/invite/<token>`) */
export function inviteToken(text: string): string | null {
  const s = text.trim();
  if (INVITE_TOKEN.test(s)) return s;
  const m = /\/invite\/([^/?#\s]+)\/?(?:[?#].*)?$/.exec(s);
  return m && INVITE_TOKEN.test(m[1]!) ? m[1]! : null;
}

/** the digits of a pasted code, at most 6 */
export const pasteCode = (text: string): string[] => (text.match(/\d/g) ?? []).slice(0, 6);
/** the code typed into the single-digit boxes */
export const codeFromBoxes = (digits: string[]): string => digits.join('').replace(/\D/g, '');

const FIELD_LABELS: Record<string, TKey> = {
  password: 'login.fields.password',
  password_repeat: 'login.fields.password_repeat',
  new_email: 'login.fields.new_email',
};
/**
 * A prompt field's label as text: FriendFlix's own labels arrive as `ff:<name>` and are localised here; an unknown `ff:` key gets a
 * neutral label (never the raw key). Anything else is Authentik's plain text (the backend strips markup); render it as text only.
 */
export function fieldLabel(label: string, tr: (key: TKey) => string): string {
  if (label.startsWith('ff:')) return tr(FIELD_LABELS[label.slice(3)] ?? 'login.fields.generic');
  return label || tr('login.fields.generic');
}

/** the text of a flow error */
export const errorKey = (e: FlowError): TKey => (FLOW_ERRORS.has(e) ? `login.errors.${e}` : 'login.errors.invalid') as TKey;

// ---------------------------------------------------------------------------------------------------------------------------
// cover wall

const ART_PATH = /^\/api\/public\/login-art\/[A-Za-z0-9_-]{12}\/\d{1,2}$/;
/** the image paths of `GET /api/public/login-art`: same-origin paths of that route only */
export function artPaths(body: unknown): string[] {
  const images = (body as { images?: unknown } | null)?.images;
  return Array.isArray(images) ? images.filter((p): p is string => typeof p === 'string' && ART_PATH.test(p)) : [];
}

/** tiles per column at least, so a few images still fill the wall */
const MIN_PER_COLUMN = 6;
/**
 * The images dealt round-robin into `cols` columns (a few images are repeated to fill them); each column is doubled, so moving it by
 * half its height loops without a seam.
 */
export function wallColumns(images: string[], cols = 5): string[][] {
  if (!images.length) return [];
  const total = Math.max(images.length, cols * MIN_PER_COLUMN);
  const out: string[][] = Array.from({ length: cols }, () => []);
  for (let k = 0; k < total; k++) out[k % cols]!.push(images[k % images.length]!);
  return out.map((c) => [...c, ...c]);
}

/** bright and deep colours of the app's palette (app.css tokens and the logo gradient) */
const ART_FROM = ['#ff4f6d', '#d6325a', '#ff6b81', '#4ade80', '#f5a623', '#ff6b6b'] as const;
const ART_TO = ['#16323a', '#3a1a2a', '#2a3f6b', '#242b33', '#161b21'] as const;
/** generated cover tiles (no text) for a wall without images: deterministic for a seed (mulberry32) */
export function fallbackArt(seed: number, n: number): Array<{ from: string; to: string; angle: number }> {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: n }, () => ({
    from: ART_FROM[Math.floor(rnd() * ART_FROM.length)]!,
    to: ART_TO[Math.floor(rnd() * ART_TO.length)]!,
    angle: 100 + Math.floor(rnd() * 90),
  }));
}

// ---------------------------------------------------------------------------------------------------------------------------
// passkeys (WebAuthn)

const toB64url = (b: ArrayBuffer | ArrayBufferView): string => {
  const bytes = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s: string): ArrayBuffer => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out.buffer;
};
const descriptors = (list: unknown[] | undefined) =>
  (list ?? []).map((d) => {
    const c = d as PasskeyCredentialDescriptor;
    return { ...c, id: fromB64url(c.id) };
  });

type PKCStatic = {
  parseRequestOptionsFromJSON?: (o: unknown) => PublicKeyCredentialRequestOptions;
  parseCreationOptionsFromJSON?: (o: unknown) => PublicKeyCredentialCreationOptions;
};
function pkc(): PKCStatic {
  const P = typeof window === 'undefined' ? undefined : (window as unknown as { PublicKeyCredential?: PKCStatic }).PublicKeyCredential;
  if (!P || typeof navigator === 'undefined' || !navigator.credentials) throw new Error('passkey_unsupported');
  return P;
}

/** the browser said no: the person cancelled, or no passkey matched (both are NotAllowedError by design); another host → unsupported */
function ceremonyError(e: unknown): Error {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return new Error('passkey_cancelled');
  if (name === 'SecurityError') return new Error('passkey_unsupported');
  return e instanceof Error ? e : new Error('passkey_failed');
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const bin = (v: unknown): string | undefined => (v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? toB64url(v as ArrayBuffer) : str(v));
/**
 * The credential as the strict JSON the backend passes on: from `toJSON()` where the browser has it, else converted by hand. Only the
 * known keys are kept: `publicKey` and `publicKeyAlgorithm` (registration) are dropped, and `clientExtensionResults` is always `{}`.
 */
export function credentialJSON(cred: unknown): Credential {
  const c = cred as { toJSON?: () => unknown; id?: unknown; rawId?: unknown; type?: unknown; response?: any; authenticatorAttachment?: unknown };
  const j = (typeof c.toJSON === 'function' ? c.toJSON() : c) as typeof c | null;
  const resp = (j?.response ?? {}) as Record<string, unknown> & { getTransports?: () => unknown };
  const out: Credential = { id: str(j?.id) ?? '', rawId: bin(j?.rawId) ?? '', type: 'public-key', response: { clientDataJSON: bin(resp.clientDataJSON) ?? '' }, clientExtensionResults: {} };
  for (const k of ['authenticatorData', 'signature', 'attestationObject'] as const) {
    const v = bin(resp[k]);
    if (v !== undefined) out.response[k] = v;
  }
  if ('userHandle' in resp) out.response.userHandle = resp.userHandle === null ? null : bin(resp.userHandle) ?? null;
  const transports = Array.isArray(resp.transports) ? resp.transports : typeof resp.getTransports === 'function' ? resp.getTransports() : undefined;
  if (Array.isArray(transports)) out.response.transports = transports.filter((t): t is string => typeof t === 'string');
  if (j && 'authenticatorAttachment' in j) out.authenticatorAttachment = typeof j.authenticatorAttachment === 'string' ? j.authenticatorAttachment : null;
  return out;
}

/** signs in with a passkey (assertion) on this page; throws `passkey_cancelled` / `passkey_unsupported` */
export async function passkeyGet(options: PasskeyGet): Promise<Credential> {
  const P = pkc();
  const publicKey = typeof P.parseRequestOptionsFromJSON === 'function'
    ? P.parseRequestOptionsFromJSON(options)
    : ({ ...options, challenge: fromB64url(options.challenge), allowCredentials: descriptors(options.allowCredentials) } as PublicKeyCredentialRequestOptions);
  let cred: unknown;
  try {
    cred = await navigator.credentials.get({ publicKey });
  } catch (e) {
    throw ceremonyError(e);
  }
  if (!cred) throw new Error('passkey_cancelled');
  return credentialJSON(cred);
}

/** creates a passkey (attestation) on this page; throws `passkey_cancelled` / `passkey_unsupported` */
export async function passkeyCreate(options: PasskeyCreate): Promise<Credential> {
  const P = pkc();
  const publicKey = typeof P.parseCreationOptionsFromJSON === 'function'
    ? P.parseCreationOptionsFromJSON(options)
    : ({
      ...options,
      challenge: fromB64url(options.challenge),
      user: { ...options.user, id: fromB64url(options.user.id) },
      excludeCredentials: descriptors(options.excludeCredentials),
    } as unknown as PublicKeyCredentialCreationOptions);
  let cred: unknown;
  try {
    cred = await navigator.credentials.create({ publicKey });
  } catch (e) {
    throw ceremonyError(e);
  }
  if (!cred) throw new Error('passkey_cancelled');
  return credentialJSON(cred);
}
