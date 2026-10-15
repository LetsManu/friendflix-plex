// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Self-service account page (/me/account): the person's own name, avatar, 2FA state, "Download my data" and deleting the account
 * (after a recent re-authentication). Owner profile only.
 * The e-mail is shown read-only (its change needs Authentik's verification flow, a later phase).
 */
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { akMfaState, akUpdateUser, akUserSettingsUrl } from '../authentik.js';
import type { Ctx } from '../ctx.js';
import { scheduleDeletion } from '../deletion.js';
import { recordError } from '../errorlog.js';
import { exportUserData } from '../export.js';
import { recentlyAuthenticated, REAUTH_WINDOW_S, requireRecentAuth } from '../reauth.js';
import { COOKIE, requireOwner } from '../session.js';
import { accountSerial, assertNotLastAdmin } from '../users.js';

/** a FriendFlix avatar key (the preset swatches), validated like the profile avatar */
const avatarKey = z.string().regex(/^[a-z0-9-]{1,20}$/);
/** the owner profile carries the account name cut to the profile name length, as provisioning does */
const profileName = (name: string) => name.slice(0, 20).trim() || 'Profil';
/** control characters and bidi overrides/isolates (a name shows up in Authentik, admin lists, audit labels, notices); ZWJ stays allowed */
const BAD_NAME_CHARS = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u;
const isUniqueViolation = (e: unknown) => (e as { code?: string }).code === '23505';

export function accountRoutes(app: FastifyInstance, ctx: Ctx) {
  const owner = { preHandler: requireOwner(ctx) };

  /** Never the Authentik sub or pk, nor any media server credential. */
  const view = async (req: FastifyRequest) => {
    const u = (await ctx.db.query<{ name: string; email: string | null; authentik_sub: string }>(
      'select name, email, authentik_sub from users where id=$1', [req.user!.id])).rows[0]!;
    const s = req.session!;
    return {
      name: u.name,
      email: u.email,
      // the owner profile's (requireOwner): the profile editor changes it without touching users.avatar
      avatar: req.profile!.avatar,
      mfa: await akMfaState(ctx, u.authentik_sub).catch(() => null), // Authentik down: shown like "no Authentik API"
      manageUrl: akUserSettingsUrl(ctx.cfg),
      /** epoch ms until which sensitive actions need no new sign-in */
      reauthUntil: recentlyAuthenticated(s) ? s.reauthAt! + REAUTH_WINDOW_S * 1000 : null,
    };
  };

  app.get('/api/account', owner, async (req) => view(req));

  /**
   * Name and/or avatar. The name goes to Authentik first (when its API is configured), so an Authentik refusal leaves FriendFlix
   * unchanged; then users + the owner profile in one transaction. Without the API the change is local only. The avatar is
   * FriendFlix-only. A name another profile of the account already has is refused before Authentik is touched.
   */
  app.patch('/api/account/profile', owner, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(60).refine((n) => !BAD_NAME_CHARS.test(n)).optional(), avatar: avatarKey.optional() }).strict()
      .refine((x) => x.name !== undefined || x.avatar !== undefined, { path: ['name'] }).parse(req.body);
    const user = req.user!, pid = req.profile!.id;
    if (b.name !== undefined) {
      const clash = await ctx.db.query('select 1 from profiles where user_id=$1 and lower(name)=lower($2) and id<>$3', [user.id, profileName(b.name), pid]);
      if (clash.rowCount) return reply.code(409).send({ error: 'name_taken' });
      if (ctx.cfg.AUTHENTIK_URL && ctx.cfg.AUTHENTIK_API_TOKEN) await akUpdateUser(ctx, user.authentik_sub, { name: b.name });
    }
    const c = await (ctx.db as pg.Pool).connect();
    try {
      await c.query('begin');
      // a lock that landed during the Authentik call wins: answered like authenticate() would answer the next request
      const upd = await c.query('update users set name=coalesce($2, name), avatar=coalesce($3, avatar) where id=$1 and not disabled', [user.id, b.name ?? null, b.avatar ?? null]);
      if (!upd.rowCount) {
        await c.query('rollback');
        return reply.code(401).send({ error: 'unauthenticated' });
      }
      await c.query('update profiles set name=coalesce($2, name), avatar=coalesce($3, avatar) where id=$1',
        [pid, b.name === undefined ? null : profileName(b.name), b.avatar ?? null]);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      if (isUniqueViolation(e)) return reply.code(409).send({ error: 'name_taken' }); // a concurrent profile rename
      throw e;
    } finally {
      c.release();
    }
    // self-service audits name the changed fields only, never the values
    await audit(ctx, user.id, 'account.profile', user.id, { fields: [...(b.name !== undefined ? ['name'] : []), ...(b.avatar !== undefined ? ['avatar'] : [])] });
    req.profile = { ...req.profile!, avatar: b.avatar ?? req.profile!.avatar };
    return view(req);
  });

  /**
   * "Download my data": the export streamed as an attachment (built while it is sent, never held in memory as a whole).
   * 5 per hour and account: the limiter runs after requireOwner, so a new session does not reset it.
   */
  const exportLimit = { rateLimit: { max: 5, timeWindow: '1 hour', hook: 'preHandler' as const, keyGenerator: (req: FastifyRequest) => `export:${req.user?.id ?? req.ip}` } };
  // no implicit HEAD route: it would run (and audit) the whole export to send no body
  app.get('/api/account/export', { ...owner, exposeHeadRoute: false, config: exportLimit }, async (req, reply) => {
    const user = req.user!;
    await audit(ctx, user.id, 'account.export', user.id);
    // a failure after the headers went out can only abort the download (the browser sees a failed transfer); it is logged here
    async function* logged() {
      try {
        yield* exportUserData(ctx, user);
      } catch (err) {
        req.log.error({ err }, 'account export failed');
        await recordError(ctx, { source: 'server', code: 'GET /api/account/export stream' }); // never throws
        throw err;
      }
    }
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="friendflix-data-${new Date().toISOString().slice(0, 10)}.json"`)
      .header('cache-control', 'no-store')
      .send(Readable.from(logged()));
  });

  /**
   * Deletes the account after the grace period: locked at once (every session and offline license revoked, this one too), the
   * admins are told. 400 last_admin for the last active admin, checked before the recent sign-in (no pointless re-auth; the
   * refusal tells the owner nothing secret) and again inside the queue. Restoring is possible by signing in again within the
   * grace period.
   */
  const lastAdminFirst = async (req: FastifyRequest) => { await assertNotLastAdmin(ctx, [req.user!.id], 'lock'); };
  app.post('/api/account/delete', { preHandler: [requireOwner(ctx), lastAdminFirst, requireRecentAuth(ctx)] }, async (req, reply) => {
    z.object({ confirm: z.literal(true) }).parse(req.body);
    const me = req.user!.id;
    const deletionAt = await accountSerial(() => scheduleDeletion(ctx, me, me));
    reply.clearCookie(COOKIE, { path: '/' });
    return { deletionAt };
  });
}
