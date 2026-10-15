// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Authentik flow executor client (Block 23 phase 3, in-app login): the backend plays the browser towards
 * `/api/v3/flows/executor/<slug>/` and keeps one cookie jar per sign-in attempt, encrypted in kv for at most 10 minutes.
 *
 * Secrets: the jar's cookies (Authentik's session) never leave the backend; they are stored only encrypted (APP_ENC_KEY).
 * Errors are HttpErrors with a code only (`authentik_unavailable` 503, `authentik_error` 502): neither a URL, a cookie nor
 * an Authentik response body ever ends up in a message, so nothing can leak into logs or answers.
 *
 * Besides the executor, this module makes one anonymous call: the forwarded-host discovery probe (probeForwardedHost),
 * which decides whether passkeys can run on the app's own host (plan Ruling 1). The admin API stays in authentik.ts.
 */
import type { Config } from './config.js';
import type { Ctx } from './ctx.js';
import { decrypt, encrypt, sha256 } from './crypto.js';
import type { FlowStep } from './flowSteps.js';
import { akBase } from './invites.js';
import { HttpError } from './users.js';

export type FlowKind =
  | 'login' | 'recovery' | 'recovery-resume' | 'enroll' | 'reauth'
  | 'setup-totp' | 'setup-static' | 'setup-webauthn' | 'change-password' | 'change-email' | 'email-confirm';

/** the kinds that can meet WebAuthn (Ruling 1); recovery, enrolment and the e-mail flows never forward the app host */
export const FORWARD_HOST_KINDS: readonly FlowKind[] = ['login', 'reauth', 'setup-webauthn'];

/** one sign-in attempt: Authentik's cookies plus where the flow stands */
export interface Jar {
  cookies: Record<string, string>;
  slug: string;
  /** the executor's `query` (the flow's own query string, e.g. `next=%2F` or `itoken=…`), sent URL-encoded once more */
  query: string;
  kind: FlowKind;
  /** epoch ms; the jar ends 600 s after this, however often it is saved */
  createdAt: number;
  /** the single-use step id the client must answer next (the routes rotate it) */
  step: string;
  /** challenges received so far (akExec counts them): 1 = the jar's first challenge */
  challenges: number;
  identifier?: string;
  invite?: string;
  userId?: string;
  then?: FlowKind;
  /** setup-static: the ids of the user's static (recovery code) devices before the flow ran; exactly these are deleted once the new codes are confirmed */
  oldStatic?: string[];
  /**
   * a recovery whose identification Authentik refused (a stage without "pretend user exists"): the person sees "e-mail sent" like
   * everyone else, and resends never reach Authentik, so the answer does not tell whether the account exists (Task 5)
   */
  decoy?: boolean;
  /** whether executor calls forward the app host (fixed when the jar is created) */
  forwardHost: boolean;
  /**
   * the step the browser was shown last and the challenge it came from (avatar and flow info left out): an answer is checked against
   * these (its stage, what the step offered) before anything reaches Authentik
   */
  last?: { raw: RawChallenge; step: Extract<FlowStep, { step: string }> };
}

/** an executor challenge as Authentik sends it (only `component` is guaranteed; the sanitiser reads the rest) */
export interface RawChallenge {
  component: string;
  flow_info?: { title?: string; background?: string; cancel_url?: string; layout?: string };
  response_errors?: Record<string, Array<{ string?: string; code?: string }>>;
  pending_user?: string;
  pending_user_avatar?: string;
  [key: string]: unknown;
}

/** seconds a jar lives, counted from `createdAt` (never extended) */
export const JAR_TTL_S = 600;
const EXEC_TIMEOUT_MS = 8_000;
const PROBE_TIMEOUT_MS = 3_000;
/** a probe answer is kept this long; an unreachable Authentik is asked again sooner */
const PROBE_TTL_S = 600;
const PROBE_UNREACHABLE_TTL_S = 60;
/** 302s to the executor itself followed per call (2 observed on 2026.8.3) */
const MAX_HOPS = 5;

type FlowCtx = Pick<Ctx, 'cfg' | 'kv' | 'fetchImpl'>;
type JarCtx = Pick<Ctx, 'kv' | 'encKey'>;

/** which sign-in UI the app uses: the setting, else the app's own screens whenever the Authentik API is configured */
export function loginUi(cfg: Pick<Config, 'LOGIN_UI' | 'AUTHENTIK_URL' | 'AUTHENTIK_API_TOKEN'>): 'app' | 'authentik' {
  return cfg.LOGIN_UI ?? (cfg.AUTHENTIK_URL && cfg.AUTHENTIK_API_TOKEN ? 'app' : 'authentik');
}

type SlugCfg = Pick<Config, 'AUTHENTIK_LOGIN_FLOW' | 'AUTHENTIK_RECOVERY_FLOW' | 'AUTHENTIK_ENROLL_FLOW' | 'AUTHENTIK_TOTP_SETUP_FLOW'
  | 'AUTHENTIK_STATIC_SETUP_FLOW' | 'AUTHENTIK_WEBAUTHN_SETUP_FLOW' | 'AUTHENTIK_PASSWORD_CHANGE_FLOW' | 'AUTHENTIK_EMAIL_CHANGE_FLOW'>;

/**
 * The flow slug for a kind; undefined when it has none (enrolment without AUTHENTIK_ENROLL_FLOW). The two `opt` keys fall back to
 * their registry defaults like authentik.ts does; `email-confirm` continues the e-mail change flow, `recovery-resume` the recovery flow.
 */
export function flowSlug(cfg: SlugCfg, kind: FlowKind): string | undefined {
  switch (kind) {
    case 'login':
    case 'reauth': return cfg.AUTHENTIK_LOGIN_FLOW || 'default-authentication-flow';
    case 'recovery':
    case 'recovery-resume': return cfg.AUTHENTIK_RECOVERY_FLOW || 'default-recovery-flow';
    case 'enroll': return cfg.AUTHENTIK_ENROLL_FLOW || undefined;
    case 'setup-totp': return cfg.AUTHENTIK_TOTP_SETUP_FLOW || 'default-authenticator-totp-setup';
    case 'setup-static': return cfg.AUTHENTIK_STATIC_SETUP_FLOW || 'default-authenticator-static-setup';
    case 'setup-webauthn': return cfg.AUTHENTIK_WEBAUTHN_SETUP_FLOW || 'default-authenticator-webauthn-setup';
    case 'change-password': return cfg.AUTHENTIK_PASSWORD_CHANGE_FLOW || 'default-password-change';
    case 'change-email':
    case 'email-confirm': return cfg.AUTHENTIK_EMAIL_CHANGE_FLOW || 'friendflix-email-change';
  }
}

const publicUrl = (cfg: Pick<Config, 'PUBLIC_URL'>): URL | null => {
  try {
    return cfg.PUBLIC_URL ? new URL(cfg.PUBLIC_URL) : null;
  } catch {
    return null;
  }
};

/** the app's host name (the WebAuthn RP ID when passkeys run in-app); null while PUBLIC_URL is unset (setup) */
export function appHost(cfg: Pick<Config, 'PUBLIC_URL'>): string | null {
  return publicUrl(cfg)?.hostname || null;
}

// ---------------------------------------------------------------------------------------------------------------------------
// passkeys in-app: preconditions and the forwarded-host probe

export type PasskeysReason = 'ok' | 'disabled' | 'not_https' | 'not_configured' | 'forwarded_host_ignored' | 'probe_not_found' | 'unreachable';
/** `not_found`: Authentik answered 404 (the issuer path names no application) */
export type ForwardedHostProbe = 'honoured' | 'ignored' | 'not_found' | 'unreachable';
const PROBES: ReadonlySet<string> = new Set(['honoured', 'ignored', 'not_found', 'unreachable']);
/** probes running in this process, by cache key: concurrent first callers share one request */
const probing = new Map<string, Promise<ForwardedHostProbe>>();

/**
 * Whether Authentik takes `X-Forwarded-Host` from this backend: an anonymous `GET <issuer path>.well-known/openid-configuration` on
 * AUTHENTIK_URL (the address the executor calls use) with the app host forwarded. The answer's `issuer` is on the app host exactly when
 * Authentik trusts the caller (verified on 2026.8.3). 3 s timeout; network errors and odd answers count as `unreachable`.
 * Cached in kv under a hash of its inputs (PUBLIC_URL, OIDC_ISSUER, AUTHENTIK_URL), so a changed setting is never answered from a stale
 * entry: 10 min, `unreachable` 1 min.
 */
export async function probeForwardedHost(ctx: FlowCtx): Promise<ForwardedHostProbe> {
  const { PUBLIC_URL, OIDC_ISSUER, AUTHENTIK_URL } = ctx.cfg;
  const app = publicUrl(ctx.cfg);
  let target: URL;
  try {
    const issuer = new URL(OIDC_ISSUER);
    target = new URL(`${issuer.pathname.replace(/\/?$/, '/')}.well-known/openid-configuration`, `${akBase(AUTHENTIK_URL ?? '')}/`);
  } catch {
    return 'unreachable';
  }
  if (!app) return 'unreachable';
  const key = `akflow:fwdhost:${sha256(`${PUBLIC_URL}|${OIDC_ISSUER}|${AUTHENTIK_URL}`)}`;
  const hit = await ctx.kv.get(key);
  if (hit && PROBES.has(hit)) return hit as ForwardedHostProbe;
  const running = probing.get(key);
  if (running) return running;
  const run = runProbe(ctx, target, app, key).finally(() => probing.delete(key));
  probing.set(key, run);
  return run;
}

async function runProbe(ctx: FlowCtx, target: URL, app: URL, key: string): Promise<ForwardedHostProbe> {
  let result: ForwardedHostProbe = 'unreachable';
  try {
    const r = await ctx.fetchImpl(target, {
      headers: { accept: 'application/json', 'x-forwarded-host': app.host, 'x-forwarded-proto': app.protocol.slice(0, -1) },
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (r.ok && !tooLarge(r)) {
      const issuer = ((await r.json()) as { issuer?: unknown }).issuer;
      if (typeof issuer === 'string') result = issuer.startsWith(`${app.protocol}//${app.host}/`) ? 'honoured' : 'ignored';
    } else {
      if (r.status === 404) result = 'not_found';
      await r.body?.cancel().catch(() => undefined);
    }
  } catch {
    result = 'unreachable'; // the cause may quote the request: never kept
  }
  await ctx.kv.set(key, result, result === 'unreachable' || result === 'not_found' ? PROBE_UNREACHABLE_TTL_S : PROBE_TTL_S);
  return result;
}

/**
 * Whether passkey ceremonies can run on the app's own pages, and why not (the status check reports the reason).
 * Order: PASSKEYS_IN_APP=off, then PUBLIC_URL https (or localhost), then an Authentik URL, then the cached probe.
 */
export async function passkeysStatus(ctx: FlowCtx): Promise<{ inApp: boolean; reason: PasskeysReason }> {
  if (ctx.cfg.PASSKEYS_IN_APP === 'off') return { inApp: false, reason: 'disabled' };
  const app = publicUrl(ctx.cfg);
  if (!app || (app.protocol !== 'https:' && app.hostname !== 'localhost')) return { inApp: false, reason: 'not_https' };
  if (!ctx.cfg.AUTHENTIK_URL) return { inApp: false, reason: 'not_configured' };
  const probe = await probeForwardedHost(ctx);
  if (probe === 'honoured') return { inApp: true, reason: 'ok' };
  return { inApp: false, reason: probe === 'ignored' ? 'forwarded_host_ignored' : probe === 'not_found' ? 'probe_not_found' : 'unreachable' };
}

export async function passkeysInApp(ctx: FlowCtx): Promise<boolean> {
  return (await passkeysStatus(ctx)).inApp;
}

// ---------------------------------------------------------------------------------------------------------------------------
// the jar

/**
 * A new jar for a flow kind; `forwardHost` is decided here once (FORWARD_HOST_KINDS and passkeysInApp). 409 `flow_not_configured`
 * when the kind has no slug.
 */
export async function createJar(ctx: FlowCtx, kind: FlowKind, init: Partial<Pick<Jar, 'query' | 'identifier' | 'invite' | 'userId' | 'then' | 'step'>> = {}): Promise<Jar> {
  const slug = flowSlug(ctx.cfg, kind);
  if (!slug) throw new HttpError(409, 'flow_not_configured');
  const forwardHost = FORWARD_HOST_KINDS.includes(kind) && (await passkeysInApp(ctx));
  return { cookies: {}, slug, query: '', step: '', ...init, kind, createdAt: Date.now(), challenges: 0, forwardHost };
}

/**
 * The jar continues with another flow in the same Authentik session (a `reauth` jar's `then`): new slug, kind and challenge count,
 * the same cookies and age. `forwardHost` is inherited only by kinds that can meet WebAuthn (setup-webauthn forwards exactly when the
 * re-authentication did); every other kind, the e-mail change above all, never forwards the app host (Ruling 1: it changes Authentik's
 * brand lookup and the links in its mails).
 */
export function continueJar(cfg: SlugCfg, jar: Jar, kind: FlowKind): Jar {
  const slug = flowSlug(cfg, kind);
  if (!slug) throw new HttpError(409, 'flow_not_configured');
  const { then: _then, ...rest } = jar;
  return { ...rest, kind, slug, query: '', challenges: 0, forwardHost: jar.forwardHost && FORWARD_HOST_KINDS.includes(kind) };
}

const jarKey = (flowId: string) => `akflow:${sha256(flowId)}`;
const jarAgeMs = (jar: Jar, now = Date.now()) => now - jar.createdAt;

/**
 * Stores the jar encrypted under `akflow:<sha256(flowId)>` for what is left of its 600 s; an expired jar is dropped instead (false).
 * `existing`: only while the jar is still stored (an answer racing a cancel or a new start never brings a dropped jar back); false when
 * it is gone.
 */
export async function saveJar(ctx: JarCtx, flowId: string, jar: Jar, opts: { existing?: boolean } = {}): Promise<boolean> {
  const left = Math.ceil(JAR_TTL_S - jarAgeMs(jar) / 1000);
  if (left <= 0) {
    await ctx.kv.del(jarKey(flowId));
    return false;
  }
  // the plaintext names its flow id (hashed): a blob copied to another flow's key does not load there
  const blob = encrypt(ctx.encKey, JSON.stringify({ fid: sha256(flowId), jar }));
  if (opts.existing) return ctx.kv.replace(jarKey(flowId), blob, left);
  await ctx.kv.set(jarKey(flowId), blob, left);
  return true;
}

/** The jar of a flow id; null when missing, unreadable or older than 600 s. */
export async function loadJar(ctx: JarCtx, flowId: string): Promise<Jar | null> {
  const blob = await ctx.kv.get(jarKey(flowId));
  if (!blob) return null;
  let jar: Jar | undefined;
  try {
    const box = JSON.parse(decrypt(ctx.encKey, blob)) as { fid?: string; jar?: Jar };
    jar = box.fid === sha256(flowId) ? box.jar : undefined;
  } catch {
    return null; // another key or a damaged entry: a fresh start, never an error
  }
  if (!jar || typeof jar.createdAt !== 'number' || jarAgeMs(jar) > JAR_TTL_S * 1000) {
    await ctx.kv.del(jarKey(flowId));
    return null;
  }
  return { ...jar, challenges: jar.challenges ?? 0 };
}

export async function dropJar(ctx: Pick<Ctx, 'kv'>, flowId: string): Promise<void> {
  await ctx.kv.del(jarKey(flowId));
}

// ---------------------------------------------------------------------------------------------------------------------------
// HTTP

const cookieHeader = (jar: Jar) => Object.entries(jar.cookies).map(([k, v]) => `${k}=${v}`).join('; ');

/** Merges `Set-Cookie` answers into the jar; an empty value, `Max-Age<=0` or an `Expires` in the past deletes the cookie. */
export function absorbCookies(jar: Jar, r: Response, now = Date.now()): void {
  for (const line of r.headers.getSetCookie()) {
    const [pair = '', ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    let gone = value === '' || value === '""';
    for (const a of attrs) {
      const [k = '', v = ''] = a.split('=').map((s) => s.trim());
      if (/^max-age$/i.test(k) && Number(v) <= 0) gone = true;
      if (/^expires$/i.test(k) && Date.parse(v) <= now) gone = true;
    }
    if (gone) delete jar.cookies[name];
    else jar.cookies[name] = value;
  }
}

const akRoot = (cfg: Pick<Config, 'AUTHENTIK_URL'>): URL => {
  if (!cfg.AUTHENTIK_URL) throw new HttpError(503, 'authentik_unavailable');
  try {
    return new URL(`${akBase(cfg.AUTHENTIK_URL)}/`);
  } catch {
    throw new HttpError(503, 'authentik_unavailable');
  }
};

/** challenges are a few KB; a declared body over 1 MB (a misconfigured URL streaming something else) is refused unread */
const MAX_BODY = 1_000_000;
const tooLarge = (r: Response) => Number(r.headers.get('content-length') ?? 0) > MAX_BODY;

const resolveUrl = (to: string | null, base: URL): URL | null => {
  try {
    return to ? new URL(to, base) : null;
  } catch {
    return null;
  }
};

/** fetch that turns every network failure (refused, DNS, timeout) into 503 without its cause, which may quote the request */
async function send(ctx: FlowCtx, url: URL, init: RequestInit): Promise<Response> {
  try {
    return await ctx.fetchImpl(url, { ...init, redirect: 'manual' });
  } catch {
    throw new HttpError(503, 'authentik_unavailable');
  }
}

/**
 * One executor exchange: GET (read the current challenge) or POST (answer it), following Authentik's 302s to the executor itself
 * with a GET (at most 5). Cookies from every answer go into the jar, and `jar.challenges` counts the challenge received.
 * - forwardHost jars send `x-forwarded-host/-proto` and `origin` = the app origin on every call (Authentik then issues WebAuthn
 *   challenges for the app host).
 * - Logged-in jars (`authentik_csrf` present) send `x-authentik-csrf` on POSTs, with `origin` and `referer` on the effective host
 *   (the app when forwarding, else AUTHENTIK_URL): Authentik refuses a session-authenticated POST without them (a 500 HTML page).
 * 8 s in all. Network errors → 503 `authentik_unavailable`; a 5xx, a non-JSON answer, a redirect elsewhere or a body without
 * `component` → 502 `authentik_error`.
 */
export async function akExec(ctx: FlowCtx, jar: Jar, method: 'GET' | 'POST', body?: object, clientIp?: string): Promise<{ challenge: RawChallenge; jar: Jar }> {
  const root = akRoot(ctx.cfg);
  const path = `${root.pathname}api/v3/flows/executor/${encodeURIComponent(jar.slug)}/`;
  let url = new URL(`${path}?query=${encodeURIComponent(jar.query)}`, root);
  const app = jar.forwardHost ? publicUrl(ctx.cfg) : null;
  const signal = AbortSignal.timeout(EXEC_TIMEOUT_MS);
  let m: 'GET' | 'POST' = method;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (jar.cookies && Object.keys(jar.cookies).length) headers.cookie = cookieHeader(jar);
    if (clientIp) headers['x-forwarded-for'] = clientIp;
    if (app) Object.assign(headers, { 'x-forwarded-host': app.host, 'x-forwarded-proto': app.protocol.slice(0, -1), origin: app.origin });
    if (m === 'POST') {
      headers['content-type'] = 'application/json';
      const csrf = jar.cookies.authentik_csrf;
      if (csrf) {
        const origin = app ? app.origin : root.origin;
        Object.assign(headers, { 'x-authentik-csrf': csrf, origin, referer: `${origin}${path}` });
      }
    }
    const r = await send(ctx, url, { method: m, headers, ...(m === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}), signal });
    absorbCookies(jar, r);
    if (r.status >= 300 && r.status < 400) {
      await r.body?.cancel().catch(() => undefined);
      const to = resolveUrl(r.headers.get('location'), url);
      if (!to || to.origin !== root.origin || to.pathname !== path) throw new HttpError(502, 'authentik_error');
      url = to;
      m = 'GET';
      continue;
    }
    if (r.status >= 400 || !/json/i.test(r.headers.get('content-type') ?? '') || tooLarge(r)) {
      await r.body?.cancel().catch(() => undefined);
      throw new HttpError(502, 'authentik_error');
    }
    let challenge: RawChallenge;
    try {
      challenge = (await r.json()) as RawChallenge;
    } catch {
      throw new HttpError(502, 'authentik_error');
    }
    if (!challenge || typeof challenge !== 'object' || typeof challenge.component !== 'string') throw new HttpError(502, 'authentik_error');
    jar.challenges = (jar.challenges ?? 0) + 1;
    return { challenge, jar };
  }
  throw new HttpError(502, 'authentik_error'); // a redirect loop
}

/**
 * One GET with the jar's cookies (authorize, invalidation): `redirect: 'manual'`, so the caller reads `Location`. A relative URL is
 * resolved against AUTHENTIK_URL. It never forwards the app host: authorize must see Authentik's real host for the issuer to match.
 * The cookies go only to Authentik (the AUTHENTIK_URL or OIDC_ISSUER origin); another origin → 502 `authentik_error`.
 * Network errors → 503 `authentik_unavailable`. Cookies from the answer go into the jar.
 */
export async function akGet(ctx: FlowCtx, jar: Jar, absoluteOrRelativeUrl: string): Promise<Response> {
  const root = akRoot(ctx.cfg);
  let url: URL;
  try {
    url = new URL(absoluteOrRelativeUrl, root);
  } catch {
    throw new HttpError(502, 'authentik_error');
  }
  const allowed = new Set([root.origin]);
  try {
    allowed.add(new URL(ctx.cfg.OIDC_ISSUER).origin);
  } catch { /* no issuer yet: AUTHENTIK_URL only */ }
  if (!allowed.has(url.origin)) throw new HttpError(502, 'authentik_error');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (Object.keys(jar.cookies).length) headers.cookie = cookieHeader(jar);
  const r = await send(ctx, url, { method: 'GET', headers, signal: AbortSignal.timeout(EXEC_TIMEOUT_MS) });
  absorbCookies(jar, r);
  return r;
}

/**
 * Ends the jar's Authentik session (best effort, never throws): one GET of the invalidation flow's executor, which answers
 * `final_redirect` and deletes `authentik_session` (U3, verified on 2026.8.3). A jar without cookies has no session to end.
 */
export async function endAkSession(ctx: FlowCtx, jar: Jar): Promise<void> {
  if (!Object.keys(jar.cookies).length) return;
  try {
    const slug = ctx.cfg.AUTHENTIK_INVALIDATION_FLOW || 'default-invalidation-flow';
    const root = akRoot(ctx.cfg);
    const r = await akGet(ctx, jar, `${root.pathname}api/v3/flows/executor/${encodeURIComponent(slug)}/`);
    await r.body?.cancel().catch(() => undefined);
  } catch {
    // best effort: the jar is dropped anyway, and Authentik's session expires on its own
  }
}
