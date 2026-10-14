// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { makeEnv, type TestEnv } from './helpers.js';

const hex = (n: number) => n.toString(16).padStart(32, '0');
const COL = hex(10), MOVIE = hex(11), SERIES = hex(12), SECRET = hex(13), NOART = hex(14), NOTCOL = hex(15);
type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess, bea: Sess;
let beaJf = '';
const items: Record<string, any> = {
  [COL]: { Id: COL, Name: 'Sammlung', Type: 'BoxSet', ImageTags: { Primary: 'p1' }, BackdropImageTags: ['b1'] },
  [MOVIE]: { Id: MOVIE, Name: 'Film', Type: 'Movie', ImageTags: { Primary: 'p2' }, BackdropImageTags: ['b2'] },
  [SERIES]: { Id: SERIES, Name: 'Serie', Type: 'Series', ImageTags: { Primary: 'p3' } },
  [SECRET]: { Id: SECRET, Name: 'Geheim', Type: 'Movie' },
  [NOART]: { Id: NOART, Name: 'Ohne Bild', Type: 'Movie' },
  [NOTCOL]: { Id: NOTCOL, Name: 'Film', Type: 'Movie' },
};
/** Jellyfin returns the hub members (everything except SECRET for Bea; Bea sees nothing of studio "Privat") */
const members = (u: URL) => {
  const forBea = u.searchParams.get('userId') === beaJf;
  if (forBea && u.searchParams.get('studios') === 'Privat') return [];
  let list = [items[MOVIE], items[SERIES], items[SECRET]];
  const types = u.searchParams.get('includeItemTypes') ?? '';
  if (types === 'Movie') list = list.filter((i) => i.Type === 'Movie');
  if (types === 'Series') list = list.filter((i) => i.Type === 'Series');
  if (forBea) list = list.filter((i) => i.Id !== SECRET);
  if (u.searchParams.get('studios') === 'Leer' || u.searchParams.get('tags') === 'leer') list = [];
  return list;
};

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items/[^/]+': (u) => {
      const id = u.pathname.split('/').pop()!;
      const hidden = id === SECRET && u.searchParams.get('userId') === beaJf;
      return items[id] && !hidden ? { json: items[id] } : { status: 404 };
    },
    'GET /Items': (u) => {
      if (u.searchParams.get('includeItemTypes') === 'BoxSet') return { json: { Items: [items[COL]] } };
      const all = members(u);
      const start = Number(u.searchParams.get('startIndex') ?? 0), limit = Number(u.searchParams.get('limit') ?? 50);
      return { json: { Items: all.slice(start, start + limit), TotalRecordCount: all.length } };
    },
    'GET /Studios': () => ({ json: { Items: [{ Name: 'Klein', MovieCount: 1 }, { Name: 'Gross', MovieCount: 5, SeriesCount: 2 }] } }),
    'GET /Genres': () => ({ json: { Items: [{ Name: 'Anime', SeriesCount: 9 }] } }),
    'GET /Items/[^/]+/LocalTrailers': () => ({ json: [{ Id: hex(21), Name: 'Trailer', Type: 'Trailer' }] }),
    'GET /Items/[^/]+/SpecialFeatures': (u) => (u.pathname.includes(SECRET) ? { status: 404 } : { json: [{ Id: hex(22), Name: 'Making of', Type: 'Video', RunTimeTicks: 6e9 }, { Id: hex(21), Name: 'Trailer', Type: 'Trailer' }] }),
  });
  admin = await env.login();
  beaJf = hex(777);
  await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-b','b@example.com','Bea','friend',$1,'Bea',$2)", [beaJf, encrypt(env.ctx.encKey, 'pw')]);
  bea = await env.login({ sub: 'sub-b', email: 'b@example.com', name: 'Bea', groups: [] });
});
afterAll(() => env.close());

const call = (s: Sess | null, method: string, url: string, body?: unknown, csrf = true) =>
  env.app.inject({ method: method as 'GET', url, cookies: s?.cookies ?? {}, headers: s && csrf ? { 'x-csrf-token': s.csrf } : {}, payload: body as object });
const create = async (body: object) => call(admin, 'POST', '/api/admin/hubs', body);
const ids: Record<string, string> = {};

describe('brand hubs: admin', () => {
  it('requires an admin, a session and CSRF', async () => {
    expect((await call(null, 'GET', '/api/admin/hubs')).statusCode).toBe(401);
    expect((await call(bea, 'GET', '/api/admin/hubs')).statusCode).toBe(403);
    expect((await call(bea, 'POST', '/api/admin/hubs', { name: 'x', source: 'genre', sourceValue: 'Anime' })).statusCode).toBe(403);
    expect((await call(admin, 'POST', '/api/admin/hubs', { name: 'x', source: 'genre', sourceValue: 'Anime' }, false)).statusCode).toBe(403);
    expect((await call(admin, 'GET', '/api/admin/hubs')).json()).toEqual({ max: 8, hubs: [] }); // nothing seeded
  });

  it('validates input', async () => {
    for (const b of [{ name: '', source: 'genre', sourceValue: 'x' }, { name: 'x', source: 'nope', sourceValue: 'x' }, { name: 'x', source: 'genre', sourceValue: 'a|b' },
      { name: 'x', source: 'genre', sourceValue: 'x', accent: 'red' }, { name: 'x', source: 'genre', sourceValue: 'x', imageItemId: 'zz' }]) {
      expect((await create(b)).statusCode, JSON.stringify(b)).toBe(400);
    }
    expect((await create({ name: 'Kein Set', source: 'collection', sourceValue: NOTCOL })).json().error).toBe('bad_source');
    expect((await create({ name: 'Bild fehlt', source: 'genre', sourceValue: 'Anime', imageItemId: hex(999) })).json().error).toBe('bad_source');
  });

  it('creates hubs in order, with collection artwork from Jellyfin', async () => {
    const a = await create({ name: 'Anime', source: 'genre', sourceValue: 'Anime', accent: '#ff6600' });
    expect(a.statusCode).toBe(201);
    ids.anime = a.json().hub.id;
    expect(a.json().hub).toMatchObject({ name: 'Anime', source: 'genre', accent: '#ff6600', sortOrder: 0, enabled: true });
    expect(a.json().hub.imageUrl).toBeUndefined(); // gradient + text on the client
    const c = await create({ name: 'Sammlung', source: 'collection', sourceValue: COL });
    ids.col = c.json().hub.id;
    expect(c.json().hub.imageUrl).toBe(`/media/Items/${COL}/Images/Backdrop?maxWidth=640&quality=80`);
    const s = await create({ name: 'Privat', source: 'studio', sourceValue: 'Privat', imageItemId: SERIES });
    ids.priv = s.json().hub.id;
    expect(s.json().hub.imageUrl).toContain(`/${SERIES}/Images/Primary`);
    const e = await create({ name: 'Leer', source: 'studio', sourceValue: 'Leer', imageItemId: NOART });
    ids.empty = e.json().hub.id;
    expect(e.json().hub.imageUrl).toBeUndefined();
    expect((await call(admin, 'GET', '/api/admin/hubs')).json().hubs.map((h: any) => h.name)).toEqual(['Anime', 'Sammlung', 'Privat', 'Leer']);
  });

  it('suggests studios, genres and collections from the library', async () => {
    const r = (await call(admin, 'GET', '/api/admin/hubs/suggestions')).json().suggestions as any[];
    expect(r.filter((x) => x.source === 'studio').map((x) => x.name)).toEqual(['Gross', 'Klein']); // biggest first
    expect(r.find((x) => x.source === 'genre')).toMatchObject({ name: 'Anime', count: 9, used: true });
    expect(r.find((x) => x.source === 'collection')).toMatchObject({ name: 'Sammlung', sourceValue: COL, used: true });
    expect(r.find((x) => x.name === 'Gross').used).toBe(false);
    expect((await call(bea, 'GET', '/api/admin/hubs/suggestions')).statusCode).toBe(403);
  });

  it('updates, reorders, toggles and deletes (audited)', async () => {
    const u = await call(admin, 'PUT', `/api/admin/hubs/${ids.anime}`, { name: 'Anime & Co', source: 'genre', sourceValue: 'Anime', accent: null });
    expect(u.json().hub).toMatchObject({ name: 'Anime & Co', enabled: true });
    expect(u.json().hub.accent).toBeUndefined();
    expect((await call(admin, 'PUT', `/api/admin/hubs/${hex(1)}`, { name: 'x', source: 'genre', sourceValue: 'x' })).statusCode).toBe(404);
    expect((await call(admin, 'PUT', '/api/admin/hubs/order', { ids: [ids.col, ids.anime, ids.priv, ids.empty] })).statusCode).toBe(200);
    expect((await call(admin, 'PUT', '/api/admin/hubs/order', { ids: [ids.col, ids.col] })).statusCode).toBe(400);
    expect((await call(admin, 'PUT', '/api/admin/hubs/order', { ids: [hex(5).replace(/^0{8}/, '00000000-0000-0000-0000-')] })).statusCode).toBe(400);
    expect((await call(admin, 'GET', '/api/admin/hubs')).json().hubs.map((h: any) => h.name)).toEqual(['Sammlung', 'Anime & Co', 'Privat', 'Leer']);
    await call(admin, 'DELETE', `/api/admin/hubs/${ids.empty}`);
    expect((await call(admin, 'DELETE', `/api/admin/hubs/${ids.empty}`)).statusCode).toBe(404);
    const actions = (await env.pool.query("select action from audit_log where action like 'hub.%' order by at")).rows.map((r) => r.action);
    expect(actions).toContain('hub.create');
    expect(actions).toContain('hub.order');
    expect(actions).toContain('hub.delete');
  });

  it('caps the number of hubs', async () => {
    for (let i = 0; i < 5; i++) expect((await create({ name: `Tag ${i}`, source: 'tag', sourceValue: `t${i}` })).statusCode).toBe(201);
    const r = await create({ name: 'Zu viel', source: 'tag', sourceValue: 'z' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'too_many', max: 8 });
    await env.pool.query("delete from brand_hubs where source_kind = 'tag'");
  });
});

describe('brand hubs: viewer', () => {
  it('needs a session', async () => {
    expect((await call(null, 'GET', '/api/hubs')).statusCode).toBe(401);
    expect((await call(null, 'GET', `/api/hubs/${ids.anime}`)).statusCode).toBe(401);
    expect((await call(null, 'GET', `/api/hubs/${ids.anime}/items`)).statusCode).toBe(401);
  });

  it('lists only enabled hubs that contain something the user can see', async () => {
    const names = async (s: Sess) => (await call(s, 'GET', '/api/hubs')).json().hubs.map((h: any) => h.name);
    expect(await names(admin)).toEqual(['Sammlung', 'Anime & Co', 'Privat']);
    expect(await names(bea)).not.toContain('Privat'); // Bea cannot see anything of that studio
    expect(await names(bea)).toContain('Anime & Co');
    const one = (await call(admin, 'GET', '/api/hubs')).json().hubs.find((h: any) => h.name === 'Sammlung');
    expect(one).toEqual({ id: ids.col, name: 'Sammlung', source: 'collection', imageUrl: `/media/Items/${COL}/Images/Backdrop?maxWidth=640&quality=80` });
    await call(admin, 'PUT', `/api/admin/hubs/${ids.anime}`, { name: 'Anime & Co', source: 'genre', sourceValue: 'Anime', enabled: false });
    expect(await names(admin)).not.toContain('Anime & Co');
    expect((await call(admin, 'GET', `/api/hubs/${ids.anime}`)).statusCode).toBe(404); // disabled = gone
    await call(admin, 'PUT', `/api/admin/hubs/${ids.anime}`, { name: 'Anime & Co', source: 'genre', sourceValue: 'Anime', enabled: true });
  });

  it('tile artwork only for viewers who may see the image item (else the gradient tile)', async () => {
    const before = (await env.pool.query('select image_item_id, image_kind from brand_hubs where id=$1', [ids.anime])).rows[0];
    await env.pool.query("update brand_hubs set image_item_id=$2, image_kind='Primary' where id=$1", [ids.anime, SECRET]); // Bea may not open SECRET
    const tile = async (s: Sess) => (await call(s, 'GET', '/api/hubs')).json().hubs.find((h: any) => h.id === ids.anime);
    expect((await tile(admin)).imageUrl).toContain(`/${SECRET}/Images/Primary`);
    expect(await tile(bea)).toMatchObject({ name: 'Anime & Co' });
    expect((await tile(bea)).imageUrl).toBeUndefined();
    expect((await call(bea, 'GET', `/api/hubs/${ids.anime}`)).json().hub.imageUrl).toBeUndefined();
    expect((await call(admin, 'GET', `/api/hubs/${ids.anime}`)).json().hub.imageUrl).toContain(SECRET);
    await env.pool.query('update brand_hubs set image_item_id=$2, image_kind=$3 where id=$1', [ids.anime, before.image_item_id, before.image_kind]);
  });

  it('hub page: header and rows, filtered by the user access', async () => {
    const a = (await call(admin, 'GET', `/api/hubs/${ids.anime}`)).json();
    expect(a.hub.name).toBe('Anime & Co');
    expect(a.total).toBe(3);
    expect(a.rows.map((r: any) => r.key)).toEqual(['new', 'popular', 'movies', 'series']);
    expect(a.rows.find((r: any) => r.key === 'movies').items.every((i: any) => i.type === 'Movie')).toBe(true);
    expect(a.featured.backdrop).toBe(true);
    const b = (await call(bea, 'GET', `/api/hubs/${ids.anime}`)).json();
    expect(b.total).toBe(2);
    expect(JSON.stringify(b)).not.toContain('Geheim');
    expect(JSON.stringify(a)).toContain('Geheim');
  });

  it('a hub with nothing visible is a plain 404, so is an unknown or malformed id', async () => {
    expect((await call(bea, 'GET', `/api/hubs/${ids.priv}`)).statusCode).toBe(404);
    expect((await call(admin, 'GET', `/api/hubs/${hex(1)}`)).statusCode).toBe(404);
    expect((await call(admin, 'GET', '/api/hubs/nope')).statusCode).toBe(404);
    expect((await call(bea, 'GET', `/api/hubs/${ids.priv}/items`)).json().total).toBe(0);
  });

  it('A-Z paging with total', async () => {
    const p1 = (await call(admin, 'GET', `/api/hubs/${ids.anime}/items?limit=2`)).json();
    expect(p1.total).toBe(3);
    expect(p1.items).toHaveLength(2);
    const p2 = (await call(admin, 'GET', `/api/hubs/${ids.anime}/items?limit=2&start=2`)).json();
    expect(p2.items).toHaveLength(1);
    expect((await call(admin, 'GET', `/api/hubs/${ids.anime}/items?types=Series`)).statusCode).toBe(200);
    expect((await call(admin, 'GET', `/api/hubs/${ids.anime}/items?limit=999`)).statusCode).toBe(400);
    expect((await call(admin, 'GET', `/api/hubs/${ids.anime}/items?types=Person`)).statusCode).toBe(400);
  });

  it('the Jellyfin query carries the right source filter', async () => {
    const calls = env.jfCalls.filter((c) => c.path === '/Items' && c.search.includes('sortBy'));
    expect(calls.some((c) => c.search.includes('genres=Anime'))).toBe(true);
    expect(calls.some((c) => c.search.includes(`parentId=${COL}`))).toBe(true);
    expect(calls.some((c) => c.search.includes('studios=Privat'))).toBe(true);
  });
});

describe('extras tab', () => {
  const url = (id: string) => `/api/items/${id}/extras/all`;
  it('needs a session', async () => {
    expect((await call(null, 'GET', url(MOVIE))).statusCode).toBe(401);
  });
  it('trailers first, then special features, no duplicates', async () => {
    const r = (await call(admin, 'GET', url(MOVIE))).json();
    expect(r.items.map((i: any) => [i.name, i.kind])).toEqual([['Trailer', 'trailer'], ['Making of', 'extra']]);
    expect(r.items[1].runtimeTicks).toBe(6e9);
  });
  it('items the user cannot see are 404 and never listed', async () => {
    expect((await call(bea, 'GET', url(SECRET))).statusCode).toBe(404);
    expect((await call(admin, 'GET', url(hex(99)))).statusCode).toBe(404);
    expect((await call(admin, 'GET', url('xyz'))).statusCode).toBe(400);
  });
});
