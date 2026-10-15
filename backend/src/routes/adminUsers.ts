// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Admin user management: the account list, single and bulk account actions (role, lock, access, sessions), the user detail page, the approval queue, invites. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { Where, likePattern, orderBy, pageQuery } from '../adminlist.js';
import { akActions, akMfaState, akSendMfaSetup, akSendRecovery } from '../authentik.js';
import type { Ctx } from '../ctx.js';
import { restoreDeletion } from '../deletion.js';
import { forgetUserAuth, revokeSessions } from '../devices.js';
import { userLicenses } from '../downloads.js';
import { createInvite, deleteAuthentikInvitation } from '../invites.js';
import { getUserLimits, invalidateLimits, setUserLimits } from '../limits.js';
import { accountJellyfinIds, getProfile, jfUserFor, listProfiles, publicProfile } from '../profiles.js';
import { roleLimitFor } from '../requestlimit.js';
import { INVITABLE_ROLES, effectiveRole } from '../roles.js';
import { requestsEnabled } from '../seerr/client.js';
import { ensureSeerrUser } from '../seerr/service.js';
import { requireAdmin, type Session } from '../session.js';
import type { ProfileRow, UserRow } from '../types.js';
import { HttpError, accessEnded, accountSerial, applyRole, assertNotLastAdmin, getUserById, getUserBySub, lockUser, provisionUser, setAccessUntil, setRole, unlockUser, type LockReason } from '../users.js';
import { pendingNoticeKey } from '../pending.js';

const uuid = z.guid();
/** ISO date-time with offset, or null (= no end) */
const accessUntil = z.iso.datetime({ offset: true }).nullable();
const toDate = (s: string | null) => (s === null ? null : new Date(s));
/** the approved person's /pending page may answer "approved" this long (as long as its cookie lives) */
const PENDING_NOTICE_TTL = 30 * 86400;

interface ApprovalRow { id: string; authentik_sub: string; email: string | null; name: string }

/**
 * Turns an approval request into an account: provisions it like an invite would (role, optional access-until), removes
 * the request and remembers it for the person's /pending page. Errors: 404 `not_found`, 409 `user_exists`, 409 `rejected` (a rejected request returns to the queue only when the person signs in again).
 */
export async function approveRequest(ctx: Ctx, actor: string, id: string, role: string, until: Date | null): Promise<string> {
  const req = (await ctx.db.query<ApprovalRow & { rejected: boolean }>('select id, authentik_sub, email, name, rejected_at is not null rejected from approval_requests where id=$1', [id])).rows[0];
  if (!req) throw new HttpError(404, 'not_found');
  if (req.rejected) throw new HttpError(409, 'rejected');
  if (await getUserBySub(ctx, req.authentik_sub)) {
    await ctx.db.query('delete from approval_requests where id=$1', [id]);
    throw new HttpError(409, 'user_exists');
  }
  const user = await provisionUser(ctx, { sub: req.authentik_sub, email: req.email ?? undefined, name: req.name, groups: [] }, role, until);
  await ctx.db.query('delete from approval_requests where id=$1', [id]);
  await audit(ctx, actor, 'user.approved', user.id, { from: 'pending', to: role, accessUntil: until?.toISOString() ?? null, request: id });
  await ctx.kv.set(pendingNoticeKey(id), JSON.stringify({ sub: req.authentik_sub, email: req.email }), PENDING_NOTICE_TTL);
  return user.id;
}

export const bulkBody = z.object({
  ids: z.array(uuid).min(1).max(200),
  action: z.enum(['role', 'lock', 'unlock', 'revoke', 'access']),
  role: z.string().max(40).optional(),
  accessUntil: accessUntil.optional(),
}).refine((b) => b.action !== 'role' || b.role !== undefined, { path: ['role'] })
  .refine((b) => b.action !== 'access' || b.accessUntil !== undefined, { path: ['accessUntil'] });
export type BulkBody = z.infer<typeof bulkBody>;

/**
 * Applies one action to many accounts. All or nothing on validation and guards (unknown id, unknown role,
 * the actor locking/demoting themselves, last admin, unlocking an account whose access has ended or whose deletion is under way); then per user. `done` counts the accounts that changed.
 */
export async function bulkUsers(ctx: Ctx, actor: string, b: BulkBody): Promise<{ done: number }> {
  const ids = [...new Set(b.ids)];
  const rows = (await ctx.db.query<{ id: string; role: string; disabled: boolean; access_until: Date | null }>('select id, role, disabled, access_until from users where id = any($1::uuid[])', [ids])).rows;
  if (rows.length !== ids.length) throw new HttpError(404, 'not_found');
  // the expiry tick would lock such an account again within a minute: extend its access instead
  if (b.action === 'unlock' && rows.some((u) => u.disabled && accessEnded(u.access_until))) throw new HttpError(409, 'access_expired');
  // unlockUser would refuse a claimed deletion mid-loop: refuse the whole call first
  if (b.action === 'unlock' && (await ctx.db.query('select 1 from account_deletions where user_id = any($1::uuid[]) limit 1', [ids])).rowCount) {
    throw new HttpError(409, 'deletion_in_progress');
  }
  if (b.action === 'role' && !Object.hasOwn(ctx.roles, b.role!)) throw new HttpError(400, 'unknown_role');
  const demote = b.action === 'role' && b.role !== 'admin';
  if ((demote || b.action === 'lock') && ids.includes(actor)) throw new HttpError(400, 'cannot_lock_yourself_out');
  if (demote) await assertNotLastAdmin(ctx, ids, 'demote');
  if (b.action === 'lock') await assertNotLastAdmin(ctx, ids, 'lock');

  let done = 0;
  for (const u of rows) {
    switch (b.action) {
      case 'role':
        if (u.role === b.role) continue;
        await setRole(ctx, actor, u.id, b.role!);
        break;
      case 'lock':
        if (u.disabled) continue;
        await lockUser(ctx, actor, u.id, 'manual');
        break;
      case 'unlock':
        if (!u.disabled) continue;
        await unlockUser(ctx, actor, u.id);
        break;
      case 'revoke':
        await audit(ctx, actor, 'user.revoke_sessions', u.id, { sessions: await revokeSessions(ctx, u.id) });
        break;
      case 'access':
        await setAccessUntil(ctx, actor, u.id, toDate(b.accessUntil!));
        break;
    }
    done++;
  }
  return { done };
}

/** Per-user limit overrides: the bounds of the role settings (roles.ts / PUT /api/admin/roles); null = as role, omitted = unchanged. */
export const limitsBody = z.object({
  maxStreams: z.number().int().min(1).max(50).nullable(),
  remoteBitrate: z.number().int().min(300_000).max(200_000_000).nullable(),
  maxDownloads: z.number().int().min(0).max(200).nullable(),
  downloadMaxHeight: z.number().int().min(0).max(2160).nullable(),
  requestsPerMonth: z.number().int().min(0).max(100).nullable(),
}).partial().strict();

const hours = (seconds: string | number) => Math.round(Number(seconds) / 360) / 10;

/** Live sessions of an account: count per device, and per profile the last activity (no profileId = the owner profile). */
async function liveSessions(ctx: Ctx, userId: string) {
  const perDevice = new Map<string, number>();
  const profileSeen = new Map<string, number>();
  for (const k of await ctx.kv.keys('sess:')) {
    const raw = await ctx.kv.get(k);
    if (!raw) continue;
    const s = JSON.parse(raw) as Session;
    if (s.userId !== userId) continue;
    if (s.deviceId) perDevice.set(s.deviceId, (perDevice.get(s.deviceId) ?? 0) + 1);
    const p = s.profileId ?? userId;
    if (s.touchedAt) profileSeen.set(p, Math.max(profileSeen.get(p) ?? 0, s.touchedAt));
  }
  return { perDevice, profileSeen };
}

/**
 * Health of the account's media server link, independent of a lock: an active account must be able to sign in (a real call as
 * the account); a locked one is disabled on purpose, so only its identity's existence is checked (admin key). Without that
 * check on the server, null (unknown) rather than false.
 */
async function jellyfinLinkOk(ctx: Ctx, user: UserRow): Promise<boolean | null> {
  if (!user.disabled) return ctx.jf.views(user).then(() => true, () => false);
  const exists = ctx.jf.admin.identityExists;
  if (!exists) return null;
  return exists.call(ctx.jf.admin, user.jellyfin_user_id).catch(() => false);
}

/** Re-applies the role policy (with the user's overrides) to every media server identity of the account. Returns the failures. */
async function reapplyAccount(ctx: Ctx, user: UserRow): Promise<{ identities: number; failed: number }> {
  const ids = await accountJellyfinIds(ctx, user.id);
  let failed = 0;
  for (const jid of ids) await applyRole(ctx, jid, user.role, user.disabled, { userId: user.id, hidden: jid !== user.jellyfin_user_id }).catch(() => { failed++; });
  return { identities: ids.length, failed };
}

export function adminUserRoutes(app: FastifyInstance, ctx: Ctx) {
  const admin = { preHandler: requireAdmin(ctx) };
  const serial = accountSerial;

  // ?q= (name/email/login) &role= &status=active|locked|pending|expiring|deleting &lastActive=7|30|90 (seen within) | 90+ (not seen for 90 days or never)
  // &sort=name|email|role|status|lastSeen|createdAt|accessUntil|profiles|devices &dir= &limit= &offset=; without params: everyone (max 1000)
  // status=pending lists open approval requests in the same row shape (pending: true, role null)
  app.get('/api/admin/users', admin, async (req) => {
    const p = pageQuery.extend({
      role: z.string().max(40).optional(),
      status: z.enum(['active', 'locked', 'pending', 'expiring', 'deleting']).optional(),
      lastActive: z.enum(['7', '30', '90', '90+']).optional(),
    }).parse(req.query);
    const w = new Where();
    if (p.q) { const m = w.param(likePattern(p.q)); w.add(`(u.name ilike ${m} or coalesce(u.email,'') ilike ${m} or coalesce(u.jellyfin_username,'') ilike ${m})`); }
    if (p.role) w.add('u.role = ?', p.role);
    if (p.status === 'active') w.add('not u.disabled and u.deletion_at is null');
    if (p.status === 'locked') w.add('u.disabled');
    if (p.status === 'expiring') w.add("u.access_until between now() and now() + interval '7 days'");
    if (p.status === 'deleting') w.add('(u.deletion_at is not null or u.cleanup is not null)');
    if (p.lastActive === '90+') w.add("(u.last_seen is null or u.last_seen < now() - interval '90 days')");
    else if (p.lastActive) w.add("u.last_seen >= now() - make_interval(days => ?)", Number(p.lastActive));
    const base = p.status === 'pending'
      ? `select a.id, a.name, a.email, null::text role, false disabled, null::text jellyfin_username, null::int seerr_user_id, a.requested_at created_at,
                null::timestamptz last_seen, null::timestamptz access_until, null::text locked_reason, null::timestamptz deletion_at, 0 profiles, 0 devices, true pending
           from approval_requests a where a.rejected_at is null`
      : `select u.id, u.name, u.email, u.role, u.disabled, u.jellyfin_username, u.seerr_user_id, u.created_at,
                (select max(last_seen) from devices d where d.user_id = u.id) last_seen, u.access_until, u.locked_reason, u.deletion_at,
                (select count(*) from profiles x where x.user_id = u.id)::int profiles,
                (select count(*) from devices d where d.user_id = u.id)::int devices, false pending${p.status === 'deleting' ? `,
                case when ad.user_id is not null and ad.finished_at is null then jsonb_build_object('step', ad.step + 1, 'error', ad.last_error, 'gone', false) end cleanup` : ''}
           from users u${p.status === 'deleting' ? ` left join account_deletions ad on ad.user_id = u.id
         union all
         -- claimed deletions carry the step being worked on and its error; once the users row is gone (steps 5-6) only the pseudonym is
         -- left (gone: no detail page to link to)
         select ad.user_id, ad.pseudonym, null, null, true, null, null, ad.started_at, null, null, 'deletion', null, 0, 0, false,
                jsonb_build_object('step', ad.step + 1, 'error', ad.last_error, 'gone', true)
           from account_deletions ad where ad.finished_at is null and not exists (select 1 from users x where x.id = ad.user_id)` : ''}`;
    const order = orderBy({ name: 'lower(u.name)', email: "lower(coalesce(u.email,''))", role: 'u.role', status: 'u.disabled', lastSeen: 'u.last_seen', createdAt: 'u.created_at', accessUntil: 'u.access_until', profiles: 'u.profiles', devices: 'u.devices' }, p.sort, p.dir, 'u.created_at, u.id');
    const total = Number((await ctx.db.query<{ c: string }>(`select count(*) c from (${base}) u ${w.sql}`, w.params)).rows[0]!.c);
    const r = await ctx.db.query(`select * from (${base}) u ${w.sql} ${order} limit ${p.limit ?? 1000} offset ${p.offset ?? 0}`, w.params);
    return { users: r.rows, total };
  });

  app.patch('/api/admin/users/:id', admin, async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const b = z.object({ role: z.string().max(40).optional(), disabled: z.boolean().optional(), accessUntil: accessUntil.optional() }).parse(req.body);
    const actor = req.user!.id;
    return serial(async () => {
      const user = await getUserById(ctx, id);
      if (!user) return reply.code(404).send({ error: 'not_found' });
      if (await claimed(id)) return reply.code(409).send({ error: 'deletion_in_progress' });
      const demote = b.role !== undefined && b.role !== 'admin';
      if (id === actor && (b.disabled || demote)) return reply.code(400).send({ error: 'cannot_lock_yourself_out' });
      if (b.role !== undefined && !Object.hasOwn(ctx.roles, b.role)) return reply.code(400).send({ error: 'unknown_role' });
      if (demote) await assertNotLastAdmin(ctx, [id], 'demote');
      if (b.disabled) await assertNotLastAdmin(ctx, [id], 'lock');
      const cur = (await ctx.db.query<{ access_until: Date | null; locked_reason: LockReason | null }>('select access_until, locked_reason from users where id=$1', [id])).rows[0]!;
      const until = b.accessUntil !== undefined ? toDate(b.accessUntil) : cur.access_until;
      // the expiry tick would lock it again within a minute: extend its access instead (409 access_expired)
      if (b.disabled === false && user.disabled && accessEnded(until)) return reply.code(409).send({ error: 'access_expired' });
      if (b.role !== undefined) await setRole(ctx, actor, id, b.role);
      // an explicit lock of an expired account becomes manual, so a new date below does not unlock it
      if (b.disabled && (!user.disabled || cur.locked_reason === 'expired')) await lockUser(ctx, actor, id, 'manual');
      if (b.disabled === false && user.disabled) await unlockUser(ctx, actor, id);
      if (b.accessUntil !== undefined) await setAccessUntil(ctx, actor, id, toDate(b.accessUntil));
      return { ok: true };
    });
  });

  app.post('/api/admin/users/bulk', admin, async (req) => {
    const b = bulkBody.parse(req.body);
    return serial(() => bulkUsers(ctx, req.user!.id, b));
  });

  // open approval requests (rejected ones are hidden; the expiry tick deletes them after 30 days)
  app.get('/api/admin/approvals', admin, async () => {
    const r = await ctx.db.query('select id, name, email, requested_at from approval_requests where rejected_at is null order by requested_at, id');
    return { requests: r.rows };
  });

  app.post('/api/admin/approvals/:id/approve', admin, async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const b = z.object({ role: z.enum([...INVITABLE_ROLES, 'admin']), accessUntil: accessUntil.optional() }).parse(req.body);
    // serialized: a double click must not provision the same person twice
    return serial(async () => ({ id: await approveRequest(ctx, req.user!.id, id, b.role, toDate(b.accessUntil ?? null)) }));
  });

  app.post('/api/admin/approvals/:id/reject', admin, async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const b = z.object({ message: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    const r = await ctx.db.query<{ name: string }>(
      'update approval_requests set rejected_at=now(), reject_message=$2 where id=$1 and rejected_at is null returning name', [id, b.message || null]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(ctx, req.user!.id, 'user.rejected', id, { from: 'pending', to: 'rejected', name: r.rows[0]!.name, message: b.message || null });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/revoke-sessions', admin, async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const n = await revokeSessions(ctx, id);
    await audit(ctx, req.user!.id, 'user.revoke_sessions', id, { sessions: n });
    return { revoked: n };
  });

  // ---- user detail page ----
  /** true once the deletion tick has claimed the account: admin changes would act on identities that are being deleted */
  const claimed = async (id: string) => Boolean((await ctx.db.query('select 1 from account_deletions where user_id=$1', [id])).rowCount);
  /** The account or a 404 HttpError. */
  const userOr404 = async (id: string) => {
    const user = await getUserById(ctx, id);
    if (!user) throw new HttpError(404, 'not_found');
    return user;
  };
  const idParam = (req: { params: unknown }) => uuid.parse((req.params as { id: string }).id);

  // never answers credentials (jellyfin_pw_enc, PIN hashes, tokens) or the Authentik sub
  app.get('/api/admin/users/:id', admin, async (req) => {
    const id = idParam(req);
    const user = await userOr404(id);
    const extra = (await ctx.db.query<{ locked_reason: string | null; access_until: Date | null; deletion_at: Date | null; avatar: string | null; last_active: Date | null }>(
      'select locked_reason, access_until, deletion_at, avatar, (select max(last_seen) from devices d where d.user_id = u.id) last_active from users u where id=$1', [id])).rows[0]!;
    const [watch, streams, counts, profiles, devices, licenses, live, mfa, jellyfinOk, requestsOk] = await Promise.all([
      ctx.db.query<{ d7: string; d30: string; total: string }>(
        `select coalesce(sum(seconds) filter (where day > current_date - 7), 0) d7, coalesce(sum(seconds) filter (where day > current_date - 30), 0) d30,
                coalesce(sum(seconds), 0) total from play_seconds where user_id=$1`, [id]),
      ctx.db.query<{ d7: string; d30: string; total: string }>(
        `select coalesce(sum(streams) filter (where day > current_date - 7), 0) d7, coalesce(sum(streams) filter (where day > current_date - 30), 0) d30,
                coalesce(sum(streams), 0) total from play_daily where user_id=$1`, [id]),
      ctx.db.query<{ downloads: string; requests: string }>(
        "select (select count(*) from downloads where user_id=$1) downloads, (select count(*) from seerr_requests where user_id=$1 and source='user') requests", [id]),
      listProfiles(ctx, id),
      ctx.db.query<{ id: string; name: string; last_seen: Date; approved: boolean }>('select device_id id, label name, last_seen, approved from devices where user_id=$1 order by last_seen desc, device_id', [id]),
      userLicenses(ctx, id),
      liveSessions(ctx, id),
      akMfaState(ctx, user.authentik_sub).catch(() => null), // Authentik down: shown like "no Authentik API"
      jellyfinLinkOk(ctx, user),
      user.seerr_user_id && ctx.seerr ? ctx.seerr.getUser(user.seerr_user_id).then(() => true, () => false) : Promise.resolve(false),
    ]);
    const w = watch.rows[0]!, st = streams.rows[0]!, c = counts.rows[0]!;
    const seen = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : null);
    return {
      user: {
        id: user.id, name: user.name, email: user.email, role: user.role, disabled: user.disabled, lockedReason: extra.locked_reason,
        accessUntil: extra.access_until, deletionAt: extra.deletion_at, createdAt: user.created_at, lastActive: extra.last_active, avatar: extra.avatar,
      },
      mfa,
      /** which Authentik actions the page may offer */
      authentik: akActions(ctx),
      totals: {
        d7: { hours: hours(w.d7), streams: Number(st.d7) },
        d30: { hours: hours(w.d30), streams: Number(st.d30) },
        all: { hours: hours(w.total), streams: Number(st.total) },
        downloads: Number(c.downloads),
        requests: Number(c.requests),
      },
      // no request service: the link is unknown (null), nothing to repair
      linked: { jellyfin: { ok: jellyfinOk, username: user.jellyfin_username }, requests: { ok: requestsEnabled(ctx) ? requestsOk : null, id: user.seerr_user_id } },
      profiles: profiles.map((p) => ({
        id: p.id, name: p.name, kids: Boolean(p.kids), maxRating: p.kids ? p.kids_max_rating : null, avatar: p.avatar,
        lastUsed: seen(live.profileSeen.get(p.id)), isOwner: p.is_owner, hasPin: Boolean(p.pin_hash),
      })),
      devices: devices.rows.map((d) => ({ id: d.id, name: d.name, lastSeen: d.last_seen, approved: d.approved, sessions: live.perDevice.get(d.id) ?? 0 })),
      licenses,
    };
  });

  // recently watched titles of every profile (media server history as that profile), newest first; viewing is audited.
  // A profile whose identity fails (bad credentials, server error) is listed in `skipped` instead of failing the call.
  app.get('/api/admin/users/:id/activity', admin, async (req) => {
    const id = idParam(req);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const user = await userOr404(id);
    const profiles = await listProfiles(ctx, id);
    await audit(ctx, req.user!.id, 'user.activity_viewed', id, { profiles: profiles.length });
    const lists = await Promise.all(profiles.map((p: ProfileRow) => ctx.jf.history(jfUserFor(user, p), { limit })
      .then((items) => items.map((i) => ({ ...i, profile: { id: p.id, name: p.name } })), () => null)));
    const ts = (i: { lastPlayedDate?: string }) => (i.lastPlayedDate ? Date.parse(i.lastPlayedDate) || 0 : 0);
    const items = lists.flatMap((l) => l ?? []).sort((a, b) => ts(b) - ts(a)).slice(0, limit);
    return { items, skipped: profiles.filter((_, i) => lists[i] === null).map((p) => p.id) };
  });

  // audit entries where the user is the target or the actor, newest first (same row shape as /api/admin/audit)
  app.get('/api/admin/users/:id/audit', admin, async (req) => {
    const id = idParam(req);
    const p = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    await userOr404(id);
    const where = 'where a.target = $1::text or a.actor = $1::uuid';
    const total = Number((await ctx.db.query<{ c: string }>(`select count(*) c from audit_log a ${where}`, [id])).rows[0]!.c);
    const r = await ctx.db.query(
      `select a.id, a.at, a.action, a.target, a.meta, a.actor actor_id, coalesce(u.name, ad.pseudonym) actor, coalesce(tu.name, tad.pseudonym, tl.name) target_name
         from audit_log a left join users u on u.id = a.actor left join account_deletions ad on ad.user_id = a.actor
         left join users tu on tu.id::text = a.target left join account_deletions tad on tad.user_id::text = a.target
         left join lists tl on tl.id::text = a.target
        ${where} order by a.id desc limit $2 offset $3`, [id, p.limit, p.offset]);
    return { entries: r.rows, total };
  });

  // cancels a scheduled deletion (409 not_scheduled, 409 deletion_in_progress once the tick claimed it); an account whose access
  // has ended stays locked as expired
  app.post('/api/admin/users/:id/deletion/restore', admin, async (req) => {
    const id = idParam(req);
    await serial(() => restoreDeletion(ctx, req.user!.id, id));
    return { ok: true };
  });

  // "delete now": only for an account already scheduled; the next deletion tick claims it
  app.post('/api/admin/users/:id/deletion/now', admin, async (req, reply) => {
    const id = idParam(req);
    const actor = req.user!.id;
    if (id === actor) return reply.code(400).send({ error: 'cannot_lock_yourself_out' });
    return serial(async () => {
      const cur = (await ctx.db.query<{ deletion_at: Date | null; locked_reason: LockReason | null }>('select deletion_at, locked_reason from users where id=$1', [id])).rows[0];
      if (!cur) return reply.code(404).send({ error: 'not_found' });
      if (!cur.deletion_at || cur.locked_reason !== 'deletion') return reply.code(409).send({ error: 'not_scheduled' });
      const to = (await ctx.db.query<{ deletion_at: Date }>('update users set deletion_at=now() where id=$1 returning deletion_at', [id])).rows[0]!.deletion_at;
      await audit(ctx, actor, 'user.deletion_now', id, { from: cur.deletion_at.toISOString(), to: to.toISOString() });
      return { ok: true };
    });
  });

  // the overrides (null = as role) and the role values they replace (the page shows them as placeholders)
  app.get('/api/admin/users/:id/limits', admin, async (req) => {
    const user = await userOr404(idParam(req));
    const [limits, role, requests] = await Promise.all([getUserLimits(ctx, user.id), effectiveRole(ctx, user.role), roleLimitFor(ctx, user.role)]);
    return {
      limits,
      role: { maxStreams: role?.maxStreams ?? null, remoteBitrate: role?.remoteMaxBitrate ?? null, maxDownloads: role?.maxDownloads ?? null, downloadMaxHeight: role?.downloadMaxHeight ?? null, requestsPerMonth: requests },
    };
  });

  // partial update: omitted fields stay, null goes back to the role. The media server policies follow (MaxActiveSessions),
  // the gateway forgets the memoised identity of the user's sessions (they stay signed in). 502 `jellyfin` when a policy failed.
  app.put('/api/admin/users/:id/limits', admin, async (req, reply) => {
    const id = idParam(req);
    const b = limitsBody.parse(req.body);
    return serial(async () => {
      const user = await userOr404(id);
      if (await claimed(id)) return reply.code(409).send({ error: 'deletion_in_progress' });
      const from = await getUserLimits(ctx, id);
      const to = { ...from, ...b };
      if (JSON.stringify(from) !== JSON.stringify(to)) {
        await setUserLimits(ctx, id, to);
        await audit(ctx, req.user!.id, 'user.limits', id, { from, to });
      }
      invalidateLimits(id);
      const { failed } = await reapplyAccount(ctx, user);
      await forgetUserAuth(ctx, id);
      if (failed) return reply.code(502).send({ error: 'jellyfin' });
      return { limits: to };
    });
  });

  // "Repair link": the role policy again on every media server identity, and the request-service user mapped again
  app.post('/api/admin/users/:id/repair', admin, async (req, reply) => {
    const id = idParam(req);
    return serial(async () => {
      const user = await userOr404(id);
      // a claimed account: the request-service user may already be deleted, a repair would create an orphan
      if (await claimed(id)) return reply.code(409).send({ error: 'deletion_in_progress' });
      const jellyfin = await reapplyAccount(ctx, user);
      const before = user.seerr_user_id;
      // no request service: nothing to map (null), and the repair is not a partial failure because of it
      const requestsOk = requestsEnabled(ctx) ? await ensureSeerrUser(ctx, user).then(() => true, () => false) : null;
      await audit(ctx, req.user!.id, 'user.repair', id, { jellyfin, requests: { ok: requestsOk, from: before, to: user.seerr_user_id } });
      return { ok: !jellyfin.failed && requestsOk !== false, jellyfin, requests: { ok: requestsOk, id: user.seerr_user_id } };
    });
  });

  // sign out the sessions of one device (its offline licences, push subscriptions and cast tokens go too)
  app.post('/api/admin/users/:id/sessions/:deviceId/revoke', admin, async (req) => {
    const { id, deviceId } = z.object({ id: uuid, deviceId: z.string().min(1).max(100) }).parse(req.params);
    await userOr404(id);
    const n = await revokeSessions(ctx, id, deviceId);
    await audit(ctx, req.user!.id, 'user.revoke_device', id, { deviceId, sessions: n });
    return { revoked: n };
  });

  // Authentik e-mails: 503 authentik_unavailable without the API, see authentik.ts for the other codes
  app.post('/api/admin/users/:id/recovery', admin, async (req) => {
    const user = await userOr404(idParam(req));
    try {
      await akSendRecovery(ctx, user.authentik_sub);
    } catch (e) {
      // failed attempts are recorded too: the code only (never the token, the e-mail or Authentik's answer)
      await audit(ctx, req.user!.id, 'user.recovery_email', user.id, { ok: false, error: e instanceof HttpError ? e.message : 'internal' });
      throw e;
    }
    await audit(ctx, req.user!.id, 'user.recovery_email', user.id, { ok: true });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/mfa-setup', admin, async (req) => {
    const user = await userOr404(idParam(req));
    await akSendMfaSetup(ctx, user.authentik_sub); // 501 not_supported: Authentik has no API for it
    await audit(ctx, req.user!.id, 'user.mfa_setup_sent', user.id);
    return { ok: true };
  });

  // rename a profile (the owner profile too, as its user can) and/or clear its PIN
  app.patch('/api/admin/users/:id/profiles/:pid', admin, async (req, reply) => {
    const { id, pid } = z.object({ id: uuid, pid: uuid }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(20).optional(), resetPin: z.literal(true).optional() }).strict()
      .refine((x) => x.name !== undefined || x.resetPin, { path: ['name'] }).parse(req.body);
    const p = await getProfile(ctx, id, pid);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (b.name && (await ctx.db.query('select 1 from profiles where user_id=$1 and lower(name)=lower($2) and id<>$3', [id, b.name, pid])).rowCount) {
      return reply.code(409).send({ error: 'name_taken' });
    }
    let u: ProfileRow;
    try {
      u = (await ctx.db.query<ProfileRow>('update profiles set name=coalesce($2, name), pin_hash=case when $3 then null else pin_hash end where id=$1 returning *',
        [pid, b.name ?? null, Boolean(b.resetPin)])).rows[0]!;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: 'name_taken' });
      throw e;
    }
    if (b.resetPin) await ctx.kv.del(`pinfail:${pid}`);
    await audit(ctx, req.user!.id, 'profile.admin_update', id, {
      profile: pid, from: { name: p.name, hasPin: Boolean(p.pin_hash) }, to: { name: u.name, hasPin: Boolean(u.pin_hash) },
    });
    return { profile: { ...publicProfile(u), hasPin: Boolean(u.pin_hash) } };
  });

  // ---- invites: multi-use (maxUses), optional access days for the accounts they create ----
  app.post('/api/admin/invites', admin, async (req) => {
    const b = z.object({
      role: z.enum(INVITABLE_ROLES),
      ttlHours: z.number().int().min(1).max(24 * 14).default(48),
      note: z.string().max(100).optional(),
      /** false: the person already has an Authentik account, skip enrollment */
      enroll: z.boolean().default(true),
      /** how many accounts the invite may create */
      maxUses: z.number().int().min(1).max(50).default(1),
      /** access_until of each new account = now + accessDays; null = no end */
      accessDays: z.number().int().min(1).max(3650).nullable().default(null),
    }).parse(req.body);
    const inv = await createInvite(ctx, req.user!.id, b, req.log);
    await audit(ctx, req.user!.id, 'invite.create', inv.id, { role: b.role, authentik: inv.authentik, maxUses: b.maxUses, accessDays: b.accessDays });
    // token is shown exactly once
    return { id: inv.id, link: inv.link, enrollUrl: inv.enrollUrl, authentik: inv.authentik, expiresAt: inv.expiresAt, uses: inv.uses, maxUses: inv.maxUses };
  });

  // ?q= (note/role/first redeemer) &status=open|used|expired &sort=role|note|validUntil|status|createdAt &dir= &limit= &offset=; without params: the newest 100
  // used = all uses taken; used_by_name names the first account (see /uses for all of them)
  app.get('/api/admin/invites', admin, async (req) => {
    const p = pageQuery.extend({ status: z.enum(['open', 'used', 'expired']).optional(), role: z.string().max(40).optional() }).parse(req.query);
    const w = new Where();
    if (p.q) { const m = w.param(likePattern(p.q)); w.add(`(coalesce(i.note,'') ilike ${m} or i.role ilike ${m} or coalesce(u.name,'') ilike ${m})`); }
    if (p.role) w.add('i.role = ?', p.role);
    if (p.status === 'used') w.add('i.uses >= i.max_uses');
    else if (p.status === 'expired') w.add('i.uses < i.max_uses and i.expires_at < now()');
    else if (p.status === 'open') w.add('i.uses < i.max_uses and i.expires_at >= now()');
    const order = orderBy({ role: 'i.role', note: "lower(coalesce(i.note,''))", validUntil: 'i.expires_at', createdAt: 'i.created_at', status: "(case when i.uses >= i.max_uses then 2 when i.expires_at < now() then 1 else 0 end)" }, p.sort, p.dir, 'i.created_at desc, i.id');
    const from = 'from invites i left join users u on u.id = i.used_by';
    const total = Number((await ctx.db.query<{ c: string }>(`select count(*) c ${from} ${w.sql}`, w.params)).rows[0]!.c);
    const r = await ctx.db.query(
      `select i.id, i.role, i.note, i.created_at, i.expires_at, i.used_at, u.name used_by_name, i.uses, i.max_uses, i.access_days ${from} ${w.sql} ${order} limit ${p.limit ?? 100} offset ${p.offset ?? 0}`,
      w.params,
    );
    return { invites: r.rows, total };
  });

  // the accounts created from an invite, oldest first
  app.get('/api/admin/invites/:id/uses', admin, async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    if (!id.success || !(await ctx.db.query('select 1 from invites where id=$1', [id.data])).rowCount) return reply.code(404).send({ error: 'not_found' });
    const r = await ctx.db.query(
      'select u.id, u.name, u.email, u.role, u.disabled, iu.at from invite_uses iu join users u on u.id = iu.user_id where iu.invite_id=$1 order by iu.at, u.id',
      [id.data],
    );
    return { uses: r.rows };
  });

  // revoke: an unused invite is deleted; a partly used one is closed (max_uses = uses) so the accounts it made stay listed
  app.delete('/api/admin/invites/:id', admin, async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const r = await ctx.db.query<{ authentik_invite: string | null; uses: number; max_uses: number }>(
      `with d as (delete from invites where id=$1 and uses = 0 returning authentik_invite, uses, max_uses),
            c as (update invites n set max_uses = n.uses from invites o where n.id=$1 and o.id = n.id and n.uses > 0 and n.uses < n.max_uses
                  returning n.authentik_invite, n.uses, o.max_uses)
       select * from d union all select * from c`, [id]);
    const row = r.rows[0];
    if (row) {
      await deleteAuthentikInvitation(ctx, row.authentik_invite, req.log);
      await audit(ctx, req.user!.id, 'invite.revoke', id, { from: { uses: row.uses, maxUses: row.max_uses }, to: row.uses ? { uses: row.uses, maxUses: row.uses } : null });
    }
    return { ok: true };
  });
}
