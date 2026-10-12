import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.js';

const A = 'a'.repeat(32);
let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
let lastItemsQuery = '';

beforeAll(async () => {
  env = await makeEnv({
    'GET /Genres': () => ({ json: { Items: [{ Name: 'Action' }, { Name: 'Komödie' }] } }),
    'GET /Items': (u) => { lastItemsQuery = u.search; return { json: { Items: u.search.includes('genres=Leer') ? [] : [{ Id: A, Name: 'Zufall', Type: 'Movie' }], TotalRecordCount: 1 } }; },
  });
  admin = await env.login();
});
afterAll(() => env.close());
const call = (method: string, url: string, cookies = admin.cookies, csrf = admin.csrf, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies, headers: { 'x-csrf-token': csrf }, payload: body as object });
const sessionKey = async (sid: string) => `sess:${sid}`;

describe('session lifetime', () => {
  it('slides the idle timeout (touch at most once a minute)', async () => {
    const key = await sessionKey(admin.cookies.ff_sid!);
    const before = JSON.parse((await env.kv.get(key))!);
    expect(before.createdAt).toBeGreaterThan(0);
    await call('GET', '/api/library/genres');
    expect(JSON.parse((await env.kv.get(key))!).touchedAt).toBe(before.touchedAt); // < 60 s: no write
    await env.kv.set(key, JSON.stringify({ ...before, touchedAt: Date.now() - 120_000 }), 300);
    await call('GET', '/api/library/genres');
    expect(JSON.parse((await env.kv.get(key))!).touchedAt).toBeGreaterThan(Date.now() - 5_000);
  });

  it('enforces the absolute lifetime even for active sessions', async () => {
    const s = await env.login();
    const key = await sessionKey(s.cookies.ff_sid!);
    const cur = JSON.parse((await env.kv.get(key))!);
    await env.kv.set(key, JSON.stringify({ ...cur, createdAt: Date.now() - 601_000 }), 300); // SESSION_TTL_SECONDS = 600
    expect((await call('GET', '/api/me', s.cookies, s.csrf)).statusCode).toBe(401);
    expect(await env.kv.get(key)).toBeNull();
    const authz = await env.app.inject({ method: 'POST', url: '/internal/authz', headers: { 'x-internal-secret': 'internal-secret-123456' }, payload: { sid: s.cookies.ff_sid } });
    expect(authz.statusCode).toBe(401);
  });
});

describe('revoking sessions', () => {
  it('"log out other devices" keeps the current session only', async () => {
    const other = await env.login();
    const third = await env.login();
    const r = await call('POST', '/api/sessions/revoke-others', third.cookies, third.csrf);
    expect(r.statusCode).toBe(200);
    expect(r.json().revoked).toBeGreaterThanOrEqual(2);
    expect((await call('GET', '/api/me', other.cookies, other.csrf)).statusCode).toBe(401);
    expect((await call('GET', '/api/me', third.cookies, third.csrf)).statusCode).toBe(200);
    admin = third;
  });

  it('admins can revoke all sessions of a user and it is audited', async () => {
    const id = (await env.pool.query('select id from users')).rows[0].id;
    const victim = await env.login();
    const r = await call('POST', `/api/admin/users/${id}/revoke-sessions`);
    expect(r.json().revoked).toBeGreaterThanOrEqual(1);
    expect((await call('GET', '/api/me', victim.cookies, victim.csrf)).statusCode).toBe(401);
    const log = (await env.pool.query("select 1 from audit_log where action='user.revoke_sessions'")).rowCount;
    expect(log).toBe(1);
    admin = await env.login();
  });
});

describe('surprise me', () => {
  it('lists genres and picks a random unwatched title with filters', async () => {
    expect((await call('GET', '/api/library/genres')).json().genres).toEqual(['Action', 'Komödie']);
    const r = await call('GET', '/api/library/random?type=Series&genre=Action');
    expect(r.json().item.name).toBe('Zufall');
    expect(lastItemsQuery).toContain('sortBy=Random');
    expect(lastItemsQuery).toContain('includeItemTypes=Series');
    expect(lastItemsQuery).toContain('genres=Action');
    expect(lastItemsQuery).toContain('filters=IsUnplayed');
    expect(lastItemsQuery).toContain('limit=1');
    await call('GET', '/api/library/random?unplayed=false');
    expect(lastItemsQuery).not.toContain('filters=');
  });
  it('404 when nothing matches, 400 on bad input', async () => {
    expect((await call('GET', '/api/library/random?genre=Leer')).statusCode).toBe(404);
    expect((await call('GET', '/api/library/random?type=Song')).statusCode).toBe(400);
  });
});

describe('title logos, intro segments and emoji-free icons', () => {
  it('maps the logo flag and exposes media segments (intro/outro/recap only), empty when unsupported', async () => {
    const e = await makeEnv({
      'GET /Items/[^/]+': () => ({ json: { Id: A, Name: 'X', Type: 'Movie', ImageTags: { Primary: 'p', Logo: 'l' }, BackdropImageTags: ['b'] } }),
      'GET /Users/[^/]+/Items/[^/]+': () => ({ json: { Id: A, Name: 'X', Type: 'Movie', ImageTags: { Primary: 'p', Logo: 'l' }, BackdropImageTags: ['b'] } }),
      'GET /MediaSegments/[^/]+': () => ({ json: { Items: [
        { Type: 'Intro', StartTicks: 10e7, EndTicks: 95e7 }, { Type: 'Commercial', StartTicks: 0, EndTicks: 5e7 },
        { Type: 'Outro', StartTicks: 3000e7, EndTicks: 3100e7 }, { Type: 'Recap', StartTicks: 5e7, EndTicks: 5e7 } ] } }),
    });
    const s = await e.login();
    const get = (u: string) => e.app.inject({ url: u, cookies: s.cookies });
    const it = (await get(`/api/items/${A}`)).json().item;
    expect(it).toMatchObject({ logo: true, backdrop: true, image: true });
    expect((await get(`/api/items/${A}/segments`)).json().segments).toEqual([
      { type: 'intro', start: 10, end: 95 }, { type: 'outro', start: 3000, end: 3100 },
    ]);
    await e.close();
    const e2 = await makeEnv({}); // no MediaSegments route -> 404 upstream
    const s2 = await e2.login();
    expect((await e2.app.inject({ url: `/api/items/${A}/segments`, cookies: s2.cookies })).json()).toEqual({ segments: [] });
    await e2.close();
  });
  it('achievements use icon names, not emoji', async () => {
    const { DEFS } = await import('../src/achievements.js');
    expect(DEFS.every((d) => /^[a-z-]+$/.test(d.icon))).toBe(true);
  });
});
