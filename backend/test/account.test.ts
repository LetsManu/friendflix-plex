// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../src/session.js';
import { lockUser } from '../src/users.js';
import { fakeHttp, makeEnv, type Handler, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
afterEach(async () => { const e = env; env = undefined as unknown as TestEnv; await e?.close(); });

const TOKEN = 'ak-account-token-0123456789';
const ISSUER = 'https://login.example.com/application/o/friendflix/';
/** the logged-in test account (ADMIN claims) as Authentik knows it */
const AK = { pk: 5, username: 'admin', email: 'admin@example.com', uid: 'sub-admin' };

const call = (s: Sess, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
const sidOf = (r: { cookies: Array<{ name: string; value: string }> }, prev: Sess): Sess => ({ cookies: { ff_sid: r.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: prev.csrf });
const me = async () => (await env.pool.query<{ id: string; name: string; avatar: string | null }>("select id, name, avatar from users where authentik_sub='sub-admin'")).rows[0]!;
const owner = async (id: string) => (await env.pool.query<{ name: string; avatar: string }>('select name, avatar from profiles where id=$1', [id])).rows[0]!;
const audits = async (action: string) => (await env.pool.query<{ actor: string; target: string; meta: Record<string, unknown> }>(
  'select actor, target, meta from audit_log where action=$1 order by id', [action])).rows;

async function mk() {
  env = await makeEnv();
  return env.login();
}
/** turns the Authentik API on (fake answers); PATCHes are recorded */
function withAuthentik(patch: Handler = () => ({ json: AK })) {
  const patched: unknown[] = [];
  env.ctx.cfg = { ...env.ctx.cfg, OIDC_ISSUER: ISSUER, AUTHENTIK_URL: 'http://authentik-server:9000', AUTHENTIK_API_TOKEN: TOKEN };
  env.ctx.fetchImpl = fakeHttp({
    'GET /api/v3/core/users/': () => ({ json: { pagination: { next: 0 }, results: [AK] } }),
    'GET /api/v3/authenticators/admin/all/': () => ({ json: [{ type: 'authentik_stages_authenticator_totp.totpdevice', confirmed: true }] }),
    'PATCH /api/v3/core/users/5/': (u, i, b) => { patched.push(b); return patch(u, i, b); },
  });
  return patched;
}

describe('GET /api/account', () => {
  it('GET /api/account never contains authentik_sub, jellyfin_pw_enc or the API token', async () => {
    const s = await mk();
    withAuthentik();
    const r = await call(s, 'GET', '/api/account');
    expect(r.statusCode).toBe(200);
    const row = (await env.pool.query('select id, authentik_sub, jellyfin_pw_enc, jellyfin_user_id from users where authentik_sub=$1', ['sub-admin'])).rows[0];
    for (const secret of [row.authentik_sub, row.jellyfin_pw_enc, row.jellyfin_user_id, TOKEN, '"pk"']) expect(r.body).not.toContain(secret);
    expect(Object.keys(r.json()).sort()).toEqual(['avatar', 'email', 'emailChangePending', 'manageUrl', 'mfa', 'name', 'reauthUntil']);
  });

  it('mfa state and manageUrl from fake Authentik', async () => {
    const s = await mk();
    withAuthentik();
    const a = (await call(s, 'GET', '/api/account')).json();
    expect(a).toMatchObject({ name: 'Admin', email: 'admin@example.com', avatar: 'red', reauthUntil: null });
    expect(a.mfa).toEqual({ totp: true, webauthn: false, static: false });
    expect(a.manageUrl).toBe('https://login.example.com/if/user/#/settings');
  });

  it('mfa null without the API, manageUrl from issuer', async () => {
    const s = await mk();
    env.ctx.cfg = { ...env.ctx.cfg, OIDC_ISSUER: ISSUER };
    const a = (await call(s, 'GET', '/api/account')).json();
    expect(a.mfa).toBeNull();
    expect(a.manageUrl).toBe('https://login.example.com/if/user/#/settings');
    env.ctx.cfg = { ...env.ctx.cfg, OIDC_ISSUER: 'https://idp.example.com/realms/x' }; // not Authentik
    expect((await call(s, 'GET', '/api/account')).json().manageUrl).toBeNull();
  });

  it('Authentik down: mfa null, the page still loads', async () => {
    const s = await mk();
    withAuthentik();
    env.ctx.fetchImpl = (async () => { throw new Error('down'); }) as typeof fetch;
    const r = await call(s, 'GET', '/api/account');
    expect(r.statusCode).toBe(200);
    expect(r.json().mfa).toBeNull();
  });

  it('reauthUntil = reauthAt + 10 min while the stamp is valid', async () => {
    const s = await mk();
    const key = `sess:${s.cookies.ff_sid}`;
    const sess = JSON.parse((await env.kv.get(key))!) as Session;
    const at = Date.now() - 60_000;
    await env.kv.set(key, JSON.stringify({ ...sess, reauthAt: at }), 300);
    expect((await call(s, 'GET', '/api/account')).json().reauthUntil).toBe(at + 600_000);
    await env.kv.set(key, JSON.stringify({ ...sess, reauthAt: Date.now() - 601_000 }), 300);
    expect((await call(s, 'GET', '/api/account')).json().reauthUntil).toBeNull();
  });

  it('a non-owner profile gets 403 owner_required', async () => {
    const s = await mk();
    const p = (await call(s, 'POST', '/api/profiles', { name: 'Kind' })).json().profile as { id: string };
    const kid = sidOf(await call(s, 'POST', `/api/profiles/${p.id}/select`, {}), s);
    for (const [m, u, b] of [['GET', '/api/account'], ['PATCH', '/api/account/profile', { name: 'X' }]] as const) {
      const r = await call(kid, m, u, b);
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ error: 'owner_required' });
    }
  });
});

describe('PATCH /api/account/profile', () => {
  it('name change writes Authentik, users and the owner profile', async () => {
    const s = await mk();
    const patched = withAuthentik();
    const r = await call(s, 'PATCH', '/api/account/profile', { name: '  Anna-Maria Beispielhausen  ' });
    expect(r.statusCode).toBe(200);
    expect(patched).toEqual([{ name: 'Anna-Maria Beispielhausen' }]);
    const u = await me();
    expect(u.name).toBe('Anna-Maria Beispielhausen');
    expect((await owner(u.id)).name).toBe('Anna-Maria Beispielh'); // 20 chars, like provisioning
    expect(r.json()).toMatchObject({ name: 'Anna-Maria Beispielhausen', avatar: 'red' });
  });

  it('without the API the name change is local only (never 501)', async () => {
    const s = await mk();
    const r = await call(s, 'PATCH', '/api/account/profile', { name: 'Lokal' });
    expect(r.statusCode).toBe(200);
    const u = await me();
    expect([u.name, (await owner(u.id)).name]).toEqual(['Lokal', 'Lokal']);
  });

  it('Authentik 400 on name change leaves the local name', async () => {
    const s = await mk();
    withAuthentik(() => ({ status: 400, json: { name: ['too long'] } }));
    const r = await call(s, 'PATCH', '/api/account/profile', { name: 'Neu', avatar: 'blue' });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'invalid_input' });
    const u = await me();
    expect(u).toMatchObject({ name: 'Admin', avatar: null });
    expect(await owner(u.id)).toEqual({ name: 'Admin', avatar: 'red' });
    expect(await audits('account.profile')).toHaveLength(0);
  });

  it('a name taken by another profile of the account: 409 name_taken before Authentik is called', async () => {
    const s = await mk();
    expect((await call(s, 'POST', '/api/profiles', { name: 'Kind' })).statusCode).toBe(201);
    const patched = withAuthentik();
    const r = await call(s, 'PATCH', '/api/account/profile', { name: 'KIND' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'name_taken' });
    expect(patched).toHaveLength(0);
    expect((await me()).name).toBe('Admin');
  });

  it('avatar is mirrored to the owner profile', async () => {
    const s = await mk();
    const patched = withAuthentik();
    const r = await call(s, 'PATCH', '/api/account/profile', { avatar: 'teal' });
    expect(r.statusCode).toBe(200);
    expect(patched).toHaveLength(0); // avatar is FriendFlix-only
    const u = await me();
    expect(u.avatar).toBe('teal');
    expect((await owner(u.id)).avatar).toBe('teal');
    expect((await call(s, 'GET', '/api/account')).json().avatar).toBe('teal');
  });

  it('the avatar follows the owner profile after a later change in the profile editor', async () => {
    const s = await mk();
    expect((await call(s, 'PATCH', '/api/account/profile', { avatar: 'teal' })).statusCode).toBe(200);
    const u = await me();
    expect((await call(s, 'PATCH', `/api/profiles/${u.id}`, { avatar: 'blue' })).statusCode).toBe(200);
    expect((await call(s, 'GET', '/api/account')).json().avatar).toBe('blue');
  });

  it('rejects bad input', async () => {
    const s = await mk();
    for (const b of [{}, { name: '   ' }, { name: 'x'.repeat(61) }, { avatar: 'Bad Key' }, { email: 'a@b.c' }]) {
      expect((await call(s, 'PATCH', '/api/account/profile', b)).statusCode).toBe(400);
    }
  });

  it('control and bidi override characters in the name: 400; emoji with ZWJ is fine', async () => {
    const s = await mk();
    for (const name of ['Anna\nAdmin', 'Anna\u0007', 'Anna\u202Enimda', 'x\u2066y', 'tab\there']) {
      const r = await call(s, 'PATCH', '/api/account/profile', { name });
      expect(r.statusCode).toBe(400);
    }
    expect((await me()).name).toBe('Admin');
    const ok = await call(s, 'PATCH', '/api/account/profile', { name: 'Familie \u{1F468}\u200D\u{1F469}' });
    expect(ok.statusCode).toBe(200);
  });

  it('a locked user cannot rename', async () => {
    const s = await mk();
    const u = await me();
    await lockUser(env.ctx, null, u.id, 'manual');
    const r = await call(s, 'PATCH', '/api/account/profile', { name: 'Neu' });
    expect(r.statusCode).toBe(401);
    expect((await me()).name).toBe('Admin');
  });

  it('a lock landing during the Authentik call is not overwritten', async () => {
    const s = await mk();
    const u = await me();
    withAuthentik();
    const inner = env.ctx.fetchImpl;
    env.ctx.fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      // an admin locks the account while Authentik answers
      if (init.method === 'PATCH') await env.pool.query("update users set disabled=true, locked_reason='manual' where id=$1", [u.id]);
      return inner(input, init);
    }) as typeof fetch;
    const r = await call(s, 'PATCH', '/api/account/profile', { name: 'Neu', avatar: 'blue' });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'unauthenticated' });
    expect(await me()).toMatchObject({ name: 'Admin', avatar: null });
    expect(await owner(u.id)).toEqual({ name: 'Admin', avatar: 'red' });
    expect(await audits('account.profile')).toHaveLength(0);
  });

  it('audit meta of account.profile has fields only', async () => {
    const s = await mk();
    withAuthentik();
    expect((await call(s, 'PATCH', '/api/account/profile', { name: 'Neuer Name', avatar: 'blue' })).statusCode).toBe(200);
    const u = await me();
    const rows = await audits('account.profile');
    expect(rows).toEqual([{ actor: u.id, target: u.id, meta: { fields: ['name', 'avatar'] } }]);
    expect(JSON.stringify(rows)).not.toContain('Neuer Name');
  });
});
