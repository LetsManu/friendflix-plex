// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { keyFromBase64 } from '../src/crypto.js';
import type { OidcClaims } from '../src/oidc.js';
import { MemorySettingsBus } from '../src/settings/bus.js';
import { readMeta, updateMeta } from '../src/settings/repo.js';
import { createSettingsStore } from '../src/settings/store.js';
import { issueSetupCode } from '../src/setup/code.js';
import { claimSetup, completeSetup, isSetupComplete } from '../src/setup/state.js';
import { cfg, ENC_KEY, makeEnv, TEST_DB, type TestEnv } from './helpers.js';

// Block 25 Task 14 (spec Parts E2 and F step 5): the first sign-in during setup becomes admin and completes setup.
type SetupSess = { cookies: Record<string, string>; csrf: string; code: string };
let ipN = 0;
const freshIp = () => `10.14.${Math.floor(++ipN / 250)}.${ipN % 250}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** a new setup code and a setup session opened with it */
async function unlock(env: TestEnv, code?: string): Promise<SetupSess> {
  code ??= await issueSetupCode(env.ctx);
  const r = await env.app.inject({ method: 'POST', url: '/api/setup/unlock', payload: { code }, remoteAddress: freshIp() });
  expect(r.statusCode).toBe(200);
  const token = r.cookies.find((c) => c.name === 'ff_setup')!.value;
  const csrf = r.cookies.find((c) => c.name === 'ff_setup_csrf')!.value;
  return { cookies: { ff_setup: token, ff_setup_csrf: csrf }, csrf, code };
}

/** /auth/login?setup=1 with the setup session: the ff_oidc state */
async function setupLogin(env: TestEnv, s: SetupSess | null, query = '?setup=1'): Promise<string> {
  const l = await env.app.inject({ url: `/auth/login${query}`, cookies: s?.cookies ?? {} });
  expect(l.statusCode).toBe(302);
  return l.cookies.find((x) => x.name === 'ff_oidc')!.value;
}

const callback = (env: TestEnv, state: string, cookies: Record<string, string> = {}) =>
  env.app.inject({ url: `/auth/callback?state=${state}&code=c`, cookies: { ...cookies, ff_oidc: state } });

const person = (sub: string, groups: string[] = []): OidcClaims => ({ sub, email: `${sub}@example.com`, name: sub, groups });
const userRow = async (env: TestEnv, sub: string) => (await env.pool.query('select id, role from users where authentik_sub=$1', [sub])).rows[0] as { id: string; role: string } | undefined;
const audits = async (env: TestEnv, action: string) => (await env.pool.query('select actor, target, meta from audit_log where action=$1 order by id', [action])).rows;

describe('the first admin', () => {
  let env: TestEnv;
  const lines: string[] = [];
  let s: SetupSess;
  let adminSid: string;
  let adminCsrf: string;
  let revBefore: number;
  let cb: Awaited<ReturnType<typeof callback>>;
  beforeAll(async () => {
    env = await makeEnv({}, { setupComplete: false, logger: { stream: { write: (l) => { lines.push(l); } }, level: 'info' } });
    s = await unlock(env);
    revBefore = env.ctx.settings.rev();
    env.claims.current = person('sub-first'); // neither the admin group nor an invite
    await env.kv.set('setup:signin:via', 'authentik', 60); // the Authentik automation's mark: completion removes it
    const announce = vi.spyOn(env.ctx.settings, 'announce');
    cb = await callback(env, await setupLogin(env, s), s.cookies);
    expect(announce).toHaveBeenCalled();
  });
  afterAll(() => env.close());

  it('callback with setup session, claims without ADMIN_GROUP and without invite -> user role admin, Jellyfin user created, setup complete, redirect /setup/extras', async () => {
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/setup/extras');
    const u = await userRow(env, 'sub-first');
    expect(u?.role).toBe('admin');
    expect(env.jfCalls.filter((c) => c.method === 'POST' && c.path === '/Users/New')).toHaveLength(1);
    expect(await isSetupComplete(env.ctx)).toBe(true);
    const meta = await readMeta(env.pool);
    expect(meta.setupCompletedAt).not.toBeNull();
    expect(meta.setupCodeHash).toBeNull();
    // the rev moved, so every instance's cached gate answer is dropped
    expect(meta.rev).toBeGreaterThan(revBefore);
    expect(env.ctx.settings.rev()).toBe(meta.rev);
    expect(await env.kv.keys('setup:sess:')).toEqual([]);
    expect(await env.kv.get('setup:signin:via')).toBeNull();
    expect(await audits(env, 'setup.completed')).toEqual([{ actor: u!.id, target: null, meta: {} }]);
    // signed in, with the re-authentication stamp of the session's creation
    adminSid = cb.cookies.find((c) => c.name === 'ff_sid')!.value;
    const sess = JSON.parse((await env.kv.get(`sess:${adminSid}`))!);
    expect(Math.abs(Date.now() - sess.reauthAt)).toBeLessThan(10_000);
    // the browser forgets the setup cookies
    expect(cb.cookies.find((c) => c.name === 'ff_setup')?.value).toBe('');
    // the log line, and no code anywhere in the log
    const msgs = lines.map((l) => JSON.parse(l) as { msg?: string });
    expect(msgs.filter((m) => m.msg === 'Setup completed; the setup code is no longer valid.')).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(s.code);
    expect(lines.join('\n')).not.toContain(s.cookies.ff_setup!);
  });

  it('after completion: unlock with the old code -> 409 setup_complete; the old ff_setup cookie is no session any more; /api/me works', async () => {
    const u = await env.app.inject({ method: 'POST', url: '/api/setup/unlock', payload: { code: s.code }, remoteAddress: freshIp() });
    expect(u.statusCode).toBe(409);
    expect(u.json()).toEqual({ error: 'setup_complete' });
    // the setup session is deleted (its kv key), so the old cookie opens nothing, setup complete or not
    expect(await env.kv.get(`setup:sess:${sha(s.cookies.ff_setup!)}`)).toBeNull();
    // 409, not the brief's 401: requireSetupSession answers setup_complete before it looks at the session (ruling D22)
    const put = await env.app.inject({ method: 'PUT', url: '/api/setup/settings', cookies: s.cookies, headers: { 'x-ff-setup-csrf': s.csrf }, payload: { values: { PUBLIC_URL: 'https://tv.example.com' } } });
    expect(put.statusCode).toBe(409);
    expect((await env.app.inject({ url: '/api/setup/state', cookies: s.cookies })).json()).toEqual({ complete: true });
    const me = await env.app.inject({ url: '/api/me', cookies: { ff_sid: adminSid } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ role: 'admin', isAdmin: true });
    adminCsrf = me.json().csrfToken;
  });

  it('D22: an admin ff_sid plus the old ff_setup cookies after completion -> 409 setup_complete, never 403 csrf', async () => {
    const both = { ...s.cookies, ff_sid: adminSid };
    for (const [method, url, payload] of [['PUT', '/api/setup/settings', { values: { PUBLIC_URL: 'https://tv.example.com' } }], ['POST', '/api/setup/test', { group: 'general' }],
      ['POST', '/api/setup/authentik/plan', { url: 'https://auth.example.com', token: 't' }]] as const) {
      for (const headers of [{}, { 'x-csrf-token': adminCsrf }, { 'x-ff-setup-csrf': s.csrf }]) {
        const r = await env.app.inject({ method, url, cookies: both, headers, payload });
        expect(r.statusCode, url).toBe(409);
        expect(r.json()).toEqual({ error: 'setup_complete' });
      }
    }
  });

  it('the new admin can PUT a secret in /api/admin/settings without re-auth within 10 min', async () => {
    const hook = 'https://discord.com/api/webhooks/1/first-admin-token';
    const r = await env.app.inject({ method: 'PUT', url: '/api/admin/settings', cookies: { ff_sid: adminSid }, headers: { 'x-csrf-token': adminCsrf }, payload: { values: { DISCORD_WEBHOOK_URL: hook } } });
    expect(r.statusCode).toBe(200);
    expect(env.ctx.cfg.DISCORD_WEBHOOK_URL).toBe(hook);
  });

  it('a second /auth/login?setup=1 after completion behaves like a normal login (group/invite/approval rules)', async () => {
    // no group, no invite: waits for approval, no account
    env.claims.current = person('sub-late');
    const late = await callback(env, await setupLogin(env, null));
    expect(late.statusCode).toBe(302);
    expect(late.headers.location).toBe('/pending');
    expect(await userRow(env, 'sub-late')).toBeUndefined();
    // the old setup cookies change nothing either
    env.claims.current = person('sub-late2');
    const withOld = await callback(env, await setupLogin(env, s), s.cookies);
    expect(withOld.headers.location).toBe('/pending');
    expect(await userRow(env, 'sub-late2')).toBeUndefined();
    // the admin group still makes an admin, through the normal path (landing on /)
    env.claims.current = person('sub-grp', [env.ctx.cfg.ADMIN_GROUP]);
    const grp = await callback(env, await setupLogin(env, null));
    expect(grp.headers.location).toBe('/');
    expect((await userRow(env, 'sub-grp'))?.role).toBe('admin');
    // the first admin signs in again normally
    env.claims.current = person('sub-first');
    const again = await callback(env, await setupLogin(env, null));
    expect(again.headers.location).toBe('/');
    expect(await audits(env, 'setup.completed')).toHaveLength(1);
  });
});

describe('the setup branch needs the setup session that started the login', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv({}, { setupComplete: false }); });
  afterAll(() => env.close());
  const noUsers = async () => expect((await env.pool.query('select count(*)::int n from users')).rows[0].n).toBe(0);

  it('callback without setup session during setup -> back to the code step (/setup?expired=1), no user row', async () => {
    const s = await unlock(env);
    const state = await setupLogin(env, s);
    const r = await callback(env, state);
    expect([r.statusCode, r.headers.location]).toEqual([302, '/setup?expired=1']);
    await noUsers();
    expect(await isSetupComplete(env.ctx)).toBe(false);
  });

  it('a login started without ?setup=1 is no setup login: back to the code step, no user row', async () => {
    const s = await unlock(env);
    const r = await callback(env, await setupLogin(env, s, ''), s.cookies);
    expect([r.statusCode, r.headers.location]).toEqual([302, '/setup?expired=1']);
    await noUsers();
  });

  it('the saved login state carries the hash of the setup session, never the token', async () => {
    const s = await unlock(env);
    const state = await setupLogin(env, s);
    const saved = JSON.parse((await env.kv.get(`oidc:${state}`))!);
    expect(saved.setup).toBe(sha(s.cookies.ff_setup!));
    expect(JSON.stringify(saved)).not.toContain(s.cookies.ff_setup!);
  });

  it('a planted ff_oidc state from another setup session is refused (back to the code step, no user row)', async () => {
    // the attacker's own setup session starts the login; the victim's browser (another setup session) finishes it
    const attacker = await unlock(env);
    const victim = await unlock(env);
    const state = await setupLogin(env, attacker);
    const r = await callback(env, state, victim.cookies);
    expect([r.statusCode, r.headers.location]).toEqual([302, '/setup?expired=1']);
    await noUsers();
    // a state forged with a setup flag but no hash of this session is refused the same way
    const forged = 'forged-state-1';
    await env.kv.set(`oidc:${forged}`, JSON.stringify({ state: forged, nonce: 'n', codeVerifier: 'v', setup: true }), 600);
    expect((await callback(env, forged, victim.cookies)).headers.location).toBe('/setup?expired=1');
    await noUsers();
    expect(await isSetupComplete(env.ctx)).toBe(false);
  });

  it('a setup session that expired between login and callback -> back to the code step', async () => {
    const s = await unlock(env);
    const state = await setupLogin(env, s);
    await env.kv.del(`setup:sess:${sha(s.cookies.ff_setup!)}`);
    expect((await callback(env, state, s.cookies)).headers.location).toBe('/setup?expired=1');
    await noUsers();
  });

  it('a disabled account that already exists gets 403 disabled, not the setup branch', async () => {
    await env.pool.query("insert into users(id, authentik_sub, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc, disabled) values (gen_random_uuid(),'sub-off','Off','friend','jfoff','Off','x',true)");
    env.claims.current = person('sub-off');
    const s = await unlock(env);
    const r = await callback(env, await setupLogin(env, s), s.cookies);
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'disabled' });
    expect((await userRow(env, 'sub-off'))?.role).toBe('friend');
    expect(await isSetupComplete(env.ctx)).toBe(false);
  });

  it('an existing account deleted between the lookup and the claim: the claim rolls back (no admin, setup stays open)', async () => {
    await env.pool.query("insert into users(id, authentik_sub, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-gone','Gone','friend','jfgone','Gone','x')");
    env.claims.current = person('sub-gone');
    const s = await unlock(env);
    const state = await setupLogin(env, s);
    // the deletion lands right before the claim's transaction starts (after the callback looked the account up)
    const pool = env.pool as unknown as { connect(...cb: unknown[]): Promise<unknown> };
    const connect = pool.connect.bind(pool);
    pool.connect = async (...cb: unknown[]) => {
      if (cb.length) return connect(...cb);
      pool.connect = connect;
      await env.pool.query("delete from users where authentik_sub='sub-gone'");
      return connect();
    };
    const r = await callback(env, state, s.cookies);
    expect(r.statusCode).not.toBe(302);
    expect((await env.pool.query("select count(*)::int n from users where role='admin' or authentik_sub='sub-gone'")).rows[0].n).toBe(0);
    expect((await readMeta(env.pool)).setupCompletedAt).toBeNull();
    expect(await isSetupComplete(env.ctx)).toBe(false);
  });

  it('an account that already exists (setup reopened by hand) becomes admin and completes setup', async () => {
    await env.pool.query("insert into users(id, authentik_sub, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-pre','Pre','friend','jfpre','Pre','x')");
    env.claims.current = person('sub-pre');
    const s = await unlock(env);
    const r = await callback(env, await setupLogin(env, s), s.cookies);
    expect(r.headers.location).toBe('/setup/extras');
    expect((await userRow(env, 'sub-pre'))?.role).toBe('admin');
    expect(await isSetupComplete(env.ctx)).toBe(true);
  });
});

describe('a claim that does not commit leaves no admin', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv({ 'DELETE /Users/[^/]+': () => ({ status: 204 }) }, { setupComplete: false }); });
  afterAll(() => env.close());

  /** the next claim's COMMIT fails (after the account was written on its transaction) */
  function failNextCommit() {
    type Client = { query: (...a: unknown[]) => Promise<unknown>; release: (...a: unknown[]) => void };
    const pool = env.pool as unknown as { connect(...cb: unknown[]): Promise<Client> };
    const connect = pool.connect.bind(pool);
    // pool.query() connects with a callback: only the promise form (claimSetup's transaction) is caught
    pool.connect = async (...cb: unknown[]) => {
      if (cb.length) return connect(...cb);
      pool.connect = connect;
      const c = await connect();
      const query = c.query;
      const release = c.release;
      c.query = (...a: unknown[]) => (a[0] === 'commit' ? Promise.reject(new Error('commit failed')) : query.apply(c, a));
      c.release = (...a: unknown[]) => { c.query = query; c.release = release; release.apply(c, a); };
      return c;
    };
  }

  it('commit fails after provisioning A -> no admin row; B completes setup -> exactly one admin; A then gets no admin', async () => {
    const code = await issueSetupCode(env.ctx);
    env.claims.current = person('sub-a');
    const a = await unlock(env, code);
    failNextCommit();
    const ra = await callback(env, await setupLogin(env, a), a.cookies);
    expect(ra.statusCode).toBe(401);
    expect((await env.pool.query('select count(*)::int n from users')).rows[0].n).toBe(0);
    expect((await env.pool.query("select count(*)::int n from audit_log where action='user.provisioned'")).rows[0].n).toBe(0);
    // the media server account created for A is deleted again
    const created = env.jfCalls.filter((c) => c.method === 'POST' && c.path === '/Users/New');
    expect(created).toHaveLength(1);
    expect(env.jfCalls.some((c) => c.method === 'DELETE' && c.path.startsWith('/Users/'))).toBe(true);
    const meta = await readMeta(env.pool);
    expect(meta.setupCompletedAt).toBeNull();
    expect(meta.setupCodeHash).not.toBeNull(); // the code is still valid
    // B completes setup
    env.claims.current = person('sub-b');
    const b = await unlock(env, code);
    const rb = await callback(env, await setupLogin(env, b), b.cookies);
    expect(rb.headers.location).toBe('/setup/extras');
    // A signs in normally: approval rules, no account, no admin
    env.claims.current = person('sub-a');
    const again = await callback(env, await setupLogin(env, null, ''));
    expect(again.headers.location).toBe('/pending');
    expect((await env.pool.query("select authentik_sub from users where role='admin'")).rows).toEqual([{ authentik_sub: 'sub-b' }]);
    expect((await env.pool.query('select count(*)::int n from users')).rows[0].n).toBe(1);
  });

  it('a failing completion step after the claim committed still signs the admin in (best effort, logged)', async () => {
    const warn = vi.fn();
    const info = vi.fn();
    const keys = vi.spyOn(env.kv, 'keys').mockRejectedValueOnce(new Error('redis down'));
    const session: { reauthAt?: number } = {};
    await completeSetup(env.ctx, 'x', session, { info, warn });
    expect(warn).toHaveBeenCalledWith('Setup completion: deleting the setup sessions failed');
    expect(typeof session.reauthAt).toBe('number');
    expect(info).toHaveBeenCalled();
    keys.mockRestore();
  });
});

describe('a claim whose transaction aborted (it answers ROLLBACK to the commit) leaves no admin', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv({ 'DELETE /Users/[^/]+': () => ({ status: 204 }) }, { setupComplete: false }); });
  afterAll(() => env.close());

  /** the next claim's audit insert fails inside its transaction: Postgres aborts it, audit() swallows the error, COMMIT rolls back */
  function abortNextClaim() {
    type Client = { query: (...a: unknown[]) => Promise<unknown>; release: (...a: unknown[]) => void };
    const pool = env.pool as unknown as { connect(...cb: unknown[]): Promise<Client> };
    const connect = pool.connect.bind(pool);
    pool.connect = async (...cb: unknown[]) => {
      if (cb.length) return connect(...cb);
      pool.connect = connect;
      const c = await connect();
      const query = c.query;
      const release = c.release;
      c.query = (...a: unknown[]) => (String(a[0]).startsWith('insert into audit_log') ? query.apply(c, ['select 1/0']) : query.apply(c, a));
      c.release = (...a: unknown[]) => { c.query = query; c.release = release; release.apply(c, a); };
      return c;
    };
  }

  it('no admin, setup stays open, the code stays valid, no session; a later claim succeeds with exactly one admin', async () => {
    const code = await issueSetupCode(env.ctx);
    const hash = (await readMeta(env.pool)).setupCodeHash;
    env.claims.current = person('sub-abort');
    const a = await unlock(env, code);
    abortNextClaim();
    const ra = await callback(env, await setupLogin(env, a), a.cookies);
    expect(ra.statusCode).not.toBe(302);
    expect(ra.cookies.find((c) => c.name === 'ff_sid')).toBeUndefined();
    expect((await env.pool.query('select count(*)::int n from users')).rows[0].n).toBe(0);
    const meta = await readMeta(env.pool);
    expect(meta.setupCompletedAt).toBeNull();
    expect(meta.setupCodeHash).toBe(hash);
    expect(await isSetupComplete(env.ctx)).toBe(false);
    expect(await audits(env, 'setup.completed')).toEqual([]);
    // the media server account created for the aborted claim is deleted again
    expect(env.jfCalls.some((c) => c.method === 'DELETE' && c.path.startsWith('/Users/'))).toBe(true);
    // the same code still opens a setup session, and the next claim completes setup
    env.claims.current = person('sub-next');
    const b = await unlock(env, code);
    const rb = await callback(env, await setupLogin(env, b), b.cookies);
    expect(rb.headers.location).toBe('/setup/extras');
    expect((await env.pool.query("select authentik_sub from users where role='admin'")).rows).toEqual([{ authentik_sub: 'sub-next' }]);
    expect((await env.pool.query('select count(*)::int n from users')).rows[0].n).toBe(1);
    expect(await audits(env, 'setup.completed')).toHaveLength(1);
  });

  it('completeSetup never completes setup on its own: without an admin account it leaves setup open', async () => {
    await updateMeta(env.pool, { setupCompletedAt: null });
    await env.ctx.settings.reload();
    const warn = vi.fn();
    await completeSetup(env.ctx, '00000000-0000-4000-8000-000000000000', {}, { info: () => {}, warn });
    expect((await readMeta(env.pool)).setupCompletedAt).toBeNull();
    expect(await isSetupComplete(env.ctx)).toBe(false);
  });
});

describe('two setup sign-ins at once', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv({}, { setupComplete: false }); });
  afterAll(() => env.close());

  it('yield exactly one admin; the other follows the normal rules (no admin role)', async () => {
    const code = await issueSetupCode(env.ctx);
    const a = await unlock(env, code);
    const b = await unlock(env, code);
    // the fake IdP answers per state: two different people
    const people = new Map<string, OidcClaims>();
    const finish = env.ctx.oidc.finish;
    env.ctx.oidc.finish = async (url, saved, o) => ({ ...(await finish(url, saved, o)), ...people.get(saved.state)! });
    const sa = await setupLogin(env, a);
    const sb = await setupLogin(env, b);
    people.set(sa, person('sub-a'));
    people.set(sb, person('sub-b'));
    const [ra, rb] = await Promise.all([callback(env, sa, a.cookies), callback(env, sb, b.cookies)]);
    const locs = [ra.headers.location, rb.headers.location].sort();
    expect(locs).toEqual(['/pending', '/setup/extras']);
    const admins = (await env.pool.query("select authentik_sub from users where role='admin'")).rows;
    expect(admins).toHaveLength(1);
    expect((await env.pool.query('select count(*)::int n from users')).rows[0].n).toBe(1);
    expect(await audits(env, 'setup.completed')).toHaveLength(1);
    env.ctx.oidc.finish = finish;
  });
});

describe('claimSetup / completeSetup', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv({}, { setupComplete: false }); });
  afterAll(() => env.close());

  it('serialises: the second claim waits for the first and then loses; a failed run rolls back', async () => {
    await issueSetupCode(env.ctx);
    // a run that fails leaves setup incomplete and the code valid
    await expect(claimSetup(env.ctx, async () => { throw new Error('jellyfin down'); })).rejects.toThrow('jellyfin down');
    const m0 = await readMeta(env.pool);
    expect(m0.setupCompletedAt).toBeNull();
    expect(m0.setupCodeHash).not.toBeNull();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let secondRan = false;
    const first = claimSetup(env.ctx, async () => { await gate; return 'first'; });
    await new Promise((r) => setTimeout(r, 50));
    const second = claimSetup(env.ctx, async () => { secondRan = true; return 'second'; });
    await new Promise((r) => setTimeout(r, 100));
    expect(secondRan).toBe(false); // blocked on the row lock
    release();
    expect(await first).toBe('first');
    expect(await second).toBeNull();
    expect(secondRan).toBe(false);
    const m = await readMeta(env.pool);
    expect(m.setupCompletedAt).not.toBeNull();
    expect(m.setupCodeHash).toBeNull();
    expect(await claimSetup(env.ctx, async () => 'late')).toBeNull();
  });

  it('completeSetup tells the other instances: their cached gate opens', async () => {
    await updateMeta(env.pool, { setupCompletedAt: null });
    const bus = new MemorySettingsBus();
    const encKey = keyFromBase64(ENC_KEY);
    const mk = () => createSettingsStore({ db: env.pool, encKey, env: { DATABASE_URL: TEST_DB, REDIS_URL: 'redis://x', APP_ENC_KEY: ENC_KEY, INTERNAL_SECRET: cfg.INTERNAL_SECRET }, bus, log: { warn: () => {} }, pollMs: 3_600_000 });
    const here = await mk();
    const there = await mk();
    try {
      const hereCtx = { db: env.pool, kv: env.kv, settings: here };
      const thereCtx = { db: env.pool, settings: there };
      expect(await isSetupComplete(thereCtx)).toBe(false); // cached
      await env.kv.set('setup:sess:x', '{}', 60);
      const uid = (await env.pool.query("insert into users(id, authentik_sub, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-c','C','admin','jfc','C','x') returning id")).rows[0].id;
      const session: { reauthAt?: number } = {};
      const info = vi.fn();
      await completeSetup(hereCtx, uid, session, { info, warn: () => {} });
      expect(typeof session.reauthAt).toBe('number');
      expect(info).toHaveBeenCalledWith('Setup completed; the setup code is no longer valid.');
      expect(await env.kv.get('setup:sess:x')).toBeNull();
      expect(await isSetupComplete(hereCtx)).toBe(true);
      await vi.waitFor(async () => expect(await isSetupComplete(thereCtx)).toBe(true));
    } finally {
      await here.close();
      await there.close();
    }
  });
});
