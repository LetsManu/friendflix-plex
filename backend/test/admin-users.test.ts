// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { HttpError, assertNotLastAdmin, lockUser, unlockUser } from '../src/users.js';
import { bulkUsers } from '../src/routes/adminUsers.js';
import { ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
let adminId = '';
const ids: Record<string, string> = {};
const as = (s: { cookies: Record<string, string>; csrf: string }, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  env.app.inject({ method, url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
const get = (url: string) => as(admin, 'GET', url);
const jfId = (sub: string) => sub.padEnd(32, '0').slice(0, 32);

const addUser = async (sub: string, name: string, role: string, disabled = false) =>
  (await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, disabled, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $1, $7) returning id`,
    [sub, `${sub}@x.de`, name, role, disabled, jfId(sub), encrypt(keyFromBase64(ENC_KEY), 'pw')],
  )).rows[0].id as string;
const row = async (id: string) => (await env.pool.query('select role, disabled, locked_reason, access_until from users where id=$1', [id])).rows[0];
const audits = async (action: string, target: string) => (await env.pool.query('select actor, meta from audit_log where action=$1 and target=$2 order by id', [action, target])).rows;
const fakeSession = (userId: string, sid: string) =>
  env.kv.set(`sess:${sid}`, JSON.stringify({ userId, csrf: 'c', deviceId: 'd', deviceApproved: true, createdAt: Date.now(), touchedAt: Date.now() }), 600);

beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login();
  adminId = (await env.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id;
  ids.anna = await addUser('anna', 'Anna', 'friend');
  ids.ben = await addUser('ben', 'Ben', 'guest');
  ids.clara = await addUser('clara', 'Clara', 'family');
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.pool.query("update users set disabled=false, locked_reason=null, access_until=null, deletion_at=null where authentik_sub <> 'sub-admin'");
  await env.pool.query("update users set role = case authentik_sub when 'anna' then 'friend' when 'ben' then 'guest' when 'clara' then 'family' else role end");
});

describe('lockUser / unlockUser', () => {
  it('lockUser sets reason and revokes sessions', async () => {
    const sid = 'anna-session-' + 'x'.repeat(30);
    await fakeSession(ids.anna!, sid);
    env.jfCalls.length = 0;
    await lockUser(env.ctx, adminId, ids.anna!, 'expired');
    expect(await row(ids.anna!)).toMatchObject({ disabled: true, locked_reason: 'expired' });
    expect(await env.kv.get(`sess:${sid}`)).toBeNull();
    expect(env.jfCalls.some((c) => c.path === `/Users/${jfId('anna')}/Policy` && c.body.IsDisabled === true)).toBe(true);
    expect((await audits('user.disable', ids.anna!)).at(-1)).toMatchObject({ actor: adminId, meta: { reason: 'expired' } });

    await unlockUser(env.ctx, adminId, ids.anna!);
    expect(await row(ids.anna!)).toMatchObject({ disabled: false, locked_reason: null });
    expect(env.jfCalls.some((c) => c.path === `/Users/${jfId('anna')}/Policy` && c.body.IsDisabled === false)).toBe(true);
    expect((await audits('user.enable', ids.anna!)).length).toBe(1);
  });

  it('PATCH disabled locks with reason manual and unlocks', async () => {
    expect((await as(admin, 'PATCH', `/api/admin/users/${ids.ben}`, { disabled: true })).statusCode).toBe(200);
    expect(await row(ids.ben!)).toMatchObject({ disabled: true, locked_reason: 'manual' });
    expect((await as(admin, 'PATCH', `/api/admin/users/${ids.ben}`, { disabled: false })).statusCode).toBe(200);
    expect(await row(ids.ben!)).toMatchObject({ disabled: false, locked_reason: null });
  });
});

describe('unlocking an account whose access has ended', () => {
  const past = () => new Date(Date.now() - 60e3);
  const PATCH = (id: string, body: unknown) => as(admin, 'PATCH', `/api/admin/users/${id}`, body);

  it('PATCH disabled:false answers 409 access_expired and changes nothing', async () => {
    for (const reason of ['expired', 'manual'] as const) {
      await env.pool.query('update users set access_until=$2 where id=$1', [ids.anna, past()]);
      await lockUser(env.ctx, adminId, ids.anna!, reason);
      const before = Number((await env.pool.query('select count(*) n from audit_log')).rows[0].n);
      env.jfCalls.length = 0;
      const r = await PATCH(ids.anna!, { disabled: false });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('access_expired');
      expect(await row(ids.anna!)).toMatchObject({ disabled: true, locked_reason: reason });
      expect(Number((await env.pool.query('select count(*) n from audit_log')).rows[0].n)).toBe(before);
      expect(env.jfCalls.filter((c) => c.method === 'POST')).toHaveLength(0);
    }
  });

  it('PATCH disabled:false with a new future date unlocks', async () => {
    await env.pool.query('update users set access_until=$2 where id=$1', [ids.clara, past()]);
    await lockUser(env.ctx, adminId, ids.clara!, 'expired');
    const until = new Date(Date.now() + 5 * 86400e3).toISOString();
    expect((await PATCH(ids.clara!, { disabled: false, accessUntil: until })).statusCode).toBe(200);
    expect(await row(ids.clara!)).toMatchObject({ disabled: false, locked_reason: null });
  });

  it('bulk unlock answers 409 access_expired for the whole set and changes nothing', async () => {
    await lockUser(env.ctx, adminId, ids.ben!, 'manual');
    await env.pool.query('update users set access_until=$2 where id=$1', [ids.clara, past()]);
    await lockUser(env.ctx, adminId, ids.clara!, 'expired');
    const r = await as(admin, 'POST', '/api/admin/users/bulk', { ids: [ids.ben, ids.clara], action: 'unlock' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('access_expired');
    expect((await row(ids.ben!)).disabled).toBe(true); // all or nothing
    expect((await row(ids.clara!)).disabled).toBe(true);
  });

  it('PATCH disabled:true with a future date on an expired lock keeps the account locked (manual)', async () => {
    await env.pool.query('update users set access_until=$2 where id=$1', [ids.clara, past()]);
    await lockUser(env.ctx, adminId, ids.clara!, 'expired');
    const until = new Date(Date.now() + 5 * 86400e3).toISOString();
    expect((await PATCH(ids.clara!, { disabled: true, accessUntil: until })).statusCode).toBe(200);
    expect(await row(ids.clara!)).toMatchObject({ disabled: true, locked_reason: 'manual' });
    expect((await row(ids.clara!)).access_until.toISOString()).toBe(until);
    expect((await audits('user.disable', ids.clara!)).at(-1)!.meta).toEqual({ reason: 'manual' });
  });
});

describe('error handler', () => {
  it('passes a 5xx business error code through, but never free text', async () => {
    const jfAdmin = env.ctx.jf.admin;
    const setDisabled = jfAdmin.setDisabled;
    try {
      jfAdmin.setDisabled = async () => { throw new HttpError(502, 'jellyfin_down'); };
      const code = await as(admin, 'PATCH', `/api/admin/users/${ids.anna}`, { disabled: true });
      expect(code.statusCode).toBe(502);
      expect(code.json()).toEqual({ error: 'jellyfin_down' });
      jfAdmin.setDisabled = async () => { throw new HttpError(502, 'Upstream https://auth.example.com/api said: no'); };
      const text = await as(admin, 'PATCH', `/api/admin/users/${ids.anna}`, { disabled: true });
      expect(text.statusCode).toBe(502);
      expect(text.json()).toEqual({ error: 'internal' });
    } finally {
      jfAdmin.setDisabled = setDisabled;
    }
  });
});

describe('guards', () => {
  it('cannot lock yourself out', async () => {
    for (const body of [{ disabled: true }, { role: 'friend' }]) {
      const r = await as(admin, 'PATCH', `/api/admin/users/${adminId}`, body);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('cannot_lock_yourself_out');
    }
    const r = await as(admin, 'POST', '/api/admin/users/bulk', { ids: [ids.anna, adminId], action: 'lock' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('cannot_lock_yourself_out');
    expect((await row(ids.anna!)).disabled).toBe(false); // all or nothing
    expect((await row(adminId)).disabled).toBe(false);
  });

  it('last admin cannot be demoted or locked', async () => {
    for (const change of ['demote', 'lock'] as const) {
      await expect(assertNotLastAdmin(env.ctx, [adminId], change)).rejects.toMatchObject({ statusCode: 400, message: 'last_admin' });
      await expect(assertNotLastAdmin(env.ctx, [ids.anna!], change)).resolves.toBeUndefined(); // no admin affected
    }
    await env.pool.query("update users set role='admin', disabled=true where id=$1", [ids.clara]); // a locked admin does not count
    await expect(assertNotLastAdmin(env.ctx, [adminId], 'lock')).rejects.toMatchObject({ message: 'last_admin' });
    await env.pool.query("update users set disabled=false where id=$1", [ids.clara]);
    await expect(assertNotLastAdmin(env.ctx, [adminId], 'lock')).resolves.toBeUndefined();
    await expect(assertNotLastAdmin(env.ctx, [adminId, ids.clara!], 'demote')).rejects.toMatchObject({ message: 'last_admin' });
  });

  it('last admin: a bulk role change including them is refused as a whole and nothing changes', async () => {
    const before = Number((await env.pool.query('select count(*) n from audit_log')).rows[0].n);
    env.jfCalls.length = 0;
    // the HTTP actor is always an active admin outside the target set, so call the bulk action as another actor
    await expect(bulkUsers(env.ctx, ids.ben!, { ids: [ids.anna!, adminId], action: 'role', role: 'friend' })).rejects.toMatchObject({ statusCode: 400, message: 'last_admin' });
    await expect(bulkUsers(env.ctx, ids.ben!, { ids: [ids.clara!, adminId], action: 'lock' })).rejects.toMatchObject({ statusCode: 400, message: 'last_admin' });
    expect((await row(adminId)).role).toBe('admin');
    expect(await row(ids.anna!)).toMatchObject({ role: 'friend', disabled: false });
    expect(await row(ids.clara!)).toMatchObject({ role: 'family', disabled: false });
    expect(Number((await env.pool.query('select count(*) n from audit_log')).rows[0].n)).toBe(before);
    expect(env.jfCalls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

});

describe('PATCH accessUntil', () => {
  it('PATCH accessUntil stores and audits user.access', async () => {
    const until = new Date(Date.now() + 5 * 86400e3);
    until.setMilliseconds(0);
    expect((await as(admin, 'PATCH', `/api/admin/users/${ids.anna}`, { accessUntil: until.toISOString() })).statusCode).toBe(200);
    expect((await row(ids.anna!)).access_until.toISOString()).toBe(until.toISOString());
    expect((await as(admin, 'PATCH', `/api/admin/users/${ids.anna}`, { accessUntil: null })).statusCode).toBe(200);
    expect((await row(ids.anna!)).access_until).toBeNull();
    expect((await audits('user.access', ids.anna!)).map((a) => a.meta)).toEqual([{ from: null, to: until.toISOString() }, { from: until.toISOString(), to: null }]);
    expect((await as(admin, 'PATCH', `/api/admin/users/${ids.anna}`, { accessUntil: 'next week' })).statusCode).toBe(400);
  });
});

describe('bulk', () => {
  const bulk = (body: unknown) => as(admin, 'POST', '/api/admin/users/bulk', body);

  it('bulk role change audits each user with from/to', async () => {
    const r = await bulk({ ids: [ids.anna, ids.ben], action: 'role', role: 'family' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ done: 2 });
    expect((await row(ids.anna!)).role).toBe('family');
    expect((await audits('user.role', ids.anna!)).at(-1)).toMatchObject({ actor: adminId, meta: { from: 'friend', to: 'family' } });
    expect((await audits('user.role', ids.ben!)).at(-1)).toMatchObject({ actor: adminId, meta: { from: 'guest', to: 'family' } });
  });

  it('lock, unlock, revoke and access apply per user', async () => {
    const sid = 'clara-session-' + 'x'.repeat(30);
    await fakeSession(ids.clara!, sid);
    expect((await bulk({ ids: [ids.anna, ids.clara], action: 'lock' })).json()).toEqual({ done: 2 });
    expect(await row(ids.clara!)).toMatchObject({ disabled: true, locked_reason: 'manual' });
    expect(await env.kv.get(`sess:${sid}`)).toBeNull();
    expect((await bulk({ ids: [ids.anna, ids.clara, ids.ben], action: 'unlock' })).json()).toEqual({ done: 2 }); // ben was not locked
    expect((await row(ids.anna!)).disabled).toBe(false);

    await fakeSession(ids.ben!, sid);
    expect((await bulk({ ids: [ids.ben], action: 'revoke' })).json()).toEqual({ done: 1 });
    expect(await env.kv.get(`sess:${sid}`)).toBeNull();
    expect((await audits('user.revoke_sessions', ids.ben!)).at(-1)!.meta).toEqual({ sessions: 1 });

    const until = '2030-01-01T00:00:00.000Z';
    expect((await bulk({ ids: [ids.anna, ids.ben], action: 'access', accessUntil: until })).json()).toEqual({ done: 2 });
    expect((await row(ids.ben!)).access_until.toISOString()).toBe(until);
    expect((await audits('user.access', ids.ben!)).at(-1)!.meta).toEqual({ from: null, to: until });
  });

  it('validates all or nothing', async () => {
    expect((await bulk({ ids: [], action: 'lock' })).statusCode).toBe(400);
    expect((await bulk({ ids: Array.from({ length: 201 }, () => ids.anna), action: 'lock' })).statusCode).toBe(400);
    expect((await bulk({ ids: [ids.anna], action: 'role' })).statusCode).toBe(400);
    expect((await bulk({ ids: [ids.anna], action: 'access' })).statusCode).toBe(400);
    const unknownRole = await bulk({ ids: [ids.anna], action: 'role', role: 'constructor' });
    expect(unknownRole.statusCode).toBe(400);
    expect(unknownRole.json().error).toBe('unknown_role');
    const missing = await bulk({ ids: [ids.anna, '00000000-0000-4000-8000-000000000000'], action: 'lock' });
    expect(missing.statusCode).toBe(404);
    expect((await row(ids.anna!)).disabled).toBe(false);
    expect((await env.app.inject({ method: 'POST', url: '/api/admin/users/bulk', payload: { ids: [ids.anna], action: 'lock' } })).statusCode).toBeGreaterThanOrEqual(401);
  });
});

describe('users list', () => {
  it('status=expiring lists accounts whose access ends within 7 days', async () => {
    await env.pool.query("update users set access_until = now() + interval '3 days' where id=$1", [ids.anna]);
    await env.pool.query("update users set access_until = now() + interval '10 days' where id=$1", [ids.ben]);
    await env.pool.query("update users set access_until = now() - interval '1 day' where id=$1", [ids.clara]);
    const j = (await get('/api/admin/users?status=expiring')).json();
    expect(j.users.map((u: any) => u.name)).toEqual(['Anna']);
    expect(j.total).toBe(1);
    expect(j.users[0].access_until).toBeTruthy();
  });

  it('returns access_until, locked_reason and profile/device counts', async () => {
    await env.pool.query("insert into devices(user_id, device_id, label, approved, last_seen) values ($1, 'dev-anna-0000000001', 'A', true, now() - interval '40 days'), ($1, 'dev-anna-0000000002', 'B', true, now() - interval '40 days')", [ids.anna]);
    await env.pool.query("insert into profiles(id, user_id, name, is_owner) values ($1, $1, 'Anna', true)", [ids.anna]);
    await lockUser(env.ctx, adminId, ids.ben!, 'deletion');
    const users = (await get('/api/admin/users')).json().users as any[];
    const anna = users.find((u) => u.id === ids.anna);
    expect(anna).toMatchObject({ profiles: 1, devices: 2, locked_reason: null, access_until: null, pending: false });
    expect(users.find((u) => u.id === ids.ben)).toMatchObject({ disabled: true, locked_reason: 'deletion' });
  });

  it('lastActive=90+ lists accounts not seen for 90 days or never', async () => {
    const dora = await addUser('dora', 'Dora', 'guest'); // no device: never seen
    await env.pool.query("insert into devices(user_id, device_id, label, approved, last_seen) values ($1, 'dev-clara-old-00001', 'A', true, now() - interval '100 days'), ($2, 'dev-ben-new-0000001', 'B', true, now() - interval '1 day')", [ids.clara, ids.ben]);
    try {
      const names = (await get('/api/admin/users?lastActive=90%2B')).json().users.map((u: any) => u.name).sort();
      expect(names).toContain('Clara'); // seen 100 days ago
      expect(names).toContain('Dora'); // never
      expect(names).not.toContain('Ben'); // seen yesterday
    } finally {
      await env.pool.query("delete from devices where device_id in ('dev-clara-old-00001', 'dev-ben-new-0000001')");
      await env.pool.query('delete from users where id=$1', [dora]);
    }
  });

  it('sorts by profile and device counts', async () => {
    await env.pool.query("insert into devices(user_id, device_id, label, approved, last_seen) values ($1, 'dev-clara-s-000001', 'A', true, now()), ($1, 'dev-clara-s-000002', 'B', true, now()), ($1, 'dev-clara-s-000003', 'C', true, now())", [ids.clara]);
    try {
      const desc = (await get('/api/admin/users?sort=devices&dir=desc')).json().users;
      expect(desc[0].name).toBe('Clara');
      expect(desc.map((u: any) => u.devices)).toEqual([...desc.map((u: any) => u.devices)].sort((a: number, b: number) => b - a));
      const prof = (await get('/api/admin/users?sort=profiles&dir=asc')).json().users.map((u: any) => u.profiles);
      expect(prof).toEqual([...prof].sort((a: number, b: number) => a - b));
      expect((await get('/api/admin/users?status=pending&sort=devices')).statusCode).toBe(200);
    } finally {
      await env.pool.query("delete from devices where device_id like 'dev-clara-s-%'");
    }
  });

  it('filters lastActive, active, locked, deleting and pending', async () => {
    const names = async (q: string) => (await get(`/api/admin/users?${q}`)).json().users.map((u: any) => u.name).sort();
    expect(await names('lastActive=30')).toEqual(['Admin']); // anna was last seen 40 days ago, ben/clara never
    expect(await names('lastActive=90')).toEqual(['Admin', 'Anna']);
    expect((await get('/api/admin/users?lastActive=5')).statusCode).toBe(400);

    await env.pool.query('update users set disabled=true where id=$1', [ids.ben]);
    await env.pool.query("update users set deletion_at = now() + interval '30 days' where id=$1", [ids.clara]);
    expect(await names('status=active')).toEqual(['Admin', 'Anna']);
    expect(await names('status=locked')).toEqual(['Ben']);
    expect(await names('status=deleting')).toEqual(['Clara']);

    await env.pool.query("insert into approval_requests(id, authentik_sub, email, name) values (gen_random_uuid(), 'p1', 'p1@x.de', 'Paula'), (gen_random_uuid(), 'p2', null, 'Peter')");
    await env.pool.query("insert into approval_requests(id, authentik_sub, email, name, rejected_at) values (gen_random_uuid(), 'p3', null, 'Rejected', now())");
    const pending = (await get('/api/admin/users?status=pending&sort=name')).json();
    expect(pending.total).toBe(2);
    expect(pending.users.map((u: any) => u.name)).toEqual(['Paula', 'Peter']);
    expect(pending.users[0]).toMatchObject({ pending: true, email: 'p1@x.de', role: null });
    expect(pending.users[0].created_at).toBeTruthy();
    expect((await get('/api/admin/users?status=pending&q=paula')).json().total).toBe(1);
    expect((await get('/api/admin/users')).json().total).toBe(4); // pending people are not in the default list
  });
});

describe('concurrency', () => {
  it('two admins demoting each other at once: one wins, the other gets last_admin', async () => {
    const B = { sub: 'sub-b', email: 'b@example.com', name: 'Bea', groups: ['friendflix-admins'] };
    const bea = await env.login(B);
    const beaId = (await env.pool.query("select id from users where authentik_sub='sub-b'")).rows[0].id as string;
    const [r1, r2] = await Promise.all([
      as(admin, 'PATCH', `/api/admin/users/${beaId}`, { role: 'friend' }),
      as(bea, 'PATCH', `/api/admin/users/${adminId}`, { role: 'friend' }),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 400]);
    expect([r1, r2].find((r) => r.statusCode === 400)!.json().error).toBe('last_admin');
    expect(Number((await env.pool.query("select count(*) n from users where role='admin' and not disabled")).rows[0].n)).toBe(1);
  });
});
