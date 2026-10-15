// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { dropRemotePeers } from './tv.js';
import { audit } from '../audit.js';
import { publicOrigin, secureCookies } from '../config.js';
import type { Ctx } from '../ctx.js';
import { authenticate, COOKIE, loadSession, newSession, rand, requireUser, saveSession } from '../session.js';
import { revokeCasts } from '../cast.js';
import { roleAllowsDownloads } from '../downloads.js';
import { effectiveLimits } from '../limits.js';
import { DEFAULT_ROLES } from '../roles.js';
import { deviceHasSession, registerDevice } from '../devices.js';
import { deletePushSubscriptions } from '../push.js';
import { claimInvite, enrollFlowUrl, inviteAccessUntil, lookupInvite, recordInviteUse, releaseInvite, type InviteRow } from '../invites.js';
import { accountJellyfinIds, deviceKidsProfile, listProfiles, publicProfile } from '../profiles.js';
import { DEVICE_COOKIE } from '../devices.js';
import { freshAuth, RESET_PIN_MAX_AGE, type OidcClaims } from '../oidc.js';
import { HttpError, accountSerial, applyRole, getUserById, getUserBySub, provisionUser } from '../users.js';
import { restoreDeletion } from '../deletion.js';
import { markReauthenticated, REAUTH_MAX_AGE } from '../reauth.js';
import { notifyAdmins } from '../notify.js';
import { pendingNoticeKey } from '../pending.js';
import { profileOnboarded } from './prefs.js';
import { publicCapabilities } from '../media/types.js';
import { requestsEnabled } from '../seerr/client.js';
import { isSetupSession, SETUP_COOKIE, SETUP_CSRF_COOKIE, setupSessionHash } from '../setup/code.js';
import { claimSetup, completeSetup, isSetupComplete, SETUP_EXPIRED } from '../setup/state.js';
import type { UserRow } from '../types.js';
import { FALLBACK_LANGUAGE, instanceLanguage, languageFromAcceptLanguage, m, profileLanguage, roleLabel } from '../i18n.js';

const OIDC_COOKIE = 'ff_oidc';
/** sign-up incl. MFA setup takes longer than a plain login */
const ENROLL_TTL = 1800;
/** a login without an invite waits for an admin: this cookie names the approval request (signed, no session) */
export const PENDING_COOKIE = 'ff_pending';
const PENDING_TTL = 30 * 86400;
/** a person who was rejected and asks again only notifies the admins again after this long */
const RENOTIFY_MS = 86400e3;
/** where a re-authentication may return to: a local path only (no `//host`, no scheme, no backslash) */
const REAUTH_NEXT = /^\/(?!\/)[A-Za-z0-9/_?=&.-]{0,200}$/;
const REAUTH_DEFAULT_NEXT = '/me/account';
const REAUTH_FAILED = '/me/account?reauth=failed';

/** The OIDC flow state kept in kv `oidc:<state>` between /auth/login (… /auth/reauth) and /auth/callback. */
interface SavedLogin {
  state: string;
  nonce: string;
  codeVerifier: string;
  invite?: string;
  resetPin?: boolean;
  /** a re-authentication of the session of `userId`: the callback only stamps that session, then returns to `next` */
  reauth?: { userId: string; next: string };
  /**
   * the first admin's sign-in (/auth/login?setup=1 during setup): sha256 of the setup session's token. The callback takes the setup
   * branch only while setup is incomplete and the same setup session finishes the login (a state planted from another one is refused).
   */
  setup?: string;
}

/**
 * a sign-in during the deletion grace period: this cookie names the account and the scheduled deletion (its date) that may be
 * restored on /restore (signed, no session); a later, different deletion of the same account is not covered by it
 */
export const RESTORE_COOKIE = 'ff_restore';
const RESTORE_TTL = 900;

const pendingMac = (ctx: Pick<Ctx, 'encKey'>, id: string) => createHmac('sha256', ctx.encKey).update(`friendflix pending v1|${id}`).digest('base64url');
const signPending = (ctx: Pick<Ctx, 'encKey'>, id: string) => `${id}.${pendingMac(ctx, id)}`;
/** The request id of a signed `ff_pending` cookie, or null when it is missing or forged. */
function verifyPending(ctx: Pick<Ctx, 'encKey'>, cookie: string | undefined): string | null {
  const [id, mac, ...rest] = (cookie ?? '').split('.');
  if (!id || !mac || rest.length) return null;
  const want = Buffer.from(pendingMac(ctx, id));
  const got = Buffer.from(mac);
  return got.length === want.length && timingSafeEqual(got, want) ? id : null;
}

const restoreMac = (ctx: Pick<Ctx, 'encKey'>, userId: string, exp: string, deletionAt: string) =>
  createHmac('sha256', ctx.encKey).update(`friendflix restore v1|${userId}|${exp}|${deletionAt}`).digest('base64url');
/** `<userId>.<exp>.<deletion_at ms>.<mac>`: valid for RESTORE_TTL, and only for the deletion scheduled at that date */
function signRestore(ctx: Pick<Ctx, 'encKey'>, userId: string, deletionAt: Date, exp = String(Math.floor(Date.now() / 1000) + RESTORE_TTL)): string {
  const at = String(deletionAt.getTime());
  return `${userId}.${exp}.${at}.${restoreMac(ctx, userId, exp, at)}`;
}
/** The account and deletion date of a signed, unexpired `ff_restore` cookie, or null when it is missing, forged or expired. */
function verifyRestore(ctx: Pick<Ctx, 'encKey'>, cookie: string | undefined): { userId: string; deletionAt: number } | null {
  const [id, exp, at, mac, ...rest] = (cookie ?? '').split('.');
  if (!id || !exp || !at || !mac || rest.length || !/^\d{1,12}$/.test(exp) || !/^\d{1,15}$/.test(at)) return null;
  const want = Buffer.from(restoreMac(ctx, id, exp, at));
  const got = Buffer.from(mac);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return Number(exp) * 1000 > Date.now() ? { userId: id, deletionAt: Number(at) } : null;
}

/**
 * The deletion date of an account that is locked for deletion, still in its grace period and not claimed by the tick; else null.
 * With `issuedFor` (a restore cookie's date) also null when the account's deletion was rescheduled since the cookie was issued.
 */
async function restorableUntil(ctx: Ctx, userId: string, issuedFor?: number): Promise<Date | null> {
  const r = await ctx.db.query<{ deletion_at: Date }>(
    `select deletion_at from users u where id=$1 and disabled and locked_reason='deletion' and deletion_at > now()
       and not exists (select 1 from account_deletions d where d.user_id=u.id)`, [userId]);
  const at = r.rows[0]?.deletion_at ?? null;
  return at && (issuedFor === undefined || at.getTime() === issuedFor) ? at : null;
}

/**
 * Records (or renews) the approval request of a person without an account and invite. The admins are notified on the
 * first request, and again when the person asks after a rejection that is older than 24 h; each such notice also brings a
 * dismissed `approvals:pending` banner back. Returns the request id.
 */
async function requestApproval(ctx: Ctx, claims: OidcClaims): Promise<string> {
  const name = claims.name ?? claims.email?.split('@')[0] ?? claims.sub;
  // one statement: concurrent logins of the same person cannot both count as the first request (Review Focus 2)
  const r = await ctx.db.query<{ id: string; inserted: boolean; prev_rejected: Date | null }>(
    `with prev as (select rejected_at from approval_requests where authentik_sub=$2)
     insert into approval_requests(id, authentik_sub, email, name) values ($1,$2,$3,$4)
     on conflict (authentik_sub) do update set email=excluded.email, name=excluded.name, rejected_at=null, reject_message=null,
       requested_at = case when approval_requests.rejected_at is null then approval_requests.requested_at else now() end
     returning id, (xmax = 0) inserted, (select rejected_at from prev) prev_rejected`,
    [randomUUID(), claims.sub, claims.email ?? null, name],
  );
  const { id, inserted, prev_rejected } = r.rows[0]!;
  if (inserted || (prev_rejected && Date.now() - prev_rejected.getTime() > RENOTIFY_MS)) {
    await notifyAdmins(ctx, { kind: 'approval', title: m('notify.approval.new', { name }), link: '/admin/users?tab=approvals' });
    await ctx.db.query('update approval_requests set notified_at=now() where id=$1', [id]);
    // the banner's fingerprint ignores the count: drop the admins' dismissals so a new request shows it again
    await ctx.db.query("delete from health_dismissals where issue_id='approvals:pending'");
  }
  return id;
}

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const secure = () => secureCookies(ctx.cfg); // PUBLIC_URL applies live

  /**
   * Starts an OIDC login; the invite (if any) travels in the server-side state to /auth/callback.
   * resetPin (forgotten owner PIN) and reauth (re-authentication of a session) force a new login at the IdP.
   */
  async function startLogin(reply: FastifyReply, invite: string | undefined, ttl: number, opts: { resetPin?: boolean; reauth?: SavedLogin['reauth']; setup?: string } = {}) {
    const s = await ctx.oidc.start({ forceLogin: Boolean(opts.resetPin || opts.reauth) });
    const saved: SavedLogin = {
      state: s.state, nonce: s.nonce, codeVerifier: s.codeVerifier, invite,
      ...(opts.resetPin ? { resetPin: true } : {}), ...(opts.reauth ? { reauth: opts.reauth } : {}), ...(opts.setup ? { setup: opts.setup } : {}),
    };
    await ctx.kv.set(`oidc:${s.state}`, JSON.stringify(saved), ttl);
    reply.setCookie(OIDC_COOKIE, s.state, { httpOnly: true, secure: secure(), sameSite: 'lax', path: '/auth', maxAge: ttl }); // binds the flow to this browser
    return s.url;
  }

  /**
   * A device that is locked to a kids profile (its ff_dev cookie or the current session's device) may never reset the owner PIN:
   * otherwise a kid who knows the account login could free itself. The owner resets from another device.
   */
  async function kidLockedDevice(req: FastifyRequest, userId?: string): Promise<boolean> {
    const ids = new Set<string>();
    const cookieDev = req.cookies[DEVICE_COOKIE];
    if (cookieDev) ids.add(cookieDev);
    const sess = await loadSession(ctx, req.cookies[COOKIE]).catch(() => null);
    if (sess?.deviceId) ids.add(sess.deviceId);
    for (const id of ids) {
      if (userId) { if (await deviceKidsProfile(ctx, userId, id)) return true; continue; }
      const r = await ctx.db.query('select 1 from devices d join profiles p on p.id=d.kids_profile_id where d.device_id=$1 and p.kids limit 1', [id]);
      if (r.rowCount) return true;
    }
    return false;
  }
  /** the profile picker explains why (no JSON error page for a person who clicked "PIN vergessen?") */
  const RESET_BLOCKED = '/profiles?pinReset=kids';
  const RESET_STALE = '/profiles?pinReset=stale';

  app.get('/auth/login', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const invite = q.invite;
    if (invite && !(await lookupInvite(ctx, invite))) return reply.code(410).send({ error: 'invite_invalid' });
    if (q.resetPin === '1' && (await kidLockedDevice(req))) return reply.redirect(RESET_BLOCKED);
    // ?setup=1: the first admin's sign-in (wizard step 5), bound to this browser's setup session; once setup is complete (or without a
    // setup session) it is a normal login
    const setup = q.setup === '1' && !(await isSetupComplete(ctx)) ? await setupSessionHash(ctx, req) : null;
    // ?resetPin=1: forgotten owner PIN -> forced re-login at the IdP, the callback then clears the owner profile's PIN
    return reply.redirect(await startLogin(reply, invite, 600, { resetPin: q.resetPin === '1', ...(setup ? { setup } : {}) }));
  });

  // Invite with Authentik enrollment: start the portal login first, then run the enrollment flow with
  // `next` = that authorize request. After sign-up (incl. MFA setup) Authentik continues the authorize
  // request and lands on /auth/callback with the invite in the state: account + portal access in one pass.
  app.get('/auth/enroll', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const invite = (req.query as Record<string, string | undefined>).invite;
    const inv = invite ? await lookupInvite(ctx, invite) : null;
    if (!invite || !inv) return reply.code(410).send({ error: 'invite_invalid' });
    if (!inv.authentik_invite || !enrollFlowUrl(ctx.cfg, inv.authentik_invite)) return reply.redirect(`/auth/login?invite=${encodeURIComponent(invite)}`);
    const authorize = await startLogin(reply, invite, ENROLL_TTL);
    return reply.redirect(enrollFlowUrl(ctx.cfg, inv.authentik_invite, authorize)!);
  });

  // Re-authentication of the current session (sensitive account actions, see reauth.ts): a forced IdP login whose
  // callback only stamps this session's `reauthAt`; it never creates a session.
  app.get('/auth/reauth', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!(await authenticate(ctx, req))) return reply.code(401).send({ error: 'unauthenticated' });
    const next = (req.query as Record<string, unknown>).next; // a repeated key is an array: refused like any other bad value
    const reauth = { userId: req.user!.id, next: typeof next === 'string' && REAUTH_NEXT.test(next) ? next : REAUTH_DEFAULT_NEXT };
    return reply.redirect(await startLogin(reply, undefined, 600, { reauth }));
  });

  /**
   * The re-authentication branch of /auth/callback: the IdP login must be fresh (auth_time) and be the same person as the
   * session that started it. No provisioning, no device, no new session.
   */
  /** The URL the IdP sent the browser back to. Without a PUBLIC_URL nobody can sign in yet: 503, like an unreachable IdP. */
  function callbackUrl(req: FastifyRequest): URL {
    if (!publicOrigin(ctx.cfg)) throw new HttpError(503, 'oidc_unavailable');
    return new URL(req.url, ctx.cfg.PUBLIC_URL);
  }
  /** a sign-in that cannot run at all (lazy OIDC 503) is answered as such, not as a failed login */
  const unavailable = (err: unknown) => err instanceof HttpError && err.statusCode === 503 && err.message === 'oidc_unavailable';

  async function finishReauth(req: FastifyRequest, reply: FastifyReply, saved: SavedLogin & { reauth: NonNullable<SavedLogin['reauth']> }) {
    const { userId, next } = saved.reauth;
    let claims: OidcClaims;
    try {
      claims = await ctx.oidc.finish(callbackUrl(req), saved, { maxAge: REAUTH_MAX_AGE });
    } catch (err) {
      if (unavailable(err)) throw err;
      req.log.warn({ err }, 'oidc re-authentication failed'); // e.g. auth_time older than REAUTH_MAX_AGE
      return reply.redirect(REAUTH_FAILED);
    }
    // checked here as well (independent of the OIDC library): a still valid IdP session is not a re-authentication
    if (!freshAuth(claims.authTime, REAUTH_MAX_AGE)) return reply.redirect(REAUTH_FAILED);
    const sid = req.cookies[COOKIE];
    const s = await loadSession(ctx, sid);
    const user = s?.userId === userId ? await getUserById(ctx, userId) : null;
    if (!sid || !s || !user || user.disabled || user.authentik_sub !== claims.sub) {
      // another person signed in at the IdP, or another (or no) session finished the flow
      await audit(ctx, userId, 'session.reauth_mismatch', userId, { ip: req.ip });
      return reply.redirect(REAUTH_FAILED);
    }
    if (!(await markReauthenticated(ctx, sid, s))) return reply.redirect(REAUTH_FAILED); // revoked meanwhile
    await audit(ctx, userId, 'session.reauth', userId, { ip: req.ip });
    return reply.redirect(next);
  }

  /** The admin role policy on all media server identities of the account (owner + profiles). */
  async function applyAdminPolicy(user: UserRow): Promise<void> {
    const owned = await accountJellyfinIds(ctx, user.id);
    for (const jid of owned) await applyRole(ctx, jid, 'admin', false, { userId: user.id, hidden: jid !== user.jellyfin_user_id });
  }

  /** Makes `user` admin (role on the account and on all its media server identities); no-op when it is one. */
  async function promoteToAdmin(user: UserRow): Promise<void> {
    if (user.role === 'admin') return;
    await ctx.db.query("update users set role='admin' where id=$1", [user.id]);
    await applyAdminPolicy(user);
    user.role = 'admin';
  }

  /**
   * The first admin (spec Part F step 5): the account is created as admin without a group, invite or approval check (the media server
   * user as for any first login), or an existing one (only when setup was reopened by hand) gets the admin role. Every database write
   * runs on claimSetup's transaction, so the role exists only together with the completed setup; a claim that does not commit leaves
   * no admin, and the media server account created for it is deleted. Returns null when another sign-in completed setup first.
   */
  async function claimFirstAdmin(claims: OidcClaims, existing: UserRow | null): Promise<UserRow | null> {
    const made: { user?: UserRow } = {};
    let admin: UserRow | null;
    try {
      admin = await claimSetup(ctx, async (tx) => {
        if (!existing) return (made.user = await provisionUser(ctx, claims, 'admin', null, tx));
        // the account may have been deleted since the lookup: no row, no admin, so the claim rolls back instead of completing setup
        const promoted = await tx.query("update users set role='admin' where id=$1 returning id", [existing.id]);
        if (!promoted.rowCount) throw new Error('setup claim: the account is gone');
        return { ...existing, role: 'admin' };
      });
    } catch (e) {
      // rolled back (unless the commit went through after all and only its answer was lost: then the account exists and keeps it)
      const u = made.user;
      if (u && !(await getUserById(ctx, u.id).catch(() => u))) await ctx.jf.admin.deleteIdentity(u.jellyfin_user_id).catch(() => undefined);
      throw e;
    }
    // the media server side of a promotion, once the role is committed
    if (admin && existing && existing.role !== 'admin') await applyAdminPolicy(admin);
    return admin;
  }

  /** The end of every sign-in: device, session, cookie, audit. The first admin also completes setup and lands on the wizard's step 6. */
  async function finishLogin(req: FastifyRequest, reply: FastifyReply, user: UserRow, firstAdmin = false) {
    const sid = rand();
    const dev = await registerDevice(ctx, req, reply, user.id, secure());
    const session = newSession({ userId: user.id, csrf: rand(), deviceId: dev.deviceId, deviceApproved: dev.approved });
    // stamps session.reauthAt before the save below (the stamp's second producer, at session creation; see reauth.ts)
    if (firstAdmin) await completeSetup(ctx, user.id, session, req.log);
    await saveSession(ctx, sid, session);
    reply.setCookie(COOKIE, sid, { httpOnly: true, secure: secure(), sameSite: 'lax', path: '/', maxAge: ctx.cfg.SESSION_TTL_SECONDS });
    if (firstAdmin) {
      // the setup session is gone (completeSetup): the browser forgets its cookies too
      reply.clearCookie(SETUP_COOKIE, { path: '/' });
      reply.clearCookie(SETUP_CSRF_COOKIE, { path: '/' });
    }
    const pendingId = verifyPending(ctx, req.cookies[PENDING_COOKIE]);
    if (req.cookies[PENDING_COOKIE]) reply.clearCookie(PENDING_COOKIE, { path: '/' }); // approved: the waiting room is done
    if (pendingId) await ctx.kv.del(pendingNoticeKey(pendingId));
    await audit(ctx, user.id, 'login', user.id, { ip: req.ip });
    return reply.redirect(firstAdmin ? '/setup/extras' : '/');
  }

  app.get('/auth/callback', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const state = (req.query as Record<string, string | undefined>).state;
    const raw = state ? await ctx.kv.get(`oidc:${state}`) : null;
    const bound = req.cookies[OIDC_COOKIE];
    reply.clearCookie(OIDC_COOKIE, { path: '/auth' });
    if (!state || !raw || !bound || bound.length !== state.length || !timingSafeEqual(Buffer.from(bound), Buffer.from(state))) return reply.code(400).send({ error: 'invalid_state' });
    await ctx.kv.del(`oidc:${state}`); // single use
    try {
      const saved = JSON.parse(raw) as SavedLogin;
      // setup mode: the only sign-in is the first admin's, started by /auth/login?setup=1 with the setup session that finishes it here
      // (the gate in app.ts lets the callback through with any valid setup session; the binding is checked here)
      const firstAdmin = !(await isSetupComplete(ctx));
      // without that setup session (it ran out meanwhile, or another browser finishes the login): back to the wizard's code step, a browser
      // navigation gets no JSON answer
      if (firstAdmin && (saved.reauth || !(await isSetupSession(ctx, req, saved.setup)))) return reply.redirect(SETUP_EXPIRED);
      // order matters (phase 2 ruling F15): a re-authentication is handled first, before any account lookup or provisioning
      if (saved.reauth) return await finishReauth(req, reply, { ...saved, reauth: saved.reauth });
      // forgotten PIN: the IdP must really have asked for the login again (auth_time), a still valid IdP session is not enough
      const claims = await ctx.oidc.finish(callbackUrl(req), saved, saved.resetPin ? { maxAge: RESET_PIN_MAX_AGE } : undefined);
      // the account is being deleted (claimed by the deletion tick): no login, no approval request, no new account (F15 step 2)
      const deleting = await ctx.db.query('select 1 from account_deletions where authentik_sub=$1 and finished_at is null', [claims.sub]);
      if (deleting.rowCount) return reply.code(403).send({ error: 'account_deleted' });
      if (firstAdmin) {
        const existing = await getUserBySub(ctx, claims.sub);
        if (existing?.disabled) return reply.code(403).send({ error: 'disabled' });
        // exactly one first admin, across instances: the completion and the account commit in one transaction (claimSetup)
        const admin = await claimFirstAdmin(claims, existing);
        if (admin) return await finishLogin(req, reply, admin, true);
        // another sign-in completed setup meanwhile: this one follows the normal rules below (group, invite, approval)
      }
      let user = await getUserBySub(ctx, claims.sub);
      const isAdmin = claims.groups.includes(ctx.cfg.ADMIN_GROUP);
      if (!user) {
        let claimed: InviteRow | null = null;
        if (!isAdmin) {
          claimed = saved.invite ? await claimInvite(ctx, saved.invite) : null;
          if (!claimed) {
            // no (valid) invite: the person waits for an admin on /pending, without a session
            const requestId = await requestApproval(ctx, claims);
            reply.setCookie(PENDING_COOKIE, signPending(ctx, requestId), { httpOnly: true, secure: secure(), sameSite: 'lax', path: '/', maxAge: PENDING_TTL });
            return reply.redirect('/pending');
          }
        }
        try {
          user = await provisionUser(ctx, claims, isAdmin ? 'admin' : claimed!.role, claimed ? inviteAccessUntil(claimed) : null);
        } catch (e) {
          if (claimed) await releaseInvite(ctx, claimed.id); // let the person retry
          throw e;
        }
        await ctx.db.query('delete from approval_requests where authentik_sub=$1', [claims.sub]); // an invite or the admin group overtook the request
        if (claimed) await recordInviteUse(ctx, claimed, user.id, req.log); // used up: the enrollment link must not create more accounts
      } else if (user.disabled) {
        // locked for deletion and still in the grace period: the person may restore it on /restore (no session); other locks: 403 (F15 step 3)
        const deletionAt = await restorableUntil(ctx, user.id);
        if (!deletionAt) return reply.code(403).send({ error: 'disabled' });
        reply.setCookie(RESTORE_COOKIE, signRestore(ctx, user.id, deletionAt), { httpOnly: true, secure: secure(), sameSite: 'lax', path: '/', maxAge: RESTORE_TTL });
        return reply.redirect('/restore');
      } else if (isAdmin) {
        await promoteToAdmin(user);
      }
      if (user.disabled) return reply.code(403).send({ error: 'disabled' });
      if (saved.resetPin) {
        // checked here as well (independent of the OIDC library): no fresh authentication, or a kid-locked device -> no reset, no login
        if (!freshAuth(claims.authTime, RESET_PIN_MAX_AGE)) return reply.redirect(RESET_STALE);
        if (await kidLockedDevice(req, user.id)) return reply.redirect(RESET_BLOCKED);
        // the person just re-authenticated at the IdP: the owner profile's forgotten PIN is cleared (and its lockout lifted)
        const cleared = await ctx.db.query('update profiles set pin_hash=null where id=$1 and is_owner and pin_hash is not null', [user.id]);
        await ctx.kv.del(`pinfail:${user.id}`);
        await ctx.kv.del(`pinfail-acct:${user.id}`);
        if (cleared.rowCount) await audit(ctx, user.id, 'profile.pin_reset', user.id);
      }
      return await finishLogin(req, reply, user);
    } catch (err) {
      if (unavailable(err)) throw err; // 503 oidc_unavailable through the error handler
      req.log.warn({ err }, 'oidc callback failed'); if (process.env.DEBUG_TEST) console.error(err);
      return reply.code(401).send({ error: 'login_failed' });
    }
  });

  // the /pending page polls this (no session): state of the approval request named by the signed ff_pending cookie
  app.get('/api/pending', async (req) => {
    const id = verifyPending(ctx, req.cookies[PENDING_COOKIE]);
    if (!id) return { state: 'none' };
    const r = await ctx.db.query<{ rejected_at: Date | null; reject_message: string | null }>('select rejected_at, reject_message from approval_requests where id=$1', [id]);
    const row = r.rows[0];
    if (row) return row.rejected_at ? { state: 'rejected', ...(row.reject_message ? { message: row.reject_message } : {}) } : { state: 'pending' };
    const raw = await ctx.kv.get(pendingNoticeKey(id));
    const sub = raw ? (JSON.parse(raw) as { sub: string }).sub : null;
    return sub && (await getUserBySub(ctx, sub)) ? { state: 'approved' } : { state: 'none' };
  });

  // the /restore page (no session): the deletion date of the account named by the signed ff_restore cookie; never its name or e-mail
  app.get('/api/restore', async (req) => {
    const c = verifyRestore(ctx, req.cookies[RESTORE_COOKIE]);
    const at = c ? await restorableUntil(ctx, c.userId, c.deletionAt) : null;
    return at ? { state: 'scheduled', deletionAt: at.toISOString() } : { state: 'none' };
  });

  // Restores the scheduled deletion. It carries no session authority, so the CSRF hook exempts it (app.ts): JSON only (a cross-site
  // form cannot send it, and a cross-site fetch with it needs a preflight) + the SameSite, HMAC-signed cookie. No session either:
  // the person signs in again through /auth/login.
  app.post('/api/restore', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!/^application\/json(\s*;|$)/i.test(String(req.headers['content-type'] ?? ''))) return reply.code(415).send({ error: 'json_required' });
    const c = verifyRestore(ctx, req.cookies[RESTORE_COOKIE]);
    if (!c) return reply.code(401).send({ error: 'unauthenticated' });
    const locked = await accountSerial(async () => {
      // the grace period is the person's window (an admin may still restore later, until the tick claims the account);
      // a cookie only restores the deletion it was issued for
      if (!(await restorableUntil(ctx, c.userId, c.deletionAt))) {
        const claimed = await ctx.db.query('select 1 from account_deletions where user_id=$1', [c.userId]);
        throw new HttpError(409, claimed.rowCount ? 'deletion_in_progress' : 'not_scheduled');
      }
      await restoreDeletion(ctx, c.userId, c.userId);
      return (await ctx.db.query<{ locked_reason: string | null }>('select locked_reason from users where id=$1', [c.userId])).rows[0]?.locked_reason;
    });
    reply.clearCookie(RESTORE_COOKIE, { path: '/' });
    // F8: ended access stays locked (as 'expired'); the page says so instead of offering a sign-in that would answer 403
    return locked === 'expired' ? { ok: true, accessEnded: true } : { ok: true };
  });

  // "Keep the deletion" on /restore: forgets the restore cookie (nothing else changes; harmless, so no checks)
  app.delete('/api/restore', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (_req, reply) => {
    reply.clearCookie(RESTORE_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', { preHandler: requireUser(ctx, { allowPendingDevice: true, allowNoProfile: true, skipProfileHeader: true }) }, async (req) => {
    const u = req.user!;
    const profileCount = (await listProfiles(ctx, u.id)).length;
    const dlRole = await effectiveLimits(ctx, u); // role + the user's own overrides
    const [instLang, profLang, onboarded] = await Promise.all([instanceLanguage(ctx), profileLanguage(ctx, req.profile?.id), profileOnboarded(ctx, req.profile?.id)]);
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      /** role name in the UI language (a label customised via ROLES_JSON is shown as configured) */
      roleLabel: roleLabel(profLang ?? instLang ?? FALLBACK_LANGUAGE, u.role, ctx.roles[u.role]?.label, DEFAULT_ROLES[u.role]?.label),
      isAdmin: u.role === 'admin',
      csrfToken: req.session!.csrf,
      deviceApproved: req.session!.deviceApproved,
      /** this session belongs to a paired television (device ids of paired TVs start with "tv-") */
      tv: Boolean(req.session!.deviceId?.startsWith('tv-')),
      limits: dlRole ?? ctx.roles[u.role],
      /** offline downloads: allowed for this role (and not on TVs) + max active licenses */
      downloads: { allowed: roleAllowsDownloads(ctx, dlRole) && !req.session!.deviceId?.startsWith('tv-'), max: dlRole?.maxDownloads ?? 0 },
      profile: req.profile ? publicProfile(req.profile) : null,
      /** true: the client must send the user to the profile picker first (owner profile has a PIN and none was chosen) */
      profileRequired: !req.profile,
      profileCount,
      /** false: this session never picked a profile explicitly (cookie of an older session / owner fallback) */
      profileChosen: Boolean(req.session!.profileId),
      /** the active profile is a kids profile: kids home, no social features (the server answers 403 kids_profile there) */
      kids: Boolean(req.profile?.kids),
      /** false: the active profile was created after onboarding existed and never finished /welcome */
      onboarded,
      /** effective UI language: the active profile's choice → instance default → 'de' (see docs/i18n.md) */
      language: profLang ?? instLang ?? FALLBACK_LANGUAGE,
      /** false: the active profile never chose a language → the client shows the first-login language picker */
      languageChosen: profLang !== null,
      /** instance default language (admin setting; 'de' until one is stored) */
      defaultLanguage: instLang ?? FALLBACK_LANGUAGE,
      /** false: no admin picked the instance language yet → the client asks the admin (owner profile) once */
      defaultLanguageSet: instLang !== null,
      /** best supported match of the browser's Accept-Language, or null (only a suggestion for the picker) */
      suggestedLanguage: languageFromAcceptLanguage(req.headers['accept-language']),
      /** media server kind + what it supports: the client hides UI for anything missing (see media/types.ts) */
      server: { kind: ctx.jf.kind, capabilities: publicCapabilities(ctx.jf.capabilities) },
      /** optional services of this instance: requests = a request service is set up (else the client hides wishes and requests) */
      features: { requests: requestsEnabled(ctx) },
    };
  });

  app.get('/api/server', { preHandler: requireUser(ctx, { allowPendingDevice: true, allowNoProfile: true, skipProfileHeader: true }) }, async () => (
    { kind: ctx.jf.kind, capabilities: publicCapabilities(ctx.jf.capabilities) }
  ));

  // State-changing: CSRF header must match the session token (also enforced globally for /api).
  app.post('/auth/logout', async (req, reply) => {
    const sid = req.cookies[COOKIE];
    const s = await loadSession(ctx, sid);
    if (!s || !sid) return reply.code(401).send({ error: 'unauthenticated' });
    const sent = Buffer.from(String(req.headers['x-csrf-token'] ?? ''));
    const want = Buffer.from(s.csrf);
    if (sent.length !== want.length || !timingSafeEqual(sent, want)) return reply.code(403).send({ error: 'csrf' });
    await ctx.kv.del(`sess:${sid}`);
    dropRemotePeers(s.userId, new Set([sid]));
    // this device's push subscriptions and cast tokens must not outlive its login (unless another live session still uses the device)
    if (s.deviceId && !(await deviceHasSession(ctx, s.userId, s.deviceId))) {
      await revokeCasts(ctx, s.userId, s.deviceId);
      await deletePushSubscriptions(ctx, s.userId, s.deviceId);
    }
    reply.clearCookie(COOKIE, { path: '/' });
    return { status: 'ok' };
  });
}
