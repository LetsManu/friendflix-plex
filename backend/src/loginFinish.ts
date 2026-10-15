// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The end of every sign-in, shared by the classic `/auth/callback` and the in-app flow (`/auth/flow/*`, Block 23 phase 3, preflight D4):
 * once the IdP has named the person (OIDC claims), `resolveLogin` applies the same rules on both paths — deletion in progress, approval,
 * invites, the admin group, locks (incl. ended access, which goes through the expiry tick's `expireAccess`), the deletion-grace restore —
 * and `issueSession` creates the FriendFlix session (device, session, cookie, audit `login {ip, ui}`).
 *
 * The first admin (setup) is not handled here: only `/auth/callback` with the wizard's setup session creates it (`claimFirstAdmin` +
 * `issueSession(…, {firstAdmin:true})`), so the Block 25 first-admin binding stays in one place.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { audit } from './audit.js';
import { secureCookies } from './config.js';
import type { Ctx } from './ctx.js';
import { DEVICE_COOKIE, registerDevice } from './devices.js';
import { expireAccess } from './expiry.js';
import { m } from './i18n.js';
import { claimInvite, inviteAccessUntil, recordInviteUse, releaseInvite, type InviteRow } from './invites.js';
import { notifyAdmins } from './notify.js';
import { freshAuth, RESET_PIN_MAX_AGE, type OidcClaims } from './oidc.js';
import { pendingNoticeKey } from './pending.js';
import { accountJellyfinIds, deviceKidsProfile } from './profiles.js';
import { COOKIE, loadSession, newSession, rand, saveSession } from './session.js';
import { SETUP_COOKIE, SETUP_CSRF_COOKIE } from './setup/code.js';
import { completeSetup } from './setup/state.js';
import type { UserRow } from './types.js';
import { accessEnded, accountSerial, applyRole, getUserBySub, provisionUser } from './users.js';

/** a login without an invite waits for an admin: this cookie names the approval request (signed, no session) */
export const PENDING_COOKIE = 'ff_pending';
const PENDING_TTL = 30 * 86400;
/** a person who was rejected and asks again only notifies the admins again after this long */
const RENOTIFY_MS = 86400e3;

/**
 * a sign-in during the deletion grace period: this cookie names the account and the scheduled deletion (its date) that may be
 * restored on /restore (signed, no session); a later, different deletion of the same account is not covered by it
 */
export const RESTORE_COOKIE = 'ff_restore';
const RESTORE_TTL = 900;

/** the profile picker explains why a forgotten-PIN reset did not happen (no JSON error page for a person who clicked "PIN vergessen?") */
export const RESET_BLOCKED = '/profiles?pinReset=kids';
export const RESET_STALE = '/profiles?pinReset=stale';

/** which sign-in UI finished the login (audit `login {ui}`) */
export type LoginUiKind = 'app' | 'classic';

/**
 * What a sign-in comes to. `redirect` only for the classic forgotten-PIN paths (`resetPin`). Cookies (`ff_sid`, `ff_dev`, `ff_pending`,
 * `ff_restore`) are already set on the reply when an outcome is returned.
 */
export type LoginOutcome =
  | { kind: 'session'; next: '/' }
  | { kind: 'pending' }
  | { kind: 'locked' }
  | { kind: 'restore' }
  | { kind: 'account_deleted' }
  | { kind: 'redirect'; to: string };

const pendingMac = (ctx: Pick<Ctx, 'encKey'>, id: string) => createHmac('sha256', ctx.encKey).update(`friendflix pending v1|${id}`).digest('base64url');
const signPending = (ctx: Pick<Ctx, 'encKey'>, id: string) => `${id}.${pendingMac(ctx, id)}`;
/** The request id of a signed `ff_pending` cookie, or null when it is missing or forged. */
export function verifyPending(ctx: Pick<Ctx, 'encKey'>, cookie: string | undefined): string | null {
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
export function verifyRestore(ctx: Pick<Ctx, 'encKey'>, cookie: string | undefined): { userId: string; deletionAt: number } | null {
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
export async function restorableUntil(ctx: Ctx, userId: string, issuedFor?: number): Promise<Date | null> {
  const r = await ctx.db.query<{ deletion_at: Date }>(
    `select deletion_at from users u where id=$1 and disabled and locked_reason='deletion' and deletion_at > now()
       and not exists (select 1 from account_deletions d where d.user_id=u.id)`, [userId]);
  const at = r.rows[0]?.deletion_at ?? null;
  return at && (issuedFor === undefined || at.getTime() === issuedFor) ? at : null;
}

/** the account is being deleted (claimed by the deletion tick): no login, no approval request, no new account (F15 step 2) */
export async function accountBeingDeleted(ctx: Ctx, sub: string): Promise<boolean> {
  const r = await ctx.db.query('select 1 from account_deletions where authentik_sub=$1 and finished_at is null', [sub]);
  return Boolean(r.rowCount);
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

/** The admin role policy on all media server identities of the account (owner + profiles). */
export async function applyAdminPolicy(ctx: Ctx, user: UserRow): Promise<void> {
  const owned = await accountJellyfinIds(ctx, user.id);
  for (const jid of owned) await applyRole(ctx, jid, 'admin', false, { userId: user.id, hidden: jid !== user.jellyfin_user_id });
}

/** Makes `user` admin (role on the account and on all its media server identities); no-op when it is one. */
async function promoteToAdmin(ctx: Ctx, user: UserRow): Promise<void> {
  if (user.role === 'admin') return;
  await ctx.db.query("update users set role='admin' where id=$1", [user.id]);
  await applyAdminPolicy(ctx, user);
  user.role = 'admin';
}

/**
 * A device that is locked to a kids profile (its ff_dev cookie or the current session's device) may never reset the owner PIN:
 * otherwise a kid who knows the account login could free itself. The owner resets from another device.
 */
export async function kidLockedDevice(ctx: Ctx, req: FastifyRequest, userId?: string): Promise<boolean> {
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

/**
 * The end of every sign-in: device, session, cookie, audit `login {ip, ui}`. The first admin also completes setup and lands on the
 * wizard's step 6. Returns where the browser goes next.
 */
export async function issueSession(ctx: Ctx, req: FastifyRequest, reply: FastifyReply, user: UserRow,
  opts: { firstAdmin?: boolean; ui: LoginUiKind }): Promise<'/' | '/setup/extras'> {
  const secure = secureCookies(ctx.cfg);
  const sid = rand();
  const dev = await registerDevice(ctx, req, reply, user.id, secure);
  const session = newSession({ userId: user.id, csrf: rand(), deviceId: dev.deviceId, deviceApproved: dev.approved });
  // stamps session.reauthAt before the save below (the stamp's second producer, at session creation; see reauth.ts)
  if (opts.firstAdmin) await completeSetup(ctx, user.id, session, req.log);
  await saveSession(ctx, sid, session);
  reply.setCookie(COOKIE, sid, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: ctx.cfg.SESSION_TTL_SECONDS });
  if (opts.firstAdmin) {
    // the setup session is gone (completeSetup): the browser forgets its cookies too
    reply.clearCookie(SETUP_COOKIE, { path: '/' });
    reply.clearCookie(SETUP_CSRF_COOKIE, { path: '/' });
  }
  const pendingId = verifyPending(ctx, req.cookies[PENDING_COOKIE]);
  if (req.cookies[PENDING_COOKIE]) reply.clearCookie(PENDING_COOKIE, { path: '/' }); // approved: the waiting room is done
  if (pendingId) await ctx.kv.del(pendingNoticeKey(pendingId));
  await audit(ctx, user.id, 'login', user.id, { ip: req.ip, ui: opts.ui });
  return opts.firstAdmin ? '/setup/extras' : '/';
}

/**
 * The rules of a normal sign-in (setup complete, or another sign-in claimed the first admin meanwhile), identical for the classic callback
 * and the in-app flow: a deletion in progress → `account_deleted`; an unknown person → the invite (claimed, its use recorded) or the admin
 * group creates the account, else an approval request + `ff_pending` → `pending`; a deletion lock in its grace period → `ff_restore` →
 * `restore`; any other lock → `locked`; ended access (`access_until <= now`) → `expireAccess` in the account serial queue → `locked`,
 * unless it is the last active admin, who signs in; the admin group promotes; `resetPin` (classic only) clears the owner PIN after a
 * fresh IdP login. Then the session is issued.
 */
export async function resolveLogin(ctx: Ctx, req: FastifyRequest, reply: FastifyReply, claims: OidcClaims,
  opts: { invite?: string; resetPin?: boolean; ui: LoginUiKind }): Promise<LoginOutcome> {
  const secure = secureCookies(ctx.cfg);
  if (await accountBeingDeleted(ctx, claims.sub)) return { kind: 'account_deleted' };
  let user = await getUserBySub(ctx, claims.sub);
  const isAdmin = claims.groups.includes(ctx.cfg.ADMIN_GROUP);
  if (!user) {
    let claimed: InviteRow | null = null;
    if (!isAdmin) {
      claimed = opts.invite ? await claimInvite(ctx, opts.invite) : null;
      if (!claimed) {
        // no (valid) invite: the person waits for an admin on /pending, without a session
        const requestId = await requestApproval(ctx, claims);
        reply.setCookie(PENDING_COOKIE, signPending(ctx, requestId), { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: PENDING_TTL });
        return { kind: 'pending' };
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
    // locked for deletion and still in the grace period: the person may restore it on /restore (no session); other locks: refused (F15 step 3)
    const deletionAt = await restorableUntil(ctx, user.id);
    if (!deletionAt) return { kind: 'locked' };
    reply.setCookie(RESTORE_COOKIE, signRestore(ctx, user.id, deletionAt), { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: RESTORE_TTL });
    return { kind: 'restore' };
  } else {
    // ended access (Ruling 7, preflight T4-c): locked like the expiry tick does it (account serial queue, last-admin guard, audit
    // user.expired, notifications); the last active admin stays unlocked and signs in
    const until = (user as UserRow & { access_until?: Date | null }).access_until ?? null;
    if (accessEnded(until)) {
      const id = user.id;
      if (await accountSerial(() => expireAccess(ctx, id, new Date()))) return { kind: 'locked' };
      // not locked by this call: the last active admin, or the expiry tick locked it meanwhile (then the row says so)
      const now = await ctx.db.query<{ disabled: boolean }>('select disabled from users where id=$1', [id]);
      if (now.rows[0]?.disabled) return { kind: 'locked' };
    }
    if (isAdmin) await promoteToAdmin(ctx, user);
  }
  if (user.disabled) return { kind: 'locked' };
  if (opts.resetPin) {
    // checked here as well (independent of the OIDC library): no fresh authentication, or a kid-locked device -> no reset, no login
    if (!freshAuth(claims.authTime, RESET_PIN_MAX_AGE)) return { kind: 'redirect', to: RESET_STALE };
    if (await kidLockedDevice(ctx, req, user.id)) return { kind: 'redirect', to: RESET_BLOCKED };
    // the person just re-authenticated at the IdP: the owner profile's forgotten PIN is cleared (and its lockout lifted)
    const cleared = await ctx.db.query('update profiles set pin_hash=null where id=$1 and is_owner and pin_hash is not null', [user.id]);
    await ctx.kv.del(`pinfail:${user.id}`);
    await ctx.kv.del(`pinfail-acct:${user.id}`);
    if (cleared.rowCount) await audit(ctx, user.id, 'profile.pin_reset', user.id);
  }
  await issueSession(ctx, req, reply, user, { ui: opts.ui });
  return { kind: 'session', next: '/' };
}
