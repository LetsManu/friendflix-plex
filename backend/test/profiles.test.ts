// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { hashPin, verifyPin } from '../src/crypto.js';
import { MemoryKV } from '../src/kv.js';
import { reapplyPoliciesOnce, reapplyRole } from '../src/users.js';
import { cfg, makeEnv, type Handler, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
const ITEM = 'a'.repeat(32);
let env: TestEnv;
afterEach(async () => { await env?.close(); });

const extraJf = (): Record<string, Handler> => ({
  'GET /UserItems/Resume': () => ({ json: { Items: [] } }),
  'GET /Users/[^/]+/Items/Resume': () => ({ json: { Items: [] } }),
  'GET /Users/[^/]+/Items/[^/]+': () => ({ json: { Id: ITEM, Name: 'Film', Type: 'Movie', UserData: {} } }),
  'POST /Sessions/Playing': () => ({ status: 204 }),
  'POST /Sessions/Playing/Progress': () => ({ status: 204 }),
  'POST /Sessions/Playing/Stopped': () => ({ status: 204 }),
});
const call = (s: Sess, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
const sessOf = (r: { cookies: Array<{ name: string; value: string }> }, prev: Sess): Sess => ({ cookies: { ff_sid: r.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: prev.csrf });
const policies = () => env.jfCalls.filter((c) => c.method === 'POST' && /\/Policy$/.test(c.path));
const ownerId = async () => (await env.pool.query<{ id: string }>("select id from users where authentik_sub='sub-admin'")).rows[0]!.id;
async function mk(extra: Record<string, Handler> = {}) {
  env = await makeEnv({ ...extraJf(), ...extra });
  return env.login();
}
async function mkProfile(s: Sess, name: string, extra: Record<string, unknown> = {}) {
  const r = await call(s, 'POST', '/api/profiles', { name, ...extra });
  expect(r.statusCode).toBe(201);
  return r.json().profile as { id: string; name: string };
}
/** second (invited) account of a role, logged in on the same fake IdP */
async function invitedLogin(admin: Sess, role: string, sub: string): Promise<Sess> {
  const inv = await call(admin, 'POST', '/api/admin/invites', { role, ttlHours: 1 });
  const token = inv.json().link.split('/').pop();
  env.claims.current = { sub, email: `${sub}@example.com`, name: sub, groups: [] };
  const l = await env.app.inject(`/auth/login?invite=${token}`);
  const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
  const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } });
  const sid = cb.cookies.find((x) => x.name === 'ff_sid')!.value;
  return { cookies: { ff_sid: sid }, csrf: (await env.app.inject({ url: '/api/me', cookies: { ff_sid: sid } })).json().csrfToken };
}

describe('profiles', () => {
  it('pin hashing is salted and verifies', () => {
    const h = hashPin('1234');
    expect(h).toMatch(/^scrypt\$/);
    expect(h).not.toBe(hashPin('1234'));
    expect(verifyPin('1234', h)).toBe(true);
    expect(verifyPin('1235', h)).toBe(false);
    expect(verifyPin('1234', null)).toBe(false);
  });

  it('kv.incr counts and keeps the first ttl', async () => {
    const kv = new MemoryKV();
    expect(await kv.incr('k', 60)).toBe(1);
    expect(await kv.incr('k', 60)).toBe(2);
    await kv.del('k');
    expect(await kv.incr('k', 60)).toBe(1);
  });

  it('every account has its owner profile (id == user id) and /api/me reports it', async () => {
    const s = await mk();
    const me = (await call(s, 'GET', '/api/me')).json();
    expect(me.profile).toMatchObject({ id: me.id, isOwner: true });
    expect(me).toMatchObject({ profileRequired: false, profileCount: 1 });
    const list = (await call(s, 'GET', '/api/profiles')).json();
    expect(list).toMatchObject({ max: 5, activeId: me.id });
    expect(list.profiles).toEqual([expect.objectContaining({ id: me.id, isOwner: true, hasPin: false, active: true })]);
  });

  it('creates a hidden Jellyfin user with the role policy, max 5 profiles', async () => {
    const s = await mk();
    const p = await mkProfile(s, 'Kind', { avatar: 'blue' });
    const created = env.jfCalls.filter((c) => c.method === 'POST' && c.path === '/Users/New');
    expect(created).toHaveLength(2); // account + profile
    expect(created[1]!.body.Name).toMatch(/^Admin-Kind/);
    const row = (await env.pool.query('select * from profiles where id=$1', [p.id])).rows[0];
    expect(row).toMatchObject({ is_owner: false, avatar: 'blue', name: 'Kind' });
    expect(row.jellyfin_pw_enc).toBeTruthy();
    expect(policies().find((c) => c.path === `/Users/${row.jellyfin_user_id}/Policy`)!.body).toMatchObject({ IsHidden: true, IsDisabled: false, Keep: 'me' });
    for (const n of ['B', 'C', 'D']) await mkProfile(s, n);
    expect((await call(s, 'POST', '/api/profiles', { name: 'Sechs' })).statusCode).toBe(409);
    expect((await call(s, 'POST', '/api/profiles', { name: 'Sechs' })).json().error).toBe('max_profiles');
    expect((await env.pool.query('select count(*) n from profiles')).rows[0].n).toBe('5');
  });

  it('rejects duplicate names and non-owner creation', async () => {
    const s = await mk();
    const p = await mkProfile(s, 'Kind');
    expect((await call(s, 'POST', '/api/profiles', { name: 'kind' })).json().error).toBe('name_taken');
    const sel = await call(s, 'POST', `/api/profiles/${p.id}/select`, {});
    const kid = sessOf(sel, s);
    expect((await call(kid, 'POST', '/api/profiles', { name: 'Neu' })).statusCode).toBe(403);
    expect((await call(kid, 'DELETE', `/api/profiles/${p.id}`)).statusCode).toBe(403);
  });

  it('rolls back the Jellyfin user when the insert fails', async () => {
    const s = await mk();
    await env.pool.query(`create function boom() returns trigger language plpgsql as $$ begin if new.name = 'Boom' then raise exception 'boom'; end if; return new; end $$;
      create trigger profiles_boom before insert on profiles for each row execute function boom();`);
    const r = await call(s, 'POST', '/api/profiles', { name: 'Boom' });
    expect(r.statusCode).toBe(500);
    const created = env.jfCalls.filter((c) => c.method === 'POST' && c.path === '/Users/New');
    expect(created).toHaveLength(2);
    expect(created[1]!.body.Name).toMatch(/Boom/);
    const del = env.jfCalls.filter((c) => c.method === 'DELETE' && c.path.startsWith('/Users/'));
    expect(del).toHaveLength(1);
    expect((await env.pool.query("select 1 from profiles where name='Boom'")).rowCount).toBe(0);
  });

  it('select without PIN rotates the session id; the old sid acts as the new profile for ~15 s, then expires', async () => {
    const s = await mk();
    const p = await mkProfile(s, 'Kind');
    const sel = await call(s, 'POST', `/api/profiles/${p.id}/select`, {});
    expect(sel.statusCode).toBe(200);
    const n = sessOf(sel, s);
    expect(n.cookies.ff_sid).not.toBe(s.cookies.ff_sid);
    const old = (await call(s, 'GET', '/api/me')).json(); // in-flight request with the old sid: no 401, already the new profile
    expect(old.profile).toMatchObject({ id: p.id, name: 'Kind' });
    expect(old.profileChosen).toBe(true);
    const realNow = Date.now;
    Date.now = () => realNow() + 16_000;
    try {
      expect((await call(s, 'GET', '/api/me')).statusCode).toBe(401);
      expect((await call(n, 'GET', '/api/me')).statusCode).toBe(200);
    } finally { Date.now = realNow; }
    const me = (await call(n, 'GET', '/api/me')).json();
    expect(me.profile).toMatchObject({ id: p.id, isOwner: false, name: 'Kind' });
    expect(me.csrfToken).toBe(s.csrf);
    expect(me.profileCount).toBe(2);
  });

  it('PIN: required, wrong -> 403, 5th wrong -> 429 and locked, right -> 200', async () => {
    const s = await mk();
    const p = await mkProfile(s, 'Kind', { pin: '4321' });
    expect((await call(s, 'GET', '/api/profiles')).json().profiles.find((x: { id: string }) => x.id === p.id).hasPin).toBe(true);
    const url = `/api/profiles/${p.id}/select`;
    expect((await call(s, 'POST', url, {})).json().error).toBe('pin_required');
    for (let i = 0; i < 4; i++) {
      const r = await call(s, 'POST', url, { pin: '0000' });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('pin_wrong');
    }
    const fifth = await call(s, 'POST', url, { pin: '0000' });
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json().error).toBe('pin_locked');
    expect((await call(s, 'POST', url, { pin: '4321' })).statusCode).toBe(429); // locked even for the right pin
    await env.kv.del(`pinfail:${p.id}`);
    const ok = await call(s, 'POST', url, { pin: '4321' });
    expect(ok.statusCode).toBe(200);
    expect(ok.cookies.find((c) => c.name === 'ff_sid')).toBeTruthy();
  });

  it('PIN change needs the current pin on the own profile; owner may reset another profile', async () => {
    const s = await mk();
    const p = await mkProfile(s, 'Kind', { pin: '1111' });
    expect((await call(s, 'PUT', `/api/profiles/${p.id}/pin`, { pin: null })).statusCode).toBe(200); // owner manages
    expect((await call(s, 'GET', '/api/profiles')).json().profiles.find((x: { id: string }) => x.id === p.id).hasPin).toBe(false);
    const kid = sessOf(await call(s, 'POST', `/api/profiles/${p.id}/select`, {}), s);
    expect((await call(kid, 'PUT', `/api/profiles/${p.id}/pin`, { pin: '2222' })).statusCode).toBe(200);
    expect((await call(kid, 'PUT', `/api/profiles/${p.id}/pin`, { pin: null })).statusCode).toBe(403);
    expect((await call(kid, 'PUT', `/api/profiles/${p.id}/pin`, { pin: null, currentPin: '2222' })).statusCode).toBe(200);
    expect((await call(kid, 'PUT', `/api/profiles/${p.id}/pin`, { pin: 'abcd' })).statusCode).toBe(400);
  });

  it('after select, Jellyfin calls and /internal/authz use the profile identity', async () => {
    const s = await mk();
    const p = await mkProfile(s, 'Kind');
    const jfName = (await env.pool.query<{ jellyfin_username: string }>('select jellyfin_username from profiles where id=$1', [p.id])).rows[0]!.jellyfin_username;
    const owner = s;
    // owner first: the gateway memoises its token for the old sid
    const authz = (sid: string) => env.app.inject({ method: 'POST', url: '/internal/authz', headers: { 'x-internal-secret': cfg.INTERNAL_SECRET }, payload: { sid } });
    const before = await authz(owner.cookies.ff_sid!);
    expect(before.json().token).toBe('tok-Admin');
    const n = sessOf(await call(s, 'POST', `/api/profiles/${p.id}/select`, {}), s);
    expect((await authz(owner.cookies.ff_sid!)).json().token).toBe(`tok-${jfName}`); // old sid: memo forgotten, now acts as the new profile (grace period)
    const after = (await authz(n.cookies.ff_sid!)).json();
    expect(after.token).toBe(`tok-${jfName}`);
    expect(after.deviceId).toBe(`ff-${p.id}`);
    expect(after.userId).toBe(await ownerId());
    env.jfCalls.length = 0;
    expect((await call(n, 'GET', '/api/library/resume')).statusCode).toBe(200);
    const resume = env.jfCalls.find((c) => /Resume$/.test(c.path))!;
    expect(resume.auth).toContain(`Token="tok-${jfName}"`);
    expect(resume.auth).toContain(`DeviceId="ff-${p.id}"`);
    // back on the owner profile
    env.jfCalls.length = 0;
    const o = sessOf(await call(n, 'POST', `/api/profiles/${await ownerId()}/select`, {}), s);
    await call(o, 'GET', '/api/library/resume');
    expect(env.jfCalls.find((c) => /Resume$/.test(c.path))!.auth).toContain('Token="tok-Admin"');
  });

  it('watchlist is per profile', async () => {
    const s = await mk();
    const p = await mkProfile(s, 'Kind');
    const uid = await ownerId();
    await env.pool.query("insert into watchlist(user_id,profile_id,item_id) values ($1,$1,'x1')", [uid]);
    const kid = sessOf(await call(s, 'POST', `/api/profiles/${p.id}/select`, {}), s);
    const rows = (await env.pool.query('select profile_id from watchlist')).rows;
    expect(rows).toEqual([{ profile_id: uid }]);
    expect((await call(kid, 'GET', '/api/me')).json().profile.id).toBe(p.id);
  });

  it('old sessions without profileId use the owner profile; with an owner PIN they get 409 profile_required', async () => {
    const s = await mk();
    const uid = await ownerId();
    expect((await call(s, 'GET', '/api/library/views')).statusCode).not.toBe(409);
    await call(s, 'PUT', `/api/profiles/${uid}/pin`, { pin: '9999' });
    const r = await call(s, 'GET', '/api/library/views');
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'profile_required' });
    const me = (await call(s, 'GET', '/api/me')).json();
    expect(me).toMatchObject({ profile: null, profileRequired: true, profileCount: 1 });
    expect((await call(s, 'GET', '/api/profiles')).json()).toMatchObject({ activeId: null });
    expect((await call(s, 'GET', '/api/devices')).statusCode).toBe(200);
    expect((await call(s, 'GET', '/api/notifications')).statusCode).toBe(200);
    expect((await env.app.inject({ method: 'POST', url: '/internal/authz', headers: { 'x-internal-secret': cfg.INTERNAL_SECRET }, payload: { sid: s.cookies.ff_sid! } })).statusCode).toBe(401);
    expect((await call(s, 'POST', `/api/profiles/${uid}/select`, { pin: '9999' })).statusCode).toBe(200);
  });

  it('admin disable and role change reach every profile Jellyfin user', async () => {
    const admin = await mk();
    const guest = await invitedLogin(admin, 'guest', 'sub-gina');
    const p = await mkProfile(guest, 'Kind');
    const g = (await env.pool.query<{ id: string; jellyfin_user_id: string }>("select id, jellyfin_user_id from users where authentik_sub='sub-gina'")).rows[0]!;
    const kidJf = (await env.pool.query<{ jellyfin_user_id: string }>('select jellyfin_user_id from profiles where id=$1', [p.id])).rows[0]!.jellyfin_user_id;
    env.jfCalls.length = 0;
    expect((await call(admin, 'PATCH', `/api/admin/users/${g.id}`, { role: 'friend' })).statusCode).toBe(200);
    const byRole = policies().map((c) => c.path);
    expect(byRole).toContain(`/Users/${g.jellyfin_user_id}/Policy`);
    expect(byRole).toContain(`/Users/${kidJf}/Policy`);
    expect(policies().find((c) => c.path === `/Users/${kidJf}/Policy`)!.body).toMatchObject({ IsHidden: true, MaxActiveSessions: 2 });
    env.jfCalls.length = 0;
    expect((await call(admin, 'PATCH', `/api/admin/users/${g.id}`, { disabled: true })).statusCode).toBe(200);
    for (const jid of [g.jellyfin_user_id, kidJf]) expect(policies().find((c) => c.path === `/Users/${jid}/Policy`)!.body.IsDisabled).toBe(true);
  });

  it('reapplyRole covers profile Jellyfin users', async () => {
    const s = await mk();
    const p = await mkProfile(s, 'Kind');
    const kidJf = (await env.pool.query<{ jellyfin_user_id: string }>('select jellyfin_user_id from profiles where id=$1', [p.id])).rows[0]!.jellyfin_user_id;
    env.jfCalls.length = 0;
    expect(await reapplyRole(env.ctx, 'admin')).toBe(0);
    const hit = policies().find((c) => c.path === `/Users/${kidJf}/Policy`);
    expect(hit!.body).toMatchObject({ IsHidden: true, IsDisabled: false });
    expect(policies()).toHaveLength(2);
  });

  it('reapplyPoliciesOnce runs once per flag; a failed Jellyfin call clears the flag so the next start retries', async () => {
    await mk();
    const flag = async (k: string) => (await env.pool.query('select 1 from app_flags where key=$1', [k])).rowCount;
    env.jfCalls.length = 0;
    await reapplyPoliciesOnce(env.ctx, 'test_once');
    const n = policies().length;
    expect(n).toBeGreaterThan(0);
    await reapplyPoliciesOnce(env.ctx, 'test_once'); // flag set: nothing pushed again
    expect(policies()).toHaveLength(n);
    expect(await flag('test_once')).toBe(1);

    const apply = env.ctx.jf.admin.applyPolicy;
    env.ctx.jf.admin.applyPolicy = async () => { throw new Error('jellyfin down'); };
    await reapplyPoliciesOnce(env.ctx, 'test_retry');
    expect(await flag('test_retry')).toBe(0);
    env.ctx.jf.admin.applyPolicy = apply;
    env.jfCalls.length = 0;
    await reapplyPoliciesOnce(env.ctx, 'test_retry');
    expect(policies()).toHaveLength(n);
    expect(await flag('test_retry')).toBe(1);
  });

  it('delete removes the Jellyfin user, the row and per-profile data; owner cannot be deleted', async () => {
    const s = await mk();
    const p = await mkProfile(s, 'Kind');
    const uid = await ownerId();
    const kidJf = (await env.pool.query<{ jellyfin_user_id: string }>('select jellyfin_user_id from profiles where id=$1', [p.id])).rows[0]!.jellyfin_user_id;
    await env.pool.query("insert into watchlist(user_id,profile_id,item_id) values ($1,$2,'x1')", [uid, p.id]);
    await env.pool.query("insert into profile_prefs(profile_id,data) values ($1,'{}')", [p.id]);
    expect((await call(s, 'DELETE', `/api/profiles/${uid}`)).statusCode).toBe(400);
    expect((await call(s, 'DELETE', `/api/profiles/${p.id}`)).statusCode).toBe(200);
    expect(env.jfCalls.some((c) => c.method === 'DELETE' && c.path === `/Users/${kidJf}`)).toBe(true);
    expect((await env.pool.query('select 1 from profiles where id=$1', [p.id])).rowCount).toBe(0);
    expect((await env.pool.query('select 1 from watchlist where profile_id=$1', [p.id])).rowCount).toBe(0);
    expect((await env.pool.query('select 1 from profile_prefs where profile_id=$1', [p.id])).rowCount).toBe(0);
  });

  it('delete answers 502 and keeps the profile when Jellyfin refuses', async () => {
    const s = await mk({ 'DELETE /Users/[^/]+': () => ({ status: 500 }) });
    const p = await mkProfile(s, 'Kind');
    const r = await call(s, 'DELETE', `/api/profiles/${p.id}`);
    expect(r.statusCode).toBe(502);
    expect((await env.pool.query('select 1 from profiles where id=$1', [p.id])).rowCount).toBe(1);
  });

  it('prefs: viewing prefs are per profile, share flags per account', async () => {
    const s = await mk();
    const p = await mkProfile(s, 'Kind');
    const base = (await call(s, 'GET', '/api/prefs')).json().prefs;
    expect((await call(s, 'PUT', '/api/prefs', { ...base, quality: 5_000_000, shareHistory: true })).statusCode).toBe(200);
    const kid = sessOf(await call(s, 'POST', `/api/profiles/${p.id}/select`, {}), s);
    const kp = (await call(kid, 'GET', '/api/prefs')).json().prefs;
    expect(kp.quality).toBe(0); // own, default
    expect(kp.shareHistory).toBe(true); // account flag
    await call(kid, 'PUT', '/api/prefs', { ...kp, quality: 1_000_000, shareHistory: false });
    const o = sessOf(await call(kid, 'POST', `/api/profiles/${await ownerId()}/select`, {}), s);
    const op = (await call(o, 'GET', '/api/prefs')).json().prefs;
    expect(op.quality).toBe(5_000_000);
    expect(op.shareHistory).toBe(true); // a non-owner profile cannot change account-level flags
    expect((await call(o, 'PUT', '/api/prefs', { ...op, shareHistory: false })).statusCode).toBe(200);
    expect((await call(o, 'GET', '/api/prefs')).json().prefs.shareHistory).toBe(false);
  });

  it('stream limit counts per account, not per profile', async () => {
    const admin = await mk();
    const guest = await invitedLogin(admin, 'guest', 'sub-gina'); // maxStreams 1
    const p = await mkProfile(guest, 'Kind');
    const body = (ps: string) => ({ itemId: ITEM, playSessionId: ps, mediaSourceId: 'ms1', positionTicks: 0 });
    expect((await call(guest, 'POST', '/api/playback/start', body('ps-aaaaaaaa'))).statusCode).toBe(200);
    const kid = sessOf(await call(guest, 'POST', `/api/profiles/${p.id}/select`, {}), guest);
    const r = await call(kid, 'POST', '/api/playback/start', body('ps-bbbbbbbb'));
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toBe('max_streams');
  });
});
