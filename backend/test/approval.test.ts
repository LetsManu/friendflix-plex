// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expiryTick } from '../src/expiry.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
const DAY = 86400e3;

beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login();
});
afterAll(() => env.close());
beforeEach(async () => {
  env.claims.current = ADMIN;
  await env.pool.query('delete from approval_requests');
  await env.pool.query('delete from notifications');
});

const adm = (method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: body as object });

/** One OIDC round trip without an invite for `sub` (not in the admin group unless `groups` says so). */
async function signIn(sub: string, groups: string[] = []) {
  env.claims.current = { sub, email: `${sub}@x.de`, name: `Person ${sub}`, groups };
  const l = await env.app.inject('/auth/login');
  const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
  const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } });
  env.claims.current = ADMIN;
  return cb;
}
const pendingCookie = (cb: Awaited<ReturnType<typeof signIn>>) => cb.cookies.find((x) => x.name === 'ff_pending');
const pendingState = (cookie: string) => env.app.inject({ url: '/api/pending', cookies: { ff_pending: cookie } }).then((r) => r.json());
const approvalNotices = async () => (await env.pool.query("select user_id, link, msg->'title'->'params' params from notifications where msg->'title'->>'key'='notify.approval.new'")).rows;

describe('approval queue', () => {
  it('login without invite creates one approval request and notifies admins once', async () => {
    const a = await signIn('pend1');
    expect(a.statusCode).toBe(302);
    expect(a.headers.location).toBe('/pending');
    expect(a.cookies.find((x) => x.name === 'ff_sid')).toBeUndefined(); // no session
    const c = pendingCookie(a)!;
    expect(c).toMatchObject({ httpOnly: true, path: '/', maxAge: 30 * 86400 });
    const b = await signIn('pend1');
    expect(b.headers.location).toBe('/pending');

    const rows = (await env.pool.query("select id, name, email, notified_at from approval_requests where authentik_sub='pend1'")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Person pend1', email: 'pend1@x.de' });
    expect(rows[0].notified_at).not.toBeNull();
    expect(c.value.startsWith(`${rows[0].id}.`)).toBe(true);
    const n = await approvalNotices();
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ link: '/admin/users?tab=approvals', params: { name: 'Person pend1' } });
    expect(await pendingState(c.value)).toEqual({ state: 'pending' });
    expect((await env.pool.query("select 1 from users where authentik_sub='pend1'")).rowCount).toBe(0);
  });

  it('approve provisions the account with role and access-until; /api/pending answers approved', async () => {
    const c = pendingCookie(await signIn('pend2'))!.value;
    const list = (await adm('GET', '/api/admin/approvals')).json().requests;
    const req = list.find((r: { email: string }) => r.email === 'pend2@x.de');
    expect(req).toMatchObject({ name: 'Person pend2' });
    const until = new Date(Date.now() + 10 * DAY).toISOString();
    expect((await adm('POST', `/api/admin/approvals/${req.id}/approve`, { role: 'owner' })).statusCode).toBe(400);
    const r = await adm('POST', `/api/admin/approvals/${req.id}/approve`, { role: 'family', accessUntil: until });
    expect(r.statusCode).toBe(200);

    const u = (await env.pool.query("select id, role, access_until, email from users where authentik_sub='pend2'")).rows[0];
    expect(u).toMatchObject({ role: 'family', email: 'pend2@x.de' });
    expect(u.access_until.toISOString()).toBe(until);
    expect((await env.pool.query('select 1 from approval_requests where id=$1', [req.id])).rowCount).toBe(0);
    const aud = (await env.pool.query("select meta from audit_log where action='user.approved' and target=$1", [u.id])).rows;
    expect(aud).toHaveLength(1);
    expect(aud[0].meta).toMatchObject({ from: 'pending', to: 'family', accessUntil: until });
    expect(JSON.parse((await env.kv.get(`pending_notice:${req.id}`))!)).toMatchObject({ email: 'pend2@x.de' });
    expect(await pendingState(c)).toEqual({ state: 'approved' });
    // a second approve finds nothing
    expect((await adm('POST', `/api/admin/approvals/${req.id}/approve`, { role: 'friend' })).statusCode).toBe(404);

    // the next login lands normally and drops the pending cookie
    const again = await signIn('pend2');
    expect(again.headers.location).toBe('/');
    expect(again.cookies.find((x) => x.name === 'ff_sid')).toBeDefined();
  });

  it('reject hides the request and /api/pending shows the message', async () => {
    const c = pendingCookie(await signIn('pend3'))!.value;
    const id = (await env.pool.query("select id from approval_requests where authentik_sub='pend3'")).rows[0].id;
    expect((await adm('POST', `/api/admin/approvals/${id}/reject`, { message: 'x'.repeat(301) })).statusCode).toBe(400);
    expect((await adm('POST', `/api/admin/approvals/${id}/reject`, { message: 'Sorry, only family.' })).statusCode).toBe(200);
    expect((await adm('GET', '/api/admin/approvals')).json().requests.map((r: { id: string }) => r.id)).not.toContain(id);
    expect((await adm('GET', '/api/admin/users?status=pending')).json().users.map((r: { id: string }) => r.id)).not.toContain(id);
    expect(await pendingState(c)).toEqual({ state: 'rejected', message: 'Sorry, only family.' });
    expect((await env.pool.query("select 1 from audit_log where action='user.rejected' and target=$1", [id])).rowCount).toBe(1);
    expect((await adm('POST', `/api/admin/approvals/${id}/reject`, {})).statusCode).toBe(404); // already rejected
    // a rejected request cannot be approved (only a new sign-in puts it back in the queue)
    const ap = await adm('POST', `/api/admin/approvals/${id}/approve`, { role: 'friend' });
    expect(ap.statusCode).toBe(409);
    expect(ap.json().error).toBe('rejected');
    expect((await env.pool.query("select 1 from users where authentik_sub='pend3'")).rowCount).toBe(0);
  });

  it('asking again after a rejection notifies the admins only when the rejection is older than 24 h', async () => {
    await signIn('pend4');
    const id = (await env.pool.query("select id from approval_requests where authentik_sub='pend4'")).rows[0].id;
    await adm('POST', `/api/admin/approvals/${id}/reject`, { message: 'no' });
    // fresh rejection: back in the queue, but no new notice
    await signIn('pend4');
    let row = (await env.pool.query('select rejected_at, reject_message from approval_requests where id=$1', [id])).rows[0];
    expect(row).toEqual({ rejected_at: null, reject_message: null });
    expect(await approvalNotices()).toHaveLength(1);
    // old rejection: the admins are told again
    await adm('POST', `/api/admin/approvals/${id}/reject`, {});
    await env.pool.query("update approval_requests set rejected_at = now() - interval '25 hours' where id=$1", [id]);
    await signIn('pend4');
    row = (await env.pool.query('select rejected_at from approval_requests where id=$1', [id])).rows[0];
    expect(row.rejected_at).toBeNull();
    expect(await approvalNotices()).toHaveLength(2);
  });

  it('a new request brings a dismissed approvals banner back; a repeat sign-in and other dismissals stay', async () => {
    await signIn('pend6');
    const adminId = (await env.pool.query("select id from users where authentik_sub=$1", [ADMIN.sub])).rows[0].id;
    await env.pool.query('delete from health_dismissals');
    await env.pool.query("insert into health_dismissals(user_id, issue_id, fp) values ($1, 'approvals:pending', 'aaaaaaaaaaaa'), ($1, 'svc:media', 'bbbbbbbbbbbb')", [adminId]);
    await signIn('pend6'); // same person again: no new request, no notice
    const ids = async () => (await env.pool.query('select issue_id from health_dismissals order by issue_id')).rows.map((r) => r.issue_id);
    expect(await ids()).toEqual(['approvals:pending', 'svc:media']);
    await signIn('pend7'); // a new request
    expect(await ids()).toEqual(['svc:media']);
  });

  it('/api/pending trusts only a signed cookie', async () => {
    const c = pendingCookie(await signIn('pend5'))!.value;
    const [id] = c.split('.');
    expect(await pendingState(`${id}.forged`)).toEqual({ state: 'none' });
    expect(await pendingState(id!)).toEqual({ state: 'none' });
    expect((await env.app.inject('/api/pending')).json()).toEqual({ state: 'none' });
  });

  it('the expiry tick deletes rejections older than 30 days', async () => {
    await signIn('old'); await signIn('recent');
    await env.pool.query("update approval_requests set rejected_at = now() - interval '31 days' where authentik_sub='old'");
    await env.pool.query("update approval_requests set rejected_at = now() - interval '29 days' where authentik_sub='recent'");
    await expiryTick(env.ctx);
    expect((await env.pool.query('select authentik_sub from approval_requests order by 1')).rows.map((r) => r.authentik_sub)).toEqual(['recent']);
  });

  it('admin-group members are still auto-created', async () => {
    const r = await signIn('newadmin', [env.ctx.cfg.ADMIN_GROUP]);
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/');
    expect((await env.pool.query("select role from users where authentik_sub='newadmin'")).rows[0].role).toBe('admin');
    expect((await env.pool.query("select 1 from approval_requests where authentik_sub='newadmin'")).rowCount).toBe(0);
  });
});
