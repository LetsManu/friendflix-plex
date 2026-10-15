// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { audit } from '../src/audit.js';
import { ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
let adminId = '';
const ids: Record<string, string> = {};
const get = (url: string) => env.app.inject({ url, cookies: admin.cookies });
const post = (url: string, payload?: unknown) => env.app.inject({ method: 'POST', url, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: payload as object });

const addUser = async (sub: string, name: string, role: string, disabled = false, email: string | null = `${sub}@x.de`) =>
  (await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, disabled, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $1, $7) returning id`,
    [sub, email, name, role, disabled, sub.padEnd(32, '0').slice(0, 32), encrypt(keyFromBase64(ENC_KEY), 'pw')],
  )).rows[0].id as string;

beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login();
  adminId = (await env.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id;
  ids.anna = await addUser('anna', 'Anna Beispiel', 'friend');
  ids.ben = await addUser('ben', 'Ben_100%', 'guest', true, null);
  ids.clara = await addUser('clara', 'Clara', 'family');
  for (const [i, u] of ['anna', 'ben', 'clara'].entries()) {
    await env.pool.query("insert into devices(user_id, device_id, label, approved, last_seen) values ($1, $2, $3, $4, now() - ($5 || ' hours')::interval)", [ids[u], `device-${u}-000000001`, `Gerät ${u}`, i === 0, String(i)]);
  }
  await env.pool.query("insert into invites(id, token_hash, role, note, expires_at, used_at, used_by, uses) values (gen_random_uuid(), 'h1', 'friend', 'für Oma', now() + interval '1 day', null, null, 0), (gen_random_uuid(), 'h2', 'guest', null, now() - interval '1 day', null, null, 0), (gen_random_uuid(), 'h3', 'family', 'Opa', now() + interval '1 day', now(), $1, 1)", [ids.clara]);
  await audit(env.ctx, adminId, 'user.disable', ids.ben);
  await audit(env.ctx, adminId, 'user.role', ids.anna, { from: 'guest', to: 'friend' });
  await audit(env.ctx, null, 'user.provisioned', ids.clara);
  await audit(env.ctx, adminId, 'invite.create', undefined, { role: 'friend' });
});
afterAll(() => env.close());

describe('admin users list', () => {
  it('returns everyone with a total when no paging params are given (backward compatible)', async () => {
    const j = (await get('/api/admin/users')).json();
    expect(j.users).toHaveLength(4);
    expect(j.total).toBe(4);
  });
  it('searches name, email and login; escapes wildcards', async () => {
    expect((await get('/api/admin/users?q=beispiel')).json().users.map((u: any) => u.name)).toEqual(['Anna Beispiel']);
    expect((await get('/api/admin/users?q=clara@')).json().total).toBe(1);
    expect((await get('/api/admin/users?q=100%25')).json().users.map((u: any) => u.name)).toEqual(['Ben_100%']);
    expect((await get('/api/admin/users?q=%25')).json().total).toBe(1);
  });
  it('filters by role and status, sorts and pages', async () => {
    expect((await get('/api/admin/users?status=locked')).json().users.map((u: any) => u.name)).toEqual(['Ben_100%']);
    expect((await get('/api/admin/users?role=family')).json().total).toBe(1);
    const page = (await get('/api/admin/users?sort=name&dir=asc&limit=2&offset=1')).json();
    expect(page.total).toBe(4);
    expect(page.users.map((u: any) => u.name)).toEqual(['Anna Beispiel', 'Ben_100%']);
    expect((await get('/api/admin/users?sort=name&dir=desc&limit=1')).json().users[0].name).toBe('Clara');
    expect((await get('/api/admin/users?sort=password;drop')).statusCode).toBe(200); // unknown sort keys are ignored
    expect((await get('/api/admin/users?limit=0')).statusCode).toBe(400);
  });
  it('is admin only', async () => {
    expect((await env.app.inject({ url: '/api/admin/users?q=x' })).statusCode).toBeGreaterThanOrEqual(401);
  });
});

describe('admin devices', () => {
  it('lists pending first, filters, counts pending independent of the filter', async () => {
    const j = (await get('/api/admin/devices')).json();
    expect(j.total).toBe(4); // + the admin's own login device
    expect(j.pending).toBe(2);
    expect(j.devices[0].approved).toBe(false);
    const q = (await get('/api/admin/devices?status=approved')).json();
    expect(q.devices.map((d: any) => d.name).sort()).toEqual(['Admin', 'Anna Beispiel']);
    expect(q.pending).toBe(2);
    expect((await get('/api/admin/devices?q=gerät%20clara')).json().total).toBe(1);
    expect((await get('/api/admin/devices?sort=user&dir=desc&limit=1')).json().devices[0].name).toBe('Clara');
  });
  it('approve → unapprove (undo) → remove (decline)', async () => {
    const body = { userId: ids.ben, deviceId: 'device-ben-000000001' };
    expect((await post('/api/admin/devices/approve', body)).statusCode).toBe(200);
    expect((await get('/api/admin/devices')).json().pending).toBe(1);
    expect((await post('/api/admin/devices/unapprove', body)).statusCode).toBe(200);
    expect((await get('/api/admin/devices')).json().pending).toBe(2);
    expect((await post('/api/admin/devices/remove', body)).statusCode).toBe(200);
    expect((await get('/api/admin/devices')).json().total).toBe(3);
    expect((await post('/api/admin/devices/remove', body)).statusCode).toBe(404);
    expect((await post('/api/admin/devices/unapprove', { userId: ids.ben, deviceId: 'nope-nope-nope-1' })).statusCode).toBe(404);
    const actions = (await get('/api/admin/audit?limit=3')).json().entries.map((e: any) => e.action);
    expect(actions).toEqual(['device.remove', 'device.unapprove', 'device.approve']);
  });
  it('remove signs out the sessions of that device only', async () => {
    const sess = (id: string, device: string) => JSON.stringify({ userId: id, csrf: 'c', deviceId: device, deviceApproved: true, createdAt: Date.now(), touchedAt: Date.now() });
    await env.kv.set('sess:keep-0000000000000000000000000000', sess(ids.clara!, 'other-device-00001'), 600);
    await env.kv.set('sess:gone-0000000000000000000000000000', sess(ids.clara!, 'device-clara-000000001'), 600);
    expect((await post('/api/admin/devices/remove', { userId: ids.clara, deviceId: 'device-clara-000000001' })).statusCode).toBe(200);
    expect(await env.kv.get('sess:gone-0000000000000000000000000000')).toBeNull();
    expect(await env.kv.get('sess:keep-0000000000000000000000000000')).not.toBeNull();
  });
  it('rejects non-admins', async () => {
    expect((await env.app.inject({ method: 'POST', url: '/api/admin/devices/remove', payload: { userId: ids.clara, deviceId: 'device-clara-000000001' } })).statusCode).toBeGreaterThanOrEqual(401);
  });
});

describe('admin invites list', () => {
  it('filters by status and search, pages, returns created_at', async () => {
    const all = (await get('/api/admin/invites')).json();
    expect(all.total).toBe(3);
    expect(all.invites[0]).toHaveProperty('created_at');
    expect((await get('/api/admin/invites?status=open')).json().invites.map((i: any) => i.note)).toEqual(['für Oma']);
    expect((await get('/api/admin/invites?status=expired')).json().invites.map((i: any) => i.role)).toEqual(['guest']);
    const used = (await get('/api/admin/invites?status=used')).json();
    expect(used.invites[0]).toMatchObject({ note: 'Opa', used_by_name: 'Clara' });
    expect((await get('/api/admin/invites?q=clara')).json().total).toBe(1);
    expect((await get('/api/admin/invites?sort=status&dir=desc&limit=1')).json().invites[0].note).toBe('Opa');
    expect((await get('/api/admin/invites?limit=1&offset=2')).json().invites).toHaveLength(1);
  });
});

describe('admin audit filters', () => {
  it('filters by actor, system, category, exact action and time range', async () => {
    expect((await get(`/api/admin/audit?actor=${adminId}`)).json().total).toBeGreaterThanOrEqual(3);
    const sys = (await get('/api/admin/audit?actor=system')).json();
    expect(sys.entries.map((e: any) => e.action)).toEqual(['user.provisioned']);
    expect(sys.entries[0].actor).toBeNull();
    const cat = (await get('/api/admin/audit?action=user')).json();
    expect(cat.entries.every((e: any) => e.action.startsWith('user.'))).toBe(true);
    expect((await get('/api/admin/audit?action=user.role')).json().entries).toHaveLength(1);
    expect((await get('/api/admin/audit?action=users')).json().total).toBe(0); // no accidental prefix match
    const future = new Date(Date.now() + 3600e3).toISOString();
    expect((await get(`/api/admin/audit?from=${encodeURIComponent(future)}`)).json().total).toBe(0);
    expect((await get(`/api/admin/audit?to=${encodeURIComponent(future)}`)).json().total).toBeGreaterThan(0);
  });
  it('searches and pages; validates input', async () => {
    expect((await get('/api/admin/audit?q=Anna')).json().entries.map((e: any) => e.action)).toEqual(['user.role']);
    const page = (await get('/api/admin/audit?limit=2&offset=1')).json();
    expect(page.entries).toHaveLength(2);
    expect(page.total).toBeGreaterThan(2);
    const asc = (await get('/api/admin/audit?dir=asc&limit=1')).json().entries[0];
    const desc = (await get('/api/admin/audit?dir=desc&limit=1')).json().entries[0];
    expect(Number(asc.id)).toBeLessThan(Number(desc.id));
    expect((await get('/api/admin/audit?actor=not-a-uuid')).statusCode).toBe(400);
    expect((await get("/api/admin/audit?action=user';drop")).statusCode).toBe(400);
    expect((await get('/api/admin/audit?from=garbage')).statusCode).toBe(400);
  });
  it('offers the filter options', async () => {
    const j = (await get('/api/admin/audit/filters')).json();
    expect(j.actors.map((a: any) => a.name)).toContain('Admin');
    expect(j.system).toBe(true);
    expect(j.categories).toEqual(expect.arrayContaining(['user', 'invite', 'device']));
  });
});
