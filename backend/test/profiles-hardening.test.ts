import { afterEach, describe, expect, it } from 'vitest';
import { ownerProfile } from '../src/profiles.js';
import { makeEnv, type Handler, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
afterEach(async () => { await env?.close(); });

const extraJf = (): Record<string, Handler> => ({
  'GET /UserItems/Resume': () => ({ json: { Items: [] } }),
  'DELETE /Users/[^/]+': () => ({ status: 204 }),
});
const call = (s: Sess, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf, ...headers }, payload: body as object });
const sidOf = (r: { cookies: Array<{ name: string; value: string }> }, prev: Sess): Sess => ({ cookies: { ff_sid: r.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: prev.csrf });
const ownerId = async () => (await env.pool.query<{ id: string }>("select id from users where authentik_sub='sub-admin'")).rows[0]!.id;
async function mk() {
  env = await makeEnv(extraJf());
  return env.login();
}
async function mkProfile(s: Sess, name: string, extra: Record<string, unknown> = {}) {
  const r = await call(s, 'POST', '/api/profiles', { name, ...extra });
  expect(r.statusCode).toBe(201);
  return r.json().profile as { id: string };
}
/** a second browser session of the same account */
const second = async (s: Sess): Promise<Sess> => {
  const r = await env.login();
  return { cookies: r.cookies, csrf: r.csrf || s.csrf };
};

describe('profile hardening', () => {
  it('requireAdmin needs the owner profile', async () => {
    const s = await mk();
    const p = await mkProfile(s, 'Kind');
    expect((await call(s, 'GET', '/api/admin/users')).statusCode).toBe(200);
    const kid = sidOf(await call(s, 'POST', `/api/profiles/${p.id}/select`, {}), s);
    const r = await call(kid, 'GET', '/api/admin/users');
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('forbidden');
  });

  it('x-ff-profile mismatch -> 409 profile_changed (not on /api/me, /api/profiles, logout); me.profileChosen', async () => {
    const s = await mk();
    const p = await mkProfile(s, 'Kind');
    const me = (await call(s, 'GET', '/api/me')).json();
    expect(me.profileChosen).toBe(false);
    expect((await call(s, 'GET', '/api/prefs', undefined, { 'x-ff-profile': me.id })).statusCode).toBe(200);
    const bad = await call(s, 'GET', '/api/prefs', undefined, { 'x-ff-profile': p.id });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error).toBe('profile_changed');
    expect((await call(s, 'GET', '/api/me', undefined, { 'x-ff-profile': p.id })).statusCode).toBe(200);
    expect((await call(s, 'GET', '/api/profiles', undefined, { 'x-ff-profile': p.id })).statusCode).toBe(200);
    const kid = sidOf(await call(s, 'POST', `/api/profiles/${p.id}/select`, {}), s);
    expect((await call(kid, 'GET', '/api/me')).json().profileChosen).toBe(true);
    expect((await call(kid, 'GET', '/api/prefs', undefined, { 'x-ff-profile': me.id })).json().error).toBe('profile_changed');
    expect((await call(kid, 'GET', '/api/prefs', undefined, { 'x-ff-profile': p.id })).statusCode).toBe(200);
    expect((await call(kid, 'POST', '/auth/logout', undefined, { 'x-ff-profile': me.id })).statusCode).toBe(200);
  });

  it('PIN lockout counts before verifying: 6th attempt is locked even with the right pin; per-account cap', async () => {
    const s = await mk();
    const p = await mkProfile(s, 'Kind', { pin: '4321' });
    const url = `/api/profiles/${p.id}/select`;
    expect((await call(s, 'POST', url, { pin: '4321' })).statusCode).toBe(200); // 1st attempt ok, resets the counter
    for (let i = 0; i < 4; i++) expect((await call(s, 'POST', url, { pin: '0000' })).statusCode).toBe(403);
    expect((await env.kv.get(`pinfail:${p.id}`))).toBe('4');
    expect((await call(s, 'POST', url, { pin: '4321' })).statusCode).toBe(200); // 5th attempt may still be right
    expect(await env.kv.get(`pinfail:${p.id}`)).toBeNull();
    await env.kv.set(`pinfail:${p.id}`, '5', 60);
    expect((await call(s, 'POST', url, { pin: '4321' })).statusCode).toBe(429); // not verified
    await env.kv.del(`pinfail:${p.id}`);
    await env.kv.set(`pinfail-acct:${await ownerId()}`, '15', 60);
    const r = await call(s, 'POST', url, { pin: '4321' });
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toBe('pin_locked');
  });

  it('setting, changing, removing a PIN and deleting a profile drop it from other sessions of the account', async () => {
    const a = await mk();
    const p = await mkProfile(a, 'Kind');
    const kid1 = sidOf(await call(a, 'POST', `/api/profiles/${p.id}/select`, {}), a);
    const b = await second(a);
    const kid2 = sidOf(await call(b, 'POST', `/api/profiles/${p.id}/select`, {}), b);
    // the actor itself is on the profile: its session keeps it, the other session loses it
    expect((await call(kid1, 'PUT', `/api/profiles/${p.id}/pin`, { pin: '1111' })).statusCode).toBe(200);
    expect((await call(kid1, 'GET', '/api/me')).json().profile.id).toBe(p.id);
    const m2 = (await call(kid2, 'GET', '/api/me')).json();
    expect(m2.profileChosen).toBe(false);
    expect(m2.profile.isOwner).toBe(true); // owner has no PIN -> fallback
    // owner (other profile) clears the PIN while kid1 sits on the profile
    const owner = sidOf(await call(kid1, 'POST', `/api/profiles/${await ownerId()}/select`, {}), a);
    const kid3 = sidOf(await call(b, 'POST', `/api/profiles/${p.id}/select`, { pin: '1111' }), b);
    expect((await call(owner, 'PUT', `/api/profiles/${p.id}/pin`, { pin: null })).statusCode).toBe(200);
    expect((await call(kid3, 'GET', '/api/me')).json().profileChosen).toBe(false);
    // owner with a PIN -> dropped sessions need the picker
    expect((await call(owner, 'PUT', `/api/profiles/${await ownerId()}/pin`, { pin: '2222' })).statusCode).toBe(200);
    expect((await call(owner, 'GET', '/api/prefs')).statusCode).toBe(200);
    const kid4 = sidOf(await call(b, 'POST', `/api/profiles/${p.id}/select`, {}), b);
    expect((await call(kid4, 'GET', '/api/prefs')).statusCode).toBe(200);
    expect((await call(owner, 'PUT', `/api/profiles/${p.id}/pin`, { pin: '3333' })).statusCode).toBe(200);
    const r = await call(kid4, 'GET', '/api/prefs');
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('profile_required');
    // delete
    const kid5 = sidOf(await call(b, 'POST', `/api/profiles/${p.id}/select`, { pin: '3333' }), b);
    expect((await call(kid5, 'GET', '/api/me')).json().profileChosen).toBe(true);
    expect((await call(owner, 'DELETE', `/api/profiles/${p.id}`)).statusCode).toBe(200);
    const sess = JSON.parse((await env.kv.get(`sess:${kid5.cookies.ff_sid}`))!);
    expect(sess.profileId).toBeUndefined();
  });

  it('owner profile heal: plain select, name collision fallback, never undefined', async () => {
    const s = await mk();
    const id = await ownerId();
    await call(s, 'GET', '/api/me');
    const same = await ownerProfile(env.ctx, { id, name: 'Whatever' });
    expect(same.id).toBe(id);
    expect(same.name).toBe('Admin'); // existing row untouched
    // missing owner row + another profile already named like the account
    const u = '99999999-9999-4999-8999-999999999999';
    await env.pool.query("insert into users(id,authentik_sub,name,role,jellyfin_user_id,jellyfin_username,jellyfin_pw_enc) values ($1,'x','Kai','member','jfx','jfx','e')", [u]);
    await env.pool.query("insert into profiles(id,user_id,name,jellyfin_user_id) values (gen_random_uuid(),$1,'kai','jfy')", [u]);
    const healed = await ownerProfile(env.ctx, { id: u, name: 'Kai' });
    expect(healed).toMatchObject({ id: u, is_owner: true });
    expect(healed.name).not.toBe('Kai');
    const blank = '88888888-8888-4888-8888-888888888888';
    await env.pool.query("insert into users(id,authentik_sub,name,role,jellyfin_user_id,jellyfin_username,jellyfin_pw_enc) values ($1,'z','','member','jfz','jfz','e')", [blank]);
    expect((await ownerProfile(env.ctx, { id: blank, name: '' })).name).toBe('Profil');
  });

  it('account-level writes need the owner profile: share flags are ignored, devices and revoke-others are 403', async () => {
    const s = await mk();
    const p = await mkProfile(s, 'Kind');
    const kid = sidOf(await call(s, 'POST', `/api/profiles/${p.id}/select`, {}), s);
    const r = await call(kid, 'POST', '/api/sessions/revoke-others');
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('owner_required');
    expect((await call(kid, 'POST', '/api/devices/' + 'd'.repeat(12) + '/approve')).statusCode).toBe(403);
    expect((await call(kid, 'DELETE', '/api/devices/' + 'd'.repeat(12))).statusCode).toBe(403);
    const owner = sidOf(await call(kid, 'POST', `/api/profiles/${await ownerId()}/select`, {}), s);
    expect((await call(owner, 'POST', '/api/sessions/revoke-others')).statusCode).toBe(200);
  });

  it('PATCH name uniqueness is case-insensitive', async () => {
    const s = await mk();
    await mkProfile(s, 'Kind');
    const p2 = await mkProfile(s, 'Oma');
    const r = await call(s, 'PATCH', `/api/profiles/${p2.id}`, { name: 'KIND' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('name_taken');
    expect((await call(s, 'PATCH', `/api/profiles/${p2.id}`, { name: 'OMA' })).statusCode).toBe(200); // own name, other case
  });

  it('forgotten owner PIN: /auth/login?resetPin=1 forces re-login and clears the owner PIN after the callback', async () => {
    const s = await mk();
    const oid = await ownerId();
    expect((await call(s, 'PUT', `/api/profiles/${oid}/pin`, { pin: '1234' })).statusCode).toBe(200);
    await env.kv.set(`pinfail:${oid}`, '5', 60);
    const starts: Array<{ forceLogin?: boolean } | undefined> = [];
    const orig = env.ctx.oidc.start;
    env.ctx.oidc.start = (o) => { starts.push(o); return orig(o); };
    // plain login keeps the PIN
    await env.login();
    expect((await env.pool.query('select pin_hash from profiles where id=$1', [oid])).rows[0].pin_hash).toBeTruthy();
    expect(starts.at(-1)?.forceLogin).toBeFalsy();
    const l = await env.app.inject('/auth/login?resetPin=1');
    expect(starts.at(-1)).toEqual({ forceLogin: true });
    const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
    expect(JSON.parse((await env.kv.get(`oidc:${st}`))!).resetPin).toBe(true);
    const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } });
    expect(cb.statusCode).toBe(302);
    expect((await env.pool.query('select pin_hash from profiles where id=$1', [oid])).rows[0].pin_hash).toBeNull();
    expect(await env.kv.get(`pinfail:${oid}`)).toBeNull();
    expect((await env.pool.query("select 1 from audit_log where action='profile.pin_reset'")).rowCount).toBe(1);
  });
});
