import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { makeEnv, type TestEnv } from './helpers.js';

const A = 'a'.repeat(32), B = 'b'.repeat(32), H = 'c'.repeat(32), SERIES = 'd'.repeat(32), EP = 'e'.repeat(32), BOX = '9'.repeat(32);
const CATALOG: Record<string, Record<string, unknown>> = {
  [A]: { Id: A, Name: 'Ashfall', Type: 'Movie' },
  [B]: { Id: B, Name: 'Brasswind', Type: 'Movie' },
  [H]: { Id: H, Name: 'Hidden', Type: 'Movie' },
  [SERIES]: { Id: SERIES, Name: 'Serie', Type: 'Series' },
  [BOX]: { Id: BOX, Name: 'Box', Type: 'BoxSet' },
  [EP]: { Id: EP, Name: 'Pilot', Type: 'Episode', SeriesId: SERIES, SeriesName: 'Serie' },
};
let env: TestEnv;
type Sess = { cookies: Record<string, string>; csrf: string };
let alice: Sess, bea: Sess, cid: Sess;
let aliceId = '', beaId = '', cidId = '';
let jfDown = false;
const hiddenFor = new Set<string>(); // jellyfin user ids that cannot see H

beforeAll(async () => {
  const visible = (u: URL, id: string) => CATALOG[id] && !(id === H && hiddenFor.has(u.searchParams.get('userId') ?? ''));
  env = await makeEnv({
    'GET /Items/[^/]+': (u) => { const id = u.pathname.split('/').pop()!; return visible(u, id) ? { json: CATALOG[id] } : { status: 404 }; },
    'GET /Items': (u) => jfDown ? { status: 500 } : ({ json: { Items: (u.searchParams.get('ids') ?? '').split(',').filter((id) => visible(u, id)).map((id) => CATALOG[id]) } }),
  });
  alice = await env.login();
  for (const [sub, name, jf] of [['sub-b', 'Bea', 'jfbea'], ['sub-c', 'Cid', 'jfcid']]) {
    await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),$1,$2,$3,'friend',$4,$3,$5)", [sub, `${sub}@example.com`, name, jf, encrypt(env.ctx.encKey, 'pw')]);
  }
  bea = await env.login({ sub: 'sub-b', email: 'b@example.com', name: 'Bea', groups: [] });
  cid = await env.login({ sub: 'sub-c', email: 'c@example.com', name: 'Cid', groups: [] });
  const u = async (sub: string) => (await env.pool.query<{ id: string; jellyfin_user_id: string }>('select id, jellyfin_user_id from users where authentik_sub=$1', [sub])).rows[0]!;
  aliceId = (await u('sub-admin')).id; beaId = (await u('sub-b')).id; cidId = (await u('sub-c')).id;
  hiddenFor.add((await u('sub-b')).jellyfin_user_id);
});
afterAll(() => env.close());
const call = (s: Sess, method: string, url: string, body?: unknown, csrf = true) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: csrf ? { 'x-csrf-token': s.csrf } : {}, payload: body as object });

describe('shared lists', () => {
  let id = '';

  it('create / list / rename', async () => {
    const r = await call(alice, 'POST', '/api/lists', { name: '  Filmabend ', description: 'Freitag' });
    expect(r.statusCode).toBe(200);
    id = r.json().id;
    expect((await call(alice, 'POST', '/api/lists', { name: '   ' })).statusCode).toBe(400);
    expect((await call(alice, 'PATCH', `/api/lists/${id}`, { name: 'Kino' })).statusCode).toBe(200);
    const l = (await call(alice, 'GET', '/api/lists')).json().lists;
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ id, name: 'Kino', description: 'Freitag', role: 'owner', itemCount: 0, memberCount: 1, owner: { id: aliceId, name: 'Admin' } });
    expect((await call(alice, 'GET', `/api/lists/${id}`)).json().list).toMatchObject({ name: 'Kino', role: 'owner' });
  });

  it('non-members get 404 everywhere', async () => {
    for (const [m, u, b] of [['GET', `/api/lists/${id}`], ['PATCH', `/api/lists/${id}`, { name: 'x' }], ['DELETE', `/api/lists/${id}`], ['POST', `/api/lists/${id}/items`, { itemId: A }],
      ['DELETE', `/api/lists/${id}/items/${A}`], ['PUT', `/api/lists/${id}/members/${cidId}`, { role: 'viewer' }], ['DELETE', `/api/lists/${id}/members/${beaId}`], ['GET', '/api/lists/not-a-uuid']] as Array<[string, string, object?]>) {
      expect((await call(bea, m, u, b)).statusCode, `${m} ${u}`).toBe(404);
    }
    expect((await call(bea, 'GET', '/api/lists')).json().lists).toEqual([]);
  });

  it('invites: validation, notification exactly once, roles', async () => {
    expect((await call(alice, 'PUT', `/api/lists/${id}/members/${aliceId}`, { role: 'editor' })).statusCode).toBe(400);
    expect((await call(alice, 'PUT', `/api/lists/${id}/members/${'0'.repeat(8)}-0000-4000-8000-000000000000`, { role: 'editor' })).statusCode).toBe(400);
    expect((await call(alice, 'PUT', `/api/lists/${id}/members/${beaId}`, { role: 'owner' })).statusCode).toBe(400);
    expect((await call(alice, 'PUT', `/api/lists/${id}/members/${beaId}`, { role: 'viewer' })).statusCode).toBe(200);
    expect((await call(alice, 'PUT', `/api/lists/${id}/members/${beaId}`, { role: 'viewer' })).statusCode).toBe(200);
    const n = (await call(bea, 'GET', '/api/notifications')).json().notifications.filter((x: any) => x.kind === 'list_invite');
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ title: 'Admin hat dich zur Liste „Kino“ eingeladen', link: `/lists/${id}` });
    expect((await call(alice, 'PUT', `/api/lists/${id}/members/${cidId}`, { role: 'editor' })).statusCode).toBe(200);
    await env.pool.query('update users set disabled = true where id = $1', [cidId]);
    const d = await call(alice, 'PUT', `/api/lists/${id}/members/${cidId}`, { role: 'viewer' });
    expect(d.statusCode).toBe(400);
    await env.pool.query('update users set disabled = false where id = $1', [cidId]);
    expect((await call(bea, 'PUT', `/api/lists/${id}/members/${cidId}`, { role: 'editor' })).statusCode).toBe(403);
  });

  it('viewer cannot add (403), editor can; addedBy; episode normalised; duplicates', async () => {
    expect((await call(bea, 'POST', `/api/lists/${id}/items`, { itemId: A })).statusCode).toBe(403);
    expect((await call(cid, 'POST', `/api/lists/${id}/items`, { itemId: A, note: 'Muss man sehen' })).statusCode).toBe(200);
    expect((await call(cid, 'POST', `/api/lists/${id}/items`, { itemId: A })).statusCode).toBe(409);
    expect((await call(alice, 'POST', `/api/lists/${id}/items`, { itemId: EP })).json().itemId).toBe(SERIES);
    expect((await call(alice, 'POST', `/api/lists/${id}/items`, { itemId: SERIES })).statusCode).toBe(409);
    const d = (await call(bea, 'GET', `/api/lists/${id}`)).json();
    expect(d.list.role).toBe('viewer');
    expect(d.members.map((m: any) => [m.name, m.role])).toEqual([['Admin', 'owner'], ['Bea', 'viewer'], ['Cid', 'editor']]);
    const alien = d.items.find((i: any) => i.id === A);
    expect(alien).toMatchObject({ name: 'Ashfall', note: 'Muss man sehen', addedBy: { id: cidId, name: 'Cid' } });
    expect(d.items.find((i: any) => i.id === SERIES).addedBy.name).toBe('Admin');
    expect((await call(bea, 'DELETE', `/api/lists/${id}/items/${A}`)).statusCode).toBe(403);
    expect((await call(alice, 'GET', '/api/lists')).json().lists[0]).toMatchObject({ itemCount: 2, memberCount: 3 });
  });

  it('items for picker: only owner/editor lists, contains flag', async () => {
    expect((await call(bea, 'GET', `/api/items/${A}/lists`)).json().lists).toEqual([]);
    expect((await call(cid, 'GET', `/api/items/${A}/lists`)).json().lists).toEqual([{ id, name: 'Kino', contains: true, canEdit: true }]);
    expect((await call(cid, 'GET', `/api/items/${B}/lists`)).json().lists[0].contains).toBe(false);
  });

  it('invisible items are filtered + counted; adding one is 404', async () => {
    expect((await call(alice, 'POST', `/api/lists/${id}/items`, { itemId: H })).statusCode).toBe(200);
    const a = (await call(alice, 'GET', `/api/lists/${id}`)).json();
    expect(a.hiddenCount).toBe(0);
    expect(a.items.some((i: any) => i.id === H)).toBe(true);
    const b = (await call(bea, 'GET', `/api/lists/${id}`)).json();
    expect(b.hiddenCount).toBe(1);
    expect(b.items.some((i: any) => i.id === H)).toBe(false);
    expect(JSON.stringify(b)).not.toContain('Hidden');
    expect((await call(bea, 'GET', '/api/lists')).json().lists[0].coverIds).not.toContain(H);
    // an editor who cannot see it cannot add it
    await call(alice, 'PUT', `/api/lists/${id}/members/${beaId}`, { role: 'editor' });
    expect((await call(bea, 'POST', `/api/lists/${id}/items`, { itemId: B })).statusCode).toBe(200);
    await call(alice, 'DELETE', `/api/lists/${id}/items/${H}`);
    expect((await call(bea, 'POST', `/api/lists/${id}/items`, { itemId: H })).statusCode).toBe(404);
    expect((await call(bea, 'POST', `/api/lists/${id}/items`, { itemId: 'f'.repeat(32) })).statusCode).toBe(404);
    expect((await call(bea, 'DELETE', `/api/lists/${id}/items/${B}`)).statusCode).toBe(200);
  });

  it('only movies and series can be added (400 bad_type)', async () => {
    const r = await call(alice, 'POST', `/api/lists/${id}/items`, { itemId: BOX });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('bad_type');
  });

  it('a Jellyfin outage is a 502, not "everything hidden"', async () => {
    jfDown = true;
    try {
      const r = await call(alice, 'GET', `/api/lists/${id}`);
      expect(r.statusCode).toBe(502);
      expect(r.json()).not.toHaveProperty('hiddenCount');
    } finally {
      jfDown = false;
    }
    expect((await call(alice, 'GET', `/api/lists/${id}`)).statusCode).toBe(200);
  });

  it('CSRF is required on mutations', async () => {
    for (const [m, u, b] of [['POST', '/api/lists', { name: 'x' }], ['PATCH', `/api/lists/${id}`, { name: 'x' }], ['DELETE', `/api/lists/${id}`], ['POST', `/api/lists/${id}/items`, { itemId: B }],
      ['DELETE', `/api/lists/${id}/items/${A}`], ['PUT', `/api/lists/${id}/members/${beaId}`, { role: 'viewer' }], ['DELETE', `/api/lists/${id}/members/${beaId}`]] as Array<[string, string, object?]>) {
      expect((await call(alice, m, u, b, false)).statusCode, `${m} ${u}`).toBe(403);
    }
  });

  it('leave, owner removes member, owner cannot leave', async () => {
    expect((await call(cid, 'DELETE', `/api/lists/${id}/members/${beaId}`)).statusCode).toBe(403);
    expect((await call(cid, 'DELETE', `/api/lists/${id}/members/${cidId}`)).statusCode).toBe(200);
    expect((await call(cid, 'GET', `/api/lists/${id}`)).statusCode).toBe(404);
    expect((await call(alice, 'DELETE', `/api/lists/${id}/members/${aliceId}`)).statusCode).toBe(400);
    expect((await call(alice, 'DELETE', `/api/lists/${id}/members/${beaId}`)).statusCode).toBe(200);
    expect((await call(bea, 'GET', `/api/lists/${id}`)).statusCode).toBe(404);
  });

  it('delete cascades; limits answer 409', async () => {
    expect((await call(bea, 'DELETE', `/api/lists/${id}`)).statusCode).toBe(404);
    expect((await call(alice, 'DELETE', `/api/lists/${id}`)).statusCode).toBe(200);
    for (const t of ['list_items', 'list_members']) expect((await env.pool.query(`select 1 from ${t}`)).rowCount).toBe(0);
    for (let i = 0; i < 20; i++) expect((await call(alice, 'POST', '/api/lists', { name: `L${i}` })).statusCode).toBe(200);
    expect((await call(alice, 'POST', '/api/lists', { name: 'zu viele' })).statusCode).toBe(409);
    const lid = (await call(alice, 'GET', '/api/lists')).json().lists[0].id;
    await env.pool.query(`insert into list_items(list_id,item_id,item_name) select $1, md5(g::text), 'x' from generate_series(1,500) g`, [lid]);
    const full = await call(alice, 'POST', `/api/lists/${lid}/items`, { itemId: A });
    expect(full.statusCode).toBe(409);
    expect(full.json().error).toBe('list_full');
    await env.pool.query(`insert into users(id,authentik_sub,name,role,jellyfin_user_id,jellyfin_username,jellyfin_pw_enc) select gen_random_uuid(), 'm'||g, 'M'||g, 'friend', 'j'||g, 'j'||g, 'x' from generate_series(1,20) g`);
    const ids = (await env.pool.query<{ id: string }>("select id from users where authentik_sub like 'm%'")).rows.map((r) => r.id);
    let last = 200;
    for (const u of ids) { last = (await call(alice, 'PUT', `/api/lists/${lid}/members/${u}`, { role: 'viewer' })).statusCode; if (last === 409) break; }
    expect(last).toBe(409);
  });
});
