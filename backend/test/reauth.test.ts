// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../src/ctx.js';
import { REAUTH_MAX_AGE, recentlyAuthenticated, requireRecentAuth } from '../src/reauth.js';
import type { Session } from '../src/session.js';
import { makeEnv, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
afterEach(async () => { const e = env; env = undefined as unknown as TestEnv; await e?.close(); });

/** a route behind the guard, registered only for these tests */
const guarded = (app: FastifyInstance, ctx: Ctx) => {
  app.get('/api/test/recent', { preHandler: requireRecentAuth(ctx) }, async () => ({ ok: true }));
};
async function mk(): Promise<Sess> {
  env = await makeEnv({}, { register: [guarded] });
  return env.login();
}
const sessionOf = async (s: Sess) => JSON.parse((await env.kv.get(`sess:${s.cookies.ff_sid}`))!) as Session;
/** runs /auth/reauth and the IdP round trip back to /auth/callback with the session cookie */
async function reauth(s: Sess, next = '/me/account') {
  const r = await env.app.inject({ url: `/auth/reauth?next=${encodeURIComponent(next)}`, cookies: s.cookies });
  expect(r.statusCode).toBe(302);
  const st = r.cookies.find((x) => x.name === 'ff_oidc')!.value;
  return env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ...s.cookies, ff_oidc: st } });
}

describe('re-authentication guard', () => {
  it('recentlyAuthenticated is true at 600 s and false at 601 s', () => {
    const now = 1_800_000_000_000;
    const s = { userId: 'u', csrf: 'c', deviceApproved: true } as Session;
    expect(recentlyAuthenticated(s, 600, now)).toBe(false); // no stamp
    s.reauthAt = now - 600_000;
    expect(recentlyAuthenticated(s, 600, now)).toBe(true);
    s.reauthAt = now - 601_000;
    expect(recentlyAuthenticated(s, 600, now)).toBe(false);
    s.reauthAt = now + 31_000; // from the future (beyond clock skew)
    expect(recentlyAuthenticated(s, 600, now)).toBe(false);
    s.reauthAt = now + 20_000;
    expect(recentlyAuthenticated(s, 600, now)).toBe(true);
  });

  it('requireRecentAuth answers 401 reauth_required without a stamp', async () => {
    const s = await mk();
    const r = await env.app.inject({ url: '/api/test/recent', cookies: s.cookies });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'reauth_required' });
    // no session at all: the owner gate answers first
    expect((await env.app.inject({ url: '/api/test/recent' })).json()).toEqual({ error: 'unauthenticated' });
    // a fresh stamp passes
    const sess = await sessionOf(s);
    await env.kv.set(`sess:${s.cookies.ff_sid}`, JSON.stringify({ ...sess, reauthAt: Date.now() }), 300);
    const ok = await env.app.inject({ url: '/api/test/recent', cookies: s.cookies });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
  });

  it('/auth/reauth without a session answers 401', async () => {
    await mk();
    const r = await env.app.inject('/auth/reauth?next=/me/account');
    expect(r.statusCode).toBe(401);
    expect(r.cookies.find((x) => x.name === 'ff_oidc')).toBeUndefined();
    expect((await env.app.inject({ url: '/auth/reauth', cookies: { ff_sid: 'nope' } })).statusCode).toBe(401);
  });

  it('/auth/reauth starts a forced login', async () => {
    const s = await mk();
    const starts: Array<{ forceLogin?: boolean } | undefined> = [];
    const orig = env.ctx.oidc.start;
    env.ctx.oidc.start = (o) => { starts.push(o); return orig(o); };
    const r = await env.app.inject({ url: '/auth/reauth?next=/me/account?delete=1', cookies: s.cookies });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('https://idp/authorize');
    expect(starts.at(-1)).toEqual({ forceLogin: true });
    const st = r.cookies.find((x) => x.name === 'ff_oidc')!.value;
    const saved = JSON.parse((await env.kv.get(`oidc:${st}`))!);
    expect(saved.reauth).toEqual({ userId: (await sessionOf(s)).userId, next: '/me/account?delete=1' });
    expect(saved.resetPin).toBeUndefined();
  });

  it('callback stamps reauthAt on the existing session and redirects to next', async () => {
    const s = await mk();
    const seen: Array<{ maxAge?: number } | undefined> = [];
    const orig = env.ctx.oidc.finish;
    env.ctx.oidc.finish = (u, saved, o) => { seen.push(o); return orig(u, saved, o); };
    const before = (await env.kv.keys('sess:')).sort();
    const devices = (await env.pool.query('select count(*)::int n from devices')).rows[0].n;
    const cb = await reauth(s, '/me/account?delete=1');
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/me/account?delete=1');
    expect(seen.at(-1)).toEqual({ maxAge: REAUTH_MAX_AGE });
    expect(REAUTH_MAX_AGE).toBe(120);
    // same ff_sid, no new session, no new device, no cookie rewrite
    expect(cb.cookies.find((x) => x.name === 'ff_sid')).toBeUndefined();
    expect((await env.kv.keys('sess:')).sort()).toEqual(before);
    expect((await env.pool.query('select count(*)::int n from devices')).rows[0].n).toBe(devices);
    const sess = await sessionOf(s);
    expect(Date.now() - sess.reauthAt!).toBeLessThan(5000);
    expect((await env.pool.query("select 1 from audit_log where action='session.reauth'")).rowCount).toBe(1);
    expect((await env.pool.query("select 1 from audit_log where action='login'")).rowCount).toBe(1); // only the first login
    expect((await env.app.inject({ url: '/api/test/recent', cookies: s.cookies })).statusCode).toBe(200);
  });

  it('callback with a different sub does not stamp', async () => {
    const s = await mk();
    // the person signs in at the IdP as somebody else
    env.claims.current = { sub: 'sub-other', email: 'other@example.com', name: 'Other', groups: ['friendflix-admins'] };
    const users = (await env.pool.query('select count(*)::int n from users')).rows[0].n;
    const cb = await reauth(s);
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/me/account?reauth=failed');
    expect((await sessionOf(s)).reauthAt).toBeUndefined();
    expect(cb.cookies.find((x) => x.name === 'ff_sid')).toBeUndefined();
    expect((await env.pool.query('select count(*)::int n from users')).rows[0].n).toBe(users); // never provisions
    const a = await env.pool.query("select meta from audit_log where action='session.reauth_mismatch'");
    expect(a.rowCount).toBe(1);
    expect(JSON.stringify(a.rows[0].meta)).not.toContain('sub-other');
    expect((await env.pool.query("select 1 from audit_log where action='session.reauth'")).rowCount).toBe(0);
  });

  it('callback with another session cookie than the one that started it does not stamp', async () => {
    const s = await mk();
    const r = await env.app.inject({ url: '/auth/reauth', cookies: s.cookies });
    const st = r.cookies.find((x) => x.name === 'ff_oidc')!.value;
    const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } }); // no ff_sid
    expect(cb.headers.location).toBe('/me/account?reauth=failed');
    expect(cb.cookies.find((x) => x.name === 'ff_sid')).toBeUndefined();
    expect((await env.kv.keys('sess:')).length).toBe(1);
  });

  it('stale auth_time does not stamp', async () => {
    const s = await mk();
    for (const authTime of [Math.floor(Date.now() / 1000) - 3600, undefined]) {
      env.claims.current = { ...env.claims.current, authTime };
      const cb = await reauth(s);
      expect(cb.statusCode).toBe(302);
      expect(cb.headers.location).toBe('/me/account?reauth=failed');
      expect((await sessionOf(s)).reauthAt).toBeUndefined();
    }
    expect((await env.pool.query("select 1 from audit_log where action='session.reauth'")).rowCount).toBe(0);
  });

  it('next may be the Admin -> Settings resume path', async () => {
    const s = await mk();
    const r = await env.app.inject({ url: `/auth/reauth?next=${encodeURIComponent('/admin/settings?resume=1')}`, cookies: s.cookies });
    const st = r.cookies.find((x) => x.name === 'ff_oidc')!.value;
    expect(JSON.parse((await env.kv.get(`oidc:${st}`))!).reauth.next).toBe('/admin/settings?resume=1');
  });

  it('next may be Admin -> Data sources (replacing a key needs a recent sign-in)', async () => {
    const s = await mk();
    const r = await env.app.inject({ url: `/auth/reauth?next=${encodeURIComponent('/admin/sources')}`, cookies: s.cookies });
    const st = r.cookies.find((x) => x.name === 'ff_oidc')!.value;
    expect(JSON.parse((await env.kv.get(`oidc:${st}`))!).reauth.next).toBe('/admin/sources');
  });

  it('next=//evil.example falls back to /me/account', async () => {
    const s = await mk();
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', '/a b', `/${'x'.repeat(201)}`]) {
      const r = await env.app.inject({ url: `/auth/reauth?next=${encodeURIComponent(bad)}`, cookies: s.cookies });
      const st = r.cookies.find((x) => x.name === 'ff_oidc')!.value;
      expect(JSON.parse((await env.kv.get(`oidc:${st}`))!).reauth.next).toBe('/me/account');
    }
    expect((await reauth(s, '//evil.example')).headers.location).toBe('/me/account');
  });

  it('a repeated next key falls back to /me/account', async () => {
    const s = await mk();
    const r = await env.app.inject({ url: '/auth/reauth?next=/me/account?delete=1&next=/me/account', cookies: s.cookies });
    const st = r.cookies.find((x) => x.name === 'ff_oidc')!.value;
    expect(JSON.parse((await env.kv.get(`oidc:${st}`))!).reauth.next).toBe('/me/account');
  });
});
