import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { setLive } from '../src/live.js';
import { requestStateKey } from '../src/seerr/client.js';
import { makeEnv, type TestEnv } from './helpers.js';

const hex = (n: number) => n.toString(16).padStart(32, '0');
const LIB = Array.from({ length: 12 }, (_, i) => [hex(i + 1), `Titel ${String.fromCharCode(65 + i)}`, i % 2 ? 'Series' : 'Movie'] as const);
const SEERR = Array.from({ length: 7 }, (_, i) => ({ id: 100 + i, type: 'movie', status: i === 6 ? 3 : 1, media: { status: i === 6 ? 1 : 2, tmdbId: 500 + i, mediaType: 'movie' }, requestedBy: { displayName: `Seerr ${i}` }, createdAt: '2026-01-01' }));

let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
let guest: { cookies: Record<string, string>; csrf: string };
let dir: string;
const call = (who: typeof admin, method: string, url: string, body?: unknown) => env.app.inject({ method: method as 'GET', url, cookies: who.cookies, headers: { 'x-csrf-token': who.csrf }, payload: body as object });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ff-admincontent-'));
  env = await makeEnv({
    'GET /Items': () => ({ json: { Items: LIB.map(([Id, Name, Type]) => ({ Id, Name, Type, UserData: {} })), TotalRecordCount: LIB.length } }),
    'DELETE /Videos/ActiveEncodings': () => ({ status: 204 }),
  }, {
    ctxPatch: (c) => { c.cfg = { ...c.cfg, PREVIEW_DIR: dir }; },
    seerr: {
      'GET /api/v1/request': (u) => {
        const take = Number(u.searchParams.get('take')), skip = Number(u.searchParams.get('skip'));
        return { json: { results: SEERR.slice(skip, skip + take), pageInfo: { results: SEERR.length } } };
      },
      'GET /api/v1/movie/\\d+': (u) => ({ json: { title: `Film ${u.pathname.split('/').pop()}` } }),
    },
  });
  admin = await env.login();
  await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-g','g@example.com','Gast','guest','jfgast','Gast',$1)", [encrypt(env.ctx.encKey, 'pw')]);
  guest = await env.login({ sub: 'sub-g', email: 'g@example.com', name: 'Gast', groups: [] });
  writeFileSync(join(dir, `${hex(1)}.mp4`), Buffer.alloc(300));
  writeFileSync(join(dir, `${hex(2)}.mp4`), Buffer.alloc(100));
  await env.pool.query("insert into preview_clips(item_id, status, bytes) values ($1,'ok',300), ($2,'ok',100)", [hex(1), hex(2)]);
  await env.pool.query("insert into preview_clips(item_id, status, error) values ($1,'failed','boom'), ($2,'failed','boom')", [hex(3), hex(4)]);
});
afterAll(() => env.close());

describe('request state keys', () => {
  it('maps Seerr codes to language-neutral keys', () => {
    expect(requestStateKey(2, 1)).toBe('pending');
    expect(requestStateKey(undefined, 1)).toBe('pending');
    expect(requestStateKey(2, 2)).toBe('approved');
    expect(requestStateKey(3, 2)).toBe('processing');
    expect(requestStateKey(5, 2)).toBe('available');
    expect(requestStateKey(4, 2)).toBe('partial');
    expect(requestStateKey(1, 3)).toBe('declined');
    expect(requestStateKey(5, 3)).toBe('available');
    expect(requestStateKey()).toBe('unknown');
  });
});

describe('admin requests paging', () => {
  it('passes take/skip to Seerr and reports the total and a status key', async () => {
    const r = (await call(admin, 'GET', '/api/admin/requests?filter=all&take=3&skip=3')).json();
    expect(r.total).toBe(7);
    expect(r.requests.map((x: { id: number }) => x.id)).toEqual([103, 104, 105]);
    expect(r.requests[0]).toMatchObject({ title: 'Film 503', status: 'angefragt', statusKey: 'pending', requestedBy: 'Seerr 3' });
    const last = (await call(admin, 'GET', '/api/admin/requests?filter=all&take=3&skip=6')).json();
    expect(last.requests).toHaveLength(1);
    expect(last.requests[0].statusKey).toBe('declined');
  });
  it('keeps the old defaults and validates input', async () => {
    const r = (await call(admin, 'GET', '/api/admin/requests')).json();
    expect(r.requests).toHaveLength(7);
    expect((await call(admin, 'GET', '/api/admin/requests?take=0')).statusCode).toBe(400);
    expect((await call(admin, 'GET', '/api/admin/requests?take=1000')).statusCode).toBe(400);
    expect((await call(admin, 'GET', '/api/admin/requests?filter=nope')).statusCode).toBe(400);
  });
  it('is admin only', async () => {
    expect((await call(guest, 'GET', '/api/admin/requests?take=5')).statusCode).toBe(403);
  });
});

describe('admin previews: server paging, filter, ids, clear', () => {
  it('without params: the legacy full list, failed first', async () => {
    const j = (await call(admin, 'GET', '/api/admin/previews')).json();
    expect(j.items).toHaveLength(12);
    expect(j.total).toBeUndefined();
    expect(j.items.slice(0, 2).map((i: { status: string }) => i.status)).toEqual(['failed', 'failed']);
    expect(j.summary).toMatchObject({ total: 12, ok: 2, failed: 2, missing: 8, preparing: 0, totalBytes: 400 });
  });
  it('pages with limit/offset and reports the matching total', async () => {
    const p1 = (await call(admin, 'GET', '/api/admin/previews?limit=5&offset=0&sort=name&dir=asc')).json();
    expect(p1.total).toBe(12);
    expect(p1.items.map((i: { name: string }) => i.name)).toEqual(['Titel A', 'Titel B', 'Titel C', 'Titel D', 'Titel E']);
    const p3 = (await call(admin, 'GET', '/api/admin/previews?limit=5&offset=10&sort=name&dir=desc')).json();
    expect(p3.items.map((i: { name: string }) => i.name)).toEqual(['Titel B', 'Titel A']);
    expect(p3.summary.total).toBe(12); // the summary always covers the whole library
  });
  it('filters by status and name', async () => {
    const f = (await call(admin, 'GET', '/api/admin/previews?status=failed&limit=50')).json();
    expect(f.total).toBe(2);
    expect(f.items.every((i: { status: string }) => i.status === 'failed')).toBe(true);
    const q = (await call(admin, 'GET', `/api/admin/previews?q=${encodeURIComponent('titel k')}&limit=50`)).json();
    expect(q.items.map((i: { name: string }) => i.name)).toEqual(['Titel K']);
    const big = (await call(admin, 'GET', '/api/admin/previews?status=ok&sort=size&dir=desc&limit=10')).json();
    expect(big.items.map((i: { bytes: number }) => i.bytes)).toEqual([300, 100]);
  });
  it('answers only the requested ids (row polling)', async () => {
    const j = (await call(admin, 'GET', `/api/admin/previews?ids=${hex(3)},${hex(12)}`)).json();
    expect(j.items.map((i: { itemId: string }) => i.itemId).sort()).toEqual([hex(12), hex(3)].sort());
    expect((await call(admin, 'GET', '/api/admin/previews?ids=')).json().items).toEqual([]);
  });
  it('validates input and is admin only', async () => {
    expect((await call(admin, 'GET', '/api/admin/previews?status=weird')).statusCode).toBe(400);
    expect((await call(admin, 'GET', '/api/admin/previews?limit=9999')).statusCode).toBe(400);
    expect((await call(guest, 'GET', '/api/admin/previews?limit=5')).statusCode).toBe(403);
    expect((await call(guest, 'DELETE', `/api/admin/previews/${hex(1)}`)).statusCode).toBe(403);
  });
  it('clear removes the clip and its row', async () => {
    expect((await call(admin, 'DELETE', '/api/admin/previews/not-an-id')).statusCode).toBe(404);
    expect((await call(admin, 'DELETE', `/api/admin/previews/${hex(1)}`)).json()).toEqual({ ok: true });
    expect((await env.pool.query('select 1 from preview_clips where item_id=$1', [hex(1)])).rowCount).toBe(0);
    const j = (await call(admin, 'GET', '/api/admin/previews?ids=' + hex(1))).json();
    expect(j.items[0].status).toBe('missing');
    expect(j.summary.ok).toBe(1);
  });
});

describe('admin lists: search, filter, paging', () => {
  const ids: string[] = [];
  it('setup', async () => {
    for (const n of ['Alpha', 'Beta', 'Gamma', 'Delta']) ids.push((await call(admin, 'POST', '/api/lists', { name: `${n}-Abend` })).json().id);
    ids.push((await call(admin, 'POST', '/api/lists', { name: '100% Kino_Nacht' })).json().id);
    expect((await call(admin, 'PUT', `/api/admin/lists/${ids[1]}/featured`, { featured: true })).statusCode).toBe(200);
  });
  it('lists everything by default, featured first, with counts', async () => {
    const j = (await call(admin, 'GET', '/api/admin/lists')).json();
    expect(j.lists).toHaveLength(5);
    expect(j.total).toBe(5);
    expect(j.featuredCount).toBe(1);
    expect(j.max).toBeGreaterThan(0);
    expect(j.lists[0]).toMatchObject({ id: ids[1], featured: true });
  });
  it('pages, searches (wildcards are literal) and filters', async () => {
    const p = (await call(admin, 'GET', '/api/admin/lists?limit=2&offset=2')).json();
    expect(p.lists).toHaveLength(2);
    expect(p.total).toBe(5);
    expect((await call(admin, 'GET', '/api/admin/lists?q=gamma')).json().lists.map((l: { name: string }) => l.name)).toEqual(['Gamma-Abend']);
    expect((await call(admin, 'GET', `/api/admin/lists?q=${encodeURIComponent('%')}`)).json().lists.map((l: { name: string }) => l.name)).toEqual(['100% Kino_Nacht']);
    expect((await call(admin, 'GET', `/api/admin/lists?q=${encodeURIComponent('o_n')}`)).json().total).toBe(1);
    expect((await call(admin, 'GET', '/api/admin/lists?q=admin')).json().total).toBe(5); // owner name matches too
    const f = (await call(admin, 'GET', '/api/admin/lists?featured=0')).json();
    expect(f.total).toBe(4);
    expect(f.featuredCount).toBe(1);
    expect((await call(admin, 'GET', '/api/admin/lists?limit=0')).statusCode).toBe(400);
    expect((await call(guest, 'GET', '/api/admin/lists?limit=1')).statusCode).toBe(403);
  });
});

describe('admin live sessions', () => {
  it('lists what plays and ends a stream (audited); unknown sessions are 404', async () => {
    const userId = (await env.pool.query("select id from users where name='Gast'")).rows[0].id as string;
    await setLive(env.ctx, { userId, userName: 'Gast', itemId: hex(5), title: 'Titel E', type: 'Movie', positionTicks: 600_000_000, runtimeTicks: 6_000_000_000, isPaused: false, playSessionId: 'ps-1', updatedAt: Date.now(), source: 'portal' });
    const l = (await call(admin, 'GET', '/api/admin/live')).json().sessions;
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ userName: 'Gast', title: 'Titel E', playSessionId: 'ps-1', isPaused: false, seriesName: null });
    expect((await call(guest, 'GET', '/api/admin/live')).statusCode).toBe(403);
    expect((await call(guest, 'POST', '/api/admin/live/stop', { userId, playSessionId: 'ps-1' })).statusCode).toBe(403);
    expect((await call(admin, 'POST', '/api/admin/live/stop', { userId, playSessionId: 'nope' })).statusCode).toBe(404);
    expect((await call(admin, 'POST', '/api/admin/live/stop', { userId: 'x', playSessionId: 'ps-1' })).statusCode).toBe(400);
    expect((await call(admin, 'POST', '/api/admin/live/stop', { userId, playSessionId: 'ps-1' })).json()).toEqual({ ok: true });
    expect(env.jfCalls.some((c) => c.method === 'DELETE' && c.path === '/Videos/ActiveEncodings' && c.search.includes('ps-1'))).toBe(true);
    expect((await call(admin, 'GET', '/api/admin/live')).json().sessions).toEqual([]);
    expect((await env.pool.query("select 1 from audit_log where action='live.stop'")).rowCount).toBe(1);
  });
});

describe('admin downloads: job titles', () => {
  it('jobs carry the title of their licenses (no raw item ids in the UI)', async () => {
    const me = (await env.pool.query("select u.id user_id, d.device_id, p.id profile_id from users u join devices d on d.user_id=u.id join profiles p on p.user_id=u.id where u.name='Admin' limit 1")).rows[0];
    const job = (await env.pool.query("insert into download_jobs(id, item_id, quality, audio_lang, status) values (gen_random_uuid(), $1, 'hd', 'deu', 'ready') returning id", [hex(7)])).rows[0].id;
    await env.pool.query("insert into downloads(id, user_id, device_id, profile_id, item_id, job_id, quality, status, expires_at, meta) values (gen_random_uuid(), $1, $2, $3, $4, $5, 'hd', 'fetched', now() + interval '1 day', $6)",
      [me.user_id, me.device_id, me.profile_id, hex(7), job, JSON.stringify({ title: 'Folge 3', seriesName: 'Meine Serie' })]);
    const j = (await call(admin, 'GET', '/api/admin/downloads')).json();
    expect(j.jobs[0]).toMatchObject({ item_id: hex(7), title: 'Folge 3', series_name: 'Meine Serie', licenses: 1 });
  });
});
