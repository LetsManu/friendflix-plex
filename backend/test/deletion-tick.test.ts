// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deletionTick, pseudonymFor, restoreDeletion, scheduleDeletion } from '../src/deletion.js';
import type { OidcClaims } from '../src/oidc.js';
import { provisionUser } from '../src/users.js';
import { ADMIN, cfg, fakeHttp, makeEnv, type Call, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess;
let adminId = '';
const DAY = 86400e3;
const TOKEN = 'ak-secret-token';

/** switches for the fakes: status codes the next calls answer */
const fail = { jfDelete: 0, seerrDelete: 0, akPatch: 0 };
/** what the Authentik user list answers for is_active (undefined: the field is left out) */
const akUser: { isActive?: boolean } = {};
const akCalls: Call[] = [];

const call = (s: Sess, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'POST', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
const audits = async (action: string, target: string) =>
  (await env.pool.query<{ actor: string | null; meta: Record<string, unknown> }>('select actor, meta from audit_log where action=$1 and target=$2 order by id', [action, target])).rows;
const notices = async (key: string) =>
  (await env.pool.query("select user_id, link, dedupe, msg->'title'->'params' params from notifications where msg->'title'->>'key'=$1 order by id", [key])).rows as
    { user_id: string; link: string; dedupe: string; params: Record<string, unknown> }[];
const tomb = async (id: string) => (await env.pool.query('select * from account_deletions where user_id=$1', [id])).rows[0] as Record<string, unknown> | undefined;
const jfDeletes = () => env.jfCalls.filter((c) => c.method === 'DELETE').map((c) => c.path);
const seerrDeletes = () => env.seerrCalls.filter((c) => c.method === 'DELETE').map((c) => c.path);
const akPatches = () => akCalls.filter((c) => c.method === 'PATCH');

function withAuthentik() {
  env.ctx.cfg = { ...env.ctx.cfg, AUTHENTIK_URL: 'http://authentik-server:9000', AUTHENTIK_API_TOKEN: TOKEN };
}
function withoutAuthentik() {
  env.ctx.cfg = { ...env.ctx.cfg, AUTHENTIK_URL: undefined, AUTHENTIK_API_TOKEN: undefined };
}

let n = 0;
/** a fresh account (owner + one profile identity, a request-service user), deletion scheduled and already due */
async function doomed(opts: { due?: boolean } = {}): Promise<{ id: string; claims: OidcClaims; profileJf: string; ownerJf: string }> {
  const k = ++n;
  const claims: OidcClaims = { sub: `hashed-sub-${k}`, email: `doomed${k}@x.de`, name: `Doomed${k}`, groups: [] };
  const u = await provisionUser(env.ctx, claims, 'friend');
  const profileJf = `jfprofile${k}`;
  await env.pool.query("insert into profiles(id, user_id, name, jellyfin_user_id) values (gen_random_uuid(), $1, 'Kid', $2)", [u.id, profileJf]);
  await env.pool.query('update users set seerr_user_id=$2 where id=$1', [u.id, 40 + k]);
  const now = opts.due === false ? new Date() : new Date(Date.now() - 8 * DAY);
  await scheduleDeletion(env.ctx, adminId, u.id, now);
  return { id: u.id, claims, profileJf, ownerJf: u.jellyfin_user_id };
}

/** runs /auth/login + /auth/callback for `claims`; answers the callback's status and body */
async function loginAttempt(claims: OidcClaims) {
  env.claims.current = claims;
  const l = await env.app.inject('/auth/login');
  const state = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
  return env.app.inject({ url: `/auth/callback?state=${state}&code=c`, cookies: { ff_oidc: state } });
}

beforeAll(async () => {
  env = await makeEnv(
    { 'DELETE /Users/[^/]+': () => ({ status: fail.jfDelete || 204 }) },
    { seerr: { 'DELETE /api/v1/user/\\d+': () => (fail.seerrDelete ? { status: fail.seerrDelete, json: { message: 'x' } } : { json: {} }) } },
  );
  env.ctx.fetchImpl = fakeHttp({
    // a hashed sub: found only through the e-mail search (as Authentik's default subject mode)
    'GET /api/v3/core/users/': (u) => {
      const q = u.searchParams.get('search');
      const m = q?.match(/^doomed(\d+)@x\.de$/);
      return { json: { pagination: { next: 0 }, results: m ? [{ pk: 100 + Number(m[1]), username: `d${m[1]}`, email: q, uid: `hashed-sub-${m[1]}`, ...(akUser.isActive === undefined ? {} : { is_active: akUser.isActive }) }] : [] } };
    },
    'PATCH /api/v3/core/users/\\d+/': () => (fail.akPatch ? { status: fail.akPatch } : { json: {} }),
  }, akCalls);
  await env.login();
  adminId = (await env.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id;
});
afterAll(() => env.close());
beforeEach(async () => {
  Object.assign(fail, { jfDelete: 0, seerrDelete: 0, akPatch: 0 });
  delete akUser.isActive;
  withAuthentik();
  // leftovers of earlier tests must not be picked up by this test's ticks
  await env.pool.query('delete from users where id in (select user_id from account_deletions where finished_at is null)');
  await env.pool.query('delete from account_deletions where finished_at is null');
  await env.pool.query("update users set deletion_at=null where locked_reason='deletion'");
  await env.pool.query('delete from notifications');
  admin = await env.login(ADMIN);
  env.jfCalls.length = 0;
  env.seerrCalls.length = 0;
  akCalls.length = 0;
});

describe('deletionTick', () => {
  it('full run deletes identities, request-service user, licences, rows, scrubs audit and deactivates Authentik', async () => {
    const d = await doomed();
    const s = await loginAttempt(d.claims); // locked: 403, but nothing else
    expect(s.statusCode).toBe(403);
    await env.pool.query("insert into audit_log(actor, action, target, meta) values ($1, 'login', $2, $3)", [d.id, d.id, JSON.stringify({ ip: '10.1.2.3' })]);
    await env.pool.query("insert into audit_log(actor, action, target, meta) values ($1, 'user.provisioned', $2, $3)",
      [adminId, d.id, JSON.stringify({ name: 'Doomed', email: 'doomed@x.de', jellyfin: 'Doomed', username: 'dd', role: 'friend' })]);
    // the person's approval history: an earlier rejection (keyed by the request id, which user.approved names), and a
    // request still on file for the sub with its own rejection
    const approvedReq = '11111111-1111-4111-8111-111111111111';
    await env.pool.query("insert into audit_log(actor, action, target, meta) values ($1, 'user.rejected', $2, $3)",
      [adminId, approvedReq, JSON.stringify({ from: 'pending', to: 'rejected', name: d.claims.name, message: `Sorry ${d.claims.name}` })]);
    await env.pool.query("insert into audit_log(actor, action, target, meta) values ($1, 'user.approved', $2, $3)",
      [adminId, d.id, JSON.stringify({ from: 'pending', to: 'friend', accessUntil: null, request: approvedReq })]);
    await env.kv.set(`pending_notice:${approvedReq}`, JSON.stringify({ sub: d.claims.sub, email: d.claims.email }), 600);
    const openReq = (await env.pool.query("insert into approval_requests(id, authentik_sub, email, name, rejected_at) values (gen_random_uuid(), $1, $2, $3, now()) returning id::text id",
      [d.claims.sub, d.claims.email, d.claims.name])).rows[0].id as string;
    await env.pool.query("insert into audit_log(actor, action, target, meta) values ($1, 'user.rejected', $2, $3)",
      [adminId, openReq, JSON.stringify({ from: 'pending', to: 'rejected', name: d.claims.name, message: null })]);
    // nested names (admin rename of a profile) and the account's own profile audit
    await env.pool.query("insert into audit_log(actor, action, target, meta) values ($1, 'profile.admin_update', $2, $3)",
      [adminId, d.id, JSON.stringify({ profile: d.id, from: { name: 'Doomed', hasPin: false }, to: { name: 'Lena', hasPin: false } })]);
    await env.pool.query("insert into audit_log(actor, action, target, meta) values ($1, 'profile.create', gen_random_uuid()::text, $2)", [d.id, JSON.stringify({ name: 'Kid' })]);
    // rows the cascade must remove: a device with a download and a push subscription, a watchlist entry, an own list with
    // another member, and a membership in someone else's list
    const dev = 'dev-doomed';
    await env.pool.query("insert into devices(user_id, device_id, label) values ($1, $2, 'Phone')", [d.id, dev]);
    await env.pool.query(
      `insert into downloads(id, user_id, device_id, profile_id, item_id, quality, status, expires_at) values (gen_random_uuid(), $1, $2, $1, 'm1', 'original', 'fetched', now() + interval '10 days')`,
      [d.id, dev]);
    await env.pool.query("insert into push_subscriptions(user_id, device_id, profile_id, endpoint, p256dh, auth) values ($1, $2, $1, 'https://push.example/doomed', 'k', 'a')", [d.id, dev]);
    await env.pool.query("insert into watchlist(user_id, profile_id, item_id) values ($1, $1, 'w1')", [d.id]);
    const own = (await env.pool.query("insert into lists(id, owner_id, name) values (gen_random_uuid(), $1, 'Mine') returning id", [d.id])).rows[0].id;
    await env.pool.query("insert into list_members(list_id, user_id, role) values ($1, $2, 'viewer')", [own, adminId]);
    const other = (await env.pool.query("insert into lists(id, owner_id, name) values (gen_random_uuid(), $1, 'Theirs') returning id", [adminId])).rows[0].id;
    await env.pool.query("insert into list_members(list_id, user_id, role) values ($1, $2, 'editor')", [other, d.id]);
    await env.kv.set(`jft:${d.id}`, 'x', 600);
    await env.kv.set(`homegen:${d.id}`, '1', 600);
    env.jfCalls.length = 0;

    const r = await deletionTick(env.ctx);
    expect(r).toEqual({ claimed: 1, finished: 1, failed: 0 });

    expect(jfDeletes().sort()).toEqual([`/Users/${d.ownerJf}`, `/Users/${d.profileJf}`].sort());
    expect(seerrDeletes()).toEqual([`/api/v1/user/${40 + n}`]);
    for (const t of ['users', 'profiles', 'devices', 'notifications', 'downloads', 'push_subscriptions', 'watchlist', 'list_members', 'lists']) {
      const col = t === 'users' ? 'id' : t === 'lists' ? 'owner_id' : 'user_id';
      expect((await env.pool.query(`select 1 from ${t} where ${col}=$1`, [d.id])).rowCount, t).toBe(0);
    }
    expect((await env.pool.query('select 1 from lists where id=$1', [own])).rowCount).toBe(0);
    expect((await env.pool.query('select 1 from list_members where list_id=$1', [other])).rowCount).toBe(0);
    expect((await env.pool.query('select 1 from lists where id=$1', [other])).rowCount).toBe(1);
    expect(await env.kv.get(`jft:${d.id}`)).toBeNull();
    expect(await env.kv.get(`homegen:${d.id}`)).toBeNull();
    const p = pseudonymFor(env.ctx, d.id);
    const rows = (await env.pool.query<{ meta: Record<string, unknown> }>('select meta from audit_log where actor=$1 or target=$1::text', [d.id])).rows;
    expect(rows.length).toBeGreaterThan(3);
    for (const a of rows) {
      expect(a.meta.pseudonym).toBe(p);
      for (const k of ['name', 'email', 'ip', 'jellyfin', 'username']) expect(a.meta).not.toHaveProperty(k);
    }
    expect(JSON.stringify(rows)).not.toMatch(/Doomed|Lena|"Kid"|10\.1\.2\.3/);
    // nothing in the whole audit log names the person any more; the approval entries carry the pseudonym
    const everything = (await env.pool.query<{ target: string; meta: Record<string, unknown> }>('select target, meta from audit_log')).rows;
    const named = new RegExp(`${d.claims.name}(?![0-9])|doomed${n}@`);
    expect(everything.filter((a) => named.test(JSON.stringify(a.meta)))).toEqual([]);
    for (const target of [approvedReq, openReq]) {
      expect(everything.find((a) => a.target === target)!.meta).toEqual({ from: 'pending', to: 'rejected', pseudonym: p });
    }
    expect((await env.pool.query('select 1 from approval_requests where authentik_sub=$1', [d.claims.sub])).rowCount).toBe(0);
    expect(await env.kv.get(`pending_notice:${approvedReq}`)).toBeNull();
    const renamed = rows.find((a) => a.meta.profile === d.id)!;
    expect(renamed.meta).toEqual({ profile: d.id, from: { hasPin: false }, to: { hasPin: false }, pseudonym: p });
    expect(akPatches().map((c) => [c.path, c.body])).toEqual([[`/api/v3/core/users/${100 + n}/`, { is_active: false }]]);
    expect(await audits('user.deleted', d.id)).toEqual([{ actor: null, meta: { pseudonym: p, authentik: 'deactivated' } }]);
    expect(await notices('notify.deletion.done')).toEqual([{ user_id: adminId, link: '/admin/users?status=deleting', dedupe: `deletion-done-${d.id}-${adminId}`, params: { pseudonym: p } }]);
    expect(await env.kv.get(`akuser:hashed-sub-${n}`)).toBeNull();
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it('a failing step 1 is retried next tick; steps run once; started audit and failure notice once', async () => {
    const d = await doomed();
    fail.jfDelete = 500;
    expect(await deletionTick(env.ctx)).toEqual({ claimed: 1, finished: 0, failed: 1 });
    expect(await tomb(d.id)).toMatchObject({ step: 0, failed_step: 1, last_error: 'JellyfinError:500' });
    expect(await deletionTick(env.ctx)).toEqual({ claimed: 0, finished: 0, failed: 1 });
    const p = pseudonymFor(env.ctx, d.id);
    expect(await audits('user.deletion_started', d.id)).toEqual([{ actor: null, meta: { pseudonym: p } }]);
    expect((await audits('user.deletion_failed', d.id)).map((a) => a.meta)).toEqual([{ step: 1, error: 'JellyfinError:500' }]);
    expect(await notices('notify.deletion.failed')).toEqual([{ user_id: adminId, link: '/admin/users?status=deleting', dedupe: `deletion-fail-${d.id}-1-${adminId}`, params: { pseudonym: p, step: 1 } }]);
    // the users row still exists, the account stays locked; the error never quotes a URL
    expect((await env.pool.query('select disabled from users where id=$1', [d.id])).rows).toEqual([{ disabled: true }]);
    expect(String((await tomb(d.id))!.last_error)).not.toMatch(/http|\//);

    fail.jfDelete = 0;
    expect(await deletionTick(env.ctx)).toEqual({ claimed: 0, finished: 1, failed: 0 });
    expect(seerrDeletes()).toHaveLength(1);
    expect(akPatches()).toHaveLength(1);
    expect(await tomb(d.id)).toMatchObject({ step: 6, failed_step: null, last_error: null });
    expect(await deletionTick(env.ctx)).toEqual({ claimed: 0, finished: 0, failed: 0 });
    expect(await audits('user.deletion_started', d.id)).toHaveLength(1);
    expect(await audits('user.deleted', d.id)).toHaveLength(1);
  });

  it('a later step failing after an earlier one failed sends its own notice; unchanged errors do not repeat it', async () => {
    const d = await doomed();
    fail.seerrDelete = 500;
    await deletionTick(env.ctx);
    await deletionTick(env.ctx);
    expect(await tomb(d.id)).toMatchObject({ step: 1, failed_step: 2, last_error: 'SeerrError:500' });
    fail.seerrDelete = 0;
    fail.akPatch = 500;
    await deletionTick(env.ctx);
    expect(await tomb(d.id)).toMatchObject({ step: 5, failed_step: 6, last_error: 'authentik_error' });
    // (the step 2 entry was scrubbed by step 5: it carries the pseudonym too)
    expect((await audits('user.deletion_failed', d.id)).map((a) => [a.meta.step, a.meta.error])).toEqual([[2, 'SeerrError:500'], [6, 'authentik_error']]);
    expect((await notices('notify.deletion.failed')).map((x) => x.params.step)).toEqual([2, 6]);
  });

  it('restore racing the claim: exactly one wins', async () => {
    for (let i = 0; i < 12; i++) {
      const d = await doomed();
      await env.pool.query('update users set deletion_at=now() where id=$1', [d.id]);
      // staggered starts, so both orders occur (the restore first, or the claim first)
      const later = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const [restore, tick] = await Promise.allSettled([later(i % 4 * 3).then(() => restoreDeletion(env.ctx, adminId, d.id)), deletionTick(env.ctx)]);
      expect(tick.status).toBe('fulfilled');
      const claimed = tick.status === 'fulfilled' ? tick.value.claimed : -1;
      const restored = restore.status === 'fulfilled';
      expect(Number(restored) + claimed, `round ${i}`).toBe(1);
      if (!restored) expect((restore as PromiseRejectedResult).reason.message).toBe('deletion_in_progress');
      if (restored) {
        expect((await env.pool.query('select disabled, deletion_at from users where id=$1', [d.id])).rows).toEqual([{ disabled: false, deletion_at: null }]);
        expect(await tomb(d.id)).toBeUndefined();
      } else expect(await tomb(d.id)).toBeDefined();
    }
  });

  it('a restore holding the users row lock makes the claim skip the account; a committed claim makes the restore fail', async () => {
    const d = await doomed();
    const c = await env.pool.connect();
    try {
      await c.query('begin');
      await c.query('select 1 from users where id=$1 for update', [d.id]); // what restoreDeletion's transaction holds
      expect((await deletionTick(env.ctx)).claimed).toBe(0);
      expect(await tomb(d.id)).toBeUndefined();
      await c.query('rollback');
    } finally {
      c.release();
    }
    fail.jfDelete = 500; // the claim commits, step 1 fails: the users row still exists
    expect((await deletionTick(env.ctx)).claimed).toBe(1);
    await expect(restoreDeletion(env.ctx, adminId, d.id)).rejects.toThrow('deletion_in_progress');
  });

  it('a failed restore after "delete now" re-arms a date at least an hour away: the next tick does not delete', async () => {
    const d = await doomed({ due: false });
    expect((await call(admin, 'POST', `/api/admin/users/${d.id}/deletion/now`)).statusCode).toBe(200);
    const jfAdmin = env.ctx.jf.admin;
    const setDisabled = jfAdmin.setDisabled;
    jfAdmin.setDisabled = async () => { throw new Error('media server down'); };
    try {
      await expect(restoreDeletion(env.ctx, adminId, d.id)).rejects.toThrow('media server down');
    } finally {
      jfAdmin.setDisabled = setDisabled;
    }
    const r = (await env.pool.query<{ disabled: boolean; locked_reason: string; deletion_at: Date }>('select disabled, locked_reason, deletion_at from users where id=$1', [d.id])).rows[0]!;
    expect(r).toMatchObject({ disabled: true, locked_reason: 'deletion' });
    expect(r.deletion_at.getTime()).toBeGreaterThan(Date.now() + 59 * 60e3);
    expect((await deletionTick(env.ctx)).claimed).toBe(0);
    expect(await tomb(d.id)).toBeUndefined();
    await restoreDeletion(env.ctx, adminId, d.id); // the retry works
    expect((await env.pool.query('select disabled, deletion_at from users where id=$1', [d.id])).rows).toEqual([{ disabled: false, deletion_at: null }]);
  });

  it('a failed restore well before the date puts the original date back', async () => {
    const d = await doomed({ due: false });
    const before = (await env.pool.query<{ deletion_at: Date }>('select deletion_at from users where id=$1', [d.id])).rows[0]!.deletion_at;
    const jfAdmin = env.ctx.jf.admin;
    const setDisabled = jfAdmin.setDisabled;
    jfAdmin.setDisabled = async () => { throw new Error('media server down'); };
    try {
      await expect(restoreDeletion(env.ctx, adminId, d.id)).rejects.toThrow('media server down');
    } finally {
      jfAdmin.setDisabled = setDisabled;
    }
    expect((await env.pool.query('select deletion_at from users where id=$1', [d.id])).rows[0].deletion_at).toEqual(before);
  });

  it('access that ends while a restore runs is judged once: the account is never left locked without a date', async () => {
    const d = await doomed({ due: false });
    const until = Date.now() + 300;
    await env.pool.query('update users set access_until=$2 where id=$1', [d.id, new Date(until)]);
    // the commit of the restore transaction returns only after access_until has passed
    const pool = env.ctx.db as unknown as pg.Pool;
    const connect = pool.connect;
    // (pool.query checks out with a callback: that path stays as it is)
    pool.connect = ((cb?: unknown) => cb ? (connect as (x: unknown) => void).call(pool, cb) : wrapped()) as typeof connect;
    const wrapped = async () => {
      const c = await (connect as () => Promise<pg.PoolClient>).call(pool);
      const query = c.query;
      const release = c.release;
      c.query = (async (...a: Parameters<typeof query>) => {
        const r = await (query as (...x: unknown[]) => Promise<unknown>).apply(c, a);
        if (a[0] === 'commit') await new Promise((ok) => setTimeout(ok, Math.max(0, until - Date.now()) + 50));
        return r;
      }) as typeof query;
      c.release = ((err?: Error | boolean) => {
        c.query = query;
        c.release = release;
        return release.call(c, err);
      }) as typeof release;
      return c;
    };
    try {
      await restoreDeletion(env.ctx, adminId, d.id);
    } finally {
      pool.connect = connect;
    }
    const r = (await env.pool.query('select disabled, locked_reason, deletion_at from users where id=$1', [d.id])).rows[0];
    // access had not ended when the transaction ran: unlocked (the expiry tick locks it as expired later)
    expect(r).toEqual({ disabled: false, locked_reason: null, deletion_at: null });
  });

  it('step 6 with an Authentik user that is already inactive finishes without a PATCH (token without change_user)', async () => {
    const d = await doomed();
    akUser.isActive = false;
    fail.akPatch = 403;
    expect(await deletionTick(env.ctx)).toEqual({ claimed: 1, finished: 1, failed: 0 });
    expect(akPatches()).toEqual([]);
    expect((await audits('user.deleted', d.id))[0]!.meta.authentik).toBe('deactivated');
    expect(await tomb(d.id)).toMatchObject({ authentik_sub: null, email: null });
  });

  it('step 6 with an active Authentik user and a token that may not change it keeps retrying', async () => {
    const d = await doomed();
    akUser.isActive = true;
    fail.akPatch = 403;
    expect(await deletionTick(env.ctx)).toEqual({ claimed: 1, finished: 0, failed: 1 });
    expect(await tomb(d.id)).toMatchObject({ step: 5, failed_step: 6, last_error: 'authentik_token_rejected' });
  });

  it('request service 404 counts as done', async () => {
    const d = await doomed();
    fail.seerrDelete = 404;
    expect(await deletionTick(env.ctx)).toEqual({ claimed: 1, finished: 1, failed: 0 });
    expect(seerrDeletes()).toHaveLength(1);
    expect(await audits('user.deletion_failed', d.id)).toEqual([]);
  });

  it('without a request-service user step 2 is done without a call', async () => {
    const d = await doomed();
    await env.pool.query('update users set seerr_user_id=null where id=$1', [d.id]);
    expect(await deletionTick(env.ctx)).toEqual({ claimed: 1, finished: 1, failed: 0 });
    expect(seerrDeletes()).toEqual([]);
  });

  it('without a request service step 2 counts as done (no call)', async () => {
    await doomed();
    await env.ctx.settings.save({ REQUESTS_URL: null }, null);
    try {
      expect(await deletionTick(env.ctx)).toEqual({ claimed: 1, finished: 1, failed: 0 });
      expect(seerrDeletes()).toEqual([]);
    } finally {
      await env.ctx.settings.save({ REQUESTS_URL: cfg.REQUESTS_URL }, null);
    }
  });

  it('without the Authentik API the deletion finishes with authentik not_configured', async () => {
    const d = await doomed();
    withoutAuthentik();
    expect(await deletionTick(env.ctx)).toEqual({ claimed: 1, finished: 1, failed: 0 });
    expect(akCalls).toEqual([]);
    expect(await audits('user.deleted', d.id)).toEqual([{ actor: null, meta: { pseudonym: pseudonymFor(env.ctx, d.id), authentik: 'not_configured' } }]);
  });

  it('an Authentik user that no longer exists finishes with authentik not_found', async () => {
    const d = await doomed();
    fail.akPatch = 404;
    expect(await deletionTick(env.ctx)).toEqual({ claimed: 1, finished: 1, failed: 0 });
    expect((await audits('user.deleted', d.id))[0]!.meta.authentik).toBe('not_found');
  });

  it('login during cleanup answers 403 account_deleted', async () => {
    const d = await doomed();
    fail.jfDelete = 500; // claimed, users row still there
    await deletionTick(env.ctx);
    let r = await loginAttempt(d.claims);
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'account_deleted' });

    fail.jfDelete = 0;
    fail.akPatch = 500; // users row gone, Authentik still active: no approval request, no new account
    await deletionTick(env.ctx);
    expect((await tomb(d.id))!.step).toBe(5);
    r = await loginAttempt(d.claims);
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'account_deleted' });
    expect((await env.pool.query('select 1 from approval_requests where authentik_sub=$1', [d.claims.sub])).rowCount).toBe(0);
    expect((await env.pool.query('select 1 from users where authentik_sub=$1', [d.claims.sub])).rowCount).toBe(0);
  });

  it('a claimed account whose users row still exists shows its failing step in the list', async () => {
    const d = await doomed();
    fail.jfDelete = 500;
    await deletionTick(env.ctx);
    const users = (await call(admin, 'GET', '/api/admin/users?status=deleting')).json().users as Array<Record<string, unknown>>;
    expect(users.filter((u) => u.id === d.id)).toEqual([expect.objectContaining({ name: d.claims.name, cleanup: { step: 1, error: 'JellyfinError:500', gone: false } })]);
    // admin changes on a claimed account are refused
    for (const [method, url, body] of [['PATCH', `/api/admin/users/${d.id}`, { role: 'guest' }], ['POST', `/api/admin/users/${d.id}/repair`, undefined],
      ['PUT', `/api/admin/users/${d.id}/limits`, { maxStreams: 2 }]] as const) {
      const r = await call(admin, method, url, body);
      expect(r.statusCode, url).toBe(409);
      expect(r.json()).toEqual({ error: 'deletion_in_progress' });
    }
    expect(seerrDeletes()).toEqual([]);
  });

  it('the user list shows unfinished cleanups under status=deleting', async () => {
    const d = await doomed();
    const pending = await doomed({ due: false });
    fail.akPatch = 500;
    await deletionTick(env.ctx);
    const r = await call(admin, 'GET', '/api/admin/users?status=deleting');
    expect(r.statusCode).toBe(200);
    const users = r.json().users as Array<Record<string, unknown>>;
    const cleanup = users.find((u) => u.id === d.id)!;
    expect(cleanup).toMatchObject({ id: d.id, name: pseudonymFor(env.ctx, d.id), email: null, cleanup: { step: 6, error: 'authentik_error', gone: true } });
    expect(JSON.stringify(cleanup)).not.toContain('doomed');
    expect(users.find((u) => u.id === pending.id)).toMatchObject({ name: pending.claims.name, cleanup: null });
    expect(r.json().total).toBe(users.length);
    // other filters never list cleanup rows
    expect(((await call(admin, 'GET', '/api/admin/users')).json().users as Array<{ id: string }>).some((u) => u.id === d.id)).toBe(false);
  });

  it('audit views show the pseudonym after deletion', async () => {
    const d = await doomed();
    await env.pool.query("insert into audit_log(actor, action, target, meta) values ($1, 'login', $2, '{}')", [d.id, d.id]);
    await deletionTick(env.ctx);
    const p = pseudonymFor(env.ctx, d.id);
    const all = (await call(admin, 'GET', '/api/admin/audit?limit=200')).json().entries as Array<Record<string, unknown>>;
    expect(all.find((e) => e.action === 'login' && e.actor_id === d.id)).toMatchObject({ actor: p, target_name: p });
    expect(all.find((e) => e.action === 'user.deletion_requested' && e.target === d.id)).toMatchObject({ actor: 'Admin', target_name: p });
    expect((await call(admin, 'GET', `/api/admin/audit?q=${p}`)).json().total).toBeGreaterThan(0);
    const mine = (await call(admin, 'GET', `/api/admin/users/${adminId}/audit?limit=200`)).json().entries as Array<Record<string, unknown>>;
    expect(mine.find((e) => e.action === 'user.deletion_requested' && e.target === d.id)).toMatchObject({ target_name: p });
    expect(JSON.stringify(all)).not.toContain(d.claims.name);
  });

  it('admin notices linking to the account are removed', async () => {
    const d = await doomed();
    await env.pool.query("insert into notifications(user_id, kind, title, link, dedupe) values ($1, 'access_soon', 'x', '/admin/users', $2)", [adminId, `access-soon-admin-${d.id}-2026-01-01-${adminId}`]);
    const keep = await env.pool.query("insert into notifications(user_id, kind, title, link) values ($1, 'other', 'y', '/admin/users') returning id", [adminId]);
    expect(await notices('notify.deletion.requested')).toHaveLength(1);
    await deletionTick(env.ctx);
    expect(await notices('notify.deletion.requested')).toEqual([]);
    expect((await env.pool.query('select 1 from notifications where dedupe like $1', [`%${d.id}%`])).rows).toHaveLength(1); // only the done notice
    expect((await env.pool.query('select 1 from notifications where id=$1', [keep.rows[0].id])).rowCount).toBe(1);
    expect(await notices('notify.deletion.done')).toHaveLength(1);
  });

  it('tick before deletion_at does nothing', async () => {
    const d = await doomed({ due: false });
    expect(await deletionTick(env.ctx)).toEqual({ claimed: 0, finished: 0, failed: 0 });
    expect(await tomb(d.id)).toBeUndefined();
    expect(jfDeletes()).toEqual([]);
    // a manually locked account with a stale date is never claimed
    await env.pool.query("update users set locked_reason='manual', deletion_at=now() - interval '1 day' where id=$1", [d.id]);
    expect((await deletionTick(env.ctx)).claimed).toBe(0);
  });

  it('finished row keeps only pseudonym and dates', async () => {
    const d = await doomed();
    await deletionTick(env.ctx);
    const t = (await tomb(d.id))!;
    expect(t).toMatchObject({ user_id: d.id, pseudonym: pseudonymFor(env.ctx, d.id), step: 6, authentik_sub: null, jellyfin_ids: null, seerr_user_id: null, name: null, email: null, last_error: null, failed_step: null });
    expect(t.started_at).toBeInstanceOf(Date);
    expect(t.finished_at).toBeInstanceOf(Date);
    // after the cleanup the sub is free again (the Authentik user is deactivated)
    expect((await env.pool.query('select 1 from account_deletions where authentik_sub=$1', [d.claims.sub])).rowCount).toBe(0);
  });
});
