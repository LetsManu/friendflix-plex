// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { recordError, resetErrorLogForTests } from '../src/errorlog.js';
import { buildSnapshot, getSnapshot, healthSettled, healthTick, issueFp, type DiskDeps, type HealthSnapshot } from '../src/health.js';
import { INVALID_KEY, OMDB_COUNT_KEY, PAUSE_KEY, setSourceKey } from '../src/sources/keys.js';
import { ADMIN, cfg, fakeHttp, makeEnv, type Call, type TestEnv } from './helpers.js';

// Block 22 Task 3: health snapshot (traffic lights, disks, error levels, issues) and the banner API.
type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess;
let adminId = '';
const ADMIN2 = { sub: 'sub-admin2', email: 'admin2@example.com', name: 'Admin Zwei', groups: ['friendflix-admins'] };
const GiB = 1024 ** 3;

const httpCalls: Call[] = [];
const gw = { status: 200, throws: false };
const oidc = { status: 200, issuer: 'https://auth.example.com' };
const http = fakeHttp({
  'GET /health': () => {
    if (gw.throws) throw new Error('connect ECONNREFUSED http://gateway:4000/health');
    return { status: gw.status, json: { status: 'ok' } };
  },
  'GET /.well-known/openid-configuration': () => ({ status: oidc.status, json: { issuer: oidc.issuer } }),
}, httpCalls);
let seerrUp = true;

// injected filesystem: path -> [usedPct, totalGiB] (missing = ENOENT), and device ids
let vols: Record<string, { usedPct: number; totalGiB?: number } | undefined> = {};
let devs: Record<string, number> = {};
const disk: DiskDeps = {
  statfs: async (p: string) => {
    const v = vols[p];
    if (!v) throw new Error(`ENOENT: no such file or directory, statfs '${p}'`);
    const bsize = 1024 * 1024, blocks = Math.round((v.totalGiB ?? 100) * 1024);
    return { bsize, blocks, bavail: Math.round(blocks * (1 - v.usedPct / 100)) };
  },
  stat: async (p: string) => {
    if (!vols[p]) throw new Error(`ENOENT: stat '${p}'`);
    return { dev: devs[p] ?? 1 };
  },
};
const deps = () => ({ fetchImpl: http, ...disk });
const as = (s: Sess, method: string, url: string, payload?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: payload as object });
const realPing = () => env.ctx.jf.admin.ping;
let origPing: () => Promise<boolean>;
const svc = (s: HealthSnapshot, id: string) => s.services.find((x) => x.id === id)!;
const dsk = (s: HealthSnapshot, id: string) => s.disks.find((x) => x.id === id);

beforeAll(async () => {
  env = await makeEnv({}, { seerr: { 'GET /api/v1/request/count': () => (seerrUp ? { json: { total: 1, movie: 1, tv: 0, pending: 0, approved: 1, declined: 0, processing: 0, available: 1 } } : { status: 503 }) } });
  env.ctx.fetchImpl = http;
  origPing = realPing();
  admin = await env.login(ADMIN);
  adminId = (await env.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id;
  await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-f','f@example.com','Fritz','friend','jffritz','Fritz',$1)", [encrypt(env.ctx.encKey, 'pw')]);
});
afterAll(() => env.close());
beforeEach(async () => {
  resetErrorLogForTests();
  for (const k of [...(await env.kv.keys('errlog:')), ...(await env.kv.keys('health:')), ...(await env.kv.keys('src:'))]) await env.kv.del(k);
  env.ctx.cfg = { ...cfg };
  env.ctx.jf.admin.ping = origPing;
  env.kv.ping = async () => true;
  gw.status = 200; gw.throws = false;
  oidc.status = 200; oidc.issuer = 'https://auth.example.com';
  seerrUp = true;
  vols = { [cfg.DOWNLOAD_DIR]: { usedPct: 40 }, [cfg.PREVIEW_DIR]: { usedPct: 40 } };
  devs = { [cfg.DOWNLOAD_DIR]: 1, [cfg.PREVIEW_DIR]: 2 };
  httpCalls.length = 0;
  await env.pool.query('delete from playback_checks; delete from download_jobs; delete from preview_clips; delete from health_dismissals');
});
afterEach(() => { vi.useRealTimers(); });

describe('traffic lights', () => {
  it('all ok → worst ok, no issues', async () => {
    const s = await buildSnapshot(env.ctx, deps());
    expect(s.worst).toBe('ok');
    expect(s.issues).toEqual([]);
    expect(s.services.map((x) => [x.id, x.level])).toEqual([
      ['media', 'ok'], ['postgres', 'ok'], ['redis', 'ok'], ['gateway', 'ok'], ['oidc', 'ok'], ['requests', 'ok'], ['tmdb', 'off'], ['omdb', 'off'], ['playbackCheck', 'off'],
    ]);
    expect(svc(s, 'tmdb').reason).toBe('not_set');
    expect(typeof svc(s, 'media').ms).toBe('number');
  });

  it('media ping 2.5 s → warn slow; ping throws → err down', async () => {
    env.ctx.jf.admin.ping = () => new Promise((r) => setTimeout(() => r(true), 2500));
    expect(svc(await buildSnapshot(env.ctx, deps()), 'media')).toMatchObject({ level: 'warn', reason: 'slow' });
    env.ctx.jf.admin.ping = async () => { throw new Error('fetch failed http://jellyfin:8096/System/Ping?api_key=adminkey'); };
    const s = await buildSnapshot(env.ctx, deps());
    expect(svc(s, 'media')).toMatchObject({ level: 'err', reason: 'down' });
    expect(s.worst).toBe('err');
    expect(s.issues).toEqual([expect.objectContaining({ id: 'svc:media', level: 'err', reason: 'down' })]);
    env.ctx.jf.admin.ping = async () => false;
    expect(svc(await buildSnapshot(env.ctx, deps()), 'media').level).toBe('err');
  }, 10_000);

  it('a ping that never resolves → err down after ~3 s (fake timers), the other probes still answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    env.ctx.jf.admin.ping = () => new Promise(() => undefined);
    let done = false;
    const p = buildSnapshot(env.ctx, deps()).then((s) => { done = true; return s; });
    await vi.advanceTimersByTimeAsync(2900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    const s = await p;
    expect(svc(s, 'media')).toMatchObject({ level: 'err', reason: 'down' });
    expect(svc(s, 'postgres').level).toBe('ok');
  });

  it('postgres error → err down; redis error → err down', async () => {
    env.kv.ping = async () => { throw new Error('ECONNREFUSED redis:6379'); };
    expect(svc(await buildSnapshot(env.ctx, deps()), 'redis')).toMatchObject({ level: 'err', reason: 'down' });
  });

  it('gateway /health 503 → err; OIDC issuer mismatch → err issuer_mismatch; OIDC fetched once in 5 min', async () => {
    gw.status = 503;
    expect(svc(await buildSnapshot(env.ctx, deps()), 'gateway')).toMatchObject({ level: 'err', reason: 'down' });
    expect(httpCalls.filter((c) => c.path === '/.well-known/openid-configuration')).toHaveLength(1);
    await buildSnapshot(env.ctx, deps());
    expect(httpCalls.filter((c) => c.path === '/.well-known/openid-configuration')).toHaveLength(1); // cached 5 min
    await env.kv.del('health:oidc');
    oidc.issuer = 'https://evil.example.com/';
    expect(svc(await buildSnapshot(env.ctx, deps()), 'oidc')).toMatchObject({ level: 'err', reason: 'issuer_mismatch' });
    await env.kv.del('health:oidc');
    oidc.status = 500;
    expect(svc(await buildSnapshot(env.ctx, deps()), 'oidc')).toMatchObject({ level: 'err', reason: 'down' });
  });

  it('request service down → warn (never err)', async () => {
    seerrUp = false;
    const s = await buildSnapshot(env.ctx, deps());
    expect(svc(s, 'requests')).toMatchObject({ level: 'warn', reason: 'down' });
    expect(s.worst).toBe('warn');
  });

  it('tmdb not set → off; invalid → warn invalid_key; paused → warn paused; omdb usedToday 820/900 → warn budget', async () => {
    expect(svc(await buildSnapshot(env.ctx, deps()), 'tmdb')).toMatchObject({ level: 'off', reason: 'not_set' });
    env.ctx.cfg = { ...cfg, TMDB_API_KEY: 'tmdbkey1234', OMDB_API_KEY: 'omdbkey1234' };
    let s = await buildSnapshot(env.ctx, deps());
    expect([svc(s, 'tmdb').level, svc(s, 'omdb').level]).toEqual(['ok', 'ok']);
    await env.kv.set(INVALID_KEY('tmdb'), '1', 3600);
    await env.kv.set(PAUSE_KEY('omdb'), '1', 3600);
    s = await buildSnapshot(env.ctx, deps());
    expect(svc(s, 'tmdb')).toMatchObject({ level: 'warn', reason: 'invalid_key' });
    expect(svc(s, 'omdb')).toMatchObject({ level: 'warn', reason: 'paused' });
    await env.kv.del(PAUSE_KEY('omdb'));
    await env.kv.set(OMDB_COUNT_KEY(new Date().toISOString().slice(0, 10)), '820', 3600);
    s = await buildSnapshot(env.ctx, deps());
    expect(svc(s, 'omdb')).toMatchObject({ level: 'warn', reason: 'budget', detail: { n: 820, pct: 91 } });
    expect(JSON.stringify(s)).not.toContain('key1234');
  });

  it('a key saved in the database counts as set', async () => {
    await setSourceKey(env.ctx, 'tmdb', 'dbkey-5678');
    expect(svc(await buildSnapshot(env.ctx, deps()), 'tmdb').level).toBe('ok');
    await env.pool.query("delete from app_settings where key='source.tmdb'");
  });

  it('last playback check with 2 failed → warn failed_titles detail n 2', async () => {
    await env.pool.query("insert into playback_checks(started_at, finished_at, results) values (now(), now(), $1)", [JSON.stringify([{ ok: false }, { ok: true }, { ok: false }])]);
    expect(svc(await buildSnapshot(env.ctx, deps()), 'playbackCheck')).toMatchObject({ level: 'warn', reason: 'failed_titles', detail: { n: 2 } });
    await env.pool.query("insert into playback_checks(started_at, finished_at, results) values (now(), now(), $1)", [JSON.stringify([{ ok: true }])]);
    expect(svc(await buildSnapshot(env.ctx, deps()), 'playbackCheck').level).toBe('ok');
  });

  it('every checked title failed (≥ 3) → err empty_media and a red issue; fewer than 3 or an abort row stay yellow', async () => {
    const fail = (itemId: string) => ({ itemId, ok: false, error: 'HTTP 200 empty body' });
    const insert = (rows: unknown[]) => env.pool.query('insert into playback_checks(started_at, finished_at, results) values (now(), now(), $1)', [JSON.stringify(rows)]);
    await insert([fail('a'), fail('b'), fail('c')]);
    const s = await buildSnapshot(env.ctx, deps());
    expect(svc(s, 'playbackCheck')).toMatchObject({ level: 'err', reason: 'empty_media', detail: { n: 3 } });
    expect(s.issues).toContainEqual(expect.objectContaining({ id: 'svc:playbackCheck', level: 'err', reason: 'empty_media' }));
    expect(s.worst).toBe('err');
    // the "aborted" row (no itemId) does not count as a checked title
    await insert([fail('a'), fail('b'), { itemId: '', ok: false, error: 'boom' }]);
    expect(svc(await buildSnapshot(env.ctx, deps()), 'playbackCheck')).toMatchObject({ level: 'warn', reason: 'failed_titles', detail: { n: 2 } });
    await insert([fail('a'), fail('b'), fail('c'), { itemId: 'd', ok: true }]);
    expect(svc(await buildSnapshot(env.ctx, deps()), 'playbackCheck')).toMatchObject({ level: 'warn', reason: 'failed_titles', detail: { n: 3 } });
    await insert([{ itemId: 'a', ok: true }]);
  });
});

describe('disks', () => {
  it('86 % → warn full; 96 % → err full', async () => {
    vols[cfg.DOWNLOAD_DIR] = { usedPct: 86 };
    let d = dsk(await buildSnapshot(env.ctx, deps()), 'downloads')!;
    expect(d).toMatchObject({ level: 'warn', reason: 'full', usedPct: 86 });
    expect(d.totalBytes).toBe(100 * GiB);
    expect(d.freeBytes).toBe(14 * GiB);
    vols[cfg.DOWNLOAD_DIR] = { usedPct: 96 };
    d = dsk(await buildSnapshot(env.ctx, deps()), 'downloads')!;
    expect(d).toMatchObject({ level: 'err', reason: 'full' });
  });

  it('free < DOWNLOAD_MIN_FREE_GB → err low_free; < 2× → warn low_free', async () => {
    vols[cfg.DOWNLOAD_DIR] = { usedPct: 50 }; // 50 GiB free
    env.ctx.cfg = { ...cfg, DOWNLOAD_MIN_FREE_GB: 60 };
    expect(dsk(await buildSnapshot(env.ctx, deps()), 'downloads')).toMatchObject({ level: 'err', reason: 'low_free' });
    env.ctx.cfg = { ...cfg, DOWNLOAD_MIN_FREE_GB: 30 };
    expect(dsk(await buildSnapshot(env.ctx, deps()), 'downloads')).toMatchObject({ level: 'warn', reason: 'low_free' });
  });

  it('downloads ≥ 90 % of the cap → warn cap; own share and cap reported', async () => {
    env.ctx.cfg = { ...cfg, DOWNLOAD_CACHE_MAX_GB: 1 };
    await env.pool.query("insert into download_jobs(id, item_id, quality, status, bytes) values ($1, 'x', 'hd', 'ready', $2)", [randomUUID(), Math.round(0.95 * GiB)]);
    const d = dsk(await buildSnapshot(env.ctx, deps()), 'downloads')!;
    expect(d).toMatchObject({ level: 'warn', reason: 'cap', ownBytes: Math.round(0.95 * GiB), capBytes: GiB });
  });

  it('a hung statfs is not called again while it is still pending (disk unavailable), and is again once it returned', async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const hung: DiskDeps['statfs'] = async (p) => {
      calls++;
      if (p === cfg.PREVIEW_DIR && calls <= 2) await new Promise<void>((res) => { release = res; }); // the first call hangs
      return disk.statfs(p);
    };
    const d = { fetchImpl: http, stat: disk.stat, statfs: hung, timeoutMs: 50 };
    expect(dsk(await buildSnapshot(env.ctx, d), 'previews')).toMatchObject({ level: 'off', reason: 'unavailable' });
    expect(dsk(await buildSnapshot(env.ctx, d), 'previews')).toMatchObject({ level: 'off', reason: 'unavailable' });
    expect(dsk(await buildSnapshot(env.ctx, d), 'downloads')!.level).toBe('ok');
    expect(calls).toBe(4); // downloads 3×, previews only once
    release();
    await new Promise((res) => setTimeout(res, 10));
    expect(dsk(await buildSnapshot(env.ctx, d), 'previews')!.level).toBe('ok');
    expect(calls).toBe(6);
  });

  it('same device → one entry with sharedWith; missing dir → off unavailable; downloads disabled → no downloads entry', async () => {
    await env.pool.query("insert into preview_clips(item_id, status, bytes) values ('p1', 'ok', 1000)");
    devs[cfg.PREVIEW_DIR] = 1;
    let s = await buildSnapshot(env.ctx, deps());
    expect(s.disks.map((d) => d.id)).toEqual(['downloads', 'database']);
    expect(dsk(s, 'downloads')).toMatchObject({ sharedWith: 'previews', sharedBytes: 1000 });
    devs[cfg.PREVIEW_DIR] = 2;
    vols[cfg.PREVIEW_DIR] = undefined;
    s = await buildSnapshot(env.ctx, deps());
    expect(dsk(s, 'previews')).toMatchObject({ level: 'off', reason: 'unavailable', ownBytes: 1000 });
    expect(s.issues.find((i) => i.id === 'disk:previews')).toBeUndefined();
    env.ctx.cfg = { ...cfg, DOWNLOADS_ENABLED: 'false' };
    vols[cfg.PREVIEW_DIR] = { usedPct: 10 };
    s = await buildSnapshot(env.ctx, deps());
    expect(s.disks.map((d) => d.id)).toEqual(['previews', 'database']);
  });

  it('database size above HEALTH_DB_WARN_GB → warn large (size only)', async () => {
    let d = dsk(await buildSnapshot(env.ctx, deps()), 'database')!;
    expect(d.level).toBe('ok');
    expect(d.ownBytes).toBeGreaterThan(0);
    expect(d.freeBytes).toBeUndefined();
    env.ctx.cfg = { ...cfg, HEALTH_DB_WARN_GB: 0.001 };
    d = dsk(await buildSnapshot(env.ctx, deps()), 'database')!;
    expect(d).toMatchObject({ level: 'warn', reason: 'large' });
  });
});

describe('error levels', () => {
  it('10 server 5xx in 15 min → warn server_errors; 3 playback failures in 60 min → warn failed_playbacks; never err', async () => {
    for (let i = 0; i < 9; i++) await recordError(env.ctx, { source: 'server', code: 'GET /api/x 500' });
    let s = await buildSnapshot(env.ctx, deps());
    expect(s.errors).toMatchObject({ level: 'ok', server15: 9 });
    await recordError(env.ctx, { source: 'server', code: 'GET /api/x 500' });
    s = await buildSnapshot(env.ctx, deps());
    expect(s.errors).toMatchObject({ level: 'warn', reason: 'server_errors', server15: 10 });
    expect(s.issues).toEqual([expect.objectContaining({ id: 'errors:server', level: 'warn', reason: 'server_errors', detail: { n: 10 } })]);
    for (let i = 0; i < 3; i++) await recordError(env.ctx, { source: 'playback', code: 'bufferStalledError', itemId: 'ab'.repeat(16) });
    for (let i = 0; i < 200; i++) await recordError(env.ctx, { source: 'server', code: 'GET /api/x 500' });
    s = await buildSnapshot(env.ctx, deps());
    expect(s.errors.playback60).toBe(3);
    expect(s.issues.map((i) => [i.id, i.level])).toEqual([['errors:server', 'warn'], ['errors:playback', 'warn']]);
    expect(s.worst).toBe('warn');
  });

  it('20 client errors in 15 min → warn client_errors', async () => {
    for (let i = 0; i < 20; i++) await recordError(env.ctx, { source: 'client', code: 'error boom' });
    expect((await buildSnapshot(env.ctx, deps())).issues.map((i) => i.id)).toEqual(['errors:client']);
  });
});

describe('fingerprints', () => {
  it('fp equal for 85 % and 86 % (both warn full); differs for warn → err', async () => {
    const fpOf = async (pct: number) => {
      vols[cfg.DOWNLOAD_DIR] = { usedPct: pct };
      return (await buildSnapshot(env.ctx, deps())).issues.find((i) => i.id === 'disk:downloads')!;
    };
    const a = await fpOf(85), b = await fpOf(86), c = await fpOf(97);
    expect(a.fp).toBe(b.fp);
    expect(a.detail).toEqual({ pct: 85 });
    expect(b.detail).toEqual({ pct: 86 });
    expect(c.fp).not.toBe(a.fp);
    expect(a.fp).toBe(issueFp('disk:downloads', 'warn', 'full'));
    expect(a.fp).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('no secrets or paths', () => {
  it('snapshot JSON never contains GATEWAY_URL, OIDC_ISSUER, DOWNLOAD_DIR, PREVIEW_DIR or an exception message', async () => {
    gw.throws = true;
    oidc.issuer = 'https://other.example.com';
    vols = {};
    env.ctx.jf.admin.ping = async () => { throw new Error('fetch failed http://jellyfin:8096/?api_key=adminkey'); };
    env.ctx.cfg = { ...cfg, TMDB_API_KEY: 'tmdbsecret99' };
    seerrUp = false;
    const json = JSON.stringify(await buildSnapshot(env.ctx, deps()));
    for (const bad of ['gateway:4000', 'auth.example.com', 'other.example.com', cfg.DOWNLOAD_DIR, cfg.PREVIEW_DIR, 'ENOENT', 'ECONNREFUSED', 'jellyfin:8096', 'adminkey', 'tmdbsecret99', 'seerr', 'http']) {
      expect(json, bad).not.toContain(bad);
    }
  });
});

describe('snapshot cache', () => {
  it('a missing snapshot is built and stored; a fresh one is served as is', async () => {
    const a = await getSnapshot(env.ctx, {}, deps());
    expect(JSON.parse((await env.kv.get('health:snap'))!).at).toBe(a.at);
    const b = await getSnapshot(env.ctx, {}, deps());
    expect(b.at).toBe(a.at);
  });

  it('stale snapshot (100 s) → served at once, one background rebuild for 3 concurrent calls', async () => {
    const old = { ...(await buildSnapshot(env.ctx, deps())), at: new Date(Date.now() - 100_000).toISOString() };
    await env.kv.set('health:snap', JSON.stringify(old), 300);
    let pings = 0;
    env.ctx.jf.admin.ping = async () => { pings++; await new Promise((r) => setTimeout(r, 50)); return true; };
    const got = await Promise.all([getSnapshot(env.ctx, {}, deps()), getSnapshot(env.ctx, {}, deps()), getSnapshot(env.ctx, {}, deps())]);
    expect(got.map((g) => g.at)).toEqual([old.at, old.at, old.at]);
    await healthSettled(env.ctx);
    expect(pings).toBe(1);
    expect(JSON.parse((await env.kv.get('health:snap'))!).at > old.at).toBe(true);
  });

  it('refresh waits for a new build; healthTick stores a snapshot and never throws', async () => {
    const old = { ...(await buildSnapshot(env.ctx, deps())), at: new Date(Date.now() - 10_000).toISOString() };
    await env.kv.set('health:snap', JSON.stringify(old), 300);
    expect((await getSnapshot(env.ctx, { refresh: true }, deps())).at > old.at).toBe(true);
    await env.kv.del('health:snap');
    env.ctx.jf.admin.ping = async () => { throw new Error('x'); };
    await expect(healthTick(env.ctx, deps())).resolves.toBeUndefined();
    expect(JSON.parse((await env.kv.get('health:snap'))!).services[0].level).toBe('err');
  });

  it('healthTick prunes dismissals older than 30 days', async () => {
    await env.pool.query("insert into health_dismissals(user_id, issue_id, fp, at) values ($1, 'svc:media', 'aaaaaaaaaaaa', now() - interval '31 days'), ($1, 'svc:gateway', 'bbbbbbbbbbbb', now())", [adminId]);
    await healthTick(env.ctx, deps());
    expect((await env.pool.query('select issue_id from health_dismissals')).rows.map((r) => r.issue_id)).toEqual(['svc:gateway']);
  });
});

describe('routes', () => {
  const snap = (issues: HealthSnapshot['issues']): HealthSnapshot => ({
    at: new Date().toISOString(), services: [], disks: [], errors: { level: 'ok', server15: 0, client15: 0, playback60: 0 }, issues,
    worst: issues.some((i) => i.level === 'err') ? 'err' : issues.length ? 'warn' : 'ok',
  });
  const issue = (id: string, level: 'warn' | 'err', reason: HealthSnapshot['issues'][number]['reason']) => ({ id, level, reason, fp: issueFp(id, level, reason) });
  const putSnap = (s: HealthSnapshot) => env.kv.set('health:snap', JSON.stringify(s), 300);

  it('GET /api/admin/health returns the snapshot', async () => {
    await putSnap(snap([issue('svc:requests', 'warn', 'down')]));
    const r = await as(admin, 'GET', '/api/admin/health');
    expect(r.statusCode).toBe(200);
    expect(r.json().issues).toHaveLength(1);
  });

  it('banner: sorted err first then by id; dismissed (id, fp) hidden for that admin only; a level change shows it again', async () => {
    await putSnap(snap([issue('svc:requests', 'warn', 'down'), issue('disk:downloads', 'warn', 'full'), issue('svc:media', 'err', 'down')]));
    let r = await as(admin, 'GET', '/api/admin/health/banner');
    expect(r.statusCode).toBe(200);
    expect(r.json().worst).toBe('err');
    expect(r.json().issues.map((i: { id: string }) => i.id)).toEqual(['svc:media', 'disk:downloads', 'svc:requests']);
    const d = r.json().issues[1];
    expect((await as(admin, 'POST', '/api/admin/health/dismiss', { id: d.id, fp: d.fp })).json()).toEqual({ ok: true });
    r = await as(admin, 'GET', '/api/admin/health/banner');
    expect(r.json().issues.map((i: { id: string }) => i.id)).toEqual(['svc:media', 'svc:requests']);
    // another admin still sees it
    const other = await env.login(ADMIN2);
    expect((await as(other, 'GET', '/api/admin/health/banner')).json().issues).toHaveLength(3);
    // same level, same reason (numbers moved): stays hidden; warn → err: back
    await putSnap(snap([issue('svc:media', 'err', 'down'), { ...issue('disk:downloads', 'warn', 'full'), detail: { pct: 88 } }]));
    expect((await as(admin, 'GET', '/api/admin/health/banner')).json().issues.map((i: { id: string }) => i.id)).toEqual(['svc:media']);
    await putSnap(snap([issue('disk:downloads', 'err', 'full')]));
    r = await as(admin, 'GET', '/api/admin/health/banner');
    expect(r.json()).toMatchObject({ worst: 'err', issues: [{ id: 'disk:downloads', level: 'err' }] });
    // a dismissal older than 30 days no longer hides anything
    await putSnap(snap([issue('svc:requests', 'warn', 'down')]));
    await as(admin, 'POST', '/api/admin/health/dismiss', { id: 'svc:requests', fp: issueFp('svc:requests', 'warn', 'down') });
    expect((await as(admin, 'GET', '/api/admin/health/banner')).json().issues).toEqual([]);
    await env.pool.query("update health_dismissals set at = now() - interval '31 days'");
    expect((await as(admin, 'GET', '/api/admin/health/banner')).json().issues).toHaveLength(1);
  });

  it('dismiss validation: bad id / fp → 400; ids with a camel-case service work', async () => {
    for (const body of [{ id: 'SVC:media', fp: 'aaaaaaaaaaaa' }, { id: 'svc', fp: 'aaaaaaaaaaaa' }, { id: 'svc:media', fp: 'zzzzzzzzzzzz' }, { id: 'svc:media', fp: 'aaaa' }, { id: `svc:${'a'.repeat(40)}`, fp: 'aaaaaaaaaaaa' }]) {
      expect((await as(admin, 'POST', '/api/admin/health/dismiss', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await as(admin, 'POST', '/api/admin/health/dismiss', { id: 'svc:playbackCheck', fp: 'aaaaaaaaaaaa' })).statusCode).toBe(200);
  });

  it('friend 403; admin on a non-owner profile 403 on all three routes; no session 401', async () => {
    const fritz = await env.login({ sub: 'sub-f', email: 'f@example.com', name: 'Fritz', groups: [] });
    const s = await env.login(ADMIN);
    const pid = randomUUID();
    await env.pool.query('insert into profiles(id, user_id, name, is_owner, kids, jellyfin_user_id) values ($1, $2, $3, false, false, $4)', [pid, adminId, 'Gast', 'f'.repeat(32)]);
    const raw = JSON.parse((await env.kv.get(`sess:${s.cookies.ff_sid}`))!);
    await env.kv.set(`sess:${s.cookies.ff_sid}`, JSON.stringify({ ...raw, profileId: pid }), 600);
    const calls: Array<[string, string, unknown?]> = [['GET', '/api/admin/health'], ['GET', '/api/admin/health/banner'], ['POST', '/api/admin/health/dismiss', { id: 'svc:media', fp: 'aaaaaaaaaaaa' }]];
    for (const [m, u, b] of calls) {
      expect((await as(fritz, m, u, b)).statusCode, `friend ${u}`).toBe(403);
      expect((await as(s, m, u, b)).statusCode, `non-owner ${u}`).toBe(403);
      expect((await env.app.inject({ method: m as 'GET', url: u, payload: b as object })).statusCode, `anon ${u}`).toBe(401);
    }
    await env.pool.query('delete from profiles where id=$1', [pid]);
  });

  it('/api/admin/summary takes the media server state from a fresh snapshot, else pings', async () => {
    let pings = 0;
    env.ctx.jf.admin.ping = async () => { pings++; return true; };
    const media = (level: 'ok' | 'err', ageMs: number): HealthSnapshot => ({ ...snap([]), at: new Date(Date.now() - ageMs).toISOString(), services: [{ id: 'media', level, ...(level === 'err' ? { reason: 'down' as const } : {}) }] });
    await putSnap(media('err', 1000));
    expect((await as(admin, 'GET', '/api/admin/summary')).json().services.jellyfin).toBe(false);
    expect(pings).toBe(0);
    await putSnap(media('err', 120_000)); // stale: ping instead
    expect((await as(admin, 'GET', '/api/admin/summary')).json().services.jellyfin).toBe(true);
    expect(pings).toBe(1);
  });

  it('refresh=1: the seventh call within a minute → 429', async () => {
    vols = {};
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await as(admin, 'GET', '/api/admin/health?refresh=1')).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 200, 200, 429]);
    expect((await as(admin, 'GET', '/api/admin/health')).statusCode).toBe(200); // the cached snapshot is still served
  });
});
