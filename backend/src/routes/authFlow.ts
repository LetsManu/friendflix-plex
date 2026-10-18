// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The in-app sign-in routes (Block 23 phase 3): `/auth/flow/*` drives an Authentik flow through the executor (akflow.ts) and answers
 * sanitised steps (flowSteps.ts).
 *
 * - CSRF: double submit. Every POST carries `x-ff-flow-csrf` equal to the `ff_flow_csrf` cookie (set by GET /auth/flow/config); a jar that
 *   belongs to a session (`userId`) also needs that session's `x-csrf-token`. These routes are outside /api/, so the global hook in app.ts
 *   does not run here.
 * - Single-use steps: every answer names the step id it answers; the id is claimed atomically and rotated before Authentik is called, so a
 *   replay (double click, captured request) gets 409 `step_used` and Authentik sees one POST.
 * - Answers are checked against the step that was shown (its stage, and whether it offered a passkey, an inline password, a code).
 * - Rate limits: per IP (route config, counted by the plugin before the handler runs) and per account under
 *   `flowfail:<sha256(lower(identifier))>` for every jar kind, 10 failures in 15 min. An answer that carries a secret (password, code,
 *   passkey) reserves its slot atomically before Authentik is called and gives it back only when the flow moved past that stage (or
 *   Authentik never judged it), so parallel answers from many flows cannot all slip past the limit; any other answer is refused at the
 *   limit and counts only when Authentik refuses it.
 * - The end of a login or enrolment flow (completeFlow): a silent OIDC authorize with the flow's Authentik session, then the same rules
 *   as the classic `/auth/callback` (loginFinish.ts); the Authentik session is ended afterwards in every case.
 * - Recovery (Task 5): "Passwort vergessen?" starts the recovery flow with the typed identifier and answers its identification itself;
 *   the reply is "e-mail sent" whether or not the account exists. Recovery e-mails (the first and every resend) are limited per typed
 *   identifier and per IP, resends to one per minute per attempt. The e-mail link leads to the app's `/reset`, whose button calls
 *   `resume`: the token only continues Authentik's own recovery flow (`?query=flow_token=…`), FriendFlix never checks or keeps it
 *   anywhere but in the encrypted jar, and a finished recovery never signs in (`done /login?reset=1`, Authentik's session ended).
 * - Errors: codes only. Logged as `{ route, code }`, never the error object or the body (passwords, codes, credentials).
 *   Authentik unreachable or answering nonsense → `200 {stage:'unavailable'}` (the card offers retry and the classic sign-in).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  akExec, akGet, appHost, continueJar, createJar, dropJar, endAkSession, flowSlug, type Jar, JAR_TTL_S, loadJar, loginUi, passkeysInApp,
  type RawChallenge, saveJar,
} from '../akflow.js';
import {
  akDeleteDevice, akDevices, akFlowExists, akFlowUrl, akForget, akUserByUsername, akUserBySub, akUsersByEmail,
} from '../authentik.js';
import { AkUpstreamError, akLogFields } from '../akdiag.js';
import { audit } from '../audit.js';
import { secureCookies } from '../config.js';
import type { Ctx } from '../ctx.js';
import { encrypt, randomToken, sha256 } from '../crypto.js';
import {
  FlowFieldError, type FlowError, type FlowInternal, type FlowStage, type FlowStep, MAX_PENDING_USER, stepErrors, toAnswer, toStep,
  type UnavailableReason,
} from '../flowSteps.js';
import { lookupInvite } from '../invites.js';
import { type LoginOutcome, resolveLogin } from '../loginFinish.js';
import type { OidcClaims } from '../oidc.js';
import { stampReauth } from '../reauth.js';
import { COOKIE as SESSION_COOKIE, loadSession, requireOwner } from '../session.js';
import { isSetupComplete } from '../setup/state.js';
import { getUserById, getUserBySub, HttpError } from '../users.js';

/** the flow id (httpOnly, only sent to /auth/flow) */
export const FLOW_COOKIE = 'ff_flow';
/** the double-submit token, readable by the page */
export const FLOW_CSRF_COOKIE = 'ff_flow_csrf';
export const FLOW_CSRF_HEADER = 'x-ff-flow-csrf';
const FLOW_PATH = '/auth/flow';
/** failed answers per account before the next one is refused, and the window they count in */
export const MAX_FLOW_FAILURES = 10;
export const FLOW_FAIL_WINDOW_S = 900;
/** the answer keys (executor side) that carry a secret: these reserve a failure slot before Authentik sees them */
const SECRET_KEYS = ['password', 'code', 'webauthn', 'passkey'] as const;
/** internal hops answered by the backend itself (select-stage) before a step is shown */
const MAX_AUTO = 3;
/** one resend of an e-mail per attempt (jar) in this many seconds */
export const RESEND_GAP_S = 60;
/** recovery e-mails (the first and every resend) per typed identifier and per client IP, in RECOVERY_MAIL_WINDOW_S */
export const MAX_RECOVERY_MAILS_ACCOUNT = 5;
export const MAX_RECOVERY_MAILS_IP = 10;
export const RECOVERY_MAIL_WINDOW_S = 3600;

type AnswerableStep = Extract<FlowStep, { step: string }>;
type Reply = AnswerableStep & { errors?: FlowError[] } | FlowStep;

/** the per-account failure counter's key: the identifier the person typed, case-insensitive, hashed */
export const flowFailKey = (identifier: string) => `flowfail:${sha256(identifier.trim().toLowerCase())}`;
const usedStepKey = (flowId: string, step: string) => `akflow:used:${sha256(`${flowId}|${step}`)}`;
/** the recovery e-mail budgets: per typed identifier (case-insensitive, like flowFailKey) and per client IP */
export const recoveryMailKey = (identifier: string) => `recoverymail:${sha256(identifier.trim().toLowerCase())}`;
const recoveryMailIpKey = (ip: string) => `recoverymail:ip:${sha256(ip)}`;
const resendKey = (flowId: string) => `akflow:resend:${sha256(flowId)}`;

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const badRequest = () => new HttpError(400, 'bad_request');
const csrfError = () => new HttpError(403, 'csrf');
const AK_DOWN: ReadonlySet<string> = new Set(['authentik_unavailable', 'authentik_error', 'authentik_token_rejected']);

/** the reason an Authentik failure gives the browser (a class only; the admin sees the details on the status card and in the log) */
export function unavailableReason(err: unknown): UnavailableReason {
  if (err instanceof AkUpstreamError) {
    const { cls, area } = err.failure;
    if (cls === 'timeout') return 'timeout';
    if (cls === 'network') return 'unreachable';
    if (area === 'api' && (cls === 'token_invalid' || cls === 'permission')) return 'service_token';
    return 'error';
  }
  if (err instanceof HttpError && err.message === 'authentik_token_rejected') return 'service_token';
  return err instanceof HttpError && err.statusCode === 503 ? 'unreachable' : 'error';
}

/** what a re-authentication may continue with (the setup kinds and the account changes are reachable only through it) */
const THEN_KINDS = ['setup-totp', 'setup-static', 'setup-webauthn', 'change-password', 'change-email'] as const;
const StartBody = z.strictObject({
  kind: z.enum(['login', 'recovery', 'enroll', 'reauth']),
  /** reauth only: the flow that continues in the same Authentik session once the person is re-authenticated */
  then: z.enum(THEN_KINDS).optional(),
  invite: z.string().min(1).max(128).optional(),
  /** recovery only: the name typed on the password screen ("Passwort vergessen?"), answered to the identification by the backend */
  identifier: z.string().trim().min(1).max(254).optional(),
});
const ResumeBody = z.strictObject({ token: z.string().max(1024), kind: z.enum(['recovery', 'email-confirm']).optional() });
/** the new address of an e-mail change: a plausible address, at most 254 characters */
const NewEmail = z.string().trim().max(254).email();
/** where a finished re-authentication or account change returns to (phase 2's account page, preflight D6) */
const ACCOUNT_NEXT = '/me/account';
/** where the e-mail link of an e-mail change ends */
const EMAIL_CONFIRMED = '/confirm-email?ok=1';
/** the pending e-mail change shown on the account page (encrypted, 30 minutes like Authentik's link) */
export const EMAIL_CHANGE_TTL_S = 1800;
export const emailChangeKey = (userId: string) => `emailchange:${userId}`;
/** what an e-mail link token may look like (Authentik's FlowToken key: 60 letters and digits); anything else never reaches Authentik */
const LINK_TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
/** a link Authentik no longer knows (used, expired, unknown): it starts a new plan (identification) or denies the flow */
const STALE_LINK: ReadonlySet<string> = new Set(['ak-stage-identification', 'ak-stage-access-denied']);
/** what a decoy attempt shows and "re-sends" (Jar.decoy): the e-mail stage, without anything from Authentik */
const DECOY_EMAIL: RawChallenge = { component: 'ak-stage-email' };
const AnswerHead = z.object({ step: z.string().min(1).max(64), stage: z.string().min(1).max(32) });

/** the challenge as kept in the jar: what toAnswer reads, without the avatar (a data URI) and the flow's brand info */
function keptChallenge(c: RawChallenge): RawChallenge {
  const { pending_user_avatar: _avatar, flow_info: _info, ...rest } = c;
  return rest;
}

/**
 * whether the challenge after an answer is a step past the answered stage: the end of the flow, a stage answered internally, or a step
 * of another stage that is not a restart (identify). Denied, classic and the same stage again do not count as progress.
 */
function movedOn(next: FlowStep | FlowInternal, answered: FlowStage): boolean {
  if ('internal' in next) return true;
  return 'step' in next && next.stage !== answered && next.stage !== 'identify';
}

/** an answer may only use what the shown step offered (an inline password, a passkey, a code); prompt answers only the shown fields */
function checkOffered(shown: AnswerableStep, answer: Record<string, unknown>): void {
  const has = (k: string) => Object.hasOwn(answer, k);
  switch (shown.stage) {
    case 'identify':
      if ((has('passkey') && !shown.passkey) || (has('password') && !shown.passwordInline)) throw badRequest();
      return;
    case 'mfa':
      if ((has('webauthn') && !shown.passkey) || (has('code') && !shown.totp && !shown.recovery)) throw badRequest();
      return;
    case 'prompt': {
      const keys = new Set(shown.fields.map((f) => f.key));
      if (Object.keys(answer).some((k) => !keys.has(k))) throw badRequest();
      return;
    }
    default:
  }
}

/** where a finished recovery sends the person: the sign-in page with the "password changed" notice (plan Ruling 3) */
const RECOVERY_DONE = '/login?reset=1';
/** the HttpError code of an error, for the `{route, code}` log line (never the error object: it may quote a URL with a code in it) */
const errCode = (err: unknown) => (err instanceof HttpError && /^[a-z0-9_]{1,64}$/.test(err.message) ? err.message : 'internal');

/** the sign-in outcome as a flow answer (preflight D4); the cookies (`ff_sid`, `ff_pending`, `ff_restore`) are on the same response */
function outcomeStep(out: LoginOutcome): FlowStep {
  switch (out.kind) {
    case 'session': return { stage: 'done', next: out.next };
    case 'pending': return { stage: 'done', next: '/pending' };
    case 'restore': return { stage: 'done', next: '/restore' };
    case 'redirect': return { stage: 'done', next: out.to }; // the classic forgotten-PIN paths only; the flow never asks for them
    case 'account_deleted':
    case 'locked': return { stage: 'locked' };
  }
}

type SilentResult = { claims: OidcClaims } | { step: FlowStep };

/**
 * The OIDC authorize request of a finished login flow, sent with the jar's Authentik session (`prompt=none`, no forwarded host).
 * Authentik answers a 302: to the app's `/auth/callback` with a code (exchanged here with the state, nonce and PKCE verifier of this very
 * start, like the classic callback's), to its own `/if/flow/…` (an explicit-consent provider: the classic sign-in asks for it), or to the
 * callback with `error=` (`consent_required` on older releases → classic; anything else → unavailable).
 */
async function silentAuthorize(ctx: Ctx, req: FastifyRequest, jar: Jar): Promise<SilentResult> {
  const unavailable = (code: string): SilentResult => {
    req.log.warn({ route: req.routeOptions.url ?? 'unmatched', code }, 'silent authorize refused');
    return { step: { stage: 'unavailable' } };
  };
  const consent: SilentResult = { step: { stage: 'classic', reason: 'consent' } };
  const start = await ctx.oidc.start({ silent: true });
  const r = await akGet(ctx, jar, start.url);
  await r.body?.cancel().catch(() => undefined);
  let to: URL | null = null;
  try {
    to = r.status >= 300 && r.status < 400 && r.headers.get('location') ? new URL(r.headers.get('location')!, start.url) : null;
  } catch { /* an unparsable Location: unavailable below */ }
  if (!to) return unavailable('authorize_no_redirect');
  const callback = new URL('/auth/callback', ctx.cfg.PUBLIC_URL);
  if (to.origin !== callback.origin || to.pathname !== callback.pathname) {
    return /^\/(?:.*\/)?if\/flow\//.test(to.pathname) ? consent : unavailable('authorize_elsewhere');
  }
  const error = to.searchParams.get('error');
  if (error !== null) return error === 'consent_required' ? consent : unavailable('authorize_error');
  // the state must be the one this start made (openid-client checks it again, with the nonce and the PKCE verifier)
  if (!sameToken(to.searchParams.get('state') ?? '', start.state)) return unavailable('invalid_state');
  return { claims: await ctx.oidc.finish(to, { state: start.state, nonce: start.nonce, codeVerifier: start.codeVerifier }) };
}

/** a re-authentication's end: the silent authorize names the person, who must be the session's own; the session gets its stamp */
async function reauthEnd(ctx: Ctx, req: FastifyRequest, jar: Jar): Promise<'ok' | FlowStep> {
  if (!jar.userId) return { stage: 'unavailable' };
  if (!(await isSetupComplete(ctx))) return { stage: 'classic', reason: 'unsupported_stage' };
  const got = await silentAuthorize(ctx, req, jar);
  if ('step' in got) return got.step;
  const r = await stampReauth(ctx, req, got.claims, jar.userId);
  if (r === 'ok') return 'ok';
  return r === 'mismatch' ? { stage: 'denied' } : r === 'revoked' ? { stage: 'expired' } : { stage: 'unavailable' };
}

/** setup-static: the old recovery codes go once the new ones are confirmed (U4: a second run adds a device, the old codes stay valid) */
async function removeOldStatic(ctx: Ctx, req: FastifyRequest, jar: Jar): Promise<void> {
  const user = jar.userId ? await getUserById(ctx, jar.userId) : null;
  if (!user) return;
  for (const id of jar.oldStatic ?? []) {
    try {
      await akDeleteDevice(ctx, user.authentik_sub, 'static', Number(id));
    } catch (err) {
      // a device that is already gone (404) is fine; anything else leaves an old code valid, which the log line names (codes only)
      req.log.warn({ route: req.routeOptions.url ?? 'unmatched', code: errCode(err) }, 'old recovery code device not removed');
    }
  }
}

/**
 * The e-mail link of an e-mail change was followed and the flow ended: the account is the one the link named (`jar.identifier`, the
 * Authentik username), and the new address is what Authentik holds now (written by the flow's user write stage), never anything the
 * client sent. Unknown account, unusable address or an address another account took meanwhile → expired, nothing changes.
 */
async function confirmEmail(ctx: Ctx, jar: Jar): Promise<FlowStep> {
  const ak = jar.identifier ? await akUserByUsername(ctx, jar.identifier) : null;
  let user = null;
  for (const sub of ak?.subs ?? []) user ??= await getUserBySub(ctx, sub);
  const email = ak?.email.trim() ?? '';
  if (!ak || !user || user.disabled || !NewEmail.safeParse(email).success) return { stage: 'expired' };
  const taken = await ctx.db.query('select 1 from users where lower(email)=lower($1) and id<>$2', [email, user.id]);
  if (taken.rowCount) return { stage: 'expired' };
  await ctx.db.query('update users set email=$2 where id=$1', [user.id, email]);
  await audit(ctx, user.id, 'account.email', user.id, { fields: ['email'] });
  await ctx.kv.del(emailChangeKey(user.id));
  await akForget(ctx, user.authentik_sub);
  return { stage: 'done', next: EMAIL_CONFIRMED };
}

/**
 * The end of a flow (`{internal:'end'}`, preflight D4/P12):
 * - `login`/`enroll`: the silent authorize yields the person's claims, and `resolveLogin` applies exactly the classic callback's rules
 *   (approval, invites incl. the enrolment's, the admin group, deletion/restore, locks, ended access) and issues the session (`ui:'app'`).
 *   Never during setup (defence in depth behind the gate, T4-e): the first admin is created only by `/auth/callback` with the setup session.
 * - `recovery`: no session; the person signs in with the new password.
 * - `reauth` (without `then`): the silent authorize must name the session's own person (stampReauth, shared with the classic callback);
 *   the session is stamped, no new session is created. A foreign person → `denied`.
 * - `setup-*`, `change-password`: the account's changes are done; `setup-static` also removes the codes that existed before.
 * - `email-confirm`: the e-mail link's flow ended; the address Authentik now holds becomes the account's e-mail (confirmEmail).
 * Whatever happens, the Authentik session the flow created is ended and the jar dropped (the FriendFlix session, if any, is issued first).
 * A `reauth` jar with `then` does not come here: the routes continue it in the same Authentik session.
 */
export async function completeFlow(ctx: Ctx, req: FastifyRequest, reply: FastifyReply, flowId: string, jar: Jar): Promise<FlowStep> {
  try {
    if (jar.kind === 'recovery' || jar.kind === 'recovery-resume') return { stage: 'done', next: RECOVERY_DONE };
    if (jar.kind === 'email-confirm') return await confirmEmail(ctx, jar);
    if (jar.kind === 'reauth') {
      const r = await reauthEnd(ctx, req, jar);
      return r === 'ok' ? { stage: 'done', next: ACCOUNT_NEXT } : r;
    }
    if (jar.kind === 'setup-totp' || jar.kind === 'setup-static' || jar.kind === 'setup-webauthn' || jar.kind === 'change-password') {
      if (jar.kind === 'setup-static') await removeOldStatic(ctx, req, jar);
      const user = jar.userId ? await getUserById(ctx, jar.userId) : null;
      if (user) await akForget(ctx, user.authentik_sub); // the account page shows the new factor
      return { stage: 'done', next: ACCOUNT_NEXT };
    }
    if (jar.kind !== 'login' && jar.kind !== 'enroll') return { stage: 'unavailable' }; // change-email ends at its e-mail stage, not here
    if (!(await isSetupComplete(ctx))) return { stage: 'classic', reason: 'unsupported_stage' };
    const got = await silentAuthorize(ctx, req, jar);
    if ('step' in got) return got.step;
    return outcomeStep(await resolveLogin(ctx, req, reply, got.claims, { invite: jar.invite, ui: 'app' }));
  } catch (err) {
    // OIDC unavailable (503), Authentik down, a refused code exchange, a provisioning failure: no session, codes only in the log
    req.log.warn({ route: req.routeOptions.url ?? 'unmatched', code: errCode(err), ...akLogFields(err) }, 'flow completion failed');
    return jar.kind === 'email-confirm' ? { stage: 'expired' } : { stage: 'unavailable', reason: unavailableReason(err) };
  } finally {
    await endAkSession(ctx, jar);
    await dropJar(ctx, flowId);
  }
}

export function authFlowRoutes(app: FastifyInstance, ctx: Ctx) {
  const secure = () => secureCookies(ctx.cfg); // PUBLIC_URL applies live

  const setFlowCookie = (reply: FastifyReply, flowId: string) =>
    reply.setCookie(FLOW_COOKIE, flowId, { httpOnly: true, secure: secure(), sameSite: 'strict', path: FLOW_PATH, maxAge: JAR_TTL_S });
  const clearFlowCookie = (reply: FastifyReply) => reply.clearCookie(FLOW_COOKIE, { path: FLOW_PATH });

  /** the double-submit check: header and cookie present and equal (timing-safe) */
  function checkFlowCsrf(req: FastifyRequest): void {
    const cookie = req.cookies[FLOW_CSRF_COOKIE];
    const header = req.headers[FLOW_CSRF_HEADER];
    if (!cookie || typeof header !== 'string' || !sameToken(header, cookie)) throw csrfError();
  }

  /** a jar of a signed-in person (re-authentication, security actions): only that session, with its own csrf token, may drive it */
  async function checkSessionCsrf(req: FastifyRequest, jar: Jar): Promise<void> {
    if (!jar.userId) return;
    const s = await loadSession(ctx, req.cookies[SESSION_COOKIE]);
    const sent = req.headers['x-csrf-token'];
    if (!s || s.userId !== jar.userId || typeof sent !== 'string' || !sameToken(sent, s.csrf)) throw csrfError();
  }

  /**
   * Turns a challenge into the answer for the browser: internal outcomes are handled here (select-stage answered automatically, the end
   * of the flow, a link interstitial outside resume → classic consent). A step with an id is kept in the jar (`live`); any other outcome
   * ends the flow in the app and drops the jar.
   */
  async function advance(req: FastifyRequest, reply: FastifyReply, flowId: string, jar: Jar, first: RawChallenge, fresh: boolean, newEmail?: string): Promise<{ out: FlowStep; live: boolean }> {
    let challenge = first;
    for (let i = 0; i <= MAX_AUTO; i++) {
      const out = toStep(challenge, jar, jar.step, appHost(ctx.cfg), newEmail);
      if ('internal' in out) {
        if (out.internal === 'select-stage' && i < MAX_AUTO) {
          challenge = (await akExec(ctx, jar, 'POST', { selected_stage: out.pk }, req.ip)).challenge;
          continue;
        }
        if (out.internal === 'end') {
          if (jar.kind === 'reauth' && jar.then) return reauthThen(req, reply, flowId, jar);
          return { out: await completeFlow(ctx, req, reply, flowId, jar), live: false };
        }
        break; // link-confirm comes only from resume (Task 5); anything else here is a consent the app does not answer
      }
      if ('step' in out) {
        jar.last = { raw: keptChallenge(challenge), step: out };
        if (await saveJar(ctx, flowId, jar, { existing: !fresh })) return { out, live: true };
        // cancelled or replaced while Authentik answered: the jar stays gone, and so does the session this answer may have advanced
        await endAkSession(ctx, jar);
        return { out: { stage: 'expired' }, live: false };
      }
      await dropJar(ctx, flowId);
      return { out, live: false };
    }
    await dropJar(ctx, flowId);
    return { out: { stage: 'classic', reason: 'consent' }, live: false };
  }

  /**
   * A re-authentication with `then` ends: the person is checked and stamped (reauthEnd), then the same jar, now logged in to Authentik,
   * continues with the follow-up flow (setup-*, change-password, change-email) and shows its first step. A setup-static run first lists
   * the user's existing recovery-code devices, which are deleted once the new codes are confirmed (completeFlow). On any failure the
   * Authentik session is ended and the jar dropped.
   */
  async function reauthThen(req: FastifyRequest, reply: FastifyReply, flowId: string, jar: Jar): Promise<{ out: FlowStep; live: boolean }> {
    const fail = async (out: FlowStep) => {
      await endAkSession(ctx, jar);
      await dropJar(ctx, flowId);
      return { out, live: false };
    };
    try {
      const done = await reauthEnd(ctx, req, jar);
      if (done !== 'ok') return await fail(done);
      const then = jar.then!;
      let oldStatic: string[] | undefined;
      if (then === 'setup-static') {
        const user = await getUserById(ctx, jar.userId!);
        const devices = user ? await akDevices(ctx, user.authentik_sub) : null;
        if (!devices) return await fail({ stage: 'unavailable', reason: 'error' });
        oldStatic = devices.filter((d) => d.type === 'static').map((d) => d.id);
      }
      const next = continueJar(ctx.cfg, jar, then);
      for (const k of Object.keys(jar)) delete (jar as unknown as Record<string, unknown>)[k];
      Object.assign(jar, next, { step: randomToken(16), ...(oldStatic ? { oldStatic } : {}) });
      delete jar.last;
      const { challenge } = await akExec(ctx, jar, 'GET', undefined, req.ip);
      return await advance(req, reply, flowId, jar, challenge, false);
    } catch (err) {
      await endAkSession(ctx, jar);
      await dropJar(ctx, flowId);
      throw err;
    }
  }

  /**
   * Every handler answers codes only: FlowFieldError → 400 `{errors}`, Authentik down → 200 `{stage:'unavailable'}`, HttpError →
   * `{error: code}`, anything else → 500 `{error:'internal'}`. Logged as `{ route, code }` only, never the error or the body.
   */
  const guarded = (handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(req, reply);
      } catch (err) {
        const route = req.routeOptions.url ?? 'unmatched';
        if (err instanceof FlowFieldError) {
          req.log.warn({ route, code: err.message }, 'flow answer refused');
          return reply.code(400).send({ errors: err.errors });
        }
        if (err instanceof HttpError) {
          const code = /^[a-z0-9_]{1,64}$/.test(err.message) ? err.message : 'internal';
          req.log.warn({ route, code, ...akLogFields(err) }, 'flow request refused');
          if (AK_DOWN.has(code) && err.statusCode >= 500) return reply.code(200).send({ stage: 'unavailable', reason: unavailableReason(err) });
          return reply.code(err.statusCode).send({ error: code });
        }
        req.log.warn({ route, code: 'internal' }, 'flow request failed');
        return reply.code(500).send({ error: 'internal' });
      }
    };

  // What the login page needs before it renders: the mode, whether "forgot password" and enrolment exist, and a fresh csrf cookie.
  // No executor call here (the reset and confirm pages call it on mount, plan Ruling 11).
  app.get('/auth/flow/config', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, guarded(async (_req, reply) => {
    const mode = loginUi(ctx.cfg);
    const recovery = mode === 'app' ? await akFlowExists(ctx, flowSlug(ctx.cfg, 'recovery')!) : false;
    reply.setCookie(FLOW_CSRF_COOKIE, randomToken(), { httpOnly: false, secure: secure(), sameSite: 'strict', path: '/', maxAge: JAR_TTL_S });
    return { mode, recovery, enroll: mode === 'app' && flowSlug(ctx.cfg, 'enroll') !== undefined };
  }));

  app.post('/auth/flow/start', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, guarded(async (req, reply) => {
    checkFlowCsrf(req);
    const parsed = StartBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest();
    const body = parsed.data;
    if (body.identifier !== undefined && body.kind !== 'recovery') throw badRequest();
    if (body.then !== undefined && body.kind !== 'reauth') throw badRequest();
    if (loginUi(ctx.cfg) !== 'app') throw new HttpError(409, 'classic');
    if (body.kind === 'reauth') return startReauth(req, reply, body.then);
    let init: Partial<Pick<Jar, 'query' | 'invite'>> = {};
    if (body.kind === 'enroll') {
      // enrolment runs with the Authentik invitation of a portal invite; the invite also travels to the end of the flow (preflight P16)
      const inv = body.invite ? await lookupInvite(ctx, body.invite) : null;
      if (!inv?.authentik_invite) throw new HttpError(410, 'invite_invalid');
      init = { query: `itoken=${encodeURIComponent(inv.authentik_invite)}`, invite: body.invite };
    } else if (body.invite !== undefined) {
      if (body.kind !== 'login') throw badRequest();
      if (!(await lookupInvite(ctx, body.invite))) throw new HttpError(410, 'invite_invalid');
      init = { invite: body.invite };
    }
    const old = await forgetPrevious(req);
    const jar = await createJar(ctx, body.kind, { ...init, step: randomToken(16) });
    const flowId = randomToken();
    const { challenge } = await akExec(ctx, jar, 'GET', undefined, req.ip);
    const { out, live } = await advance(req, reply, flowId, jar, challenge, true);
    if (live) setFlowCookie(reply, flowId);
    else if (old) clearFlowCookie(reply);
    // "Passwort vergessen?": the name from the password screen answers the identification right away (normally → email-sent)
    if (body.identifier !== undefined && live && out.stage === 'identify') {
      return answerStep(req, reply, flowId, jar, 'identify', { identifier: body.identifier });
    }
    return out;
  }));

  /**
   * A re-authentication of the signed-in person (owner profile): needs the session and its `x-csrf-token` (these routes are outside /api/,
   * so the global hook does not run; the jar does not exist yet to check it later). The backend answers the identification with the
   * person's Authentik username itself, so the first step is the password (or the second factor, or a passkey). With `then` the follow-up
   * flow is checked up front: a passkey setup needs passkeys in-app (else 409 `passkey_classic`: the web uses the classic page), an
   * e-mail change needs its flow in Authentik.
   */
  async function startReauth(req: FastifyRequest, reply: FastifyReply, then: (typeof THEN_KINDS)[number] | undefined) {
    await requireOwner(ctx)(req, reply);
    if (reply.sent) return reply;
    const sent = req.headers['x-csrf-token'];
    if (typeof sent !== 'string' || !sameToken(sent, req.session!.csrf)) throw csrfError();
    const user = req.user!;
    if (then === 'setup-webauthn' && !(await passkeysInApp(ctx))) throw new HttpError(409, 'passkey_classic');
    if (then === 'change-email' && !(await akFlowExists(ctx, flowSlug(ctx.cfg, 'change-email')!))) throw new HttpError(409, 'flow_not_configured');
    const identifier = await reauthIdentifier(req, user);
    const old = await forgetPrevious(req);
    const jar = await createJar(ctx, 'reauth', { userId: user.id, identifier, ...(then ? { then } : {}), step: randomToken(16) });
    const flowId = randomToken();
    let { challenge } = await akExec(ctx, jar, 'GET', undefined, req.ip);
    // an identification stage with the password inline cannot be answered without it: the person sees it (the sub check at the end holds anyway)
    if (challenge.component === 'ak-stage-identification' && challenge.password_fields !== true) {
      ({ challenge } = await akExec(ctx, jar, 'POST', { uid_field: identifier }, req.ip));
    }
    const { out, live } = await advance(req, reply, flowId, jar, challenge, true);
    if (live) setFlowCookie(reply, flowId);
    else if (old) clearFlowCookie(reply);
    return out;
  }

  /**
   * What a re-authentication answers Authentik's identification with: the Authentik username (looked up with the service token), else
   * the account's e-mail address, which the default identification stage accepts too. The fallback keeps the password change and the
   * setup flows working while the service token is refused or the lookup fails (the status card names that); the end of the flow
   * checks the person by `sub` either way (stampReauth), so an identifier never decides whose session is stamped.
   */
  async function reauthIdentifier(req: FastifyRequest, user: { authentik_sub: string; email: string | null }): Promise<string> {
    try {
      const ak = await akUserBySub(ctx, user.authentik_sub);
      if (ak) return ak.username;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      req.log.warn({ route: req.routeOptions.url ?? 'unmatched', code: errCode(err), ...akLogFields(err) }, 'reauth user lookup failed');
      if (!user.email) throw err;
    }
    if (user.email) return user.email;
    throw new HttpError(404, 'authentik_user_not_found');
  }

  // The button on /reset?token= (Ruling 11: the page itself never calls this): continues Authentik's recovery flow with the e-mail
  // link's token in a new jar. Authentik's link interstitial (the first challenge, nothing else) is answered with its own token, since the
  // click is the confirmation; then the flow goes on as usual (MFA, new password ×2). The token is only passed on to Authentik, never
  // checked, logged or answered by FriendFlix; a token Authentik does not continue (used, expired, unknown, malformed) → expired.
  app.post('/auth/flow/resume', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, guarded(async (req, reply) => {
    checkFlowCsrf(req);
    const parsed = ResumeBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest();
    if (loginUi(ctx.cfg) !== 'app') throw new HttpError(409, 'classic');
    const old = await forgetPrevious(req);
    const expired = (): FlowStep => {
      if (old) clearFlowCookie(reply);
      return { stage: 'expired' };
    };
    const { token } = parsed.data;
    if (!LINK_TOKEN.test(token)) return expired();
    const confirm = parsed.data.kind === 'email-confirm';
    const jar = await createJar(ctx, confirm ? 'email-confirm' : 'recovery-resume', { query: `flow_token=${token}`, step: randomToken(16) });
    const flowId = randomToken();
    let { challenge } = await akExec(ctx, jar, 'GET', undefined, req.ip);
    let first = toStep(challenge, jar, jar.step, appHost(ctx.cfg));
    if (confirm) {
      // the e-mail change's link: no session of any kind. The first challenge must be the link interstitial, which names the account
      // (read before it is answered); the flow must then end (its user write stage has written the address). Anything else → expired.
      if (!('internal' in first && first.internal === 'link-confirm' && first.pendingUser)) {
        await endAkSession(ctx, jar);
        return expired();
      }
      jar.identifier = first.pendingUser;
      ({ challenge } = await akExec(ctx, jar, 'POST', { token: first.token }, req.ip));
      first = toStep(challenge, jar, jar.step, appHost(ctx.cfg));
      if (!('internal' in first && first.internal === 'end')) {
        await endAkSession(ctx, jar);
        return expired();
      }
      const out = await completeFlow(ctx, req, reply, flowId, jar);
      if (old) clearFlowCookie(reply);
      return out;
    }
    if ('internal' in first && first.internal === 'link-confirm') {
      if (first.pendingUser) jar.identifier = first.pendingUser; // the account the link belongs to: its failure counter (codes)
      ({ challenge } = await akExec(ctx, jar, 'POST', { token: first.token }, req.ip));
      first = toStep(challenge, jar, jar.step, appHost(ctx.cfg));
    }
    // a link Authentik does not continue, or a plan that ends before a new password was set: no reset happened
    if (STALE_LINK.has(challenge.component) || ('internal' in first && first.internal === 'end')) {
      await endAkSession(ctx, jar);
      return expired();
    }
    const named = challenge.pending_user;
    if (!jar.identifier && typeof named === 'string' && named && named.length <= MAX_PENDING_USER) jar.identifier = named;
    const { out, live } = await advance(req, reply, flowId, jar, challenge, true);
    if (live) setFlowCookie(reply, flowId);
    else if (old) clearFlowCookie(reply);
    return out;
  }));

  app.post('/auth/flow/answer', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, guarded(async (req, reply): Promise<Reply> => {
    checkFlowCsrf(req);
    const raw = req.body;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw badRequest();
    const head = AnswerHead.safeParse(raw);
    if (!head.success) throw badRequest();
    const { step: _s, stage: _st, ...given } = raw as Record<string, unknown>;
    if (loginUi(ctx.cfg) !== 'app') throw new HttpError(409, 'classic');
    const flowId = req.cookies[FLOW_COOKIE];
    // older than 600 s, never started, or already finished: nothing reaches Authentik
    const jar = flowId ? await loadJar(ctx, flowId) : null;
    if (!flowId || !jar?.last) {
      if (flowId) clearFlowCookie(reply);
      return { stage: 'expired' };
    }
    await checkSessionCsrf(req, jar);
    if (!sameToken(head.data.step, jar.step)) throw new HttpError(409, 'step_used');
    return answerStep(req, reply, flowId, jar, head.data.stage, given);
  }));

  /**
   * Answers the step a live jar shows: the answer route, and a recovery start with an identifier. Checked against the shown step, made
   * single use, rate limited (per account, and for e-mails per account and IP), then sent to Authentik; the next challenge is advanced.
   */
  async function answerStep(req: FastifyRequest, reply: FastifyReply, flowId: string, jar: Jar, stage: string, given: Record<string, unknown>): Promise<Reply> {
    if (!jar.last) throw badRequest();
    const shown = jar.last.step;
    if (stage !== shown.stage) throw badRequest();
    checkOffered(shown, given);
    let answer = toAnswer(shown.stage, given, jar.last.raw); // 400 bad_request / password_mismatch, before anything is used up
    const typed = (answer as { uid_field?: unknown }).uid_field;
    const identifier = shown.stage === 'identify' && typeof typed === 'string' ? typed : jar.identifier;
    // single use: the step is claimed atomically (a concurrent replay loses here) and rotated before Authentik is called
    if (!(await ctx.kv.setnx(usedStepKey(flowId, jar.step), '1', JAR_TTL_S))) throw new HttpError(409, 'step_used');
    jar.step = randomToken(16);
    jar.last = { ...jar.last, step: { ...shown, step: jar.step } };
    if (identifier !== undefined) jar.identifier = identifier;
    // only while the jar is still stored: an answer racing a cancel or a new start never brings it back
    if (!(await saveJar(ctx, flowId, jar, { existing: true }))) {
      clearFlowCookie(reply);
      return { stage: 'expired' };
    }
    // e-mail change: the new address is checked before Authentik or a mail budget is touched (a refused address uses up nothing but the step)
    let newEmail: string | undefined;
    if (jar.kind === 'change-email' && shown.stage === 'prompt') {
      const bad = await checkNewEmail(jar, (answer as { email?: unknown }).email);
      if (bad) return { ...jar.last.step, errors: [bad] };
      newEmail = String((answer as { email: string }).email).trim();
      answer = { ...answer, email: newEmail };
    }
    const limited = (): Reply => ({ ...jar.last!.step, errors: ['rate_limited'] });
    const failKey = identifier ? flowFailKey(identifier) : null;
    // a secret reserves its failure slot first (atomic incr): of N parallel answers at the limit, at most the free slots reach Authentik
    const reserved = failKey !== null && SECRET_KEYS.some((k) => Object.hasOwn(answer, k));
    if (failKey && reserved) {
      if ((await ctx.kv.incr(failKey, FLOW_FAIL_WINDOW_S)) > MAX_FLOW_FAILURES) {
        await ctx.kv.decr(failKey);
        return limited();
      }
    } else if (failKey && Number((await ctx.kv.get(failKey)) ?? 0) >= MAX_FLOW_FAILURES) {
      return limited();
    }
    // e-mails: a recovery identification sends the reset mail, every answer on the e-mail stage re-sends it. One resend a minute per
    // attempt, and a budget per typed name and per IP; neither depends on whether the account exists.
    const mails = shown.stage === 'email-sent' || (shown.stage === 'identify' && jar.kind === 'recovery') || newEmail !== undefined;
    let budget: string[] = [];
    if (mails) {
      if (shown.stage === 'email-sent' && !(await ctx.kv.setnx(resendKey(flowId), '1', RESEND_GAP_S))) return limited();
      const taken = await takeMailBudget(identifier, req.ip);
      if (!taken) return limited();
      budget = taken;
    }
    let challenge: RawChallenge;
    try {
      // a decoy attempt never asks Authentik again: a resend there must look like any other
      challenge = jar.decoy ? DECOY_EMAIL : (await akExec(ctx, jar, 'POST', answer, req.ip)).challenge;
    } catch (err) {
      if (failKey && reserved) await ctx.kv.decr(failKey); // Authentik never judged it (unreachable, transport error)
      for (const k of budget) await ctx.kv.decr(k); // no mail went out
      throw err;
    }
    if (newEmail !== undefined) {
      if (challenge.component !== 'ak-stage-email') for (const k of budget) await ctx.kv.decr(k); // Authentik sent no mail
      else return emailRequested(reply, flowId, jar, challenge, newEmail);
    }
    if (jar.kind === 'recovery' && shown.stage === 'identify' && challenge.component === 'ak-stage-identification') {
      // an identification stage without "pretend user exists" refused the name: answer exactly as for an existing account
      jar.decoy = true;
      challenge = DECOY_EMAIL;
    }
    // a wrong password, code or passkey counts; the e-mail stage's resend notice is no error (stepErrors skips it)
    const errors = stepErrors(challenge);
    // a reserved slot goes back only when the flow moved past the answered stage (Task 3 review N1): a denial, a restart or an answer
    // the app cannot continue keeps it, like a refused secret
    if (failKey && reserved && !errors.length && movedOn(toStep(challenge, jar, jar.step, appHost(ctx.cfg)), shown.stage)) await ctx.kv.decr(failKey);
    else if (failKey && !reserved && errors.length) await ctx.kv.incr(failKey, FLOW_FAIL_WINDOW_S);
    const { out, live } = await advance(req, reply, flowId, jar, challenge, false);
    if (!live) clearFlowCookie(reply);
    // a mail went out: the next resend waits a minute from now
    else if (mails && out.stage === 'email-sent') await ctx.kv.set(resendKey(flowId), '1', RESEND_GAP_S);
    return errors.length && 'step' in out ? { ...out, errors } : out;
  }

  /**
   * The new address of an e-mail change: a plausible address (zod, ≤ 254) that differs from the current one → `invalid`, and that no
   * other FriendFlix account (`users.email`, case-insensitive) or Authentik user has → `email_in_use`. Null when it is fine.
   */
  async function checkNewEmail(jar: Jar, typed: unknown): Promise<FlowError | null> {
    if (typeof typed !== 'string' || !typed.trim()) return 'required';
    const parsed = NewEmail.safeParse(typed);
    if (!parsed.success) return 'invalid';
    const email = parsed.data;
    const me = jar.userId ? await getUserById(ctx, jar.userId) : null;
    if (!me) throw new HttpError(401, 'unauthenticated');
    if ((me.email ?? '').toLowerCase() === email.toLowerCase()) return 'invalid';
    const other = await ctx.db.query('select 1 from users where lower(email)=lower($1) and id<>$2', [email, me.id]);
    if (other.rowCount) return 'email_in_use';
    const mine = await akUserBySub(ctx, me.authentik_sub);
    if ((await akUsersByEmail(ctx, email)).some((u) => u.pk !== mine?.pk)) return 'email_in_use';
    return null;
  }

  /**
   * Authentik sent the confirmation link to the new address: the answer is the masked address. The link works without a session, so the
   * Authentik session is ended and the jar dropped now. The address is kept encrypted for 30 minutes, only to show "confirmation pending"
   * on the account page; the audit row lists field names, never addresses.
   */
  async function emailRequested(reply: FastifyReply, flowId: string, jar: Jar, challenge: RawChallenge, newEmail: string): Promise<FlowStep> {
    const out = toStep(challenge, jar, randomToken(16), appHost(ctx.cfg), newEmail);
    await endAkSession(ctx, jar);
    await dropJar(ctx, flowId);
    clearFlowCookie(reply);
    await ctx.kv.set(emailChangeKey(jar.userId!), encrypt(ctx.encKey, newEmail), EMAIL_CHANGE_TTL_S);
    await audit(ctx, jar.userId!, 'account.email_requested', jar.userId!, { fields: ['email'] });
    return 'step' in out ? out : { stage: 'unavailable' };
  }

  /**
   * Takes one recovery e-mail from the per-IP budget and, when a name was typed, from that name's budget. Null when either is used up
   * (nothing is taken then); otherwise the keys taken, to give back when the mail could not be sent.
   */
  async function takeMailBudget(identifier: string | undefined, ip: string): Promise<string[] | null> {
    const budgets: Array<[string, number]> = [[recoveryMailIpKey(ip), MAX_RECOVERY_MAILS_IP]];
    if (identifier) budgets.push([recoveryMailKey(identifier), MAX_RECOVERY_MAILS_ACCOUNT]);
    const taken: string[] = [];
    for (const [key, max] of budgets) {
      taken.push(key);
      if ((await ctx.kv.incr(key, RECOVERY_MAIL_WINDOW_S)) > max) {
        for (const k of taken) await ctx.kv.decr(k);
        return null;
      }
    }
    return taken;
  }

  /** one attempt per browser: a new start or resume ends the previous attempt (its Authentik session too) and forgets its jar */
  async function forgetPrevious(req: FastifyRequest): Promise<string | undefined> {
    const old = req.cookies[FLOW_COOKIE];
    if (old) {
      const prev = await loadJar(ctx, old);
      if (prev) await endAkSession(ctx, prev);
      await dropJar(ctx, old);
    }
    return old;
  }

  // The fallback of Ruling 1 (passkeys cannot run in-app): the person registers a passkey on Authentik's own page. A redirect to the
  // browser-facing issuer origin (AUTHENTIK_URL may be internal), for the signed-in owner only.
  app.get('/auth/flow/classic/webauthn-setup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, guarded(async (req, reply) => {
    await requireOwner(ctx)(req, reply);
    if (reply.sent) return reply;
    const url = akFlowUrl(ctx.cfg, flowSlug(ctx.cfg, 'setup-webauthn')!);
    if (!url) throw new HttpError(409, 'flow_not_configured');
    return reply.redirect(url);
  }));

  // Gives up the attempt: Authentik's session (if any) is ended, the jar deleted, the cookies cleared.
  app.post('/auth/flow/cancel', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, guarded(async (req, reply) => {
    checkFlowCsrf(req);
    const flowId = req.cookies[FLOW_COOKIE];
    const jar = flowId ? await loadJar(ctx, flowId) : null;
    if (flowId && jar) {
      await checkSessionCsrf(req, jar);
      await endAkSession(ctx, jar);
      await dropJar(ctx, flowId);
    }
    clearFlowCookie(reply);
    reply.clearCookie(FLOW_CSRF_COOKIE, { path: '/' });
    return { ok: true };
  }));
}
