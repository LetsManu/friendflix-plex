// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { expiryTick } from '../src/expiry.js';
import { lockUser, setAccessUntil } from '../src/users.js';
import { ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
let adminId = '';
const ids: Record<string, string> = {};
const DAY = 86400e3;
const jfId = (sub: string) => sub.padEnd(32, '0').slice(0, 32);

const addUser = async (sub: string, name: string, role: string) =>
  (await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), $1, $2, $3, $4, $5, $1, $6) returning id`,
    [sub, `${sub}@x.de`, name, role, jfId(sub), encrypt(keyFromBase64(ENC_KEY), 'pw')],
  )).rows[0].id as string;
const row = async (id: string) => (await env.pool.query('select disabled, locked_reason, access_until, expiry_notified_at from users where id=$1', [id])).rows[0];
const setUntil = (id: string, until: Date | null) => env.pool.query('update users set access_until=$2 where id=$1', [id, until]);
/** Notifications by message key: [user_id, params] */
const notices = async (key: string) =>
  (await env.pool.query("select user_id, msg->'title'->'params' params from notifications where msg->'title'->>'key'=$1 order by id", [key])).rows as { user_id: string | null; params: Record<string, unknown> }[];
const audits = async (action: string, target: string) => (await env.pool.query('select actor, meta from audit_log where action=$1 and target=$2 order by id', [action, target])).rows;

beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login();
  adminId = (await env.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id;
  ids.anna = await addUser('anna', 'Anna', 'friend');
  ids.ben = await addUser('ben', 'Ben', 'guest');
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.pool.query("update users set role = case authentik_sub when 'anna' then 'friend' when 'ben' then 'guest' else 'admin' end, disabled=false, locked_reason=null, access_until=null, expiry_notified_at=null");
  await env.pool.query('delete from notifications');
  await env.pool.query("delete from audit_log where action like 'user.%'");
});

describe('expiryTick', () => {
  it('warns once 3 days before', async () => {
    const now = new Date();
    const until = new Date(now.getTime() + 2 * DAY);
    await setUntil(ids.anna!, until);
    await setUntil(ids.ben!, new Date(now.getTime() + 4 * DAY)); // outside the window

    expect(await expiryTick(env.ctx, now)).toEqual({ warned: 1, locked: 0 });
    expect(await expiryTick(env.ctx, now)).toEqual({ warned: 0, locked: 0 });

    const soon = await notices('notify.access.soon');
    expect(soon).toEqual([{ user_id: ids.anna, params: { date: { date: until.toISOString() } } }]);
    const soonAdmin = await notices('notify.access.soonAdmin');
    expect(soonAdmin).toEqual([{ user_id: adminId, params: { name: 'Anna', date: { date: until.toISOString() } } }]);
    expect((await row(ids.anna!)).expiry_notified_at).not.toBeNull();
    expect((await row(ids.ben!)).expiry_notified_at).toBeNull();
    expect((await row(ids.anna!)).disabled).toBe(false);
  });

  it('locks on the day and notifies', async () => {
    const now = new Date();
    const until = new Date(now.getTime() - 60e3);
    await setUntil(ids.anna!, until);
    env.jfCalls.length = 0;

    expect(await expiryTick(env.ctx, now)).toEqual({ warned: 0, locked: 1 });
    expect(await row(ids.anna!)).toMatchObject({ disabled: true, locked_reason: 'expired' });
    expect(env.jfCalls.some((c) => c.path === `/Users/${jfId('anna')}/Policy` && c.body.IsDisabled === true)).toBe(true);
    expect(await notices('notify.access.ended')).toEqual([{ user_id: ids.anna, params: { date: { date: until.toISOString() } } }]);
    expect(await notices('notify.access.endedAdmin')).toEqual([{ user_id: adminId, params: { name: 'Anna', date: { date: until.toISOString() } } }]);
    expect(await audits('user.expired', ids.anna!)).toEqual([{ actor: null, meta: { accessUntil: until.toISOString() } }]);
    expect((await audits('user.disable', ids.anna!)).map((a) => a.meta)).toEqual([{ reason: 'expired' }]);

    // idempotent: a second run neither re-locks nor notifies again
    expect(await expiryTick(env.ctx, now)).toEqual({ warned: 0, locked: 0 });
    expect(await notices('notify.access.ended')).toHaveLength(1);
    expect(await audits('user.disable', ids.anna!)).toHaveLength(1);
  });

  it('does not warn or lock already locked accounts', async () => {
    const now = new Date();
    await lockUser(env.ctx, adminId, ids.anna!, 'manual');
    await setUntil(ids.anna!, new Date(now.getTime() + DAY));
    await setUntil(ids.ben!, new Date(now.getTime() - DAY));
    await lockUser(env.ctx, adminId, ids.ben!, 'manual');
    expect(await expiryTick(env.ctx, now)).toEqual({ warned: 0, locked: 0 });
    expect(await row(ids.ben!)).toMatchObject({ disabled: true, locked_reason: 'manual' });
    expect(await notices('notify.access.soon')).toHaveLength(0);
  });

  it('null access_until never expires', async () => {
    const far = new Date(Date.now() + 100 * 365 * DAY);
    expect(await expiryTick(env.ctx, far)).toEqual({ warned: 0, locked: 0 });
    expect(await row(ids.anna!)).toMatchObject({ disabled: false, locked_reason: null, expiry_notified_at: null });
    expect(await notices('notify.access.soon')).toHaveLength(0);
  });

  it('never locks the last active admin: admins are told once and the skip is audited', async () => {
    const now = new Date();
    const until = new Date(now.getTime() - 60e3);
    await setUntil(adminId, until);

    expect(await expiryTick(env.ctx, now)).toEqual({ warned: 0, locked: 0 });
    expect(await expiryTick(env.ctx, now)).toEqual({ warned: 0, locked: 0 });
    expect(await row(adminId)).toMatchObject({ disabled: false, locked_reason: null });
    expect(await notices('notify.access.endedAdmin')).toEqual([{ user_id: adminId, params: { name: 'Admin', date: { date: until.toISOString() } } }]);
    expect(await notices('notify.access.ended')).toHaveLength(0);
    expect(await audits('user.expiry_skipped_last_admin', adminId)).toEqual([{ actor: null, meta: { accessUntil: until.toISOString() } }]);
    expect(await audits('user.expired', adminId)).toHaveLength(0);

    // with a second active admin the expired admin is locked normally
    await env.pool.query("update users set role='admin' where id=$1", [ids.ben]);
    expect(await expiryTick(env.ctx, now)).toEqual({ warned: 0, locked: 1 });
    expect(await row(adminId)).toMatchObject({ disabled: true, locked_reason: 'expired' });
    // the locked admin gets the account notice; only the remaining active admin gets the admin notice
    expect((await notices('notify.access.endedAdmin')).map((n) => n.user_id)).toEqual([adminId, ids.ben]);
    expect((await notices('notify.access.ended')).map((n) => n.user_id)).toEqual([adminId]);
    // unlocked with the access extended: a sign-in with ended access would lock the account again (loginFinish, Ruling 7)
    await env.pool.query("update users set disabled=false, locked_reason=null, access_until=null where id=$1", [adminId]);
    admin = await env.login(); // the lock revoked the admin's session
  });
});

describe('expiryTick and concurrent admin changes', () => {
  const ENDED = 'select id, name, access_until from users where access_until <=';
  /** Runs `between` right after the tick has selected the accounts whose access ended (before it locks them). */
  async function tickWith(now: Date, between: () => Promise<unknown>) {
    const db = env.ctx.db;
    let hook: Promise<unknown> | undefined;
    env.ctx.db = new Proxy(db, {
      get(t, prop) {
        const v = Reflect.get(t, prop);
        if (prop !== 'query') return v;
        return async (...args: unknown[]) => {
          const res = await (v as (...a: unknown[]) => Promise<unknown>).apply(t, args);
          if (typeof args[0] === 'string' && args[0].startsWith(ENDED) && !hook) { hook = between(); await hook; }
          return res;
        };
      },
    });
    try {
      return await expiryTick(env.ctx, now);
    } finally {
      env.ctx.db = db;
    }
  }

  it('an extension made after the tick selected the account is not undone', async () => {
    const now = new Date();
    await setUntil(ids.anna!, new Date(now.getTime() - 60e3));
    const until = new Date(now.getTime() + 30 * DAY);
    expect(await tickWith(now, () => setAccessUntil(env.ctx, adminId, ids.anna!, until))).toEqual({ warned: 0, locked: 0 });
    expect(await row(ids.anna!)).toMatchObject({ disabled: false, locked_reason: null });
    expect(await audits('user.expired', ids.anna!)).toHaveLength(0);
  });

  it('the last-admin guard holds when the tick and an admin lock race', async () => {
    const now = new Date();
    await env.pool.query("update users set role='admin' where id=$1", [ids.ben]);
    await setUntil(adminId, new Date(now.getTime() - 60e3)); // the acting admin's access has ended
    let patch: Promise<{ statusCode: number }> | undefined;
    // the admin locks Ben while the tick is between its select and the lock of the admin
    await tickWith(now, async () => {
      patch = env.app.inject({ method: 'PATCH', url: `/api/admin/users/${ids.ben}`, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { disabled: true } });
      // let the PATCH reach its own last-admin check before the tick goes on
      for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    });
    await patch;
    try {
      expect(Number((await env.pool.query("select count(*) n from users where role='admin' and not disabled")).rows[0].n)).toBe(1);
    } finally {
      await env.pool.query("update users set disabled=false, locked_reason=null, access_until=null where id=$1", [adminId]);
      admin = await env.login(); // a lock of the admin may have revoked the session
    }
  });
});

describe('changing access until', () => {
  it('extending an expired account unlocks it', async () => {
    const now = new Date();
    await setUntil(ids.anna!, new Date(now.getTime() - 60e3));
    await expiryTick(env.ctx, now);
    expect((await row(ids.anna!)).locked_reason).toBe('expired');

    const until = new Date(now.getTime() + 30 * DAY);
    until.setMilliseconds(0);
    const r = await env.app.inject({ method: 'PATCH', url: `/api/admin/users/${ids.anna}`, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { accessUntil: until.toISOString() } });
    expect(r.statusCode).toBe(200);
    expect(await row(ids.anna!)).toMatchObject({ disabled: false, locked_reason: null, expiry_notified_at: null });
    expect((await audits('user.enable', ids.anna!)).at(-1)).toMatchObject({ actor: adminId });

    // clearing the date (null) also unlocks an expired account, via bulk
    await setUntil(ids.ben!, new Date(now.getTime() - 60e3));
    await expiryTick(env.ctx, now);
    const b = await env.app.inject({ method: 'POST', url: '/api/admin/users/bulk', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { ids: [ids.ben], action: 'access', accessUntil: null } });
    expect(b.statusCode).toBe(200);
    expect(await row(ids.ben!)).toMatchObject({ disabled: false, locked_reason: null, access_until: null });
  });

  it('a failed unlock while extending an expired account heals on retry', async () => {
    const now = new Date();
    await setUntil(ids.anna!, new Date(now.getTime() - 60e3));
    await expiryTick(env.ctx, now);
    const until = new Date(now.getTime() + 30 * DAY);
    until.setMilliseconds(0);
    const patch = () => env.app.inject({ method: 'PATCH', url: `/api/admin/users/${ids.anna}`, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { accessUntil: until.toISOString() } });
    const jfAdmin = env.ctx.jf.admin;
    const setDisabled = jfAdmin.setDisabled;
    jfAdmin.setDisabled = async () => { throw new Error('media server down'); };
    try {
      expect((await patch()).statusCode).toBe(500);
    } finally {
      jfAdmin.setDisabled = setDisabled;
    }
    expect(await row(ids.anna!)).toMatchObject({ disabled: true, locked_reason: 'expired' }); // date stored, unlock failed
    expect((await row(ids.anna!)).access_until.toISOString()).toBe(until.toISOString());

    expect((await patch()).statusCode).toBe(200); // same date again
    expect(await row(ids.anna!)).toMatchObject({ disabled: false, locked_reason: null });
    expect(await audits('user.access', ids.anna!)).toHaveLength(1); // the unchanged date is not audited twice
    expect(await audits('user.enable', ids.anna!)).toHaveLength(1);
  });

  it('a new date in the past keeps an expired account locked', async () => {
    const now = new Date();
    await setUntil(ids.anna!, new Date(now.getTime() - 60e3));
    await expiryTick(env.ctx, now);
    await setAccessUntil(env.ctx, adminId, ids.anna!, new Date(now.getTime() - DAY));
    expect(await row(ids.anna!)).toMatchObject({ disabled: true, locked_reason: 'expired' });
  });

  it('extending a manually locked account keeps it locked', async () => {
    const now = new Date();
    await setUntil(ids.anna!, new Date(now.getTime() + DAY));
    await expiryTick(env.ctx, now); // warned
    await lockUser(env.ctx, adminId, ids.anna!, 'manual');
    await setAccessUntil(env.ctx, adminId, ids.anna!, new Date(now.getTime() + 30 * DAY));
    expect(await row(ids.anna!)).toMatchObject({ disabled: true, locked_reason: 'manual', expiry_notified_at: null });
    expect(await audits('user.enable', ids.anna!)).toHaveLength(0);
  });

  it('a changed date resets the warning so the new date is announced again', async () => {
    const now = new Date();
    await setUntil(ids.anna!, new Date(now.getTime() + DAY));
    expect((await expiryTick(env.ctx, now)).warned).toBe(1);
    await setAccessUntil(env.ctx, adminId, ids.anna!, new Date(now.getTime() + 2 * DAY));
    expect((await row(ids.anna!)).expiry_notified_at).toBeNull();
    expect((await expiryTick(env.ctx, now)).warned).toBe(1);
    expect(await notices('notify.access.soon')).toHaveLength(2);
  });
});
