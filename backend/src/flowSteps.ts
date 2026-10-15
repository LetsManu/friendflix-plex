// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The challenge sanitiser (Block 23 phase 3, in-app login): turns Authentik flow-executor challenges into the step DTOs the web renders,
 * and the web's answers back into executor answers.
 *
 * The DTO is an allow-list. Every value is picked by name and checked by type and shape: no Authentik URL, flow or CSRF token, cookie,
 * internal id (user pk, stage pk, device uid), avatar, brand text or raw HTML reaches the browser. The deliberate exceptions (plan
 * Ruling 2) are the user's own new TOTP secret (`otpauth://`), their recovery codes and the WebAuthn options the browser API needs; the
 * WebAuthn options pass only when their RP ID is the app host (Ruling 1), anything else becomes the classic sign-in page. An unknown or
 * unusable challenge is never passed through: it becomes `{stage:'classic'}`.
 *
 * Internal outcomes (`{internal: …}`) are for the flow routes only and never sent to the browser.
 */
import { z } from 'zod';
import type { FlowKind, Jar, RawChallenge } from './akflow.js';
import { HttpError } from './users.js';

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

/**
 * Outcomes the routes act on themselves; never part of an answer to the browser.
 * - `end`: the flow finished (`final_redirect`, or a redirect home / to the OIDC authorize endpoint)
 * - `select-stage`: the validate stage has no device yet but offers TOTP setup; the route answers `{selected_stage: pk}` itself
 * - `link-confirm`: Authentik's e-mail link interstitial; the route answers `{token}` itself (the user's click is the confirmation).
 *   `pendingUser` is the Authentik username the link belongs to (preflight P10, for the e-mail change).
 */
export type FlowInternal =
  | { internal: 'end' }
  | { internal: 'select-stage'; pk: string }
  | { internal: 'link-confirm'; token: string; pendingUser?: string };

export type FlowStage = FlowStep['stage'];

/** the RP name the browser shows in its passkey prompt (display only, not part of the signed data) */
export const RP_NAME = 'FriendFlix';
/** prompt labels FriendFlix sets itself, by field key: the web shows its own localised text for `ff:<name>` labels */
const FF_LABEL = 'ff:';

/** Authentik usernames are at most 150 characters; anything longer is not a username and is dropped (Task 2 review) */
export const MAX_PENDING_USER = 254;
const TOTP_STAGE_MODEL = 'authentik_stages_authenticator_totp.authenticatortotpstage';
const LINK_KINDS: readonly FlowKind[] = ['recovery-resume', 'email-confirm'];
const SHOWN_FIELD_TYPES: ReadonlySet<string> = new Set(['text', 'username', 'email', 'password']);
const SKIPPED_FIELD_TYPES: ReadonlySet<string> = new Set(['static', 'separator']);
const USER_VERIFICATION: ReadonlySet<string> = new Set(['required', 'preferred', 'discouraged']);
const TRANSPORTS: ReadonlySet<string> = new Set(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card', 'cable']);
const RESIDENT_KEY: ReadonlySet<string> = new Set(['required', 'preferred', 'discouraged']);
const ATTACHMENT: ReadonlySet<string> = new Set(['platform', 'cross-platform']);
const ATTESTATION: ReadonlySet<string> = new Set(['none', 'indirect', 'direct', 'enterprise']);

// ---------------------------------------------------------------------------------------------------------------------------
// small readers: everything Authentik sends is `unknown` until checked

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const B64URL = /^[A-Za-z0-9_-]+$/;
const b64url = (v: unknown, max = 1024): string | null => (typeof v === 'string' && v.length <= max && B64URL.test(v) ? v : null);
const timeout = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 600_000 ? v : undefined);
const oneOf = (v: unknown, set: ReadonlySet<string>): string | undefined => (typeof v === 'string' && set.has(v) ? v : undefined);
/** plain text for display: no tags, no control characters, bounded; null when nothing usable (or it carries a URL) is left */
function plainText(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null;
  // markup is refused, not stripped: a label with any angle bracket is dropped (the caller falls back to the field key)
  if (/[<>]/.test(v)) return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || s.length > max || /:\/\/|^\/\/|\bwww\./i.test(s)) return null;
  return s;
}

function credentialDescriptors(v: unknown): PasskeyCredentialDescriptor[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 64) return null;
  const out: PasskeyCredentialDescriptor[] = [];
  for (const c of v) {
    if (!isObj(c) || c.type !== 'public-key') return null;
    const id = b64url(c.id);
    if (!id) return null;
    const d: PasskeyCredentialDescriptor = { id, type: 'public-key' };
    if (Array.isArray(c.transports)) {
      const t = c.transports.filter((x): x is string => typeof x === 'string' && TRANSPORTS.has(x));
      if (t.length) d.transports = t;
    }
    out.push(d);
  }
  return out;
}

/** PublicKeyCredentialRequestOptions, rebuilt from known keys; null when malformed */
function passkeyGet(v: unknown): PasskeyGet | null {
  if (!isObj(v)) return null;
  const challenge = b64url(v.challenge);
  const allowCredentials = credentialDescriptors(v.allowCredentials);
  if (!challenge || typeof v.rpId !== 'string' || !allowCredentials) return null;
  const out: PasskeyGet = { challenge, rpId: v.rpId, allowCredentials };
  const uv = oneOf(v.userVerification, USER_VERIFICATION);
  if (uv) out.userVerification = uv;
  const t = timeout(v.timeout);
  if (t) out.timeout = t;
  return out;
}

/** PublicKeyCredentialCreationOptions, rebuilt from known keys with FriendFlix as the RP name; null when malformed */
function passkeyCreate(v: unknown): PasskeyCreate | null {
  if (!isObj(v) || !isObj(v.rp) || !isObj(v.user) || !Array.isArray(v.pubKeyCredParams)) return null;
  const challenge = b64url(v.challenge);
  const userId = b64url(v.user.id);
  const name = typeof v.user.name === 'string' && v.user.name.length <= 256 ? v.user.name : null;
  const displayName = typeof v.user.displayName === 'string' && v.user.displayName.length <= 256 ? v.user.displayName : null;
  const excludeCredentials = credentialDescriptors(v.excludeCredentials);
  if (!challenge || typeof v.rp.id !== 'string' || !userId || name === null || displayName === null || !excludeCredentials) return null;
  const pubKeyCredParams: Array<{ type: 'public-key'; alg: number }> = [];
  for (const p of v.pubKeyCredParams.slice(0, 32)) {
    if (isObj(p) && p.type === 'public-key' && Number.isInteger(p.alg)) pubKeyCredParams.push({ type: 'public-key', alg: p.alg as number });
  }
  if (!pubKeyCredParams.length) return null;
  const out: PasskeyCreate = { challenge, rp: { id: v.rp.id, name: RP_NAME }, user: { id: userId, name, displayName }, pubKeyCredParams, excludeCredentials };
  if (isObj(v.authenticatorSelection)) {
    const s = v.authenticatorSelection;
    const sel: Obj = {};
    const rk = oneOf(s.residentKey, RESIDENT_KEY);
    if (rk) sel.residentKey = rk;
    if (typeof s.requireResidentKey === 'boolean') sel.requireResidentKey = s.requireResidentKey;
    const uv = oneOf(s.userVerification, USER_VERIFICATION);
    if (uv) sel.userVerification = uv;
    const att = oneOf(s.authenticatorAttachment, ATTACHMENT);
    if (att) sel.authenticatorAttachment = att;
    out.authenticatorSelection = sel;
  }
  const attestation = oneOf(v.attestation, ATTESTATION);
  if (attestation) out.attestation = attestation;
  const t = timeout(v.timeout);
  if (t) out.timeout = t;
  return out;
}

/** `otpauth://totp/<label>?…` rebuilt with the parameters an authenticator app needs (an `image=` URL and the like are dropped) */
function otpauth(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 1024) return null;
  const m = /^otpauth:\/\/totp\/([^?#\s/]{1,256})\?([^#\s]*)$/.exec(v);
  if (!m) return null;
  const q = new URLSearchParams(m[2]);
  const secret = q.get('secret');
  if (!secret || !/^[A-Z2-7]{16,128}=*$/i.test(secret)) return null;
  const out = new URLSearchParams({ secret });
  const checks: Record<string, RegExp> = { algorithm: /^SHA(1|256|512)$/i, digits: /^[68]$/, period: /^\d{1,3}$/, issuer: /^[^\s:/][^:/]{0,63}$/ };
  for (const [k, re] of Object.entries(checks)) {
    const val = q.get(k);
    if (val !== null && re.test(val)) out.set(k, val);
  }
  return `otpauth://totp/${m[1]}?${out.toString()}`;
}

/** 'anna@example.com' → 'a•••@example.com'; null for a username (no '@') or an unusable address */
export function maskEmail(identifier: string): string | null {
  const s = identifier.trim();
  const at = s.lastIndexOf('@');
  if (s.length > 254 || at < 1) return null;
  const domain = s.slice(at + 1).toLowerCase();
  if (!/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u.test(domain)) return null;
  const first = [...s][0] as string;
  return /[\p{L}\p{N}]/u.test(first) ? `${first}•••@${domain}` : `•••@${domain}`;
}

// ---------------------------------------------------------------------------------------------------------------------------
// toStep

const classic = (reason: ClassicReason): FlowStep => ({ stage: 'classic', reason });

/**
 * One executor challenge as a step DTO (or an internal outcome). `appHost` is akflow's `appHost(cfg)` (null while PUBLIC_URL is
 * unset); WebAuthn options pass only for a jar that forwards the app host and an RP ID equal to it (plan Ruling 1). `newEmail` is the
 * address an e-mail change sends its link to (the masked address on the `email-sent` screen of a `change-email` jar).
 */
export function toStep(raw: RawChallenge, jar: Jar, step: string, appHost: string | null, newEmail?: string): FlowStep | FlowInternal {
  const webauthnOk = (rpId: unknown) => jar.forwardHost && !!appHost && rpId === appHost;
  const r = raw as Obj;
  switch (raw.component) {
    case 'ak-stage-identification': {
      if (r.captcha_stage !== undefined && r.captcha_stage !== null) return classic('unsupported_stage');
      const pk = r.passkey_challenge ? passkeyGet(r.passkey_challenge) : null;
      const passkey = pk && webauthnOk(pk.rpId) ? pk : null;
      // an identification stage without user fields (sources only) cannot be answered here
      if (Array.isArray(r.user_fields) && r.user_fields.length === 0 && !passkey) return classic('unsupported_stage');
      return { stage: 'identify', step, passwordInline: r.password_fields === true, canRecover: !!r.recovery_url, canEnroll: !!r.enroll_url, passkey };
    }
    case 'ak-stage-password':
      // the identity is what the person typed, never Authentik's pending_user (it would name the account behind an e-mail)
      return { stage: 'password', step, identity: (jar.identifier ?? '').slice(0, 254), canRecover: !!r.recovery_url };
    case 'ak-stage-authenticator-validate':
      return validateStep(r, step, webauthnOk);
    case 'ak-stage-authenticator-webauthn': {
      const options = passkeyCreate(r.registration);
      if (!options || !webauthnOk(options.rp.id)) return classic('passkey_origin');
      return { stage: 'passkey-setup', step, options };
    }
    case 'ak-stage-authenticator-totp': {
      const uri = otpauth(r.config_url);
      return uri ? { stage: 'totp-setup', step, otpauth: uri } : classic('unsupported_stage');
    }
    case 'ak-stage-authenticator-static': {
      const codes = Array.isArray(r.codes) ? r.codes.filter((c): c is string => typeof c === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(c)).slice(0, 64) : [];
      return codes.length && codes.length === (r.codes as unknown[]).length ? { stage: 'recovery-codes', step, codes } : classic('unsupported_stage');
    }
    case 'ak-stage-prompt':
      return promptStep(r, jar, step);
    case 'ak-stage-email': {
      const to = jar.kind === 'change-email' ? newEmail : jar.identifier;
      return { stage: 'email-sent', step, to: to ? maskEmail(to) : null };
    }
    case 'ak-stage-consent': {
      const link = LINK_KINDS.includes(jar.kind) && jar.query.startsWith('flow_token=') && jar.challenges === 1
        && Array.isArray(r.permissions) && r.permissions.length === 0
        && Array.isArray(r.additional_permissions) && r.additional_permissions.length === 0
        && typeof r.token === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(r.token);
      if (!link) return classic('consent');
      const out: FlowInternal = { internal: 'link-confirm', token: r.token as string };
      if (typeof raw.pending_user === 'string' && raw.pending_user && raw.pending_user.length <= MAX_PENDING_USER) out.pendingUser = raw.pending_user;
      return out;
    }
    case 'ak-stage-access-denied':
      return { stage: 'denied' };
    case 'xak-flow-redirect':
      return r.final_redirect === true || endsFlow(r.to) ? { internal: 'end' } : classic('external_redirect');
    default:
      return classic('unsupported_stage');
  }
}

/** a redirect home, to Authentik's user interface or to the OIDC authorize endpoint (older releases without `final_redirect`) */
function endsFlow(to: unknown): boolean {
  if (typeof to !== 'string' || !to.startsWith('/') || to.startsWith('//')) return false;
  return to === '/' || to === '/if/user/' || to.startsWith('/application/o/authorize');
}

function validateStep(r: Obj, step: string, webauthnOk: (rpId: unknown) => boolean): FlowStep | FlowInternal {
  const devices = Array.isArray(r.device_challenges) ? r.device_challenges.filter(isObj) : [];
  if (!devices.length) {
    const stages = Array.isArray(r.configuration_stages) ? r.configuration_stages.filter(isObj) : [];
    const totp = stages.find((s) => s.meta_model_name === TOTP_STAGE_MODEL && typeof s.pk === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(s.pk));
    return totp ? { internal: 'select-stage', pk: totp.pk as string } : classic('unsupported_stage');
  }
  const has = (cls: string) => devices.some((d) => d.device_class === cls);
  const totp = has('totp');
  const recovery = has('static');
  const webauthn = devices.find((d) => d.device_class === 'webauthn');
  const pk = webauthn ? passkeyGet(webauthn.challenge) : null;
  const passkey = pk && webauthnOk(pk.rpId) ? pk : null;
  if (totp || recovery || passkey) return { stage: 'mfa', step, totp, recovery, passkey, passkeyClassic: !!webauthn && !passkey };
  // only devices FriendFlix cannot run (sms, duo, email) or a passkey for another host
  if (webauthn && !has('sms') && !has('duo') && !has('email')) return classic('passkey_origin');
  return classic('unsupported_stage');
}

/** FriendFlix's own label for a field, by key (the web localises `ff:<name>`); undefined keeps Authentik's text */
function ffLabel(key: string, kind: FlowKind): string | undefined {
  if (key === 'password') return `${FF_LABEL}password`;
  if (key === 'password_repeat') return `${FF_LABEL}password_repeat`;
  if (key === 'email' && kind === 'change-email') return `${FF_LABEL}new_email`;
  return undefined;
}

function promptStep(r: Obj, jar: Jar, step: string): FlowStep {
  if (!Array.isArray(r.fields) || r.fields.length > 32) return classic('unsupported_stage');
  const fields: PromptField[] = [];
  for (const f of r.fields) {
    if (!isObj(f) || typeof f.type !== 'string') return classic('unsupported_stage');
    if (SKIPPED_FIELD_TYPES.has(f.type)) continue;
    if (!SHOWN_FIELD_TYPES.has(f.type)) return classic('unsupported_stage');
    const key = typeof f.field_key === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(f.field_key) ? f.field_key : null;
    if (!key) return classic('unsupported_stage');
    const label = ffLabel(key, jar.kind) ?? plainText(f.label) ?? key;
    fields.push({ key, type: f.type as PromptFieldType, label, required: f.required === true });
  }
  return fields.length ? { stage: 'prompt', step, fields } : classic('unsupported_stage');
}

// ---------------------------------------------------------------------------------------------------------------------------
// stepErrors

/**
 * The field errors of a challenge as FlowError codes: a wrong code (`code` field) is `code_invalid`, Authentik's `required` stays,
 * anything else is `invalid`. The e-mail stage's `email-sent` "error" is a resend, not a failure (plan Ruling 9).
 */
export function stepErrors(raw: RawChallenge): FlowError[] {
  const out = new Set<FlowError>();
  if (!isObj(raw.response_errors)) return [];
  for (const [field, list] of Object.entries(raw.response_errors)) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      const code = isObj(e) ? e.code : undefined;
      if (code === 'email-sent') continue;
      out.add(code === 'required' ? 'required' : field === 'code' ? 'code_invalid' : 'invalid');
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------------------------------------------
// toAnswer

/** a refused answer that carries field errors for the browser (`400 {errors}`), raised before Authentik is called */
export class FlowFieldError extends HttpError {
  constructor(readonly errors: FlowError[]) {
    super(400, errors[0] ?? 'invalid');
  }
}

const b64 = (max: number) => z.string().min(1).max(max).regex(B64URL);
const KIB16 = 16 * 1024;
/** a WebAuthn credential (RegistrationResponseJSON / AuthenticationResponseJSON), strictly shaped; passed through unchanged */
export const Credential = z.strictObject({
  id: b64(1024),
  rawId: b64(1024),
  type: z.literal('public-key'),
  response: z.strictObject({
    clientDataJSON: b64(KIB16),
    authenticatorData: b64(KIB16).optional(),
    signature: b64(KIB16).optional(),
    userHandle: b64(KIB16).nullable().optional(),
    attestationObject: b64(KIB16).optional(),
    transports: z.array(z.string().regex(/^[a-z-]{1,32}$/)).max(8).optional(),
  }),
  clientExtensionResults: z.strictObject({}).optional(),
  authenticatorAttachment: z.string().max(32).nullable().optional(),
});

const CODE = z.string().regex(/^(\d{6}|[A-Za-z0-9]{8,32})$/);
const ANSWERS = {
  identify: z.union([
    z.strictObject({ identifier: z.string().min(1).max(254), password: z.string().min(1).max(1024).optional() }),
    z.strictObject({ passkey: Credential }),
  ]),
  password: z.strictObject({ password: z.string().min(1).max(1024) }),
  mfa: z.union([z.strictObject({ code: CODE }), z.strictObject({ webauthn: Credential })]),
  'passkey-setup': z.strictObject({ response: Credential }),
  'totp-setup': z.strictObject({ code: z.string().regex(/^\d{6}$/) }),
  'recovery-codes': z.strictObject({}),
  'email-sent': z.strictObject({}),
} as const;

const badRequest = () => new HttpError(400, 'bad_request');

/** the visible prompt fields of a challenge (the same filter as the DTO) */
function promptKeys(raw: RawChallenge): Array<{ key: string; type: string }> {
  const fields = Array.isArray((raw as Obj).fields) ? ((raw as Obj).fields as unknown[]).filter(isObj) : [];
  return fields
    .filter((f) => typeof f.type === 'string' && SHOWN_FIELD_TYPES.has(f.type) && typeof f.field_key === 'string')
    .map((f) => ({ key: f.field_key as string, type: f.type as string }));
}

/**
 * The executor answer for a step, from the browser's body: validated per stage (strict, bounded), else 400 `bad_request`.
 * A prompt whose `password` and `password_repeat` differ is refused with `FlowFieldError(['password_mismatch'])` (400
 * `{errors:['password_mismatch']}`) without calling Authentik, since Authentik's own mismatch error is a localised string.
 */
export function toAnswer(stage: FlowStage, body: unknown, raw: RawChallenge): object {
  const input = body ?? {};
  if (stage === 'prompt') return promptAnswer(input, raw);
  if (!Object.hasOwn(ANSWERS, stage)) throw badRequest();
  const parsed = ANSWERS[stage as keyof typeof ANSWERS].safeParse(input);
  if (!parsed.success) throw badRequest();
  const a = parsed.data as Obj;
  const r = raw as Obj;
  switch (stage) {
    case 'identify':
      if ('passkey' in a) {
        if (!r.passkey_challenge) throw badRequest();
        return { passkey: a.passkey };
      }
      return a.password === undefined ? { uid_field: a.identifier } : { uid_field: a.identifier, password: a.password };
    case 'mfa':
      if ('webauthn' in a) {
        const devices = Array.isArray(r.device_challenges) ? r.device_challenges.filter(isObj) : [];
        if (!devices.some((d) => d.device_class === 'webauthn')) throw badRequest();
        return { webauthn: a.webauthn };
      }
      return { code: a.code };
    default:
      return a;
  }
}

function promptAnswer(body: unknown, raw: RawChallenge): object {
  const fields = promptKeys(raw);
  if (!fields.length || !isObj(body)) throw badRequest();
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) shape[f.key] = z.string().max(f.type === 'email' ? 254 : 1024).optional();
  const parsed = z.strictObject(shape).safeParse(body);
  if (!parsed.success) throw badRequest();
  const a = parsed.data as Record<string, string | undefined>;
  if (a.password !== undefined && a.password_repeat !== undefined && a.password !== a.password_repeat) {
    throw new FlowFieldError(['password_mismatch']);
  }
  return Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined));
}
