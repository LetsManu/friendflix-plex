import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
type Sess = { cookies: Record<string, string>; csrf: string };
let admin: Sess, friend: Sess;
let fail = false;
let tmdb = 1000;
let rid = 100;
const imported = new Set<string>();

beforeAll(async () => {
  env = await makeEnv({}, {
    seerr: {
      'GET /api/v1/user': () => ({ json: { results: [...imported].map((j, i) => ({ id: 10 + i, jellyfinUserId: j })) } }),
      'POST /api/v1/user/import-from-jellyfin': (_u, _i, b) => { imported.add(b.jellyfinUserIds[0]); return { json: [{ id: 9 }] }; },
      'GET /api/v1/movie/\\d+': () => ({ json: { title: 'Dune', posterPath: '/dune.jpg' } }),
      'POST /api/v1/request': () => (fail ? { status: 500, json: {} } : { json: { id: ++rid, status: 1, media: { status: 2 } } }),
    },
  });
  admin = await env.login();
  const inv = await env.app.inject({ method: 'POST', url: '/api/admin/invites', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { role: 'friend', ttlHours: 1 } });
  const token = inv.json().link.split('/').pop();
  env.claims.current = { sub: 'sub-friend', email: 'f@example.com', name: 'Fred', groups: [] };
  const l = await env.app.inject(`/auth/login?invite=${token}`);
  const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
  const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } });
  const sid = cb.cookies.find((x) => x.name === 'ff_sid')!.value;
  friend = { cookies: { ff_sid: sid }, csrf: (await env.app.inject({ url: '/api/me', cookies: { ff_sid: sid } })).json().csrfToken };
});
afterAll(() => env.close());

const call = (s: Sess, method: string, url: string, body?: unknown) => env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
const wish = (s: Sess) => call(s, 'POST', '/api/requests', { mediaType: 'movie', tmdbId: ++tmdb });
const uid = async (name: string) => (await env.pool.query('select id from users where name=$1', [name])).rows[0].id as string;
const reset = () => env.pool.query('delete from seerr_requests; delete from request_reservations');

describe('monthly request limit', () => {
  it('friend default is 2, third wish gets 429', async () => {
    expect((await wish(friend)).statusCode).toBe(200);
    expect((await wish(friend)).statusCode).toBe(200);
    const r = await wish(friend);
    expect(r.statusCode).toBe(429);
    const b = r.json();
    expect(b).toMatchObject({ error: 'request_limit', limit: 2, used: 2 });
    const first = new Date(); first.setMonth(first.getMonth() + 1, 1); first.setHours(0, 0, 0, 0);
    expect(new Date(b.resetsAt).getTime()).toBe(first.getTime());
  });

  it('quota endpoint reports limit/used/remaining/resetsAt', async () => {
    const q = (await call(friend, 'GET', '/api/requests/quota')).json();
    expect(q).toMatchObject({ limit: 2, used: 2, remaining: 0 });
    expect(typeof q.resetsAt).toBe('string');
  });

  it('admin is unlimited', async () => {
    for (let i = 0; i < 4; i++) expect((await wish(admin)).statusCode).toBe(200);
    expect((await call(admin, 'GET', '/api/requests/quota')).json()).toMatchObject({ limit: null, remaining: null, used: 4 });
  });

  it('admin lists roles; PUT changes the limit and is enforced; audit written', async () => {
    const l = (await call(admin, 'GET', '/api/admin/roles')).json().limits;
    expect(l.find((x: any) => x.role === 'friend')).toMatchObject({ label: 'Freund', requestsPerMonth: 2, isDefault: true });
    expect(l.find((x: any) => x.role === 'admin')).toMatchObject({ requestsPerMonth: null, isDefault: true });
    expect((await call(admin, 'PUT', '/api/admin/roles/friend', { requestsPerMonth: 3 })).statusCode).toBe(200);
    expect((await call(admin, 'GET', '/api/admin/roles')).json().limits.find((x: any) => x.role === 'friend')).toMatchObject({ requestsPerMonth: 3, isDefault: false });
    expect((await wish(friend)).statusCode).toBe(200);
    expect((await wish(friend)).statusCode).toBe(429);
    expect((await env.pool.query("select 1 from audit_log where action='role.request_limit'")).rowCount).toBe(1);
  });

  it('PUT validation, unknown role and non-admin', async () => {
    expect((await call(friend, 'PUT', '/api/admin/roles/friend', { requestsPerMonth: 50 })).statusCode).toBe(403);
    expect((await call(admin, 'PUT', '/api/admin/roles/nope', { requestsPerMonth: 1 })).statusCode).toBe(404);
    expect((await call(admin, 'PUT', '/api/admin/roles/friend', { requestsPerMonth: 101 })).statusCode).toBe(400);
    expect((await call(admin, 'PUT', '/api/admin/roles/friend', { requestsPerMonth: null })).statusCode).toBe(200);
    expect((await wish(friend)).statusCode).toBe(200);
    await call(admin, 'PUT', '/api/admin/roles/friend', { requestsPerMonth: 2 });
  });

  it("last month's wishes and poll-sourced wishes do not count", async () => {
    await reset();
    const id = await uid('Fred');
    await env.pool.query("insert into seerr_requests(seerr_request_id,user_id,media_type,tmdb_id,title,created_at) values (9001,$1,'movie',1,'Old', date_trunc('month', now()) - interval '1 day')", [id]);
    await env.pool.query("insert into seerr_requests(seerr_request_id,user_id,media_type,tmdb_id,title,source) values (9002,$1,'movie',2,'Poll','poll')", [id]);
    expect((await call(friend, 'GET', '/api/requests/quota')).json()).toMatchObject({ used: 0, remaining: 2 });
    expect((await wish(friend)).statusCode).toBe(200);
    expect((await wish(friend)).statusCode).toBe(200);
    expect((await wish(friend)).statusCode).toBe(429);
  });

  it('a Seerr failure does not consume quota', async () => {
    await reset();
    fail = true;
    expect((await wish(friend)).statusCode).toBe(502);
    expect((await wish(friend)).statusCode).toBe(502);
    fail = false;
    expect((await env.pool.query('select count(*) n from request_reservations')).rows[0].n).toBe('0');
    expect((await call(friend, 'GET', '/api/requests/quota')).json()).toMatchObject({ used: 0, remaining: 2 });
    expect((await wish(friend)).statusCode).toBe(200);
  });

  it('two concurrent wishes with one slot left: exactly one succeeds', async () => {
    await reset();
    const id = await uid('Fred');
    await env.pool.query("insert into seerr_requests(seerr_request_id,user_id,media_type,tmdb_id,title) values (9100,$1,'movie',5,'One')", [id]);
    const rs = await Promise.all([wish(friend), wish(friend)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 429]);
  });
});
