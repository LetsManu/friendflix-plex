// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { makeEnv, type TestEnv } from './helpers.js';

// Block 17 S1: themed lists (editorial, pinned to the home page by an admin) and the per-profile calm pref
const A = 'a'.repeat(32), B = 'b'.repeat(32), H = 'c'.repeat(32);
const CATALOG: Record<string, Record<string, unknown>> = {
  [A]: { Id: A, Name: 'Ashfall', Type: 'Movie' },
  [B]: { Id: B, Name: 'Brasswind', Type: 'Movie' },
  [H]: { Id: H, Name: 'Hidden', Type: 'Movie' },
};
let env: TestEnv;
type Sess = { cookies: Record<string, string>; csrf: string };
let admin: Sess, bea: Sess, kid: Sess;
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
  for (const [sub, name, jf] of [['sub-b', 'Bea', 'jfbea'], ['sub-k', 'Kim', 'jfkim']]) {
    await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),$1,$2,$3,'friend',$4,$3,$5)", [sub, `${sub}@example.com`, name, jf, encrypt(env.ctx.encKey, 'pw')]);
  }
  bea = await env.login({ sub: 'sub-b', email: 'b@example.com', name: 'Bea', groups: [] });
  kid = await env.login({ sub: 'sub-k', email: 'k@example.com', name: 'Kim', groups: [] });
  await env.pool.query("update profiles set kids = true where user_id = (select id from users where authentik_sub='sub-k')"); // Kim's active profile is a kids profile
  hiddenFor.add('jfbea');
});
afterAll(() => env.close());

describe('themed lists', () => {
  let id = '', plain = '', second = '';

  it('owner creates a themed list with look; bad emoji / colour are rejected', async () => {
    expect((await call(bea, 'POST', '/api/lists', { name: 'x', themed: true, emoji: '<b>' })).statusCode).toBe(400);
    expect((await call(bea, 'POST', '/api/lists', { name: 'x', themed: true, coverColor: 'red' })).statusCode).toBe(400);
    id = (await call(admin, 'POST', '/api/lists', { name: 'Gruselabend', description: 'Licht aus', themed: true, emoji: '🎃', coverColor: '#aa3300' })).json().id;
    plain = (await call(admin, 'POST', '/api/lists', { name: 'Privat' })).json().id;
    second = (await call(admin, 'POST', '/api/lists', { name: 'Zweite', themed: true })).json().id;
    for (const l of [id, second]) for (const i of [A, B, H]) await call(admin, 'POST', `/api/lists/${l}/items`, { itemId: i });
    const lists = (await call(admin, 'GET', '/api/lists')).json().lists;
    expect(lists.find((l: { id: string }) => l.id === id)).toMatchObject({ themed: true, emoji: '🎃', coverColor: '#aa3300' });
    expect(lists.find((l: { id: string }) => l.id === plain)).toMatchObject({ themed: false, emoji: null, coverColor: null });
    expect((await call(admin, 'GET', `/api/lists/${id}`)).json().list).toMatchObject({ themed: true, emoji: '🎃', coverColor: '#aa3300', role: 'owner' });
  });

  it('only the owner edits the look (PATCH), validated', async () => {
    expect((await call(bea, 'PATCH', `/api/lists/${id}`, { emoji: '🎬' })).statusCode).toBe(404);
    expect((await call(admin, 'PATCH', `/api/lists/${id}`, { coverColor: '#12' })).statusCode).toBe(400);
    expect((await call(admin, 'PATCH', `/api/lists/${id}`, { emoji: '🧛', coverColor: '#112233' })).statusCode).toBe(200);
    expect((await call(admin, 'GET', `/api/lists/${id}`)).json().list).toMatchObject({ emoji: '🧛', coverColor: '#112233', name: 'Gruselabend' });
    expect((await call(admin, 'PATCH', `/api/lists/${id}`, { emoji: null })).statusCode).toBe(200);
    expect((await call(admin, 'GET', `/api/lists/${id}`)).json().list.emoji).toBeNull();
  });

  it('nothing is on the home page until an admin pins; non-admins cannot pin, manage or order', async () => {
    expect((await call(bea, 'GET', '/api/lists/themed')).json()).toEqual({ lists: [] });
    for (const [m, u, b] of [['PUT', `/api/lists/${id}/pin`, { pinned: true }], ['GET', '/api/lists/themed/manage'], ['PUT', '/api/lists/themed/order', { ids: [id] }]] as Array<[string, string, object?]>) {
      expect((await call(bea, m, u, b)).statusCode, `${m} ${u}`).toBe(403);
    }
    expect((await call(admin, 'PUT', `/api/lists/${plain}/pin`, { pinned: true })).json().error).toBe('not_themed');
    expect((await call(admin, 'PUT', '/api/lists/00000000-0000-4000-8000-000000000000/pin', { pinned: true })).statusCode).toBe(404);
    expect((await call(admin, 'PUT', `/api/lists/${id}/pin`, { pinned: 'yes' })).statusCode).toBe(400);
  });

  it('admin pins two themed lists in order (audited); visible to everyone, hidden items filtered, plain featured lists stay separate', async () => {
    expect((await call(admin, 'PUT', `/api/lists/${id}/pin`, { pinned: true })).json()).toEqual({ ok: true, pinned: true });
    await call(admin, 'PUT', `/api/lists/${second}/pin`, { pinned: true });
    await call(admin, 'POST', `/api/lists/${plain}/items`, { itemId: A });
    await call(admin, 'PUT', `/api/admin/lists/${plain}/featured`, { featured: true }); // an ordinary featured list
    const t = (await call(bea, 'GET', '/api/lists/themed')).json().lists;
    expect(t.map((l: { id: string }) => l.id)).toEqual([id, second]);
    expect(t[0]).toMatchObject({ name: 'Gruselabend', description: 'Licht aus', coverColor: '#112233', owner: { name: 'Admin' } });
    expect(t[0].items.map((i: { id: string }) => i.id).sort()).toEqual([A, B]); // Bea cannot see "Hidden"
    expect((await call(admin, 'GET', '/api/lists/themed')).json().lists[0].items).toHaveLength(3);
    const f = (await call(bea, 'GET', '/api/lists/featured')).json().lists;
    expect(f.map((l: { id: string }) => l.id)).toEqual([plain]); // themed lists are not repeated as plain rows
    expect((await env.pool.query("select target from audit_log where action = 'list.feature' order by id")).rows.map((x) => x.target)).toEqual(expect.arrayContaining([id, second]));
    // a guest reads the pinned themed list page
    expect((await call(bea, 'GET', `/api/lists/${id}`)).json().list).toMatchObject({ role: 'guest', themed: true });
  });

  it('admin reorders; manage lists every themed list; ids not pinned are ignored', async () => {
    expect((await call(admin, 'PUT', '/api/lists/themed/order', { ids: [second, id, plain] })).statusCode).toBe(200);
    expect((await call(bea, 'GET', '/api/lists/themed')).json().lists.map((l: { id: string }) => l.id)).toEqual([second, id]);
    const m = (await call(admin, 'GET', '/api/lists/themed/manage')).json();
    expect(m.lists.map((l: { id: string }) => l.id)).toEqual([second, id]);
    expect(m.lists[0]).toMatchObject({ pinned: true, itemCount: 3 });
    expect((await call(admin, 'PUT', '/api/lists/themed/order', { ids: ['nope'] })).statusCode).toBe(400);
  });

  it('kids profile: reads themed rows (filtered, no people) and pinned themed pages, but no plain lists', async () => {
    const t = (await call(kid, 'GET', '/api/lists/themed')).json().lists;
    expect(t).toHaveLength(2);
    expect(t[0].owner).toBeUndefined();
    const page = await call(kid, 'GET', `/api/lists/${id}`);
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ list: { id, owner: null, role: 'guest' }, members: [], hiddenCount: 0 });
    expect(page.json().items[0].addedBy).toBeUndefined();
    expect((await call(kid, 'GET', `/api/lists/${plain}`)).json().error).toBe('kids_profile'); // featured but not themed
    expect((await call(kid, 'GET', '/api/lists')).json().error).toBe('kids_profile');
    expect((await call(kid, 'GET', '/api/lists/featured')).json().error).toBe('kids_profile');
  });

  it('a themed list without any visible item is dropped from the rows', async () => {
    const solo = (await call(admin, 'POST', '/api/lists', { name: 'Nur versteckt', themed: true })).json().id;
    await call(admin, 'POST', `/api/lists/${solo}/items`, { itemId: H });
    await call(admin, 'PUT', `/api/lists/${solo}/pin`, { pinned: true });
    expect((await call(bea, 'GET', '/api/lists/themed')).json().lists.map((l: { id: string }) => l.id)).not.toContain(solo);
    expect((await call(admin, 'GET', '/api/lists/themed')).json().lists.map((l: { id: string }) => l.id)).toContain(solo);
  });

  it('pin limit is shared with featured lists; unpin removes the row; un-theming keeps it off the themed rows', async () => {
    for (let i = 0; i < 5; i++) {
      const x = (await call(admin, 'POST', '/api/lists', { name: `T${i}`, themed: true })).json().id;
      const r = await call(admin, 'PUT', `/api/lists/${x}/pin`, { pinned: true });
      if (r.statusCode === 409) { expect(r.json().error).toBe('too_many_featured'); break; }
    }
    expect((await call(admin, 'PUT', `/api/lists/${id}/pin`, { pinned: false })).json()).toEqual({ ok: true, pinned: false });
    expect((await call(admin, 'GET', '/api/lists/themed')).json().lists.map((l: { id: string }) => l.id)).not.toContain(id);
    await call(admin, 'PUT', `/api/lists/${second}/pin`, { pinned: false });
    await call(admin, 'PUT', `/api/lists/${second}/pin`, { pinned: true });
    await call(admin, 'PATCH', `/api/lists/${second}`, { themed: false });
    expect((await call(admin, 'GET', '/api/lists/themed')).json().lists.map((l: { id: string }) => l.id)).not.toContain(second);
  });

  it('changing `themed` on a featured list unfeatures it (no kids-readable home row without an admin decision)', async () => {
    // Bea owns a plain list an admin featured
    const own = (await call(bea, 'POST', '/api/lists', { name: 'Beas Liste' })).json().id;
    await call(bea, 'POST', `/api/lists/${own}/items`, { itemId: A });
    expect((await call(admin, 'PUT', `/api/admin/lists/${own}/featured`, { featured: true })).statusCode).toBe(200);
    // same value: nothing changes
    expect((await call(bea, 'PATCH', `/api/lists/${own}`, { themed: false })).json()).toEqual({ ok: true });
    expect((await env.pool.query('select featured_at is not null as f from lists where id = $1', [own])).rows[0].f).toBe(true);
    const r = await call(bea, 'PATCH', `/api/lists/${own}`, { themed: true, emoji: '🎈' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, unfeatured: true });
    expect((await env.pool.query('select themed, featured_at, featured_pos from lists where id = $1', [own])).rows[0]).toEqual({ themed: true, featured_at: null, featured_pos: null });
    expect((await call(kid, 'GET', '/api/lists/themed')).json().lists.map((l: { id: string }) => l.id)).not.toContain(own);
    expect((await call(kid, 'GET', `/api/lists/${own}`)).statusCode).toBe(403);
    // a pinned themed list turned plain does not stay a featured (social) list either
    const pinned = (await call(admin, 'POST', '/api/lists', { name: 'Gepinnt', themed: true })).json().id;
    await call(admin, 'POST', `/api/lists/${pinned}/items`, { itemId: A });
    await call(admin, 'PUT', `/api/lists/${id}/pin`, { pinned: false }); // room under the pin limit
    expect((await call(admin, 'PUT', `/api/lists/${pinned}/pin`, { pinned: true })).statusCode).toBe(200);
    expect((await call(admin, 'PATCH', `/api/lists/${pinned}`, { themed: false })).json()).toEqual({ ok: true, unfeatured: true });
    expect((await call(bea, 'GET', '/api/lists/featured')).json().lists.map((l: { id: string }) => l.id)).not.toContain(pinned);
  });

  it('kids and plain users: unauthenticated requests are 401', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/api/lists/themed' })).statusCode).toBe(401);
  });
});

describe('calm mode pref', () => {
  it('defaults to off, is stored per profile, and validated', async () => {
    expect((await call(bea, 'GET', '/api/prefs')).json().prefs.calm).toBe(false);
    expect((await call(bea, 'PUT', '/api/prefs', { calm: 'yes' })).statusCode).toBe(400);
    expect((await call(bea, 'PUT', '/api/prefs', { calm: true })).json().prefs.calm).toBe(true);
    expect((await call(bea, 'GET', '/api/prefs')).json().prefs.calm).toBe(true);
    expect((await call(admin, 'GET', '/api/prefs')).json().prefs.calm).toBe(false); // other profile unaffected
    expect((await call(kid, 'GET', '/api/prefs')).json().prefs.calm).toBe(false);
    expect((await call(kid, 'PUT', '/api/prefs', { calm: true })).json().prefs.calm).toBe(true); // kids profiles may use it too
  });
  it('audioFx (player sound): own endpoint, validated, per profile, kept by a full PUT', async () => {
    expect((await call(bea, 'GET', '/api/prefs')).json().prefs.audioFx).toBe('off');
    expect((await call(bea, 'PUT', '/api/prefs/audiofx', { audioFx: 'loud' })).statusCode).toBe(400);
    expect((await call(bea, 'PUT', '/api/prefs/audiofx', {})).statusCode).toBe(400);
    expect((await call(bea, 'PUT', '/api/prefs/audiofx', { audioFx: 'night' })).json()).toEqual({ audioFx: 'night' });
    expect((await call(bea, 'GET', '/api/prefs')).json().prefs.audioFx).toBe('night');
    expect((await call(admin, 'GET', '/api/prefs')).json().prefs.audioFx).toBe('off'); // other profile unaffected
    // a settings form (full PUT, stale or without the field) never reverts it
    expect((await call(bea, 'PUT', '/api/prefs', { calm: true, audioFx: 'off' })).json().prefs.audioFx).toBe('night');
    expect((await call(bea, 'PUT', '/api/prefs', { calm: true })).json().prefs).toMatchObject({ audioFx: 'night', calm: true });
    expect((await call(bea, 'PUT', '/api/prefs/audiofx', { audioFx: 'both' })).statusCode).toBe(200);
    expect((await call(bea, 'GET', '/api/prefs')).json().prefs.audioFx).toBe('both');
    expect((await env.app.inject({ method: 'PUT', url: '/api/prefs/audiofx', payload: { audioFx: 'off' } })).statusCode).toBe(401);
  });
});
