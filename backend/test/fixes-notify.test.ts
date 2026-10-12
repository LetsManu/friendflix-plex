import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let a: { cookies: Record<string, string>; csrf: string };
let b: { cookies: Record<string, string>; csrf: string };

beforeAll(async () => {
  env = await makeEnv();
  a = await env.login();
  await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-b','b@example.com','Bea','friend','jfb','bea','x')");
  b = await env.login({ sub: 'sub-b', email: 'b@example.com', name: 'Bea', groups: [] });
});
afterAll(() => env.close());

const as = (u: typeof a, method: string, url: string) => env.app.inject({ method: method as 'GET', url, cookies: u.cookies, headers: { 'x-csrf-token': u.csrf } });
const hook = (payload: object) => env.app.inject({ method: 'POST', url: '/internal/webhook/seerr', headers: { 'x-webhook-secret': cfg.WEBHOOK_SECRET }, payload });

describe('broadcast notifications', () => {
  it('become read per user after POST /read', async () => {
    await env.pool.query("insert into notifications(user_id, kind, title, dedupe) values (null, 'available_all', 'Neu: X', 'bc-1')");
    const bc = async (u: typeof a) => (await as(u, 'GET', '/api/notifications')).json().notifications.find((n: any) => n.kind === 'available_all');
    expect((await bc(a)).read).toBe(false);
    expect((await bc(b)).read).toBe(false);
    await as(a, 'POST', '/api/notifications/read');
    expect((await bc(a)).read).toBe(true);
    expect((await bc(b)).read).toBe(false);
  });
});

describe('seerr webhook scoping', () => {
  it('declined only affects the request with that id, not other requesters of the same title', async () => {
    const ids = (await env.pool.query('select id, name from users')).rows;
    const ua = ids.find((u: any) => u.name === 'Admin').id;
    const ub = ids.find((u: any) => u.name === 'Bea').id;
    await env.pool.query("insert into seerr_requests(seerr_request_id, user_id, media_type, tmdb_id, title) values (101,$1,'movie',555,'Dunmoor'),(102,$2,'movie',555,'Dunmoor')", [ua, ub]);
    const r = await hook({ notification_type: 'MEDIA_DECLINED', subject: 'Dunmoor', media: { media_type: 'movie', tmdbId: '555' }, request: { request_id: '101' } });
    expect(r.statusCode).toBe(200);
    const n = (await env.pool.query("select user_id from notifications where kind='media_declined'")).rows;
    expect(n.map((x: any) => x.user_id)).toEqual([ua]);
  });
  it('available still notifies every requester of the title', async () => {
    await hook({ notification_type: 'MEDIA_AVAILABLE', subject: 'Dunmoor', media: { media_type: 'movie', tmdbId: '555' }, request: { request_id: '101' } });
    const n = (await env.pool.query("select user_id from notifications where kind='available'")).rows;
    expect(n).toHaveLength(2);
  });
});
