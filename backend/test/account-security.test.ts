// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { lastAkFailures } from '../src/akdiag.js';
import { loadJar } from '../src/akflow.js';
import { akFlowCacheKey } from '../src/authentik.js';
import { sha256 } from '../src/crypto.js';
import type { OidcProvider } from '../src/oidc.js';
import type { Session } from '../src/session.js';
import { type AkCall, type FakeStage, fixture } from './akflow-fake.js';
import { makeEnv, type TestEnv } from './helpers.js';
import {
  AK_CFG, ANNA, BEN, browser, executorPosts, freshIp, installWorld, jsonResponse, LOGIN, loginStages, RIGHT, STATIC_TYPE, TOTP_TYPE, type World, WEBAUTHN_TYPE,
} from './reauth-fake.js';

// Block 23 phase 3, Task 10: in-app re-authentication (reauth → then), the security setup flows and the account's device routes.

const TOTP_SETUP = 'default-authenticator-totp-setup';
const STATIC_SETUP = 'default-authenticator-static-setup';
const WEBAUTHN_SETUP = 'default-authenticator-webauthn-setup';
const INVALIDATION = '/api/v3/flows/executor/default-invalidation-flow/';

describe('re-authentication, security actions', () => {
  let env: TestEnv;
  let w: World;
  const logs: string[] = [];
  const authorizeStarts: boolean[] = [];

  /** an OIDC fake that checks the state like openid-client does (the code exchange itself is the library's) */
  const oidc: OidcProvider = {
    async start(o) {
      authorizeStarts.push(Boolean(o?.silent));
      const state = `st${Math.random().toString(36).slice(2)}`;
      const url = new URL('/application/o/authorize/', 'https://auth.example.com');
      url.searchParams.set('state', state);
      return { url: url.toString(), state, nonce: `n-${state}`, codeVerifier: `v-${state}` };
    },
    async finish(url, saved) {
      if (url.searchParams.get('state') !== saved.state) throw new Error('state mismatch');
      return { authTime: Math.floor(Date.now() / 1000), ...env.claims.current };
    },
  };

  const setupFlows = (): Record<string, FakeStage[]> => ({
    [LOGIN]: loginStages(),
    [TOTP_SETUP]: [{ challenge: fixture('totp-setup'), answer: (b: { code?: string }) => (b.code === '123456' ? true : fixture('totp-setup-invalid')), hops: 2 }],
    [STATIC_SETUP]: [{ challenge: fixture('static-setup'), answer: () => true, hops: 2 }],
    [WEBAUTHN_SETUP]: [{ challenge: fixture('webauthn-setup'), answer: () => true, hops: 2 }],
  });
  const world = () => {
    w = installWorld(env, setupFlows());
    w.devices = [{ pk: 11, type: TOTP_TYPE, name: 'Phone', owner: ANNA.pk }, { pk: 99, type: TOTP_TYPE, name: 'Bens', owner: BEN.pk }];
  };
  const audits = async (action: string) => (await env.pool.query<{ actor: string; meta: Record<string, unknown> }>('select actor, meta from audit_log where action=$1 order by id', [action])).rows;
  const sessionOf = async (s: { cookies: Record<string, string> }) => JSON.parse((await env.kv.get(`sess:${s.cookies.ff_sid}`))!) as Session;
  const setReauthAt = async (s: { cookies: Record<string, string> }, at: number | undefined) => {
    const sess = await sessionOf(s);
    if (at === undefined) delete sess.reauthAt;
    else sess.reauthAt = at;
    await env.kv.set(`sess:${s.cookies.ff_sid}`, JSON.stringify(sess), 600);
  };
  const del = (s: { cookies: Record<string, string>; csrf: string }, path: string) =>
    env.app.inject({ method: 'DELETE', url: `/api/account/security/devices/${path}`, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf } });

  beforeAll(async () => {
    env = await makeEnv({}, { logger: { stream: { write: (m: string) => { logs.push(m); } }, level: 'trace' } });
  });
  beforeEach(async () => {
    env.ctx.cfg = { ...env.ctx.cfg, ...AK_CFG };
    env.ctx.oidc = oidc;
    env.claims.current = { sub: 'sub-admin', email: 'admin@example.com', name: 'Admin', groups: ['friendflix-admins'] };
    authorizeStarts.length = 0;
    world();
    for (const k of [...(await env.kv.keys('flowfail:')), ...(await env.kv.keys('akflow')), ...(await env.kv.keys('akmfa:')), ...(await env.kv.keys('akuser:'))]) await env.kv.del(k);
    await env.pool.query("delete from audit_log where action like 'session.reauth%' or action like 'account.%'");
  });
  afterAll(() => env.close());

  it('reauth skips identification and asks for the password', async () => {
    const s = await env.login();
    const b = browser(env, s);
    await b.config();
    const r = await b.post('start', { kind: 'reauth' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ stage: 'password', step: expect.any(String), identity: 'anna', canRecover: false });
    // the backend answered the identification with the session user's Authentik username
    expect(executorPosts(w).map((c) => c.body)).toEqual([{ uid_field: 'anna' }]);
    // the jar belongs to the session user and forwards the app host only when passkeys run in-app
    const jar = (await loadJar(env.ctx, b.cookies.ff_flow!))!;
    expect(jar).toMatchObject({ kind: 'reauth', identifier: 'anna', slug: LOGIN });
    expect(jar.userId).toBeTruthy();
    // nothing of Authentik reaches the browser
    expect(r.body).not.toContain('auth.example.com');
    expect(r.body).not.toContain('authentik_');
  });

  it('reauth of another Authentik user → denied and audited, no stamp', async () => {
    const s = await env.login();
    const b = browser(env, s);
    env.claims.current = { sub: 'sub-ben', email: 'ben@elsewhere.example.com', name: 'Ben', groups: [] };
    const end = await b.reauth();
    expect(end.json()).toEqual({ stage: 'denied' });
    expect((await sessionOf(s)).reauthAt).toBeUndefined();
    expect((await audits('session.reauth_mismatch')).length).toBe(1);
    expect(await audits('session.reauth')).toHaveLength(0);
    // the Authentik session is ended and the jar gone
    expect(w.calls.some((c) => c.path === INVALIDATION && /authentik_session=/.test(c.headers.cookie ?? ''))).toBe(true);
    expect(b.cookies.ff_flow).toBeUndefined();
  });

  it('reauth sets reauthAt; DELETE device works within 10 min, 401 reauth_required after 11 min', async () => {
    const s = await env.login();
    // no stamp yet
    expect((await del(s, 'totp/11')).statusCode).toBe(401);
    const b = browser(env, s);
    authorizeStarts.length = 0;
    const end = await b.reauth();
    expect(end.json()).toEqual({ stage: 'done', next: '/me/account' });
    expect(authorizeStarts).toEqual([true]); // a silent authorize
    const stamped = (await sessionOf(s)).reauthAt!;
    expect(Math.abs(Date.now() - stamped)).toBeLessThan(5_000);
    expect((await audits('session.reauth')).length).toBe(1);
    // reauth created no new session
    expect(end.cookies.find((c) => c.name === 'ff_sid')).toBeUndefined();
    await setReauthAt(s, Date.now() - 9 * 60_000);
    const ok = await del(s, 'totp/11');
    expect([ok.statusCode, ok.json()]).toEqual([200, { ok: true }]);
    expect(w.deleted).toEqual(['totp/11']);
    expect((await audits('account.mfa_removed')).map((a) => a.meta)).toEqual([{ type: 'totp' }]);
    await setReauthAt(s, Date.now() - 11 * 60_000);
    const late = await del(s, 'totp/11');
    expect([late.statusCode, late.json()]).toEqual([401, { error: 'reauth_required' }]);
  });

  it('reauth then setup-totp returns totp-setup and finishing ends the Authentik session', async () => {
    const s = await env.login();
    const b = browser(env, s);
    const step = (await b.reauth('setup-totp')).json() as { stage: string; step: string; otpauth: string };
    expect(step).toMatchObject({ stage: 'totp-setup', otpauth: expect.stringMatching(/^otpauth:\/\/totp\//) });
    expect((await sessionOf(s)).reauthAt).toBeTruthy(); // stamped before the follow-up flow starts
    // the same Authentik session continues in the TOTP setup flow
    const exec = w.calls.filter((c) => c.path === `/api/v3/flows/executor/${TOTP_SETUP}/`);
    expect(exec[0]!.headers.cookie).toMatch(/authentik_session=/);
    expect(w.calls.some((c) => c.path === INVALIDATION)).toBe(false);
    // a wrong code stays on the step, the right one finishes
    const bad = (await b.post('answer', { step: step.step, stage: 'totp-setup', code: '000000' })).json() as { stage: string; step: string; errors?: string[] };
    expect(bad).toMatchObject({ stage: 'totp-setup', errors: ['code_invalid'] });
    const done = await b.post('answer', { step: bad.step, stage: 'totp-setup', code: '123456' });
    expect(done.json()).toEqual({ stage: 'done', next: '/me/account' });
    expect(w.calls.some((c) => c.path === INVALIDATION && /authentik_session=/.test(c.headers.cookie ?? ''))).toBe(true);
    expect(await loadJar(env.ctx, b.cookies.ff_flow ?? 'none')).toBeNull();
  });

  it('logged-in setup POSTs carry x-authentik-csrf and origin (U1)', async () => {
    const s = await env.login();
    const b = browser(env, s);
    const step = (await b.reauth('setup-totp')).json() as { step: string };
    await b.post('answer', { step: step.step, stage: 'totp-setup', code: '123456' });
    const post = executorPosts(w, TOTP_SETUP)[0]!;
    expect(post.headers['x-authentik-csrf']).toBe('c1');
    expect(post.headers.origin).toBe('http://auth.example.com:9000');
    expect(post.headers.referer).toBe(`http://auth.example.com:9000/api/v3/flows/executor/${TOTP_SETUP}/`);
  });

  it('setup-static deletes exactly the previously listed static devices after the new codes are confirmed; a cancelled run deletes nothing (U4)', async () => {
    const s = await env.login();
    w.devices.push({ pk: 21, type: STATIC_TYPE, name: 'old a', owner: ANNA.pk }, { pk: 22, type: STATIC_TYPE, name: 'old b', owner: ANNA.pk });
    // a cancelled regeneration: Authentik already added a device, the old codes keep working
    const c = browser(env, s);
    const codes = (await c.reauth('setup-static')).json() as { stage: string; step: string; codes: string[] };
    expect(codes.stage).toBe('recovery-codes');
    expect((await c.post('cancel', {})).statusCode).toBe(200);
    expect(w.deleted).toEqual([]);
    // a finished one: the new device (23) appears in Authentik while the flow runs
    delete w.fakes[LOGIN];
    delete w.fakes[STATIC_SETUP];
    const b = browser(env, s);
    const step = (await b.reauth('setup-static')).json() as { stage: string; step: string };
    w.devices.push({ pk: 23, type: STATIC_TYPE, name: 'new', owner: ANNA.pk });
    expect(w.deleted).toEqual([]); // nothing is deleted while the codes are only shown
    const done = await b.post('answer', { step: step.step, stage: 'recovery-codes' });
    expect(done.json()).toEqual({ stage: 'done', next: '/me/account' });
    expect(w.deleted.sort()).toEqual(['static/21', 'static/22']);
    expect(w.devices.map((d) => d.pk).sort((a, c2) => a - c2)).toEqual([11, 23, 99]);
  });

  it('reauth then setup-webauthn with passkeys in-app returns passkey-setup with rp.id = app host and rp.name FriendFlix; without → 409 passkey_classic', async () => {
    const s = await env.login();
    const b = browser(env, s);
    const step = (await b.reauth('setup-webauthn')).json() as { stage: string; options: { rp: { id: string; name: string } } };
    expect(step.stage).toBe('passkey-setup');
    expect(step.options.rp).toEqual({ id: 'friend.example.com', name: 'FriendFlix' });
    // the app host is forwarded on the whole jar (re-authentication and setup)
    expect(w.calls.filter((c) => c.path.startsWith('/api/v3/flows/executor/')).every((c) => c.headers['x-forwarded-host'] === 'friend.example.com')).toBe(true);
    // passkeys off (or not provable): refused up front, the web uses the classic page
    for (const k of await env.kv.keys('akflow')) await env.kv.del(k);
    env.ctx.cfg = { ...env.ctx.cfg, PASSKEYS_IN_APP: 'off' };
    const off = browser(env, s);
    await off.config();
    const r = await off.post('start', { kind: 'reauth', then: 'setup-webauthn' });
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'passkey_classic' }]);
  });

  it('setup kinds cannot be started directly, and then belongs to reauth only', async () => {
    const s = await env.login();
    const b = browser(env, s);
    await b.config();
    for (const body of [{ kind: 'setup-totp' }, { kind: 'setup-static' }, { kind: 'setup-webauthn' }, { kind: 'change-password' }, { kind: 'change-email' }, { kind: 'email-confirm' },
      { kind: 'login', then: 'setup-totp' }, { kind: 'reauth', then: 'login' }, { kind: 'reauth', extra: 1 }]) {
      const r = await b.post('start', body);
      expect([r.statusCode, r.json()], JSON.stringify(body)).toEqual([400, { error: 'bad_request' }]);
    }
    expect(w.calls.filter((c) => c.path.startsWith('/api/v3/flows/executor/'))).toHaveLength(0);
  });

  it('csrf: the session token is required, and the flow csrf too; a session is required', async () => {
    const s = await env.login();
    const b = browser(env, s);
    await b.config();
    const noToken = await b.post('start', { kind: 'reauth' }, { token: null });
    expect([noToken.statusCode, noToken.json()]).toEqual([403, { error: 'csrf' }]);
    expect((await b.post('start', { kind: 'reauth' }, { token: 'wrong' })).statusCode).toBe(403);
    expect((await b.post('start', { kind: 'reauth' }, { csrf: null })).statusCode).toBe(403);
    const anon = browser(env);
    await anon.config();
    expect((await anon.post('start', { kind: 'reauth' })).statusCode).toBe(401);
    expect(w.calls.filter((c) => c.path.startsWith('/api/v3/flows/executor/'))).toHaveLength(0);
    // answers of a started re-authentication also need the session token
    const step = (await b.post('start', { kind: 'reauth' })).json() as { step: string };
    expect((await b.post('answer', { step: step.step, stage: 'password', password: RIGHT }, { token: null })).statusCode).toBe(403);
    expect((await b.post('cancel', {}, { token: 'wrong' })).statusCode).toBe(403);
    // a device removal needs the session csrf token like every /api mutation
    await setReauthAtNow(s);
    const noCsrf = await env.app.inject({ method: 'DELETE', url: '/api/account/security/devices/totp/11', cookies: s.cookies });
    expect(noCsrf.statusCode).toBe(403);
  });
  const setReauthAtNow = (s: { cookies: Record<string, string> }) => setReauthAt(s, Date.now());

  it('the per-account failure limit applies to a re-authentication (shared with sign-in)', async () => {
    const s = await env.login();
    await env.kv.set(`flowfail:${sha256('anna')}`, '10', 900);
    const b = browser(env, s);
    await b.config();
    const pw = (await b.post('start', { kind: 'reauth' })).json() as { step: string };
    const r = await b.post('answer', { step: pw.step, stage: 'password', password: RIGHT });
    expect(r.json()).toMatchObject({ stage: 'password', errors: ['rate_limited'] });
    expect(executorPosts(w).map((c) => c.body)).toEqual([{ uid_field: 'anna' }]); // the password never reached Authentik
  });

  it('GET /api/account/security lists the confirmed devices and the passkey mode; only the GET skips the re-authentication', async () => {
    const s = await env.login();
    w.devices.push({ pk: 31, type: WEBAUTHN_TYPE, name: 'Key', owner: ANNA.pk }, { pk: 32, type: STATIC_TYPE, name: 'pending', owner: ANNA.pk, confirmed: false });
    const r = await env.app.inject({ url: '/api/account/security', cookies: s.cookies });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      mfa: { totp: true, webauthn: true, static: false },
      devices: [{ id: '11', type: 'totp', name: 'Phone', lastUsed: null }, { id: '31', type: 'webauthn', name: 'Key', lastUsed: null }],
      passkeySetup: 'in-app', emailChange: true, emailChangePending: null, username: 'anna', usernameChange: true, problem: null,
    });
    expect(r.body).not.toContain('auth.example.com');
    env.ctx.cfg = { ...env.ctx.cfg, PASSKEYS_IN_APP: 'off' };
    expect((await env.app.inject({ url: '/api/account/security', cookies: s.cookies })).json().passkeySetup).toBe('sign-in page');
    expect((await env.app.inject({ url: '/api/account/security' })).statusCode).toBe(401);
  });

  it('root cause of "POST /auth/flow/start 502": a service token Authentik refuses no longer blocks the re-authentication', async () => {
    // before the fix the reauth start looked the Authentik username up with the service token and answered 502
    // authentik_token_rejected when Authentik refused the token (deleted, expired, another one in .env, or no view_user);
    // now it identifies with the account's e-mail address, and the end of the flow still checks the person by sub
    const s = await env.login();
    const users = w.fakes.base!;
    users.override = (c) => (c.path.startsWith('/api/v3/core/users/') ? jsonResponse({ detail: 'Token invalid/expired' }, 403) : undefined);
    const b = browser(env, s);
    await b.config();
    const start = await b.post('start', { kind: 'reauth', then: 'change-password' });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ stage: 'password', identity: 'admin@example.com' });
    expect(executorPosts(w, LOGIN)[0]!.body).toEqual({ uid_field: 'admin@example.com' });
    // the refusal is logged as class + status + endpoint path, never with the token, and kept for the status card
    const line = logs.find((l) => l.includes('reauth user lookup failed'))!;
    expect(JSON.parse(line)).toMatchObject({ code: 'authentik_token_rejected', area: 'api', cls: 'token_invalid', status: 403, endpoint: 'api/v3/core/users/' });
    expect(logs.join('\n')).not.toContain('api-token-placeholder');
    expect(await lastAkFailures(env.ctx)).toEqual([expect.objectContaining({ area: 'api', cls: 'token_invalid', status: 403 })]);
    // GET /api/account/security names the problem instead of an empty list
    const sec = (await env.app.inject({ url: '/api/account/security', cookies: s.cookies })).json();
    expect(sec).toMatchObject({ problem: 'service_token', username: null, usernameChange: false, devices: [] });
    users.override = undefined;
    await env.kv.del('akdiag:last:api');
  });

  it('an executor failure answers unavailable with a reason the dialog can show (timeout, unreachable, error)', async () => {
    const s = await env.login();
    const b = browser(env, s);
    await b.config();
    const exec = (fn: (c: AkCall) => Response | undefined) => { for (const f of Object.values(w.fakes)) f.override = fn; w.fakes.base!.override = fn; };
    // installWorld creates the executor fake lazily: a first start makes it exist
    await b.post('start', { kind: 'reauth', then: 'change-password' });
    w.fakes[LOGIN]!.override = () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); };
    expect((await b.post('start', { kind: 'reauth', then: 'change-password' })).json()).toEqual({ stage: 'unavailable', reason: 'timeout' });
    w.fakes[LOGIN]!.override = () => new Response('<html>proxy</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    expect((await b.post('start', { kind: 'reauth', then: 'change-password' })).json()).toEqual({ stage: 'unavailable', reason: 'error' });
    const line = logs.filter((l) => l.includes('flow request refused')).at(-1)!;
    expect(JSON.parse(line)).toMatchObject({ area: 'executor', cls: 'non_json', status: 200, endpoint: `api/v3/flows/executor/${LOGIN}/` });
    w.fakes[LOGIN]!.override = () => { throw new TypeError('fetch failed'); };
    expect((await b.post('start', { kind: 'reauth', then: 'change-password' })).json()).toEqual({ stage: 'unavailable', reason: 'unreachable' });
    exec(() => undefined);
    for (const k of await env.kv.keys('akdiag:')) await env.kv.del(k);
  });

  describe('username change', () => {
    const put = (s: { cookies: Record<string, string>; csrf: string }, username: unknown) =>
      env.app.inject({ method: 'PUT', url: '/api/account/security/username', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: { username }, remoteAddress: freshIp() });
    const patches: unknown[] = [];
    beforeEach(async () => {
      patches.length = 0;
      for (const k of await env.kv.keys('usernamechange:')) await env.kv.del(k);
      w.fakes.base!.override = (c) => {
        if (c.method === 'PATCH' && c.path === `/api/v3/core/users/${ANNA.pk}/`) {
          patches.push(c.body);
          ANNA.username = (c.body as { username: string }).username;
          return jsonResponse({ pk: ANNA.pk, username: ANNA.username });
        }
        return undefined;
      };
    });
    afterAll(() => { ANNA.username = 'anna'; });

    it('needs a recent re-authentication', async () => {
      const s = await env.login();
      await setReauthAt(s, undefined);
      const r = await put(s, 'anna2');
      expect([r.statusCode, r.json()]).toEqual([401, { error: 'reauth_required' }]);
      await setReauthAt(s, Date.now() - 11 * 60_000);
      expect((await put(s, 'anna2')).statusCode).toBe(401);
      expect(patches).toEqual([]);
    });

    it("validates with Authentik's rules (letters, digits, @ . + - _; at most 150) before anything reaches Authentik", async () => {
      const s = await env.login();
      await setReauthAtNow(s);
      for (const bad of ['', '   ', 'anna smith', 'anna/x', '<b>', 'a'.repeat(151), 'anna;drop']) {
        const r = await put(s, bad);
        expect([r.statusCode, r.json()], bad).toEqual([400, { error: 'username_invalid' }]);
      }
      expect((await put(s, 42)).statusCode).toBe(400);
      expect(patches).toEqual([]);
      for (const good of ['Änne.Müller', 'anna+tv@home', 'a'.repeat(150)]) expect((await put(s, good)).statusCode, good).toBe(200);
      await env.kv.del('usernamechange:' + (await env.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id);
    });

    it('refuses a name another Authentik user has (case-insensitive), changes it, audits without the names, and the login mapping (sub) stays', async () => {
      const s = await env.login();
      await setReauthAtNow(s);
      ANNA.username = 'anna';
      const taken = await put(s, 'BEN');
      expect([taken.statusCode, taken.json()]).toEqual([409, { error: 'username_taken' }]);
      const same = await put(s, 'anna');
      expect([same.statusCode, same.json()]).toEqual([200, { ok: true, username: 'anna' }]);
      expect(patches).toEqual([]);
      const r = await put(s, '  anna.neu  ');
      expect([r.statusCode, r.json()]).toEqual([200, { ok: true, username: 'anna.neu' }]);
      expect(patches).toEqual([{ username: 'anna.neu' }]);
      const audit = await audits('account.username');
      expect(audit).toHaveLength(1);
      expect(audit[0]!.meta).toEqual({ fields: ['username'] });
      expect(JSON.stringify(audit)).not.toContain('anna.neu');
      // FriendFlix keys the account by sub: a sign-in after the rename is the same account, nothing else changed
      const before = (await env.pool.query("select id, jellyfin_username from users where authentik_sub='sub-admin'")).rows[0];
      const again = await env.login();
      const me = (await env.app.inject({ url: '/api/me', cookies: again.cookies })).json();
      expect(me.id).toBe(before.id);
      expect((await env.pool.query("select id, jellyfin_username from users where authentik_sub='sub-admin'")).rows[0]).toEqual(before);
      // the security section reads the new name (the cached lookup was dropped)
      expect((await env.app.inject({ url: '/api/account/security', cookies: again.cookies })).json().username).toBe('anna.neu');
    });

    it('is limited to 3 changes a day per account; a refusal by Authentik gives the slot back', async () => {
      const s = await env.login();
      await setReauthAtNow(s);
      w.fakes.base!.override = (c) => (c.method === 'PATCH' ? jsonResponse({ username: ['This field must be unique.'] }, 400) : undefined);
      expect((await put(s, 'race1')).json()).toEqual({ error: 'username_taken' });
      w.fakes.base!.override = (c) => {
        if (c.method !== 'PATCH') return undefined;
        ANNA.username = (c.body as { username: string }).username;
        return jsonResponse({ pk: ANNA.pk });
      };
      for (const n of ['n1', 'n2', 'n3']) expect((await put(s, n)).statusCode, n).toBe(200);
      const limited = await put(s, 'n4');
      expect([limited.statusCode, limited.json()]).toEqual([429, { error: 'rate_limited' }]);
    });

    it('is refused where the OIDC subject is the username (a rename would become another account)', async () => {
      const s = await env.login();
      await setReauthAtNow(s);
      w.fakes.base!.override = (c) => (c.path === '/api/v3/providers/oauth2/' ? jsonResponse({ results: [{ sub_mode: 'user_username', grant_types: [] }] }) : undefined);
      expect((await put(s, 'other')).json()).toEqual({ error: 'username_is_subject' });
      expect((await env.app.inject({ url: '/api/account/security', cookies: s.cookies })).json().usernameChange).toBe(false);
    });
  });

  it('delete a device of another user → 404; an unknown id or type → 404 / 400', async () => {
    const s = await env.login();
    await setReauthAtNow(s);
    const other = await del(s, 'totp/99'); // Ben's device
    expect([other.statusCode, other.json()]).toEqual([404, { error: 'device_not_found' }]);
    expect((await del(s, 'static/11')).statusCode).toBe(404); // right id, wrong type
    expect((await del(s, 'totp/12')).statusCode).toBe(404);
    expect((await del(s, 'sms/11')).statusCode).toBe(400);
    expect((await del(s, 'totp/abc')).statusCode).toBe(400);
    expect(w.deleted).toEqual([]);
  });

  /** drops the cached read of the login flow (authentik.ts akFlowStages), as its 10 minutes would */
  const forgetLoginFlow = () => env.ctx.kv.del(akFlowCacheKey(env.ctx.cfg, LOGIN));

  it('removing the last factor under mandatory MFA → 409 last_factor; with another factor, without mandatory MFA or when unknown it works', async () => {
    const s = await env.login();
    await setReauthAtNow(s);
    w.mfaMandatory = true;
    const last = await del(s, 'totp/11');
    expect([last.statusCode, last.json()]).toEqual([409, { error: 'last_factor' }]);
    expect(w.deleted).toEqual([]);
    // another factor remains
    w.devices.push({ pk: 31, type: WEBAUTHN_TYPE, name: 'Key', owner: ANNA.pk });
    expect((await del(s, 'totp/11')).statusCode).toBe(200);
    // an unconfirmed device does not count as a factor
    w.devices = [{ pk: 12, type: TOTP_TYPE, name: 'Only', owner: ANNA.pk }, { pk: 13, type: TOTP_TYPE, name: 'Half', owner: ANNA.pk, confirmed: false }];
    expect((await del(s, 'totp/12')).statusCode).toBe(409);
    // the login flow is read through the one flow reader and its 10-minute cache (P27): a change in Authentik shows after the cache
    w.mfaMandatory = false;
    expect((await del(s, 'totp/12')).statusCode).toBe(409);
    await forgetLoginFlow();
    // not mandatory, or the login flow cannot be read: the removal is allowed
    expect((await del(s, 'totp/12')).statusCode).toBe(200);
    w.devices = [{ pk: 14, type: TOTP_TYPE, name: 'Only', owner: ANNA.pk }];
    w.mfaMandatory = 'error';
    await forgetLoginFlow();
    expect((await del(s, 'totp/14')).statusCode).toBe(200);
  });

  it('the deny setting is read from the validate stage itself (the bindings never carry it): 409 last_factor; a refused stage read allows', async () => {
    const s = await env.login();
    await setReauthAtNow(s);
    await forgetLoginFlow();
    w.mfaMandatory = true;
    w.devices = [{ pk: 21, type: TOTP_TYPE, name: 'Only', owner: ANNA.pk }];
    const r = await del(s, 'totp/21');
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'last_factor' }]);
    expect(w.calls.some((c) => c.path === '/api/v3/stages/authenticator/validate/stage-validate/')).toBe(true);
    expect(w.deleted).toEqual([]);
    // without view_authenticatorvalidatestage (403) the setting is unknown: allowed, like an unreadable flow (P26)
    w.mfaMandatory = 'forbidden';
    await forgetLoginFlow();
    expect((await del(s, 'totp/21')).statusCode).toBe(200);
    expect(w.deleted).toEqual(['totp/21']);
  });

  it('GET /auth/flow/classic/webauthn-setup redirects to the browser-facing flow page for the signed-in owner only', async () => {
    const s = await env.login();
    const r = await env.app.inject({ url: '/auth/flow/classic/webauthn-setup', cookies: s.cookies });
    expect([r.statusCode, r.headers.location]).toEqual([302, `https://auth.example.com/if/flow/${WEBAUTHN_SETUP}/`]);
    env.ctx.cfg = { ...env.ctx.cfg, AUTHENTIK_WEBAUTHN_SETUP_FLOW: 'custom-passkeys' };
    expect((await env.app.inject({ url: '/auth/flow/classic/webauthn-setup', cookies: s.cookies })).headers.location).toBe('https://auth.example.com/if/flow/custom-passkeys/');
    expect((await env.app.inject({ url: '/auth/flow/classic/webauthn-setup' })).statusCode).toBe(401);
    env.ctx.cfg = { ...env.ctx.cfg, OIDC_ISSUER: 'https://idp.example.com/' };
    expect((await env.app.inject({ url: '/auth/flow/classic/webauthn-setup', cookies: s.cookies })).statusCode).toBe(409);
    env.ctx.cfg = { ...env.ctx.cfg, AUTHENTIK_WEBAUTHN_SETUP_FLOW: WEBAUTHN_SETUP };
  });

  it('no password, code or token appears in a log line', async () => {
    const s = await env.login();
    const b = browser(env, s);
    const step = (await b.reauth('setup-totp')).json() as { step: string };
    await b.post('answer', { step: step.step, stage: 'totp-setup', code: '987654' });
    const all = logs.join('\n');
    for (const secret of [RIGHT, '987654', 'FAKESECRET', 'authentik_session', 'api-token-placeholder']) expect(all).not.toContain(secret);
  });
});

