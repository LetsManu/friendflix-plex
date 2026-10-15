// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Account deletion with a grace period: scheduling locks the account at once (locked_reason 'deletion', deletion_at = now + 7 days),
 * a restore within the grace period undoes it. The final deletion steps run in the deletion tick, which first claims the account
 * (an account_deletions row); from then on it can no longer be restored. Callers run these helpers in accountSerial (not re-entrant).
 */
import { createHmac } from 'node:crypto';
import type pg from 'pg';
import { audit } from './audit.js';
import type { Ctx } from './ctx.js';
import { m } from './i18n.js';
import { notifyAdmins } from './notify.js';
import { akSetActive } from './authentik.js';
import { revokeDownloads } from './downloads.js';
import { accountJellyfinIds } from './profiles.js';
import { pendingNoticeKey } from './pending.js';
import { SeerrError } from './seerr/client.js';
import { HttpError, accessEnded, accountSerial, assertNotLastAdmin, lockUser, unlockUser } from './users.js';

/** the grace period between the request and the final deletion */
export const GRACE_MS = 7 * 86400e3;

/** `deleted-` + 8 hex characters of an HMAC over the id: stable, not reversible without the key (it replaces the name in the audit log) */
export function pseudonymFor(ctx: Pick<Ctx, 'encKey'>, userId: string): string {
  return `deleted-${createHmac('sha256', ctx.encKey).update(`friendflix deleted v1|${userId}`).digest('hex').slice(0, 8)}`;
}

const adminLink = (userId: string) => `/admin/users/${userId}`;

/**
 * Schedules the deletion and locks the account at once (sessions and offline licenses revoked). Refuses the last active admin
 * (400 last_admin) and an account that is already locked (409 account_locked). Returns the deletion date.
 */
export async function scheduleDeletion(ctx: Ctx, actor: string | null, userId: string, now = new Date()): Promise<Date> {
  const u = (await ctx.db.query<{ name: string; disabled: boolean }>('select name, disabled from users where id=$1', [userId])).rows[0];
  if (!u) throw new HttpError(404, 'not_found');
  if (u.disabled) throw new HttpError(409, 'account_locked');
  await assertNotLastAdmin(ctx, [userId], 'lock');
  const at = new Date(now.getTime() + GRACE_MS);
  await ctx.db.query('update users set deletion_at=$2 where id=$1', [userId, at]);
  try {
    await lockUser(ctx, actor, userId, 'deletion');
  } catch (e) {
    // the lock failed (e.g. media server down): no deletion date on an account that is still usable
    await ctx.db.query('update users set deletion_at=null where id=$1 and not disabled', [userId]);
    throw e;
  }
  const iso = at.toISOString();
  await audit(ctx, actor, 'user.deletion_requested', userId, { deletionAt: iso, by: actor === userId ? 'self' : 'admin' });
  await notifyAdmins(ctx, { kind: 'deletion_requested', title: m('notify.deletion.requested', { name: u.name, date: { date: iso } }), link: adminLink(userId), dedupe: `deletion-req-${userId}-${iso}` });
  return at;
}

/**
 * Cancels a scheduled deletion. One transaction locks the users row and then checks for a claim in a fresh statement, so a
 * claim that committed while this waited is seen (409 deletion_in_progress). Not scheduled: 409 not_scheduled; unknown: 404.
 * An account whose access has ended meanwhile stays locked, as 'expired' (never enabled); otherwise it is unlocked
 * (unlockUser audits the restore). Only this path sends the admins the "restored" notice.
 */
export async function restoreDeletion(ctx: Ctx, actor: string | null, userId: string): Promise<void> {
  const c = await (ctx.db as pg.Pool).connect();
  let u: { name: string; deletion_at: Date; access_until: Date | null };
  let ended: boolean;
  try {
    await c.query('begin');
    const r = await c.query<typeof u & { locked_reason: string | null }>(
      'select name, locked_reason, deletion_at, access_until from users where id=$1 for update', [userId]);
    const claimed = await c.query('select 1 from account_deletions where user_id=$1', [userId]);
    if (claimed.rowCount) throw new HttpError(409, 'deletion_in_progress');
    const row = r.rows[0];
    if (!row) throw new HttpError(404, 'not_found');
    if (row.locked_reason !== 'deletion' || !row.deletion_at) throw new HttpError(409, 'not_scheduled');
    u = row;
    // ended access: the lock stays and becomes the expiry lock (phase 1 never unlocks ended access). Judged once, here: the
    // branch after the commit must follow what this statement did
    ended = accessEnded(u.access_until);
    await c.query(`update users set deletion_at=null${ended ? ", locked_reason='expired'" : ''} where id=$1`, [userId]);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  if (ended) await audit(ctx, actor, 'user.deletion_restored', userId, { lockedReason: 'expired' });
  else {
    try {
      await unlockUser(ctx, actor, userId); // still locked as 'deletion' here, so it audits user.deletion_restored
    } catch (e) {
      // e.g. media server down: the account is still locked; the date goes back so the restore can be retried. Never to a
      // date that has passed (after "delete now", or close to the date): the next tick would delete what was being restored
      await ctx.db.query(
        "update users set deletion_at=greatest($2, now() + interval '1 hour') where id=$1 and disabled and locked_reason='deletion' and deletion_at is null",
        [userId, u.deletion_at]);
      throw e;
    }
  }
  await notifyAdmins(ctx, { kind: 'deletion_restored', title: m('notify.deletion.restored', { name: u.name }), link: adminLink(userId), dedupe: `deletion-restored-${userId}-${u.deletion_at.toISOString()}` });
}

/** where the deletion tick's admin notices point: the user list's "deletion pending" filter, which lists unfinished cleanups */
const CLEANUP_LINK = '/admin/users?status=deleting';

/** An account_deletions row: the snapshot the steps work from (its personal columns are nulled when the deletion finishes). */
interface Tombstone {
  user_id: string;
  pseudonym: string;
  step: number;
  authentik_sub: string | null;
  jellyfin_ids: string[] | null;
  seerr_user_id: number | null;
  email: string | null;
}

/**
 * Timer tick of the final deletion. Claims every account whose grace period is over (locked_reason 'deletion', deletion_at
 * passed), then runs the steps of every unfinished deletion from the step after the last one done:
 * 1 media server identities, 2 request-service user, 3 offline licences, 4 the users row (cascades) and admin notices
 * naming the person, 5 audit scrub (pseudonym), 6 Authentik user deactivated. Every step can be repeated. A failing step
 * stores its error code and stops that account until the next tick (the admins are told once per step); other accounts go
 * on. The claim and steps 1–4 run in accountSerial, so they never interleave with an admin action on the account.
 */
export async function deletionTick(ctx: Ctx, now = new Date()): Promise<{ claimed: number; finished: number; failed: number }> {
  const due = await ctx.db.query<{ id: string }>(
    "select id from users where locked_reason='deletion' and deletion_at <= $1 order by deletion_at, id", [now]);
  let claimed = 0;
  let failure: unknown;
  for (const u of due.rows) {
    try {
      if (await accountSerial(() => claim(ctx, u.id, now))) claimed++;
    } catch (e) {
      failure ??= e; // one account must not block the others; retried next tick
    }
  }
  const open = await ctx.db.query<Tombstone>(
    `select user_id, pseudonym, step, authentik_sub, jellyfin_ids, seerr_user_id, email
       from account_deletions where finished_at is null order by started_at, user_id`);
  let finished = 0;
  let failed = 0;
  for (const t of open.rows) {
    try {
      const r = await runSteps(ctx, t, now);
      if (r === 'finished') finished++;
      else if (r === 'failed') failed++;
    } catch (e) {
      failed++;
      failure ??= e;
    }
  }
  if (failure) throw failure;
  return { claimed, finished, failed };
}

/**
 * Claims one due account: locks its users row first (`for update skip locked`; a restore holding the lock wins, phase 2
 * ruling F7), then writes the account_deletions snapshot. From then on the account can no longer be restored. Returns
 * false when the account is no longer due or is locked by a restore.
 */
async function claim(ctx: Ctx, userId: string, now: Date): Promise<boolean> {
  const c = await (ctx.db as pg.Pool).connect();
  try {
    await c.query('begin');
    const u = (await c.query<{ id: string; authentik_sub: string; seerr_user_id: number | null; name: string; email: string | null }>(
      `select id, authentik_sub, seerr_user_id, name, email from users
        where id=$1 and locked_reason='deletion' and deletion_at <= $2 for update skip locked`, [userId, now])).rows[0];
    if (!u) {
      await c.query('rollback');
      return false;
    }
    const pseudonym = pseudonymFor(ctx, userId);
    const ins = await c.query(
      `insert into account_deletions(user_id, pseudonym, authentik_sub, jellyfin_ids, seerr_user_id, name, email)
       values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing returning 1`,
      [userId, pseudonym, u.authentik_sub, await accountJellyfinIds({ db: c as unknown as Ctx['db'] }, userId), u.seerr_user_id, u.name, u.email]);
    if (ins.rowCount) await audit({ db: c as unknown as Ctx['db'] }, null, 'user.deletion_started', userId, { pseudonym });
    await c.query('commit');
    return Boolean(ins.rowCount);
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** The stored error of a failed step: a code or a class name (with a status), never a message that could quote a URL or token. */
function errorCode(e: unknown): string {
  if (e instanceof HttpError) return e.message; // a code by construction
  const name = e instanceof Error ? e.constructor.name : 'Error';
  const { status, code } = (e ?? {}) as { status?: unknown; code?: unknown };
  if (typeof status === 'number') return `${name}:${status}`;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return `${name}:${code}`; // a Postgres SQLSTATE
  return name;
}

type StepResult = 'finished' | 'failed' | 'pending';

/**
 * The audit scrub of entries keyed by the person's approval-request ids (`user.rejected` carries the requester's name and the
 * admin's message, which may quote it). $1 the request ids, $2 the pseudonym.
 */
const SCRUB_REQUESTS = `update audit_log set meta = (meta - 'name' - 'email' - 'jellyfin' - 'username' - 'ip' - 'message')
                                                 || jsonb_build_object('pseudonym', $2::text)
                         where target = any($1::text[])`;

/** Runs the steps of one claimed account from `step + 1`; stops at the first failure (recorded, not thrown). */
async function runSteps(ctx: Ctx, t: Tombstone, now: Date): Promise<StepResult> {
  const id = t.user_id;
  let step = t.step;
  /** runs step n; on failure records it (the first failure of step n is audited and the admins told) and answers false */
  const run = async (n: number, fn: () => Promise<void>): Promise<boolean> => {
    try {
      await fn();
    } catch (e) {
      await stepFailed(ctx, t, n, errorCode(e));
      return false;
    }
    if (n < 6) await ctx.db.query('update account_deletions set step=greatest(step, $2), last_error=null, failed_step=null where user_id=$1', [id, n]);
    step = n;
    return true;
  };
  const early: Array<() => Promise<void>> = [
    // 1: the owner and profile identities on the media server (an identity that is already gone counts as deleted)
    async () => { for (const jid of t.jellyfin_ids ?? []) await ctx.jf.admin.deleteIdentity(jid); },
    // 2: the request-service user (404: already gone; no request service set up: nothing to do, the step counts as done)
    async () => {
      if (t.seerr_user_id == null || !ctx.seerr) return;
      await ctx.seerr.deleteUser(t.seerr_user_id).catch((e: unknown) => { if (!(e instanceof SeerrError && e.status === 404)) throw e; });
    },
    // 3: offline licences (the lock revoked them already; repeated for safety)
    async () => { await revokeDownloads(ctx, id); },
    // 4: the account's rows and the admin notices that name the person
    async () => {
      const c = await (ctx.db as pg.Pool).connect();
      let profileIds: string[];
      try {
        await c.query('begin');
        profileIds = (await c.query<{ id: string }>('select id from profiles where user_id=$1', [id])).rows.map((r) => r.id);
        // the pseudonymous failure notices of this deletion stay
        await c.query("delete from notifications where (link = '/admin/users/' || $1 or dedupe like '%' || $1 || '%') and kind <> 'deletion_failed'", [id]);
        if (t.authentik_sub) {
          // an open or rejected request of this person: its audit entries are keyed by the request id (step 5 cannot find them later)
          const reqIds = (await c.query<{ id: string }>('select id::text id from approval_requests where authentik_sub=$1', [t.authentik_sub])).rows.map((r) => r.id);
          await c.query(SCRUB_REQUESTS, [reqIds, t.pseudonym]);
          await c.query('delete from approval_requests where authentik_sub=$1', [t.authentik_sub]);
        }
        await c.query('delete from users where id=$1', [id]); // cascades profiles, lists, history, devices, push subscriptions, limits …
        await c.query('commit');
      } catch (e) {
        await c.query('rollback').catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
      // akuser:<sub> stays until step 6 (the Authentik lookup); akmfa is a cache only
      if (t.authentik_sub) await ctx.kv.del(`akmfa:${t.authentik_sub}`);
      await ctx.kv.del(`pinfail:${id}`);
      await ctx.kv.del(`pinfail-acct:${id}`);
      // per-profile caches (TTL only): media server tokens of the deleted identities, PIN lockouts, home cache stamps
      for (const pid of profileIds) for (const k of [`jft:${pid}`, `pinfail:${pid}`, `homegen:${pid}`]) await ctx.kv.del(k);
    },
  ];
  if (step < 4) {
    const ok = await accountSerial(async () => {
      for (let n = step + 1; n <= 4; n++) if (!(await run(n, early[n - 1]!))) return false;
      return true;
    });
    if (!ok) return 'failed';
  }
  if (step < 5 && !(await run(5, async () => {
    await ctx.db.query(
      // nested names: profile.admin_update keeps { from: { name }, to: { name } } of the account's profiles
      `update audit_log set meta = (meta - 'name' - 'email' - 'jellyfin' - 'username' - 'ip' #- '{from,name}' #- '{to,name}')
                                   || jsonb_build_object('pseudonym', $2::text)
        where actor = $1::uuid or target = $1::text`, [id, t.pseudonym]);
    // the approval request that became this account (user.approved names it): its user.rejected entries and the /pending notice
    const reqIds = (await ctx.db.query<{ r: string }>(
      "select distinct meta->>'request' r from audit_log where action='user.approved' and target=$1 and meta ? 'request'", [id])).rows.map((x) => x.r);
    await ctx.db.query(SCRUB_REQUESTS, [reqIds, t.pseudonym]);
    for (const r of reqIds) await ctx.kv.del(pendingNoticeKey(r));
  }))) return 'failed';
  // 6: the Authentik user is deactivated (never deleted); finishing is part of the step, so its outcome reaches the audit
  let authentik: 'deactivated' | 'not_configured' | 'not_found' = 'not_found';
  if (!(await run(6, async () => {
    if (t.authentik_sub) {
      await ctx.kv.del(`akuser:${t.authentik_sub}`); // a cached "missing" must not stand for "not found" here
      const r = await akSetActive(ctx, t.authentik_sub, false, t.email);
      authentik = r === 'done' ? 'deactivated' : r;
      await ctx.kv.del(`akuser:${t.authentik_sub}`);
    }
  }))) return 'failed';
  const done = await ctx.db.query(
    `update account_deletions set step=6, finished_at=$2, last_error=null, failed_step=null,
            authentik_sub=null, jellyfin_ids=null, seerr_user_id=null, name=null, email=null
      where user_id=$1 and finished_at is null returning 1`, [id, now]);
  if (!done.rowCount) return 'pending'; // finished by an overlapping run
  await audit(ctx, null, 'user.deleted', id, { pseudonym: t.pseudonym, authentik });
  await notifyAdmins(ctx, { kind: 'deletion_done', title: m('notify.deletion.done', { pseudonym: t.pseudonym }), link: CLEANUP_LINK, dedupe: `deletion-done-${id}` });
  return 'finished';
}

/**
 * Records a failed step. Only its first failure (detected in SQL: failed_step changes) is audited and sent to the admins,
 * so a step that keeps failing does not repeat either (phase 2 ruling F12).
 */
async function stepFailed(ctx: Ctx, t: Tombstone, step: number, error: string): Promise<void> {
  const first = await ctx.db.query(
    'update account_deletions set failed_step=$2, last_error=$3 where user_id=$1 and failed_step is distinct from $2 returning 1', [t.user_id, step, error]);
  if (!first.rowCount) {
    await ctx.db.query('update account_deletions set last_error=$2 where user_id=$1', [t.user_id, error]);
    return;
  }
  await audit(ctx, null, 'user.deletion_failed', t.user_id, { step, error });
  await notifyAdmins(ctx, { kind: 'deletion_failed', title: m('notify.deletion.failed', { pseudonym: t.pseudonym, step }), link: CLEANUP_LINK, dedupe: `deletion-fail-${t.user_id}-${step}` });
}
