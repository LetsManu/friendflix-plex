import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };
const h = () => ({ 'x-csrf-token': s.csrf });

beforeAll(async () => { env = await makeEnv(); s = await env.login(ADMIN); });
afterAll(() => env.close());

describe('auth fixes', () => {
  it('callback without the oidc cookie is rejected', async () => {
    await env.app.inject('/auth/login');
    const key = (await env.kv.keys('oidc:')).at(-1)!;
    const r = await env.app.inject(`/auth/callback?state=${key.slice(5)}&code=c`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalid_state');
    const bad = await env.app.inject({ url: `/auth/callback?state=${key.slice(5)}&code=c`, cookies: { ff_oidc: 'x' } });
    expect(bad.statusCode).toBe(400);
  });

  it('disabled user is rejected before admin promotion; role change keeps the account disabled', async () => {
    const D = { sub: 'sub-d', email: 'd@example.com', name: 'Dis', groups: ['friendflix-admins'] };
    await env.login(D);
    await env.pool.query("update users set role='friend', disabled=true where authentik_sub='sub-d'");
    env.claims.current = D;
    const l = await env.app.inject('/auth/login');
    const state = (await env.kv.keys('oidc:')).at(-1)!.slice(5);
    env.jfCalls.length = 0;
    const cb = await env.app.inject({ url: `/auth/callback?state=${state}&code=c`, cookies: { ff_oidc: l.cookies.find((x) => x.name === 'ff_oidc')!.value } });
    expect(cb.statusCode).toBe(403);
    expect(cb.json().error).toBe('disabled');
    expect(env.jfCalls.filter((c) => c.path.endsWith('/Policy'))).toHaveLength(0);
    expect((await env.pool.query("select role from users where authentik_sub='sub-d'")).rows[0].role).toBe('friend');

    const id = (await env.pool.query("select id from users where authentik_sub='sub-d'")).rows[0].id as string;
    const r = await env.app.inject({ method: 'PATCH', url: `/api/admin/users/${id}`, cookies: s.cookies, headers: h(), payload: { role: 'admin' } });
    expect(r.statusCode).toBe(200);
    const pol = env.jfCalls.filter((c) => c.path.endsWith('/Policy')).at(-1)!;
    expect(pol.body.IsDisabled).toBe(true);
  });

  it('unknown/prototype role is rejected', async () => {
    const u = (await env.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id as string;
    const other = await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-x','x@x','X','friend','jfx','x','x') returning id");
    for (const role of ['constructor', '__proto__', 'toString']) {
      const r = await env.app.inject({ method: 'PATCH', url: `/api/admin/users/${other.rows[0].id}`, cookies: s.cookies, headers: h(), payload: { role } });
      expect(r.statusCode).toBe(400);
    }
    void u;
  });

  it('approving a nonexistent device is 404 and not audited', async () => {
    const me = (await env.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id as string;
    const before = (await env.pool.query("select count(*) n from audit_log where action='device.approve'")).rows[0].n;
    const a = await env.app.inject({ method: 'POST', url: '/api/admin/devices/approve', cookies: s.cookies, headers: h(), payload: { userId: me, deviceId: 'nonexistent-device-1' } });
    expect(a.statusCode).toBe(404);
    const b = await env.app.inject({ method: 'POST', url: '/api/devices/nonexistent-device-1/approve', cookies: s.cookies, headers: h() });
    expect(b.statusCode).toBe(404);
    expect((await env.pool.query("select count(*) n from audit_log where action='device.approve'")).rows[0].n).toBe(before);
  });
});
