// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scheduleDeletion } from '../src/deletion.js';
import type { OidcClaims } from '../src/oidc.js';
import { provisionUser } from '../src/users.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let anna = '';
const DAY = 86400e3;
const ANNA: OidcClaims = { sub: 'sub-anna', email: 'anna@x.de', name: 'Anna', groups: [] };

/** One OIDC round trip as Anna, without a session cookie. */
async function signIn() {
  env.claims.current = ANNA;
  const l = await env.app.inject('/auth/login');
  const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
  const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } });
  env.claims.current = ADMIN;
  return cb;
}
const restoreCookie = (cb: Awaited<ReturnType<typeof signIn>>) => cb.cookies.find((x) => x.name === 'ff_restore');
const getRestore = (cookie?: string) => env.app.inject({ url: '/api/restore', cookies: cookie ? { ff_restore: cookie } : {} });
/** POST /api/restore is limited to 10 a minute per address: every call comes from a new one unless `ip` is given */
let ipSeq = 0;
const freshIp = () => `10.7.${(++ipSeq >> 8) & 255}.${ipSeq & 255}`;
const postRestore = (cookie?: string, ip = freshIp()) => env.app.inject({
  method: 'POST', url: '/api/restore', cookies: cookie ? { ff_restore: cookie } : {}, headers: { 'content-type': 'application/json' }, payload: '{}', remoteAddress: ip,
});
/** a correctly signed cookie with any expiry and deletion date (what an attacker cannot make without the key) */
const signed = (userId: string, exp: number, deletionAt: number) =>
  `${userId}.${exp}.${deletionAt}.${createHmac('sha256', env.ctx.encKey).update(`friendflix restore v1|${userId}|${exp}|${deletionAt}`).digest('base64url')}`;
const deletionMs = async () => (await row(anna)).deletion_at!.getTime();
const row = async (id: string) => (await env.pool.query<{ disabled: boolean; locked_reason: string | null; deletion_at: Date | null }>(
  'select disabled, locked_reason, deletion_at from users where id=$1', [id])).rows[0]!;

beforeAll(async () => {
  env = await makeEnv();
  await env.login(); // provisions the admin
  anna = (await provisionUser(env.ctx, ANNA, 'friend')).id;
});
afterAll(() => env.close());
beforeEach(async () => {
  env.claims.current = ADMIN;
  await env.pool.query('delete from account_deletions');
  await env.pool.query('update users set disabled=false, locked_reason=null, deletion_at=null, access_until=null where id=$1', [anna]);
  await scheduleDeletion(env.ctx, anna, anna);
});

describe('restore on sign-in', () => {
  it('signing in during the grace period redirects to /restore without a session', async () => {
    const cb = await signIn();
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/restore');
    expect(cb.cookies.find((x) => x.name === 'ff_sid')).toBeUndefined();
    const c = restoreCookie(cb)!;
    expect(c.httpOnly).toBe(true);
    expect(c.path).toBe('/');
    expect(c.maxAge).toBe(900);
    expect(String(c.sameSite).toLowerCase()).toBe('lax');
    const r = await getRestore(c.value);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toEqual({ state: 'scheduled', deletionAt: (await row(anna)).deletion_at!.toISOString() });
    expect(r.body).not.toContain('anna');
    expect(r.body).not.toContain('Anna');
    expect((await row(anna)).disabled).toBe(true); // signing in alone restores nothing
  });

  it('POST /api/restore unlocks and the next login creates a session', async () => {
    const c = restoreCookie(await signIn())!.value;
    const r = await postRestore(c);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(r.cookies.find((x) => x.name === 'ff_restore')!.value).toBe('');
    expect(r.cookies.find((x) => x.name === 'ff_sid')).toBeUndefined(); // no session minted by the restore
    expect(await row(anna)).toEqual({ disabled: false, locked_reason: null, deletion_at: null });
    const audits = await env.pool.query('select actor from audit_log where action=$1 and target=$2', ['user.deletion_restored', anna]);
    expect(audits.rows.at(-1)).toEqual({ actor: anna });
    expect((await getRestore(c)).json()).toEqual({ state: 'none' });
    expect((await postRestore(c)).statusCode).toBe(409); // not scheduled any more

    const s = await env.login(ANNA);
    expect(s.cookies.ff_sid).toBeTruthy();
    env.claims.current = ADMIN;
  });

  it('a restore of an account whose access ended keeps it locked as expired and says so', async () => {
    await env.pool.query("update users set access_until=now() - interval '1 day' where id=$1", [anna]);
    const c = restoreCookie(await signIn())!.value;
    const r = await postRestore(c);
    expect(r.json()).toEqual({ ok: true, accessEnded: true });
    expect(await row(anna)).toEqual({ disabled: true, locked_reason: 'expired', deletion_at: null });
    expect((await signIn()).statusCode).toBe(403);
  });

  it('forged or expired restore cookie answers state none / 401', async () => {
    const good = restoreCookie(await signIn())!.value;
    const [id, exp, at, mac] = good.split('.');
    expect(Number(at)).toBe(await deletionMs());
    const forged = [
      undefined,
      '',
      'garbage',
      `${id}.${exp}.${at}`,
      `${id}.${Number(exp) + 3600}.${at}.${mac}`, // a longer life with the old MAC
      `${id}.${exp}.${Number(at) + 1}.${mac}`, // another deletion date with the old MAC
      `${id}.${exp}.${at}.${mac}x`,
      `${id}.${exp}.${at}.${mac}.x`,
      signed(anna, Math.floor(Date.now() / 1000) - 1, await deletionMs()), // signed but expired
    ];
    for (const c of forged) {
      expect((await getRestore(c)).json(), String(c)).toEqual({ state: 'none' });
      expect((await postRestore(c)).statusCode, String(c)).toBe(401);
    }
    expect((await row(anna)).disabled).toBe(true);
    // a signed cookie still in its 15 minutes works
    expect((await getRestore(signed(anna, Math.floor(Date.now() / 1000) + 60, await deletionMs()))).json().state).toBe('scheduled');
  });

  it('form-encoded POST is refused', async () => {
    const c = restoreCookie(await signIn())!.value;
    for (const [type, payload] of [['application/x-www-form-urlencoded', 'a=1'], ['text/plain', '{}'], ['multipart/form-data; boundary=x', '--x--']]) {
      const r = await env.app.inject({ method: 'POST', url: '/api/restore', cookies: { ff_restore: c }, headers: { 'content-type': type }, payload, remoteAddress: freshIp() });
      expect(r.statusCode, type).toBe(415);
    }
    expect((await row(anna)).disabled).toBe(true);
  });

  it('the claim wins: POST answers 409 deletion_in_progress', async () => {
    const c = restoreCookie(await signIn())!.value;
    await env.pool.query("insert into account_deletions(user_id, pseudonym, authentik_sub) values ($1, 'deleted-x', 'sub-anna')", [anna]);
    const r = await postRestore(c);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'deletion_in_progress' });
    expect((await getRestore(c)).json()).toEqual({ state: 'none' });
    const cb = await signIn();
    expect(cb.statusCode).toBe(403);
    expect(cb.json()).toEqual({ error: 'account_deleted' }); // F15: the claim is checked before the restore redirect
  });

  it('after deletion_at the callback answers 403', async () => {
    await env.pool.query('update users set deletion_at=$2 where id=$1', [anna, new Date(Date.now() - DAY)]);
    const cb = await signIn();
    expect(cb.statusCode).toBe(403);
    expect(cb.json()).toEqual({ error: 'disabled' });
    expect(restoreCookie(cb)).toBeUndefined();
    // an issued cookie no longer restores either once the grace period is over
    const c = signed(anna, Math.floor(Date.now() / 1000) + 600, await deletionMs());
    expect((await getRestore(c)).json()).toEqual({ state: 'none' });
    expect((await postRestore(c)).statusCode).toBe(409);
  });

  it('a cookie only restores the deletion it was issued for', async () => {
    const old = restoreCookie(await signIn())!.value;
    // restored (elsewhere), then deleted again: the first cookie is still within its 15 minutes
    await postRestore(old);
    await scheduleDeletion(env.ctx, anna, anna, new Date(Date.now() + 1000));
    expect((await getRestore(old)).json()).toEqual({ state: 'none' });
    const r = await postRestore(old);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'not_scheduled' });
    expect((await row(anna)).locked_reason).toBe('deletion');
  });

  it('another account signed in in the same browser does not block the restore (no CSRF token needed)', async () => {
    const other = await env.login(ADMIN);
    const c = restoreCookie(await signIn())!.value;
    const r = await env.app.inject({
      method: 'POST', url: '/api/restore', cookies: { ...other.cookies, ff_restore: c }, headers: { 'content-type': 'application/json' }, payload: '{}', remoteAddress: freshIp(),
    });
    expect(r.statusCode).toBe(200);
    expect((await row(anna)).disabled).toBe(false);
    // the exemption is only for /api/restore: the other session still needs its token elsewhere
    const d = await env.app.inject({ method: 'POST', url: '/api/account/delete', cookies: other.cookies, payload: { confirm: false } });
    expect(d.statusCode).toBe(403);
    expect(d.json()).toEqual({ error: 'csrf' });
  });

  it('DELETE /api/restore ("keep the deletion") clears the cookie and changes nothing else', async () => {
    const c = restoreCookie(await signIn())!.value;
    const r = await env.app.inject({ method: 'DELETE', url: '/api/restore', cookies: { ff_restore: c }, remoteAddress: freshIp() });
    expect(r.statusCode).toBe(200);
    expect(r.cookies.find((x) => x.name === 'ff_restore')!.value).toBe('');
    expect((await row(anna)).locked_reason).toBe('deletion');
  });

  it('POST is rate limited to 10 a minute', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await postRestore('forged', '10.8.0.1')).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('other locks keep the 403', async () => {
    await env.pool.query("update users set locked_reason='manual', deletion_at=null where id=$1", [anna]);
    const cb = await signIn();
    expect(cb.statusCode).toBe(403);
    expect(restoreCookie(cb)).toBeUndefined();
  });
});
