// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { hygieneIdle } from '../src/hygiene/scan.js';
import { MediaError, type HygieneFacts } from '../src/media/types.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

// Block 22 Task 6: hygiene admin API (summary, list, ignore, refresh, scan).
type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess;
let adminId = '';
const id = (n: number) => n.toString(16).padStart(32, 'a');
const SERIES = 'c'.repeat(32);
const as = (s: Sess, method: string, url: string, payload?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: payload as object });

const facts = (o: Record<string, unknown> = {}) => ({
  overview: true, poster: true, backdrop: true, providerIds: { tmdb: '603' }, virtual: false, runtimeTicks: 6e10,
  sources: [{ container: 'mkv', bitrate: 8e6, sizeBytes: 4e9, video: [{ codec: 'h264', bitDepth: 8, height: 1080 }], audio: [{ codec: 'aac', lang: 'deu', channels: 2 }], subtitles: [] }],
  ...o,
});
async function seed(n: number, type: string, name: string, issues: string[], o: { seriesId?: string; seriesName?: string; year?: number; facts?: object; ids?: string } = {}) {
  await env.pool.query(
    `insert into hygiene_items(item_id, type, name, series_id, series_name, year, facts, issues, ids_key) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id(n), type, name, o.seriesId ?? null, o.seriesName ?? null, o.year ?? 2001, JSON.stringify(o.facts ?? facts()), issues, o.ids ?? null]);
}

let refreshCalls: string[] = [];
beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login(ADMIN);
  adminId = (await env.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id;
  await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-f','f@example.com','Fritz','friend','jffritz','Fritz',$1)", [encrypt(env.ctx.encKey, 'pw')]);
  (env.ctx.jf as { refreshMetadata?: unknown }).refreshMetadata = async (itemId: string) => {
    refreshCalls.push(itemId);
    if (itemId === id(999)) throw new MediaError(404, 'Jellyfin refresh -> 404 http://jellyfin:8096/Items?api_key=adminkey');
  };
  (env.ctx.jf as { libraryHygiene?: unknown }).libraryHygiene = async (): Promise<HygieneFacts[]> => [];
});
afterAll(() => env.close());
beforeEach(async () => {
  refreshCalls = [];
  await env.pool.query('delete from hygiene_items; delete from hygiene_ignored; delete from audit_log');
  for (const k of await env.kv.keys('hygiene:')) await env.kv.del(k);
  await seed(1, 'Movie', 'Alpha', ['no_poster', 'no_backdrop']);
  await seed(2, 'Movie', 'Beta 100%', ['foreign_no_subs'], { facts: facts({ sources: [{ container: 'mp4', bitrate: 45e6, sizeBytes: 9e9, video: [{ codec: 'hevc', bitDepth: 10, height: 2160, hdr: true }], audio: [{ codec: 'dts', lang: 'eng', channels: 6 }], subtitles: [{ codec: 'subrip', lang: 'deu', forced: true, text: true }, { codec: 'pgssub', lang: 'eng', forced: false, text: false }] }] }) });
  await seed(3, 'Movie', 'Gamma', ['dup_ids'], { ids: 'Movie:tmdb:603' });
  await seed(4, 'Movie', 'Gamma (Kopie)', ['dup_ids'], { ids: 'Movie:tmdb:603', facts: { ...facts(), path: '/mnt/media/secret.mkv', sources: [{ path: '/mnt/media/secret.mkv', video: [], audio: [], subtitles: [] }] } });
  await seed(5, 'Episode', 'Folge 1', ['no_audio'], { seriesId: SERIES, seriesName: 'Delta Serie', year: undefined });
  await seed(6, 'Episode', 'Folge 2', ['zero_runtime'], { seriesId: SERIES, seriesName: 'Delta Serie' });
  await seed(7, 'Movie', 'Clean', []);
});

const list = async (qs: string) => {
  const r = await as(admin, 'GET', `/api/admin/hygiene${qs}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { items: Array<Record<string, any>>; total: number };
};

describe('hygiene admin API', () => {
  it('summary counts per category and issue; ignored excluded and counted in ignored', async () => {
    let s = (await as(admin, 'GET', '/api/admin/hygiene/summary')).json();
    expect(s).toMatchObject({ total: 6, ignored: 0, canRefresh: true, state: { supported: true, running: false, lastDone: null, lastFull: null } });
    expect(s.byCategory).toEqual({ info: 1, language: 2, duplicate: 2, file: 1 });
    expect(s.byIssue).toEqual({ no_poster: 1, no_backdrop: 1, foreign_no_subs: 1, dup_ids: 2, no_audio: 1, zero_runtime: 1 });
    expect((await as(admin, 'POST', '/api/admin/hygiene/ignore', { itemId: id(2), code: 'foreign_no_subs' })).statusCode).toBe(200);
    s = (await as(admin, 'GET', '/api/admin/hygiene/summary')).json();
    expect(s).toMatchObject({ total: 5, ignored: 1 });
    expect(s.byIssue.foreign_no_subs).toBeUndefined();
    expect(s.byCategory.language).toBe(1);
  });

  it('filters: category, issue, type + seriesId, q (ilike, escaped)', async () => {
    expect((await list('?category=language')).items.map((r) => r.itemId).sort()).toEqual([id(2), id(5)]);
    expect((await list('?issue=dup_ids')).items.map((r) => r.itemId).sort()).toEqual([id(3), id(4)]);
    const eps = await list(`?type=Episode&seriesId=${SERIES}`);
    expect(eps.total).toBe(2);
    expect(eps.items[0]).toMatchObject({ type: 'Episode', seriesId: SERIES, seriesName: 'Delta Serie' });
    expect((await list('?q=delta')).items.map((r) => r.itemId).sort()).toEqual([id(5), id(6)]);
    expect((await list('?q=gAmMa')).total).toBe(2);
    expect((await list('?q=100%25')).items.map((r) => r.itemId)).toEqual([id(2)]);
    expect((await list('?q=%25')).items.map((r) => r.itemId)).toEqual([id(2)]); // "%" is a literal, not a wildcard
    expect((await list('?q=_')).total).toBe(0);
    expect((await list('')).items.map((r) => r.itemId)).not.toContain(id(7)); // only rows with an issue
  });

  it('sort size desc, paging limit/offset and total', async () => {
    const all = await list('?sort=size&dir=desc');
    expect(all.total).toBe(6);
    expect(all.items[0]!.itemId).toBe(id(2));
    const p1 = await list('?sort=name&dir=asc&limit=2&offset=0');
    const p2 = await list('?sort=name&dir=asc&limit=2&offset=2');
    expect(p1.total).toBe(6);
    expect(p1.items.map((r) => r.name)).toEqual(['Alpha', 'Beta 100%']);
    expect(p2.items.map((r) => r.name)).toEqual(['Folge 1', 'Folge 2']); // episodes sort by their series name
    expect((await list('?sort=issues')).items[0]!.itemId).toBe(id(1));
  });

  it('row strings: video "hevc 10-bit 2160p HDR", audio "eng dts 6ch", subtitles "deu forced"', async () => {
    const r = (await list('?issue=foreign_no_subs')).items[0]!;
    expect(r).toMatchObject({
      itemId: id(2), type: 'Movie', name: 'Beta 100%', year: 2001, versions: 1, container: 'mp4', bitrate: 45e6, sizeBytes: 9e9,
      video: 'hevc 10-bit 2160p HDR', audio: ['eng dts 6ch'], subtitles: ['deu forced', 'eng pgs'],
      issues: [{ code: 'foreign_no_subs', severity: 'warn' }], dupOf: [],
    });
    const plain = (await list('?issue=no_poster')).items[0]!;
    expect(plain).toMatchObject({ video: 'h264 1080p', audio: ['deu aac 2ch'], subtitles: [], issues: [{ code: 'no_poster', severity: 'warn' }, { code: 'no_backdrop', severity: 'info' }] });
  });

  it('dupOf lists the other items with the same key; row JSON never has a path', async () => {
    const d = await list('?issue=dup_ids');
    expect(d.items.find((r) => r.itemId === id(3))!.dupOf).toEqual([id(4)]);
    expect(d.items.find((r) => r.itemId === id(4))!.dupOf).toEqual([id(3)]);
    const all = JSON.stringify((await list('?limit=200')).items);
    expect(all).not.toContain('/mnt/media');
    expect(all).not.toContain('path');
  });

  it('ignore → the row drops out when it was its only issue; unignore brings it back; audit entries without names', async () => {
    expect((await as(admin, 'POST', '/api/admin/hygiene/ignore', { itemId: id(6), code: 'zero_runtime' })).json()).toEqual({ ok: true });
    expect((await list('')).items.map((r) => r.itemId)).not.toContain(id(6));
    expect((await as(admin, 'POST', '/api/admin/hygiene/ignore', { itemId: id(1), code: 'no_backdrop' })).statusCode).toBe(200);
    expect((await list('?issue=no_backdrop')).total).toBe(0);
    expect((await list('?issue=no_poster')).items[0]!.issues).toEqual([{ code: 'no_poster', severity: 'warn' }]);
    expect((await as(admin, 'DELETE', '/api/admin/hygiene/ignore', { itemId: id(6), code: 'zero_runtime' })).json()).toEqual({ ok: true });
    expect((await list('')).items.map((r) => r.itemId)).toContain(id(6));
    const a = (await env.pool.query("select actor, action, target, meta from audit_log where action like 'hygiene.%' order by id")).rows;
    expect(a.map((x) => x.action)).toEqual(['hygiene.ignore', 'hygiene.ignore', 'hygiene.unignore']);
    expect(a[0]).toMatchObject({ actor: adminId, target: id(6), meta: { code: 'zero_runtime' } });
    expect(JSON.stringify(a)).not.toContain('Folge');
  });

  it('refresh calls refreshMetadata once; unknown id → 404; server without it → 501 unsupported', async () => {
    const r = await as(admin, 'POST', `/api/admin/hygiene/${id(1)}/refresh`);
    expect(r.json()).toEqual({ ok: true });
    expect(refreshCalls).toEqual([id(1)]);
    const nf = await as(admin, 'POST', `/api/admin/hygiene/${id(999)}/refresh`);
    expect(nf.statusCode).toBe(404);
    expect(nf.body).not.toContain('api_key');
    expect(nf.body).not.toContain('jellyfin');
    expect((await env.pool.query("select count(*)::int n from audit_log where action = 'hygiene.refresh'")).rows[0].n).toBe(1);
    const fn = env.ctx.jf.refreshMetadata;
    (env.ctx.jf as { refreshMetadata?: unknown }).refreshMetadata = undefined;
    try {
      const u = await as(admin, 'POST', `/api/admin/hygiene/${id(1)}/refresh`);
      expect(u.statusCode).toBe(501);
      expect(u.json()).toEqual({ error: 'unsupported' });
      expect((await as(admin, 'GET', '/api/admin/hygiene/summary')).json().canRefresh).toBe(false);
    } finally {
      (env.ctx.jf as { refreshMetadata?: unknown }).refreshMetadata = fn;
    }
    expect((await as(admin, 'POST', '/api/admin/hygiene/bad%20id/refresh')).statusCode).toBe(400);
  });

  it('refresh rate limit 30/min', async () => {
    for (let i = 0; i < 28; i++) expect((await as(admin, 'POST', `/api/admin/hygiene/${id(1)}/refresh`)).statusCode).toBe(200);
    expect((await as(admin, 'POST', `/api/admin/hygiene/${id(1)}/refresh`)).statusCode).toBe(429); // 2 counted in the test above
  });

  it('scan: starts a full sweep; while running → started false; third call in 10 min → 429', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fn = env.ctx.jf.libraryHygiene;
    (env.ctx.jf as { libraryHygiene?: unknown }).libraryHygiene = async () => { await gate; return []; };
    try {
      expect((await as(admin, 'POST', '/api/admin/hygiene/scan')).json()).toEqual({ started: true });
      expect((await as(admin, 'GET', '/api/admin/hygiene/summary')).json().state.running).toBe(true);
      expect((await as(admin, 'POST', '/api/admin/hygiene/scan')).json()).toEqual({ started: false });
      expect((await as(admin, 'POST', '/api/admin/hygiene/scan')).statusCode).toBe(429);
      release();
      await hygieneIdle();
    } finally {
      (env.ctx.jf as { libraryHygiene?: unknown }).libraryHygiene = fn;
    }
    expect((await env.pool.query("select count(*)::int n from audit_log where action = 'hygiene.scan'")).rows[0].n).toBe(2);
  });

  it('friend 403; admin on a non-owner profile 403; no session 401; bad issue code → 400', async () => {
    const fritz = await env.login({ sub: 'sub-f', email: 'f@example.com', name: 'Fritz', groups: [] });
    const s = await env.login(ADMIN);
    const pid = randomUUID();
    await env.pool.query('insert into profiles(id, user_id, name, is_owner, kids, jellyfin_user_id) values ($1, $2, $3, false, false, $4)', [pid, adminId, 'Gast', 'f'.repeat(32)]);
    const raw = JSON.parse((await env.kv.get(`sess:${s.cookies.ff_sid}`))!);
    await env.kv.set(`sess:${s.cookies.ff_sid}`, JSON.stringify({ ...raw, profileId: pid }), 600);
    const calls: Array<[string, string, unknown?]> = [
      ['GET', '/api/admin/hygiene/summary'], ['GET', '/api/admin/hygiene'], ['POST', '/api/admin/hygiene/ignore', { itemId: id(1), code: 'no_poster' }],
      ['DELETE', '/api/admin/hygiene/ignore', { itemId: id(1), code: 'no_poster' }], ['POST', `/api/admin/hygiene/${id(1)}/refresh`], ['POST', '/api/admin/hygiene/scan'],
    ];
    for (const [m, u, b] of calls) {
      expect((await as(fritz, m, u, b)).statusCode, `friend ${m} ${u}`).toBe(403);
      expect((await as(s, m, u, b)).statusCode, `non-owner ${m} ${u}`).toBe(403);
      expect((await env.app.inject({ method: m as 'GET', url: u, payload: b as object })).statusCode, `anon ${m} ${u}`).toBe(401);
    }
    await env.pool.query('delete from profiles where id=$1', [pid]);
    expect((await as(admin, 'GET', '/api/admin/hygiene?issue=bogus')).statusCode).toBe(400);
    expect((await as(admin, 'GET', '/api/admin/hygiene?limit=500')).statusCode).toBe(400);
    expect((await as(admin, 'POST', '/api/admin/hygiene/ignore', { itemId: id(1), code: 'bogus' })).statusCode).toBe(400);
    expect(refreshCalls).toEqual([]);
  });
});
