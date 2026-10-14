// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { dropRemotePeers } from './tv.js';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { COOKIE, loadSession, newSession, rand, requireUser, saveSession } from '../session.js';
import { revokeCasts } from '../cast.js';
import { roleAllowsDownloads } from '../downloads.js';
import { DEFAULT_ROLES, effectiveRole } from '../roles.js';
import { deviceHasSession, registerDevice } from '../devices.js';
import { deletePushSubscriptions } from '../push.js';
import { claimInvite, deleteAuthentikInvitation, enrollFlowUrl, lookupInvite, releaseInvite, type InviteRow } from '../invites.js';
import { accountJellyfinIds, deviceKidsProfile, listProfiles, publicProfile } from '../profiles.js';
import { DEVICE_COOKIE } from '../devices.js';
import { freshAuth, RESET_PIN_MAX_AGE } from '../oidc.js';
import { applyRole, getUserBySub, provisionUser } from '../users.js';
import { profileOnboarded } from './prefs.js';
import { publicCapabilities } from '../media/types.js';
import { FALLBACK_LANGUAGE, instanceLanguage, languageFromAcceptLanguage, profileLanguage, roleLabel } from '../i18n.js';

const OIDC_COOKIE = 'ff_oidc';
/** sign-up incl. MFA setup takes longer than a plain login */
const ENROLL_TTL = 1800;

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const secure = ctx.cfg.PUBLIC_URL.startsWith('https://');

  /** Starts an OIDC login; the invite (if any) travels in the server-side state to /auth/callback. */
  async function startLogin(reply: FastifyReply, invite: string | undefined, ttl: number, resetPin = false) {
    const s = await ctx.oidc.start({ forceLogin: resetPin });
    await ctx.kv.set(`oidc:${s.state}`, JSON.stringify({ state: s.state, nonce: s.nonce, codeVerifier: s.codeVerifier, invite, ...(resetPin ? { resetPin: true } : {}) }), ttl);
    reply.setCookie(OIDC_COOKIE, s.state, { httpOnly: true, secure, sameSite: 'lax', path: '/auth', maxAge: ttl }); // binds the flow to this browser
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
    // ?resetPin=1: forgotten owner PIN -> forced re-login at the IdP, the callback then clears the owner profile's PIN
    return reply.redirect(await startLogin(reply, invite, 600, q.resetPin === '1'));
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

  app.get('/auth/callback', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const state = (req.query as Record<string, string | undefined>).state;
    const raw = state ? await ctx.kv.get(`oidc:${state}`) : null;
    const bound = req.cookies[OIDC_COOKIE];
    reply.clearCookie(OIDC_COOKIE, { path: '/auth' });
    if (!state || !raw || !bound || bound.length !== state.length || !timingSafeEqual(Buffer.from(bound), Buffer.from(state))) return reply.code(400).send({ error: 'invalid_state' });
    await ctx.kv.del(`oidc:${state}`); // single use
    try {
      const saved = JSON.parse(raw) as { state: string; nonce: string; codeVerifier: string; invite?: string; resetPin?: boolean };
      // forgotten PIN: the IdP must really have asked for the login again (auth_time), a still valid IdP session is not enough
      const claims = await ctx.oidc.finish(new URL(req.url, ctx.cfg.PUBLIC_URL), saved, saved.resetPin ? { maxAge: RESET_PIN_MAX_AGE } : undefined);
      let user = await getUserBySub(ctx, claims.sub);
      const isAdmin = claims.groups.includes(ctx.cfg.ADMIN_GROUP);
      if (!user) {
        let claimed: InviteRow | null = null;
        if (!isAdmin) {
          claimed = saved.invite ? await claimInvite(ctx, saved.invite) : null;
          if (!claimed) return reply.code(403).send({ error: 'no_invite' });
        }
        try {
          user = await provisionUser(ctx, claims, isAdmin ? 'admin' : claimed!.role);
        } catch (e) {
          if (claimed) await releaseInvite(ctx, claimed.id); // let the person retry
          throw e;
        }
        if (claimed) {
          await ctx.db.query('update invites set used_by=$1 where id=$2', [user.id, claimed.id]);
          void deleteAuthentikInvitation(ctx, claimed.authentik_invite, req.log); // redeemed: the enrollment link must not create more accounts
        }
      } else if (user.disabled) {
        return reply.code(403).send({ error: 'disabled' });
      } else if (isAdmin && user.role !== 'admin') {
        await ctx.db.query("update users set role='admin' where id=$1", [user.id]);
        const owned = await accountJellyfinIds(ctx, user.id);
        for (const jid of owned) await applyRole(ctx, jid, 'admin', false, { hidden: jid !== user.jellyfin_user_id });
        user.role = 'admin';
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
      const sid = rand();
      const dev = await registerDevice(ctx, req, reply, user.id, secure);
      await saveSession(ctx, sid, newSession({ userId: user.id, csrf: rand(), deviceId: dev.deviceId, deviceApproved: dev.approved }));
      reply.setCookie(COOKIE, sid, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: ctx.cfg.SESSION_TTL_SECONDS });
      await audit(ctx, user.id, 'login', user.id, { ip: req.ip });
      return reply.redirect('/');
    } catch (err) {
      req.log.warn({ err }, 'oidc callback failed'); if (process.env.DEBUG_TEST) console.error(err);
      return reply.code(401).send({ error: 'login_failed' });
    }
  });

  app.get('/api/me', { preHandler: requireUser(ctx, { allowPendingDevice: true, allowNoProfile: true, skipProfileHeader: true }) }, async (req) => {
    const u = req.user!;
    const profileCount = (await listProfiles(ctx, u.id)).length;
    const dlRole = await effectiveRole(ctx, u.role);
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
      limits: ctx.roles[u.role],
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
