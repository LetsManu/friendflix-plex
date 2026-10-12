import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

// Admin people/devices hardening: unapprove really takes access away, an admin cannot revoke the device they sit at,
// preview clip actions are audited, and the admin endpoints refuse non-admins, non-owner/kids profiles and requests without CSRF.
type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess;
let adminId = '';
const DORA = { sub: 'sub-dora', email: 'dora@example.com', name: 'Dora', groups: [] as string[] };

const as = (s: Sess, method: string, url: string, payload?: unknown, csrf = true) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: csrf ? { 'x-csrf-token': s.csrf } : {}, payload: payload as object });
const sessionOf = async (s: Sess) => JSON.parse((await env.kv.get(`sess:${s.cookies.ff_sid}`))!) as { userId: string; deviceId: string; profileId?: string };

beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login(ADMIN);
  adminId = (await env.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id;
  // existing (invited earlier) non-admin accounts
  for (const [sub, name] of [['sub-dora', 'Dora'], ['sub-pat', 'Pat']] as const) {
    await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), $1, $2, $3, 'friend', $4, $3, $5)", [sub, `${name.toLowerCase()}@example.com`, name, sub.padEnd(32, '0').slice(0, 32), encrypt(env.ctx.encKey, 'pw')]);
  }
});
afterAll(() => env.close());

describe('device unapprove / remove', () => {
  it('unapprove signs the device out: a session that was refreshed after the approval loses access', async () => {
    let dora = await env.login(DORA);
    const { userId, deviceId } = await sessionOf(dora);
    // the device starts out pending (e.g. a second device of the account)
    await env.pool.query('update devices set approved=false where user_id=$1 and device_id=$2', [userId, deviceId]);
    dora = await env.login(DORA);
    expect((await as(dora, 'GET', '/api/prefs')).json().error).toBe('device_pending');
    // approve → the next request refreshes the session (deviceApproved=true cached in the session)
    expect((await as(admin, 'POST', '/api/admin/devices/approve', { userId, deviceId })).statusCode).toBe(200);
    expect((await as(dora, 'GET', '/api/prefs')).statusCode).toBe(200);
    expect(JSON.parse((await env.kv.get(`sess:${dora.cookies.ff_sid}`))!).deviceApproved).toBe(true);
    // Undo of the approval
    expect((await as(admin, 'POST', '/api/admin/devices/unapprove', { userId, deviceId })).statusCode).toBe(200);
    expect(await env.kv.get(`sess:${dora.cookies.ff_sid}`)).toBeNull();
    expect((await as(dora, 'GET', '/api/prefs')).statusCode).toBe(401);
    // logging in again on that device: waiting for approval, not let in
    dora = await env.login(DORA);
    const r = await as(dora, 'GET', '/api/prefs');
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('device_pending');
  });
  it('remove signs the device out as well', async () => {
    const dora = await env.login(DORA);
    const { userId, deviceId } = await sessionOf(dora);
    expect((await as(admin, 'POST', '/api/admin/devices/remove', { userId, deviceId })).statusCode).toBe(200);
    expect((await as(dora, 'GET', '/api/prefs')).statusCode).toBe(401);
  });
  it('an admin cannot unapprove or remove the device of their own session; the list marks it as current', async () => {
    const { deviceId } = await sessionOf(admin);
    for (const url of ['/api/admin/devices/unapprove', '/api/admin/devices/remove']) {
      const r = await as(admin, 'POST', url, { userId: adminId, deviceId });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('cannot_lock_yourself_out');
    }
    expect((await as(admin, 'GET', '/api/prefs')).statusCode).toBe(200);
    const list = (await as(admin, 'GET', '/api/admin/devices')).json().devices as Array<{ user_id: string; device_id: string; current: boolean }>;
    expect(list.filter((d) => d.current)).toEqual([expect.objectContaining({ user_id: adminId, device_id: deviceId })]);
  });
});

describe('preview clips are audited', () => {
  it('DELETE writes preview.clear', async () => {
    const id = 'ab'.repeat(16);
    expect((await as(admin, 'DELETE', `/api/admin/previews/${id}`)).statusCode).toBe(200);
    const last = (await env.pool.query('select action, target, actor from audit_log order by id desc limit 1')).rows[0];
    expect(last).toMatchObject({ action: 'preview.clear', target: id, actor: adminId });
  });
});

describe('admin endpoints: who may call them', () => {
  const GETS = ['/api/admin/users', '/api/admin/devices', '/api/admin/invites', '/api/admin/audit', '/api/admin/audit/filters'];
  const body = { userId: randomUUID(), deviceId: 'device-xxxxxxxxxxxx' };

  it('an authenticated non-admin gets 403', async () => {
    const pat = await env.login({ sub: 'sub-pat', email: 'pat@example.com', name: 'Pat', groups: [] });
    for (const url of GETS) expect((await as(pat, 'GET', url)).statusCode, url).toBe(403);
    expect((await as(pat, 'POST', '/api/admin/devices/unapprove', body)).statusCode).toBe(403);
    expect((await as(pat, 'POST', '/api/admin/devices/remove', body)).statusCode).toBe(403);
  });

  for (const kids of [false, true]) {
    it(`an admin account on a ${kids ? 'kids' : 'non-owner'} profile gets 403`, async () => {
      const s = await env.login(ADMIN);
      const pid = randomUUID();
      await env.pool.query('insert into profiles(id, user_id, name, is_owner, kids, jellyfin_user_id) values ($1, $2, $3, false, $4, $5)', [pid, adminId, kids ? 'Kind' : 'Gast', kids, 'f'.repeat(32)]);
      const raw = JSON.parse((await env.kv.get(`sess:${s.cookies.ff_sid}`))!);
      await env.kv.set(`sess:${s.cookies.ff_sid}`, JSON.stringify({ ...raw, profileId: pid }), 600);
      try {
        for (const url of GETS) expect((await as(s, 'GET', url)).statusCode, url).toBe(403);
        expect((await as(s, 'POST', '/api/admin/devices/unapprove', body)).statusCode).toBe(403);
        expect((await as(s, 'POST', '/api/admin/devices/remove', body)).statusCode).toBe(403);
      } finally {
        await env.pool.query('delete from profiles where id=$1', [pid]);
      }
    });
  }

  it('state-changing admin calls without the CSRF header get 403', async () => {
    const calls: Array<[string, string, unknown]> = [
      ['POST', '/api/admin/devices/unapprove', body],
      ['POST', '/api/admin/devices/remove', body],
      ['POST', '/api/admin/live/stop', { userId: randomUUID(), playSessionId: 'ps-1' }],
      ['DELETE', `/api/admin/previews/${'cd'.repeat(16)}`, undefined],
    ];
    for (const [m, url, b] of calls) {
      const r = await as(admin, m, url, b, false);
      expect(r.statusCode, url).toBe(403);
      expect(r.json().error).toBe('csrf');
    }
  });
});
