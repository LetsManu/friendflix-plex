// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keyFromBase64 } from '../src/crypto.js';
import { GRACE_MS, pseudonymFor, scheduleDeletion } from '../src/deletion.js';
import { expiryTick } from '../src/expiry.js';
import type { OidcClaims } from '../src/oidc.js';
import type { Session } from '../src/session.js';
import { provisionUser, setAccessUntil } from '../src/users.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess;
let adminId = '';
let anna = '';
let ben = '';
const DAY = 86400e3;
const ANNA: OidcClaims = { sub: 'sub-anna', email: 'anna@x.de', name: 'Anna', groups: [] };
const ADMIN2: OidcClaims = { sub: 'sub-admin2', email: 'admin2@x.de', name: 'Zweite', groups: ['friendflix-admins'] };

const call = (s: Sess, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'POST', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
/** marks the session as re-authenticated just now (what /auth/reauth's callback does) */
async function stamp(s: Sess, at = Date.now()) {
  const key = `sess:${s.cookies.ff_sid}`;
  const sess = JSON.parse((await env.kv.get(key))!) as Session;
  await env.kv.set(key, JSON.stringify({ ...sess, reauthAt: at }), 300);
}
const row = async (id: string) => (await env.pool.query<{ disabled: boolean; locked_reason: string | null; deletion_at: Date | null }>(
  'select disabled, locked_reason, deletion_at from users where id=$1', [id])).rows[0]!;
const notices = async (key: string) =>
  (await env.pool.query("select user_id, link, msg->'title'->'params' params from notifications where msg->'title'->>'key'=$1 order by id", [key])).rows as
    { user_id: string; link: string; params: Record<string, unknown> }[];
const audits = async (action: string, target: string) =>
  (await env.pool.query<{ actor: string | null; meta: Record<string, unknown> }>('select actor, meta from audit_log where action=$1 and target=$2 order by id', [action, target])).rows;
const jfDisabled = (value: boolean) => env.jfCalls.filter((c) => c.path.endsWith('/Policy') && c.body.IsDisabled === value);

beforeAll(async () => {
  env = await makeEnv();
  await env.login(); // provisions the admin
  adminId = (await env.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id;
  anna = (await provisionUser(env.ctx, ANNA, 'friend')).id;
  ben = (await provisionUser(env.ctx, { sub: 'sub-ben', email: 'ben@x.de', name: 'Ben', groups: [] }, 'guest')).id;
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.pool.query("delete from users where authentik_sub='sub-admin2'");
  await env.pool.query('update users set disabled=false, locked_reason=null, deletion_at=null, access_until=null, expiry_notified_at=null');
  await env.pool.query('delete from account_deletions');
  await env.pool.query('delete from notifications');
  await env.pool.query("delete from audit_log where action like 'user.%'");
  for (const k of await env.kv.keys('sess:')) await env.kv.del(k);
  admin = await env.login(ADMIN);
  env.jfCalls.length = 0;
});

describe('POST /api/account/delete', () => {
  it('self-delete locks at once with reason deletion, revokes sessions and licences, notifies admins once', async () => {
    const s = await env.login(ANNA);
    await stamp(s);
    const dev = (await env.pool.query<{ device_id: string }>('select device_id from devices where user_id=$1 limit 1', [anna])).rows[0]!.device_id;
    await env.pool.query(
      `insert into downloads(id, user_id, device_id, profile_id, item_id, quality, status, expires_at) values (gen_random_uuid(), $1, $2, $1, 'm1', 'original', 'fetched', now() + interval '10 days')`,
      [anna, dev]);

    expect((await call(s, 'POST', '/api/account/delete', { confirm: false })).statusCode).toBe(400);
    expect((await row(anna)).disabled).toBe(false);

    const before = Date.now();
    const r = await call(s, 'POST', '/api/account/delete', { confirm: true });
    expect(r.statusCode).toBe(200);
    const at = Date.parse(r.json().deletionAt);
    expect(at).toBeGreaterThanOrEqual(before + GRACE_MS);
    expect(at).toBeLessThanOrEqual(Date.now() + GRACE_MS);
    const cleared = r.cookies.find((c) => c.name === 'ff_sid')!;
    expect(cleared.value).toBe('');

    expect(await row(anna)).toEqual({ disabled: true, locked_reason: 'deletion', deletion_at: new Date(at) });
    expect(jfDisabled(true).length).toBeGreaterThan(0);
    // the session is gone: the old cookie no longer works
    expect((await env.app.inject({ url: '/api/me', cookies: s.cookies })).statusCode).toBe(401);
    expect((await env.pool.query('select status from downloads where user_id=$1', [anna])).rows).toEqual([{ status: 'revoked' }]);

    const iso = new Date(at).toISOString();
    expect(await audits('user.deletion_requested', anna)).toEqual([{ actor: anna, meta: { deletionAt: iso, by: 'self' } }]);
    expect((await audits('user.disable', anna)).map((a) => a.meta)).toEqual([{ reason: 'deletion' }]);
    expect(await notices('notify.deletion.requested')).toEqual([{ user_id: adminId, link: `/admin/users/${anna}`, params: { name: 'Anna', date: { date: iso } } }]);

    // the detail page shows the date
    expect((await call(admin, 'GET', `/api/admin/users/${anna}`)).json().user.deletionAt).toBe(iso);
  });

  it('delete needs recent auth', async () => {
    const s = await env.login(ANNA);
    const r = await call(s, 'POST', '/api/account/delete', { confirm: true });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'reauth_required' });
    await stamp(s, Date.now() - 601_000); // too old
    expect((await call(s, 'POST', '/api/account/delete', { confirm: true })).statusCode).toBe(401);
    expect(await row(anna)).toEqual({ disabled: false, locked_reason: null, deletion_at: null });
  });

  it('a kids or other non-owner profile gets 403 owner_required and nothing is scheduled', async () => {
    const s = await env.login(ANNA);
    for (const body of [{ name: 'Kind', kids: true }, { name: 'Zweit' }]) {
      const created = await call(s, 'POST', '/api/profiles', body);
      expect(created.statusCode, body.name).toBe(201);
      // the session switched to that profile (what /api/profiles/:id/select stores), recently authenticated: only the profile is wrong
      const key = `sess:${s.cookies.ff_sid}`;
      const sess = JSON.parse((await env.kv.get(key))!) as Session;
      await env.kv.set(key, JSON.stringify({ ...sess, profileId: created.json().profile.id, reauthAt: Date.now() }), 300);
      const r = await call(s, 'POST', '/api/account/delete', { confirm: true });
      expect(r.statusCode, body.name).toBe(403);
      expect(r.json()).toEqual({ error: 'owner_required' });
      await env.kv.set(key, JSON.stringify(sess), 300); // back to the owner profile
    }
    expect(await row(anna)).toEqual({ disabled: false, locked_reason: null, deletion_at: null });
    expect(await audits('user.deletion_requested', anna)).toEqual([]);
  });

  it('last admin cannot self-delete; a second admin can', async () => {
    // the refusal comes before the re-authentication (no pointless sign-in first)
    const early = await call(admin, 'POST', '/api/account/delete', { confirm: true });
    expect(early.statusCode).toBe(400);
    expect(early.json()).toEqual({ error: 'last_admin' });
    await stamp(admin);
    const r = await call(admin, 'POST', '/api/account/delete', { confirm: true });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'last_admin' });
    expect(await row(adminId)).toEqual({ disabled: false, locked_reason: null, deletion_at: null });
    expect(await audits('user.deletion_requested', adminId)).toEqual([]);

    const s2 = await env.login(ADMIN2); // a second active admin
    await stamp(admin);
    expect((await call(admin, 'POST', '/api/account/delete', { confirm: true })).statusCode).toBe(200);
    expect(await row(adminId)).toMatchObject({ disabled: true, locked_reason: 'deletion' });
    // the one remaining admin cannot follow
    await stamp(s2);
    expect((await call(s2, 'POST', '/api/account/delete', { confirm: true })).json()).toEqual({ error: 'last_admin' });
  });

  it('scheduleDeletion refuses an account that is already locked', async () => {
    await env.pool.query("update users set disabled=true, locked_reason='manual' where id=$1", [anna]);
    await expect(scheduleDeletion(env.ctx, adminId, anna)).rejects.toMatchObject({ statusCode: 409 });
    expect(await row(anna)).toEqual({ disabled: true, locked_reason: 'manual', deletion_at: null });
  });
});

describe('the deletion lock and phase-1 account actions', () => {
  it('admin unlock of a deletion-locked account restores it (deletion_at null, audited)', async () => {
    await scheduleDeletion(env.ctx, anna, anna);
    const r = await call(admin, 'PATCH', `/api/admin/users/${anna}`, { disabled: false });
    expect(r.statusCode).toBe(200);
    expect(await row(anna)).toEqual({ disabled: false, locked_reason: null, deletion_at: null });
    expect(jfDisabled(false).length).toBeGreaterThan(0);
    expect(await audits('user.deletion_restored', anna)).toEqual([{ actor: adminId, meta: {} }]);
    expect(await audits('user.enable', anna)).toHaveLength(1);
  });

  it('admin restore route: one audit, one notice; not scheduled 409, unknown 404', async () => {
    await scheduleDeletion(env.ctx, anna, anna);
    const r = await call(admin, 'POST', `/api/admin/users/${anna}/deletion/restore`);
    expect(r.statusCode).toBe(200);
    expect(await row(anna)).toEqual({ disabled: false, locked_reason: null, deletion_at: null });
    expect(await audits('user.deletion_restored', anna)).toHaveLength(1);
    expect(await notices('notify.deletion.restored')).toEqual([{ user_id: adminId, link: `/admin/users/${anna}`, params: { name: 'Anna' } }]);

    const again = await call(admin, 'POST', `/api/admin/users/${anna}/deletion/restore`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'not_scheduled' });
    const unknown = await call(admin, 'POST', '/api/admin/users/00000000-0000-4000-8000-000000000000/deletion/restore');
    expect(unknown.statusCode).toBe(404);
  });

  it('a claimed deletion cannot be restored or unlocked (single and bulk)', async () => {
    await scheduleDeletion(env.ctx, anna, anna);
    await env.pool.query('update users set disabled=true where id=$1', [ben]);
    await env.pool.query("insert into account_deletions(user_id, pseudonym) values ($1, 'deleted-00000000')", [anna]);
    for (const r of [
      await call(admin, 'POST', `/api/admin/users/${anna}/deletion/restore`),
      await call(admin, 'PATCH', `/api/admin/users/${anna}`, { disabled: false }),
      await call(admin, 'POST', '/api/admin/users/bulk', { ids: [ben, anna], action: 'unlock' }),
    ]) {
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: 'deletion_in_progress' });
    }
    expect(await row(anna)).toMatchObject({ disabled: true, locked_reason: 'deletion' });
    expect((await row(ben)).disabled).toBe(true); // bulk is all or nothing
    expect(jfDisabled(false)).toEqual([]);
  });

  it('manual lock on a deletion-locked account changes nothing', async () => {
    const at = await scheduleDeletion(env.ctx, anna, anna);
    expect((await call(admin, 'PATCH', `/api/admin/users/${anna}`, { disabled: true })).statusCode).toBe(200);
    expect((await call(admin, 'POST', '/api/admin/users/bulk', { ids: [anna], action: 'lock' })).json()).toEqual({ done: 0 });
    expect(await row(anna)).toEqual({ disabled: true, locked_reason: 'deletion', deletion_at: at });
    expect(await audits('user.disable', anna)).toHaveLength(1);
  });

  it('setAccessUntil does not unlock a deletion lock', async () => {
    const at = await scheduleDeletion(env.ctx, anna, anna);
    await setAccessUntil(env.ctx, adminId, anna, new Date(Date.now() + 30 * DAY));
    await setAccessUntil(env.ctx, adminId, anna, null);
    expect(await row(anna)).toEqual({ disabled: true, locked_reason: 'deletion', deletion_at: at });
  });

  it('expiry tick skips deletion-locked accounts', async () => {
    await scheduleDeletion(env.ctx, anna, anna);
    await env.pool.query('update users set access_until=$2 where id=$1', [anna, new Date(Date.now() + DAY)]);
    expect(await expiryTick(env.ctx)).toEqual({ warned: 0, locked: 0 });
    await env.pool.query('update users set access_until=$2 where id=$1', [anna, new Date(Date.now() - 60e3)]);
    expect(await expiryTick(env.ctx)).toEqual({ warned: 0, locked: 0 });
    expect(await row(anna)).toMatchObject({ disabled: true, locked_reason: 'deletion' });
    expect(await notices('notify.access.ended')).toEqual([]);
  });

  it('restored account whose access_until passed is locked as expired by the next expiryTick', async () => {
    await scheduleDeletion(env.ctx, anna, anna);
    await env.pool.query('update users set access_until=$2 where id=$1', [anna, new Date(Date.now() - 60e3)]);
    env.jfCalls.length = 0;
    // phase 1's guard stays first: a plain unlock of ended access is refused
    const patch = await call(admin, 'PATCH', `/api/admin/users/${anna}`, { disabled: false });
    expect(patch.statusCode).toBe(409);
    expect(patch.json()).toEqual({ error: 'access_expired' });

    expect((await call(admin, 'POST', `/api/admin/users/${anna}/deletion/restore`)).statusCode).toBe(200);
    expect(await row(anna)).toEqual({ disabled: true, locked_reason: 'expired', deletion_at: null });
    expect(jfDisabled(false)).toEqual([]); // never enabled, not even for a moment
    expect(await audits('user.enable', anna)).toEqual([]);
    expect(await audits('user.deletion_restored', anna)).toEqual([{ actor: adminId, meta: { lockedReason: 'expired' } }]);
    expect(await notices('notify.deletion.restored')).toHaveLength(1);

    await expiryTick(env.ctx);
    expect(await row(anna)).toEqual({ disabled: true, locked_reason: 'expired', deletion_at: null });
    // and an extension now unlocks it the phase-1 way
    await setAccessUntil(env.ctx, adminId, anna, new Date(Date.now() + DAY));
    expect(await row(anna)).toEqual({ disabled: false, locked_reason: null, deletion_at: null });
  });

  it('admin delete-now sets deletion_at to now and refuses self', async () => {
    const at = await scheduleDeletion(env.ctx, anna, anna);
    const before = Date.now();
    const r = await call(admin, 'POST', `/api/admin/users/${anna}/deletion/now`);
    expect(r.statusCode).toBe(200);
    const now = (await row(anna)).deletion_at!.getTime();
    expect(now).toBeGreaterThanOrEqual(before - 1000);
    expect(now).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await audits('user.deletion_now', anna)).toEqual([{ actor: adminId, meta: { from: at.toISOString(), to: new Date(now).toISOString() } }]);

    const self = await call(admin, 'POST', `/api/admin/users/${adminId}/deletion/now`);
    expect(self.statusCode).toBe(400);
    expect(self.json()).toEqual({ error: 'cannot_lock_yourself_out' });
    const unscheduled = await call(admin, 'POST', `/api/admin/users/${ben}/deletion/now`);
    expect(unscheduled.statusCode).toBe(409);
    expect(unscheduled.json()).toEqual({ error: 'not_scheduled' });
    expect((await call(admin, 'POST', '/api/admin/users/00000000-0000-4000-8000-000000000000/deletion/now')).statusCode).toBe(404);
    expect((await row(ben)).deletion_at).toBeNull();
  });
});

describe('pseudonymFor', () => {
  it('pseudonymFor is stable and matches the pattern', () => {
    const p = pseudonymFor(env.ctx, anna);
    expect(p).toMatch(/^deleted-[0-9a-f]{8}$/);
    expect(pseudonymFor(env.ctx, anna)).toBe(p);
    expect(pseudonymFor(env.ctx, ben)).not.toBe(p);
    expect(pseudonymFor({ encKey: keyFromBase64(Buffer.alloc(32, 9).toString('base64')) }, anna)).not.toBe(p);
  });
});
