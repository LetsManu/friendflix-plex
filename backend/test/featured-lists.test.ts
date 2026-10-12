import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { makeEnv, type TestEnv } from './helpers.js';

const A = 'a'.repeat(32), B = 'b'.repeat(32), H = 'c'.repeat(32);
const CATALOG: Record<string, Record<string, unknown>> = {
  [A]: { Id: A, Name: 'Ashfall', Type: 'Movie' },
  [B]: { Id: B, Name: 'Brasswind', Type: 'Movie' },
  [H]: { Id: H, Name: 'Hidden', Type: 'Movie' },
};
let env: TestEnv;
type Sess = { cookies: Record<string, string>; csrf: string };
let admin: Sess, bea: Sess;
const hiddenFor = new Set<string>();
const call = (s: Sess, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });

beforeAll(async () => {
  const visible = (u: URL, id: string) => CATALOG[id] && !(id === H && hiddenFor.has(u.searchParams.get('userId') ?? ''));
  env = await makeEnv({
    'GET /Items/[^/]+': (u) => { const id = u.pathname.split('/').pop()!; return visible(u, id) ? { json: CATALOG[id] } : { status: 404 }; },
    'GET /Items': (u) => ({ json: { Items: (u.searchParams.get('ids') ?? '').split(',').filter((id) => visible(u, id)).map((id) => CATALOG[id]) } }),
  });
  admin = await env.login();
  await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-b','b@example.com','Bea','friend','jfbea','Bea',$1)", [encrypt(env.ctx.encKey, 'pw')]);
  bea = await env.login({ sub: 'sub-b', email: 'b@example.com', name: 'Bea', groups: [] });
  hiddenFor.add('jfbea');
});
afterAll(() => env.close());

describe('featured lists', () => {
  let id = '', plain = '';

  it('setup: admin owns a list with items', async () => {
    id = (await call(admin, 'POST', '/api/lists', { name: 'Horror-Nacht', description: 'Gruselig' })).json().id;
    plain = (await call(admin, 'POST', '/api/lists', { name: 'Privat' })).json().id;
    for (const i of [A, B, H]) expect((await call(admin, 'POST', `/api/lists/${id}/items`, { itemId: i })).statusCode).toBe(200);
    await call(admin, 'POST', `/api/lists/${plain}/items`, { itemId: A });
  });

  it('non-admin cannot feature or list admin lists', async () => {
    expect((await call(bea, 'PUT', `/api/admin/lists/${id}/featured`, { featured: true })).statusCode).toBe(403);
    expect((await call(bea, 'GET', '/api/admin/lists')).statusCode).toBe(403);
  });

  it('before featuring: nothing featured, non-member gets 404', async () => {
    expect((await call(bea, 'GET', '/api/lists/featured')).json()).toEqual({ lists: [] });
    expect((await call(bea, 'GET', `/api/lists/${id}`)).statusCode).toBe(404);
  });

  it('admin features a list (audited) and sees it in the admin overview', async () => {
    expect((await call(admin, 'PUT', `/api/admin/lists/00000000-0000-4000-8000-000000000000/featured`, { featured: true })).statusCode).toBe(404);
    expect((await call(admin, 'PUT', `/api/admin/lists/${id}/featured`, { featured: 'yes' })).statusCode).toBe(400);
    const r = await call(admin, 'PUT', `/api/admin/lists/${id}/featured`, { featured: true });
    expect(r.json()).toEqual({ ok: true, featured: true });
    const l = (await call(admin, 'GET', '/api/admin/lists')).json().lists;
    expect(l).toHaveLength(2);
    expect(l.find((x: { id: string }) => x.id === id)).toMatchObject({ name: 'Horror-Nacht', itemCount: 3, featured: true, owner: { name: 'Admin' } });
    expect(l.find((x: { id: string }) => x.id === plain).featured).toBe(false);
    const a = await env.pool.query("select target from audit_log where action = 'list.feature'");
    expect(a.rows.map((x) => x.target)).toEqual([id]);
  });

  it('featured list is visible to non-members; hidden items are filtered', async () => {
    const f = (await call(bea, 'GET', '/api/lists/featured')).json();
    expect(f.lists).toHaveLength(1);
    expect(f.lists[0]).toMatchObject({ id, name: 'Horror-Nacht', description: 'Gruselig', owner: { name: 'Admin' } });
    expect(f.lists[0].items.map((i: { id: string }) => i.id).sort()).toEqual([A, B]);
    const full = (await call(admin, 'GET', '/api/lists/featured')).json();
    expect(full.lists[0].items).toHaveLength(3);
  });

  it('GET /api/lists/:id works read-only for non-members of a featured list only', async () => {
    const r = await call(bea, 'GET', `/api/lists/${id}`);
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.list).toMatchObject({ id, name: 'Horror-Nacht', role: 'guest', owner: { name: 'Admin' } });
    expect(j.members).toHaveLength(1);
    expect(j.items).toHaveLength(2);
    expect(j.hiddenCount).toBe(1);
    expect((await call(bea, 'GET', `/api/lists/${plain}`)).statusCode).toBe(404);
  });

  it('non-members cannot write to a featured list', async () => {
    for (const [m, u, b] of [['POST', `/api/lists/${id}/items`, { itemId: A }], ['DELETE', `/api/lists/${id}/items/${A}`], ['PATCH', `/api/lists/${id}`, { name: 'x' }],
      ['DELETE', `/api/lists/${id}`], ['PUT', `/api/lists/${id}/members/${'0'.repeat(8)}-0000-4000-8000-000000000000`, { role: 'viewer' }]] as Array<[string, string, object?]>) {
      expect([403, 404], `${m} ${u}`).toContain((await call(bea, m, u, b)).statusCode);
    }
    expect((await env.pool.query('select count(*) c from list_items where list_id = $1', [id])).rows[0].c).toBe('3');
  });

  it('lists with no visible items are omitted', async () => {
    const only = (await call(admin, 'POST', '/api/lists', { name: 'Nur versteckt' })).json().id;
    await call(admin, 'POST', `/api/lists/${only}/items`, { itemId: H });
    await call(admin, 'PUT', `/api/admin/lists/${only}/featured`, { featured: true });
    const f = (await call(bea, 'GET', '/api/lists/featured')).json().lists;
    expect(f.map((x: { id: string }) => x.id)).toEqual([id]);
    await call(admin, 'PUT', `/api/admin/lists/${only}/featured`, { featured: false });
  });

  it('max 5 featured lists (409), unfeature frees a slot and is audited', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await call(admin, 'POST', '/api/lists', { name: `L${i}` })).json().id);
    for (const x of ids.slice(0, 4)) expect((await call(admin, 'PUT', `/api/admin/lists/${x}/featured`, { featured: true })).statusCode).toBe(200);
    const over = await call(admin, 'PUT', `/api/admin/lists/${ids[4]}/featured`, { featured: true });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toBe('too_many_featured');
    // re-featuring an already featured list is idempotent, not a 409
    expect((await call(admin, 'PUT', `/api/admin/lists/${id}/featured`, { featured: true })).statusCode).toBe(200);
    expect((await call(admin, 'PUT', `/api/admin/lists/${id}/featured`, { featured: false })).statusCode).toBe(200);
    expect((await call(admin, 'PUT', `/api/admin/lists/${ids[4]}/featured`, { featured: true })).statusCode).toBe(200);
    expect((await call(bea, 'GET', `/api/lists/${id}`)).statusCode).toBe(404);
    expect((await env.pool.query("select 1 from audit_log where action = 'list.unfeature'")).rowCount).toBeGreaterThan(0);
  });
});
