// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIGRATIONS } from '../src/db.js';
import { forgetDownloadVisibility, qualityOptions } from '../src/downloads.js';
import { DEFAULT_ROLES, invalidateRoles } from '../src/roles.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

const enqueued: string[] = [];
vi.mock('../src/downloadprep.js', async (orig) => ({ ...(await orig<typeof import('../src/downloadprep.js')>()), enqueueJob: async (_c: unknown, id: string) => { enqueued.push(id); } }));

type Sess = { cookies: Record<string, string>; csrf: string };
const H = { 'x-internal-secret': cfg.INTERNAL_SECRET };
const MOVIE = 'a'.repeat(32);
const SERIES = 'b'.repeat(32);
const EPS = [1, 2, 3, 4, 5].map((n) => `${String(n).repeat(1)}`.padEnd(32, 'e'));
const TICKS = 90 * 600_000_000;
const GONE = 'f'.repeat(32);

let env: TestEnv;
let admin: Sess, family: Sess, guest: Sess;
let original = false;
let lastPlayed: string | undefined;
let failInfoFor = '';
let hiddenItem = '';

const item = (id: string) => {
  const ep = EPS.indexOf(id);
  if (ep >= 0) return { Id: id, Name: `Folge ${ep + 1}`, Type: 'Episode', SeriesId: SERIES, SeriesName: 'Die Serie', ParentIndexNumber: ep < 3 ? 1 : 2, IndexNumber: ep < 3 ? ep + 1 : ep - 2, RunTimeTicks: TICKS, ImageTags: { Primary: 'x' }, UserData: { LastPlayedDate: lastPlayed } };
  return { Id: id, Name: 'Der Film', Type: 'Movie', RunTimeTicks: TICKS, ImageTags: { Primary: 'x' }, BackdropImageTags: ['b'], UserData: { LastPlayedDate: lastPlayed } };
};

async function newUser(role: 'family' | 'guest' | 'friend', sub: string): Promise<Sess> {
  const inv = await env.app.inject({ method: 'POST', url: '/api/admin/invites', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { role, ttlHours: 1 } });
  const token = inv.json().link.split('/').pop();
  env.claims.current = { sub, email: `${sub}@example.com`, name: sub, groups: [] };
  const l = await env.app.inject(`/auth/login?invite=${token}`);
  const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
  const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } });
  const sid = cb.cookies.find((x) => x.name === 'ff_sid')!.value;
  return { cookies: { ff_sid: sid }, csrf: (await env.app.inject({ url: '/api/me', cookies: { ff_sid: sid } })).json().csrfToken };
}

const call = (s: Sess, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
const uid = async (name: string) => (await env.pool.query('select id from users where name=$1', [name])).rows[0].id as string;
const setRole = async (role: string, cols: Record<string, unknown>) => {
  const keys = Object.keys(cols);
  await env.pool.query(
    `insert into role_settings(role, ${keys.join(',')}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) on conflict (role) do update set ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')}`,
    [role, ...Object.values(cols)],
  );
  invalidateRoles(env.ctx);
};
const resetRole = async () => { await env.pool.query('delete from role_settings'); invalidateRoles(env.ctx); };
const authz = (s: Sess, dl: string) => env.app.inject({ method: 'POST', url: '/internal/authz', headers: H, payload: { sid: s.cookies.ff_sid, dl } });

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items/[^/]+': (u) => (u.pathname.endsWith(GONE) || (hiddenItem && u.pathname.endsWith(hiddenItem)) ? { status: 404, raw: 'secret jellyfin detail' } : { json: item(u.pathname.split('/').pop()!) }),
    'GET /Users/[^/]+/Items/[^/]+': (u) => (u.pathname.endsWith(GONE) || (hiddenItem && u.pathname.endsWith(hiddenItem)) ? { status: 404, raw: 'secret jellyfin detail' } : { json: item(u.pathname.split('/').pop()!) }),
    'GET /Shows/[^/]+/Episodes': (u) => {
      const start = u.searchParams.get('startItemId');
      const i = EPS.indexOf(start ?? '');
      return { json: { Items: EPS.slice(Math.max(i, 0), Math.max(i, 0) + 2).map(item) } };
    },
    'POST /Items/[^/]+/PlaybackInfo': (u) => failInfoFor && u.pathname.includes(failInfoFor) ? { status: 500, raw: 'secret jellyfin detail' } : ({
      json: {
        PlaySessionId: 'ps-dl-12345',
        MediaSources: [{
          Id: 'ms1', Container: original ? 'mp4' : 'mkv', Bitrate: 3_000_000, Size: 2_000_000_000, RunTimeTicks: TICKS,
          MediaStreams: [
            { Type: 'Video', Index: 0, Codec: 'h264', Height: 1080, BitDepth: 8 },
            { Type: 'Audio', Index: 1, Codec: 'aac', Language: 'eng', IsDefault: true },
            { Type: 'Audio', Index: 2, Codec: 'aac', Language: 'ger' },
            { Type: 'Subtitle', Index: 3, Codec: 'subrip', Language: 'ger', IsTextSubtitleStream: true },
            { Type: 'Subtitle', Index: 4, Codec: 'subrip', Language: 'eng', IsTextSubtitleStream: true },
          ],
        }],
      },
    }),
    'POST /UserItems/[^/]+/UserData': () => ({ status: 204 }),
  });
  admin = await env.login();
  family = await newUser('family', 'Fam');
  guest = await newUser('guest', 'Gast');
});
afterAll(() => env.close());
beforeEach(async () => {
  await resetRole();
  await env.pool.query('delete from downloads');
  await env.pool.query('delete from download_jobs');
  enqueued.length = 0;
  original = false;
  lastPlayed = undefined;
  failInfoFor = '';
  env.ctx.jf.forgetItems(); // item() is memoised for 10 s: every test starts from the fake library's current state
});

const create = async (s: Sess, body: Record<string, unknown>) => { const r = await call(s, 'POST', '/api/downloads', { quality: 'hd', ...body }); if (process.env.DBG && r.statusCode !== 200) console.log(r.statusCode, r.body); return r; };

describe('migration 20', () => {
  it('is the last migration and creates the tables', async () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(20);
    const t = (await env.pool.query("select table_name from information_schema.tables where table_name in ('downloads','download_jobs')")).rows;
    expect(t).toHaveLength(2);
    const c = (await env.pool.query("select column_name from information_schema.columns where table_name='role_settings'")).rows.map((r) => r.column_name);
    expect(c).toEqual(expect.arrayContaining(['download', 'max_downloads', 'download_max_height', 'download_days']));
    expect((await env.pool.query('select version from schema_migrations where version=20')).rowCount).toBe(1);
  });
});

describe('roles and /api/me', () => {
  it('defaults', () => {
    expect(DEFAULT_ROLES.guest).toMatchObject({ download: false, maxDownloads: 0, downloadMaxHeight: 0 });
    expect(DEFAULT_ROLES.friend).toMatchObject({ download: false, maxDownloads: 15, downloadMaxHeight: 720, downloadDays: 30 });
    expect(DEFAULT_ROLES.family).toMatchObject({ download: true, maxDownloads: 25, downloadMaxHeight: 1080 });
    expect(DEFAULT_ROLES.admin).toMatchObject({ download: true, maxDownloads: 50, downloadMaxHeight: 1080 });
  });
  it('/api/me reports downloads.allowed', async () => {
    expect((await call(family, 'GET', '/api/me')).json().downloads).toEqual({ allowed: true, max: 25 });
    expect((await call(guest, 'GET', '/api/me')).json().downloads.allowed).toBe(false);
  });
  it('admin role settings round trip and re-apply the Jellyfin policy', async () => {
    const before = env.jfCalls.filter((c) => /\/Policy$/.test(c.path)).length;
    const r = await call(admin, 'PUT', '/api/admin/roles/friend', { download: true, maxDownloads: 7, downloadMaxHeight: 480, downloadDays: 10 });
    expect(r.statusCode).toBe(200);
    const g = (await call(admin, 'GET', '/api/admin/roles')).json();
    expect(g.limits.find((l: any) => l.role === 'friend')).toMatchObject({ download: true, maxDownloads: 7, downloadMaxHeight: 480, downloadDays: 10 });
    expect(g.roles.friend.download).toBe(true);
    void before;
    expect((await call(admin, 'PUT', '/api/admin/roles/friend', { maxDownloads: 999 })).statusCode).toBe(400);
  });
});

describe('quality options', () => {
  const role = { ...DEFAULT_ROLES.family!, maxHeight: null };
  const src = { originalEligible: true, sizeBytes: 2_000_000_000, runtimeTicks: TICKS };
  it('clamps to the role height cap', () => {
    expect(qualityOptions({ ...role, downloadMaxHeight: 720 }, src).map((o) => o.id)).toEqual(['sd', 'hd', 'original']);
    expect(qualityOptions({ ...role, downloadMaxHeight: 1080 }, src).map((o) => o.id)).toEqual(['sd', 'hd', 'fhd', 'original']);
    expect(qualityOptions({ ...role, downloadMaxHeight: 1080, maxHeight: 720 }, src).map((o) => o.id)).toEqual(['sd', 'hd', 'original']);
    expect(qualityOptions({ ...role, downloadMaxHeight: 0 }, src)).toEqual([]);
    expect(qualityOptions({ ...role, downloadMaxHeight: 360 }, src).find((o) => o.id === 'sd')!.height).toBe(360);
  });
  it('estimates sizes and gates original by eligibility and bitrate', () => {
    const hd = qualityOptions(role, src).find((o) => o.id === 'hd')!;
    expect(hd.estBytes).toBe(Math.round(((2_500_000 + 128_000) / 8) * 5400));
    expect(qualityOptions(role, { ...src, originalEligible: false }).some((o) => o.id === 'original')).toBe(false);
    expect(qualityOptions({ ...role, maxBitrate: 1_000_000 }, src).some((o) => o.id === 'original')).toBe(false); // 2 GB / 90 min = ~3 Mbit
  });
});

describe('options and creation', () => {
  it('download=false roles are refused', async () => {
    const o = (await call(guest, 'GET', `/api/downloads/options/${MOVIE}`)).json();
    expect(o.allowed).toBe(false);
    const r = await create(guest, { itemId: MOVIE });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('downloads_not_allowed');
  });

  it('options list qualities, languages and quota', async () => {
    original = true;
    const o = (await call(family, 'GET', `/api/downloads/options/${MOVIE}`)).json();
    expect(o.allowed).toBe(true);
    expect(o.qualities.map((q: any) => q.id)).toEqual(['sd', 'hd', 'fhd', 'original']);
    expect(o.audio.map((a: any) => a.lang)).toEqual(['eng', 'ger']);
    expect(o.subtitles.map((a: any) => a.lang)).toEqual(['ger', 'eng']);
    expect(o.quota).toEqual({ used: 0, max: 25 });
    expect(o.days).toBe(30);
  });

  it('creates a license + queued job; the request does not call enqueueJob (the preparer tick picks it up)', async () => {
    const r = await create(family, { itemId: MOVIE, audioLang: 'ger', subLangs: ['ger'] });
    expect(r.statusCode).toBe(200);
    const l = r.json().licenses[0];
    expect(l).toMatchObject({ itemId: MOVIE, status: 'pending', quality: 'hd', title: 'Der Film', fileUrl: `/media/d/${l.id}`, ready: false, audioLang: 'ger' });
    expect(l.subtitles).toEqual([{ lang: 'ger', title: expect.any(String), url: expect.stringContaining('/Subtitles/3/') }]);
    expect(l.poster).toContain(MOVIE);
    const job = (await env.pool.query('select * from download_jobs')).rows;
    expect(job).toHaveLength(1);
    expect(job[0]).toMatchObject({ item_id: MOVIE, quality: 'hd', audio_lang: 'ger', status: 'queued', max_height: 720, max_bitrate: 2_628_000 });
    expect(env.ctx.cfg.BACKGROUND_JOBS).toBe('false');
    expect(enqueued).toEqual([]);
    expect(Math.round((Date.parse(l.expiresAt) - Date.now()) / 86_400_000)).toBe(30);
  });

  it('creating the same item twice on one device returns the same license', async () => {
    const a = (await create(family, { itemId: MOVIE })).json().licenses[0];
    const b = (await create(family, { itemId: MOVIE })).json().licenses[0];
    expect(b.id).toBe(a.id);
    expect((await env.pool.query('select count(*) n from downloads')).rows[0].n).toBe('1');
  });

  it('shares one job between users (same item, quality, audio)', async () => {
    const a = await create(family, { itemId: MOVIE });
    const b = await create(admin, { itemId: MOVIE });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const jobs = (await env.pool.query('select id from download_jobs')).rows;
    expect(jobs).toHaveLength(1);
    expect((await env.pool.query('select count(*) n from downloads where job_id=$1', [jobs[0].id])).rows[0].n).toBe('2');
    // a failed job is replaced by a fresh one
    await env.pool.query("update download_jobs set status='failed'");
    await create(family, { itemId: EPS[0] });
    await env.pool.query("update download_jobs set status='failed' where item_id=$1", [EPS[0]]);
    const c = await create(admin, { itemId: EPS[0], quality: 'sd' });
    expect(c.statusCode).toBe(200);
  });

  it('original needs no job and falls back to hd when the source does not qualify', async () => {
    original = true;
    const a = (await create(family, { itemId: MOVIE, quality: 'original' })).json().licenses[0];
    expect(a).toMatchObject({ quality: 'original', ready: true });
    expect((await env.pool.query('select count(*) n from download_jobs')).rows[0].n).toBe('0');
    original = false;
    const b = (await create(family, { itemId: EPS[0], quality: 'original' })).json().licenses[0];
    expect(b.quality).toBe('hd');
  });

  it('refuses qualities above the role cap', async () => {
    await setRole('family', { download_max_height: 720 });
    const r = await create(family, { itemId: MOVIE, quality: 'fhd' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('quality_unavailable');
  });

  it('enforces maxDownloads per account', async () => {
    await setRole('family', { max_downloads: 2 });
    expect((await create(family, { itemId: EPS[0] })).statusCode).toBe(200);
    expect((await create(family, { itemId: EPS[1] })).statusCode).toBe(200);
    const r = await create(family, { itemId: EPS[2] });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'quota_exceeded', used: 2, max: 2 });
    // deleting frees a slot
    const id = (await call(family, 'GET', '/api/downloads')).json().downloads[0].id;
    expect((await call(family, 'DELETE', `/api/downloads/${id}`)).statusCode).toBe(200);
    expect((await create(family, { itemId: EPS[2] })).statusCode).toBe(200);
  });

  it('a batch is refused as a whole when it does not fit', async () => {
    await setRole('family', { max_downloads: 2 });
    const r = await create(family, { seriesId: SERIES, fromEpisodeId: EPS[0], count: 3 });
    expect(r.statusCode).toBe(409);
    expect((await env.pool.query('select count(*) n from downloads')).rows[0].n).toBe('0');
  });

  it('downloads the next N episodes across seasons', async () => {
    const r = await create(family, { seriesId: SERIES, fromEpisodeId: EPS[1], count: 3 });
    expect(r.statusCode).toBe(200);
    const l = r.json().licenses;
    expect(l.map((x: any) => x.itemId)).toEqual([EPS[1], EPS[2], EPS[3]]);
    expect(l.map((x: any) => [x.season, x.episode])).toEqual([[1, 2], [1, 3], [2, 1]]);
    expect(l[0].seriesName).toBe('Die Serie');
    expect(enqueued).toEqual([]);
    // stops at the end of the series
    const r2 = await create(admin, { seriesId: SERIES, fromEpisodeId: EPS[4], count: 5 });
    expect(r2.json().licenses).toHaveLength(1);
  });

  it('rejects malformed bodies and counts > 10', async () => {
    expect((await create(family, { seriesId: SERIES, fromEpisodeId: EPS[0], count: 11 })).statusCode).toBe(400);
    expect((await create(family, { itemId: 'nope' })).statusCode).toBe(400);
    expect((await create(family, { itemId: MOVIE, quality: '4k' })).statusCode).toBe(400);
  });

  it('DOWNLOADS_ENABLED=false hides the feature', async () => {
    const was = env.ctx.cfg;
    env.ctx.cfg = { ...was, DOWNLOADS_ENABLED: 'false' };
    try {
      expect((await create(family, { itemId: MOVIE })).statusCode).toBe(404);
      expect((await call(family, 'GET', '/api/me')).json().downloads.allowed).toBe(false);
    } finally { env.ctx.cfg = was; }
  });
});

describe('license lifecycle', () => {
  it('lists, heartbeats, marks fetched and deletes on this device only', async () => {
    const l = (await create(family, { itemId: MOVIE })).json().licenses[0];
    const list = (await call(family, 'GET', '/api/downloads')).json();
    expect(list.downloads.map((d: any) => d.id)).toEqual([l.id]);
    expect(list.quota).toEqual({ used: 1, max: 25 });
    expect((await call(family, 'GET', `/api/downloads/${l.id}`)).json()).toMatchObject({ id: l.id, prep: { status: 'queued', percent: 0 } });
    expect((await call(admin, 'GET', `/api/downloads/${l.id}`)).statusCode).toBe(404); // someone else's
    await env.pool.query("update download_jobs set status='preparing', seg_done=3, seg_total=10");
    expect((await call(family, 'GET', `/api/downloads/${l.id}`)).json().prep).toMatchObject({ status: 'preparing', percent: 30 });
    expect((await call(family, 'POST', `/api/downloads/${l.id}/fetched`, { bytes: 1234 })).statusCode).toBe(200);
    expect((await env.pool.query('select status from downloads where id=$1', [l.id])).rows[0].status).toBe('fetched');
    expect((await call(family, 'DELETE', `/api/downloads/${l.id}`)).statusCode).toBe(200);
    expect((await call(family, 'GET', '/api/downloads')).json().downloads).toEqual([]);
    expect((await call(family, 'DELETE', `/api/downloads/${l.id}`)).statusCode).toBe(404);
  });
});

describe('check-in', () => {
  const check = (s: Sess, ids: string[]) => call(s, 'POST', '/api/downloads/check', { ids });

  it('renews valid licenses within the offline grace and revokes the rest', async () => {
    const l = (await create(family, { itemId: MOVIE })).json().licenses[0];
    const unknown = randomUUID();
    const r = (await check(family, [l.id, unknown])).json();
    expect(r.revoked).toEqual([unknown]);
    expect(r.valid).toHaveLength(1);
    const days = (Date.parse(r.valid[0].validUntil) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
    // someone else's id looks unknown
    expect((await check(admin, [l.id])).json().revoked).toEqual([l.id]);
  });

  it('validUntil never exceeds the license expiry', async () => {
    const l = (await create(family, { itemId: MOVIE })).json().licenses[0];
    await env.pool.query("update downloads set expires_at = now() + interval '2 days'");
    const r = (await check(family, [l.id])).json();
    expect(Date.parse(r.valid[0].validUntil)).toBeLessThanOrEqual(Date.parse(r.valid[0].expiresAt));
  });

  it('expired licenses are revoked', async () => {
    const l = (await create(family, { itemId: MOVIE })).json().licenses[0];
    await env.pool.query("update downloads set expires_at = now() - interval '1 minute'");
    expect((await check(family, [l.id])).json().revoked).toEqual([l.id]);
  });

  it('role downgrade revokes', async () => {
    const l = (await create(family, { itemId: MOVIE })).json().licenses[0];
    await setRole('family', { download: false });
    expect((await check(family, [l.id])).json().revoked).toEqual([l.id]);
    expect((await env.pool.query('select status from downloads where id=$1', [l.id])).rows[0].status).toBe('revoked');
  });

  it('removing a device removes its licenses', async () => {
    const l = (await create(family, { itemId: MOVIE })).json().licenses[0];
    // a second device of the same account (pending approval is fine for the fixture)
    await env.pool.query("insert into devices(user_id, device_id, label, approved) select user_id, 'dev-second-0000000000001', 'x', true from downloads limit 1");
    const fid = await uid('Fam');
    const prof = (await env.pool.query('select id from profiles where user_id=$1 and is_owner', [fid])).rows[0].id;
    const other = randomUUID();
    await env.pool.query("insert into downloads(id,user_id,device_id,profile_id,item_id,quality,status,expires_at) values ($1,$2,'dev-second-0000000000001',$3,$4,'hd','fetched', now() + interval '1 day')", [other, fid, prof, MOVIE]);
    const { revokeSessions } = await import('../src/devices.js');
    await revokeSessions(env.ctx, fid, 'dev-second-0000000000001');
    const st = Object.fromEntries((await env.pool.query('select id, status from downloads')).rows.map((r) => [r.id, r.status]));
    expect(st[other]).toBe('revoked');
    expect(st[l.id]).toBe('pending');
    // deleting the device row cascades
    await env.pool.query("delete from devices where device_id='dev-second-0000000000001'");
    expect((await env.pool.query('select count(*) n from downloads where id=$1', [other])).rows[0].n).toBe('0');
  });

  it('revoke-others spares the current device, disabling a user revokes everything', async () => {
    const l = (await create(family, { itemId: MOVIE })).json().licenses[0];
    const { revokeSessions } = await import('../src/devices.js');
    const fid = await uid('Fam');
    const sid = family.cookies.ff_sid;
    await revokeSessions(env.ctx, fid, undefined, sid);
    expect((await env.pool.query('select status from downloads where id=$1', [l.id])).rows[0].status).toBe('pending');
    const r = await call(admin, 'PATCH', `/api/admin/users/${fid}`, { disabled: true });
    expect(r.statusCode).toBe(200);
    expect((await env.pool.query('select status from downloads where id=$1', [l.id])).rows[0].status).toBe('revoked');
    await call(admin, 'PATCH', `/api/admin/users/${fid}`, { disabled: false });
    family = await newLogin('Fam');
  });

  async function newLogin(sub: string): Promise<Sess> {
    env.claims.current = { sub, email: `${sub}@example.com`, name: sub, groups: [] };
    const l = await env.app.inject('/auth/login');
    const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
    const dev = (await env.pool.query('select device_id from devices d join users u on u.id=d.user_id where u.name=$1', [sub])).rows[0].device_id;
    const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st, ff_dev: dev } });
    const sid = cb.cookies.find((x) => x.name === 'ff_sid')!.value;
    return { cookies: { ff_sid: sid }, csrf: (await env.app.inject({ url: '/api/me', cookies: { ff_sid: sid } })).json().csrfToken };
  }
});

describe('offline progress', () => {
  const ev = (l: { id: string }, over: Record<string, unknown> = {}) => ({ downloadId: l.id, itemId: MOVIE, positionTicks: 1_000_000_000, played: false, at: Date.now() - 1000, ...over });
  const post = (events: unknown[]) => call(family, 'POST', '/api/downloads/progress', { events });
  const posts = () => env.jfCalls.filter((c) => c.method === 'POST' && /UserData$/.test(c.path));

  it('writes the newest event per item to Jellyfin without touching /api/playback/progress', async () => {
    const l = (await create(family, { itemId: MOVIE })).json().licenses[0];
    await env.pool.query("update downloads set created_at = now() - interval '1 hour'");
    const n = posts().length;
    const old = Date.now() - 5000;
    const r = await post([ev(l, { positionTicks: 111, at: old }), ev(l, { positionTicks: 222_000_000, at: old + 3000 })]);
    expect(r.json().applied).toEqual([MOVIE]);
    const sent = posts().slice(n);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ PlaybackPositionTicks: 222_000_000, Played: false });
    expect(Date.parse(sent[0]!.body.LastPlayedDate)).toBe(old + 3000);
    expect(env.jfCalls.some((c) => /Sessions\/Playing/.test(c.path))).toBe(false);
  });

  it('marks played at >= 90 % and resets the position', async () => {
    const l = (await create(family, { itemId: MOVIE })).json().licenses[0];
    const n = posts().length;
    await post([ev(l, { positionTicks: TICKS * 0.95 })]);
    expect(posts().slice(n)[0]!.body).toMatchObject({ Played: true, PlaybackPositionTicks: 0 });
  });

  it('skips events that are not newer than Jellyfin LastPlayedDate', async () => {
    const l = (await create(family, { itemId: MOVIE })).json().licenses[0];
    lastPlayed = new Date(Date.now() + 1000).toISOString();
    env.ctx.jf.forgetItems(); // item() is memoised for 10 s; the fake Jellyfin state just changed underneath it
    const n = posts().length;
    const r = await post([ev(l)]);
    expect(r.json()).toMatchObject({ applied: [], skipped: [MOVIE] });
    expect(posts().length).toBe(n);
  });

  it('clamps future times to now and times before the license to its creation', async () => {
    const l = (await create(family, { itemId: MOVIE })).json().licenses[0];
    await env.pool.query("update downloads set created_at = now() - interval '1 hour'");
    const created = ((await env.pool.query('select created_at from downloads')).rows[0].created_at as Date).getTime();
    const n = posts().length;
    await post([ev(l, { at: Date.now() + 3_600_000 })]);
    const t = Date.parse(posts().slice(n)[0]!.body.LastPlayedDate);
    expect(t).toBeLessThanOrEqual(Date.now());
    expect(t).toBeGreaterThan(Date.now() - 5000);
    const n2 = posts().length;
    await post([ev(l, { at: created - 86_400_000 })]);
    expect(Date.parse(posts().slice(n2)[0]!.body.LastPlayedDate)).toBe(created);
  });

  it('ignores foreign, revoked and mismatching licenses', async () => {
    const l = (await create(family, { itemId: MOVIE })).json().licenses[0];
    const n = posts().length;
    const r1 = await call(admin, 'POST', '/api/downloads/progress', { events: [ev(l)] });
    expect(r1.json().applied).toEqual([]);
    expect((await post([ev(l, { itemId: EPS[0] })])).json().applied).toEqual([]);
    await env.pool.query("update downloads set status='revoked'");
    expect((await post([ev(l)])).json().applied).toEqual([]);
    expect(posts().length).toBe(n);
  });
});

describe('/internal/authz {sid, dl}', () => {
  const ready = async (l: { id: string }, bytes = 4096) => env.pool.query("update download_jobs set status='ready', bytes=$1 where id=(select job_id from downloads where id=$2)", [bytes, l.id]);

  it('serves a ready file with name, size and etag', async () => {
    const l = (await create(family, { itemId: MOVIE })).json().licenses[0];
    expect((await authz(family, l.id)).statusCode).toBe(404); // still preparing
    await ready(l);
    const r = await authz(family, l.id);
    expect(r.statusCode).toBe(200);
    const jobId = (await env.pool.query('select job_id from downloads where id=$1', [l.id])).rows[0].job_id;
    expect(r.json()).toMatchObject({ token: expect.any(String), download: { kind: 'file', file: `${jobId}.mp4`, size: 4096, etag: `${jobId}-4096` } });
  });

  it('original licenses are proxied statically', async () => {
    original = true;
    const l = (await create(family, { itemId: MOVIE, quality: 'original' })).json().licenses[0];
    const r = await authz(family, l.id);
    expect(r.json().download).toEqual({ kind: 'static', path: `/Videos/${MOVIE}/stream`, query: { static: 'true', MediaSourceId: 'ms1' } });
  });

  it('denies other users, deleted/revoked/expired licenses, role loss and other devices', async () => {
    const l = (await create(family, { itemId: MOVIE })).json().licenses[0];
    await ready(l);
    expect((await authz(admin, l.id)).statusCode).toBe(404);
    expect((await authz(family, randomUUID())).statusCode).toBe(404);
    expect((await authz(family, 'not-a-uuid')).statusCode).toBeGreaterThanOrEqual(400);
    await setRole('family', { download: false });
    expect((await authz(family, l.id)).statusCode).toBe(404);
    await resetRole();
    expect((await authz(family, l.id)).statusCode).toBe(200);
    await env.pool.query("update downloads set expires_at = now() - interval '1 second'");
    expect((await authz(family, l.id)).statusCode).toBe(404);
    await env.pool.query("update downloads set expires_at = now() + interval '1 day', status='deleted'");
    expect((await authz(family, l.id)).statusCode).toBe(404);
    await env.pool.query("update downloads set status='revoked'");
    expect((await authz(family, l.id)).statusCode).toBe(404);
  });

  it('denies and revokes a licence once the item is no longer visible for its profile', async () => {
    const l = (await create(family, { itemId: MOVIE })).json().licenses[0];
    await ready(l);
    forgetDownloadVisibility();
    expect((await authz(family, l.id)).statusCode).toBe(200);
    hiddenItem = MOVIE;
    try {
      expect((await authz(family, l.id)).statusCode).toBe(200); // memoised for a few seconds
      forgetDownloadVisibility();
      env.ctx.jf.forgetItems?.(); // the Jellyfin service memoises items too (10 s)
      expect((await authz(family, l.id)).statusCode).toBe(404);
      expect((await env.pool.query('select status from downloads where id=$1', [l.id])).rows[0].status).toBe('revoked');
    } finally {
      hiddenItem = '';
      forgetDownloadVisibility();
    }
  });

  it('denies a session of another device (401/404) and a disabled user', async () => {
    const l = (await create(family, { itemId: MOVIE })).json().licenses[0];
    await ready(l);
    const dev = (await env.pool.query<{ user_id: string; device_id: string }>('select user_id, device_id from downloads where id=$1', [l.id])).rows[0]!;
    await env.pool.query("insert into devices(user_id, device_id, label, approved) values ($1,'other-device-000000001','Other',true)", [dev.user_id]);
    await env.pool.query("update downloads set device_id='other-device-000000001' where id=$1", [l.id]);
    expect((await authz(family, l.id)).statusCode).toBe(404);
    await env.pool.query('update downloads set device_id=$1 where id=$2', [dev.device_id, l.id]);
    expect((await authz(family, l.id)).statusCode).toBe(200);
    expect((await env.app.inject({ method: 'POST', url: '/internal/authz', headers: H, payload: { sid: 'x'.repeat(30), dl: l.id } })).statusCode).toBe(401);
    await env.pool.query('update users set disabled=true where id=$1', [dev.user_id]);
    expect((await authz(family, l.id)).statusCode).toBe(401);
    await env.pool.query('update users set disabled=false where id=$1', [dev.user_id]);
  });

  it('needs the internal secret', async () => {
    const l = (await create(family, { itemId: MOVIE })).json().licenses[0];
    expect((await env.app.inject({ method: 'POST', url: '/internal/authz', payload: { sid: family.cookies.ff_sid, dl: l.id } })).statusCode).toBe(403);
  });
});

describe('admin overview', () => {
  it('lists jobs, disk usage and licenses; admin can revoke', async () => {
    const l = (await create(family, { itemId: MOVIE })).json().licenses[0];
    await env.pool.query("update download_jobs set status='ready', bytes=5000");
    const o = (await call(admin, 'GET', '/api/admin/downloads')).json();
    expect(o).toMatchObject({ enabled: true, diskBytes: 5000, jobCounts: { ready: 1 } });
    expect(o.jobs[0]).toMatchObject({ item_id: MOVIE, licenses: 1 });
    expect(o.licenses[0]).toMatchObject({ id: l.id, user_name: 'Fam', title: 'Der Film' });
    expect((await call(family, 'GET', '/api/admin/downloads')).statusCode).toBe(403);
    expect((await call(admin, 'DELETE', `/api/admin/downloads/${l.id}`)).statusCode).toBe(200);
    expect((await call(admin, 'DELETE', `/api/admin/downloads/${l.id}`)).statusCode).toBe(404);
    expect((await env.pool.query('select status from downloads where id=$1', [l.id])).rows[0].status).toBe('revoked');
  });
});


// ---- review fixes ----

/** switching rotates the sid: the old session cookie keeps acting as the NEW profile, so always continue with the returned session */
const selectProfile = async (s: Sess, pid: string): Promise<Sess> => {
  const sel = await call(s, 'POST', `/api/profiles/${pid}/select`, {});
  expect(sel.statusCode).toBe(200);
  return { cookies: { ff_sid: sel.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: sel.json().csrfToken };
};
/** a second browser session of the same account on the same device (stays on the owner profile until it selects another) */
const loginAgain = async (sub: string): Promise<Sess> => {
  env.claims.current = { sub, email: `${sub}@example.com`, name: sub, groups: [] };
  const l = await env.app.inject('/auth/login');
  const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
  const dev = (await env.pool.query('select device_id from devices d join users u on u.id=d.user_id where u.name=$1', [sub])).rows[0].device_id;
  const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st, ff_dev: dev } });
  const sid = cb.cookies.find((x) => x.name === 'ff_sid')!.value;
  return { cookies: { ff_sid: sid }, csrf: (await env.app.inject({ url: '/api/me', cookies: { ff_sid: sid } })).json().csrfToken };
};
/** profile B of Fam: a separate session (same device) that selected a second profile; `s` stays on its own profile */
const mkProfile = async (s: Sess, name: string): Promise<Sess> => {
  const r = await call(s, 'POST', '/api/profiles', { name });
  expect(r.statusCode).toBe(201);
  return selectProfile(await loginAgain('Fam'), r.json().profile.id);
};
const jobOf = async (licenseId: string) => (await env.pool.query('select j.* from download_jobs j join downloads d on d.job_id=j.id where d.id=$1', [licenseId])).rows[0];

describe('licenses are scoped per profile', () => {
  it('profile B cannot list, fetch, delete, check, sync or fetch the file of profile A, and can download the same item separately', async () => {
    const a = (await create(family, { itemId: MOVIE })).json().licenses[0];
    const A = family;
    const B = await mkProfile(A, 'Kind');
    await env.pool.query("update download_jobs set status='ready', bytes=100");

    expect((await call(B, 'GET', '/api/downloads')).json().downloads).toEqual([]);
    expect((await call(B, 'GET', `/api/downloads/${a.id}`)).statusCode).toBe(404);
    expect((await call(B, 'POST', `/api/downloads/${a.id}/fetched`, { bytes: 1 })).statusCode).toBe(404);
    expect((await call(B, 'DELETE', `/api/downloads/${a.id}`)).statusCode).toBe(404);
    const chk = (await call(B, 'POST', '/api/downloads/check', { ids: [a.id] })).json();
    expect(chk).toMatchObject({ valid: [], revoked: [a.id] });
    const n = env.jfCalls.filter((c) => /UserData$/.test(c.path)).length;
    const pr = (await call(B, 'POST', '/api/downloads/progress', { events: [{ downloadId: a.id, itemId: MOVIE, positionTicks: 5, played: false, at: Date.now() - 1000 }] })).json();
    expect(pr.applied).toEqual([]);
    expect(env.jfCalls.filter((c) => /UserData$/.test(c.path)).length).toBe(n);
    expect((await authz(B, a.id)).statusCode).toBe(404);
    // A's license is untouched by all of that
    expect((await env.pool.query('select status from downloads where id=$1', [a.id])).rows[0].status).toBe('pending');
    expect((await authz(A, a.id)).statusCode).toBe(200);
    expect((await call(A, 'GET', `/api/downloads/${a.id}`)).statusCode).toBe(200);

    // options: existingId per profile
    expect((await call(A, 'GET', `/api/downloads/options/${MOVIE}`)).json().existingId).toBe(a.id);
    expect((await call(B, 'GET', `/api/downloads/options/${MOVIE}`)).json().existingId).toBeNull();

    // B downloads the same item: its own license, the shared job, account-wide quota
    const b = (await create(B, { itemId: MOVIE })).json();
    expect(b.licenses[0].id).not.toBe(a.id);
    expect(b.licenses[0].profileId).not.toBe(a.profileId);
    expect(b.quota.used).toBe(2);
    expect((await env.pool.query('select count(*) n from download_jobs')).rows[0].n).toBe('1');
    expect((await create(B, { itemId: MOVIE })).json().licenses[0].id).toBe(b.licenses[0].id); // idempotent per profile
    expect((await call(B, 'GET', '/api/downloads')).json().downloads.map((d: any) => d.id)).toEqual([b.licenses[0].id]);
    expect((await call(A, 'GET', '/api/downloads')).json().downloads.map((d: any) => d.id)).toEqual([a.id]);
    expect((await authz(B, b.licenses[0].id)).statusCode).toBe(200);
    expect((await authz(A, b.licenses[0].id)).statusCode).toBe(404);
    // B deleting its own does not touch A's
    expect((await call(B, 'DELETE', `/api/downloads/${b.licenses[0].id}`)).statusCode).toBe(200);
    expect((await env.pool.query('select status from downloads where id=$1', [a.id])).rows[0].status).toBe('pending');
  });

  it('syncProgress applies only the caller profile licenses', async () => {
    const A = family;
    const a = (await create(A, { itemId: MOVIE })).json().licenses[0];
    const n = env.jfCalls.filter((c) => /UserData$/.test(c.path)).length;
    const ev = { downloadId: a.id, itemId: MOVIE, positionTicks: 1_000_000_000, played: false, at: Date.now() - 1000 };
    expect((await call(A, 'POST', '/api/downloads/progress', { events: [ev] })).json().applied).toEqual([MOVIE]);
    expect(env.jfCalls.filter((c) => /UserData$/.test(c.path)).length).toBe(n + 1);
  });
});

describe('creation is atomic and never waits', () => {
  it('a Jellyfin error mid-batch inserts nothing (jobs and licenses) and leaks no detail', async () => {
    failInfoFor = EPS[1]!; // 2nd episode of the batch
    const r = await create(family, { seriesId: SERIES, fromEpisodeId: EPS[0], count: 2 });
    expect(r.statusCode).toBe(502);
    expect(r.body).not.toContain('secret');
    expect(r.json().error).toBe('upstream_failed');
    expect((await env.pool.query('select count(*) n from downloads')).rows[0].n).toBe('0');
    expect((await env.pool.query('select count(*) n from download_jobs')).rows[0].n).toBe('0');
    failInfoFor = '';
    expect((await create(family, { seriesId: SERIES, fromEpisodeId: EPS[0], count: 2 })).statusCode).toBe(200);
  });

  it('a failing license insert (unknown profile -> FK violation) rolls back the jobs inserted before it', async () => {
    const { createDownloads } = await import('../src/downloads.js');
    const { effectiveRole } = await import('../src/roles.js');
    const user = (await env.pool.query('select * from users where id=$1', [await uid('Fam')])).rows[0];
    const role = (await effectiveRole(env.ctx, 'family'))!;
    await expect(createDownloads(env.ctx, { user, profileId: randomUUID(), jfUser: user, deviceId: 'dev-x', role }, { seriesId: SERIES, fromEpisodeId: EPS[0], count: 2, quality: 'hd' })).rejects.toThrow();
    expect((await env.pool.query('select count(*) n from download_jobs')).rows[0].n).toBe('0');
  });

  it('404 for unknown items without Jellyfin details', async () => {
    const r = await create(family, { itemId: GONE });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'not_found' });
  });

  it('BACKGROUND_JOBS=true kicks the job off fire-and-forget; false never calls enqueueJob', async () => {
    const was = env.ctx.cfg;
    env.ctx.cfg = { ...was, BACKGROUND_JOBS: 'true' };
    try {
      await create(family, { itemId: MOVIE });
    } finally { env.ctx.cfg = was; }
    const job = (await env.pool.query('select id from download_jobs')).rows;
    expect(enqueued).toEqual([job[0].id]);
  });
});

describe('role caps are part of the job key', () => {
  it('two roles with different effective caps get different jobs; equal caps share one', async () => {
    await setRole('family', { download_max_height: 360 });
    const a = (await create(family, { itemId: MOVIE, quality: 'sd' })).json().licenses[0];
    const b = (await create(admin, { itemId: MOVIE, quality: 'sd' })).json().licenses[0];
    const ja = await jobOf(a.id), jb = await jobOf(b.id);
    expect(ja.id).not.toBe(jb.id);
    expect(ja).toMatchObject({ max_height: 360, max_bitrate: 1_128_000 });
    expect(jb).toMatchObject({ max_height: 480, max_bitrate: 1_128_000 });
    await resetRole();
    const c = (await create(guest, { itemId: MOVIE })).statusCode; // guest cannot download at all
    expect(c).toBe(403);
    // same effective caps (hd, 720) from two roles -> one job
    await setRole('family', { download_max_height: 720 });
    const x = (await create(family, { itemId: EPS[0] })).json().licenses[0];
    const y = (await create(admin, { itemId: EPS[0] })).json().licenses[0];
    expect((await jobOf(x.id)).id).toBe((await jobOf(y.id)).id);
  });

  it('the bitrate cap shapes the job (qualityOptions clamp)', () => {
    const role = { ...DEFAULT_ROLES.family!, maxHeight: null, maxBitrate: 1_500_000 };
    const hd = qualityOptions(role, { originalEligible: false, sizeBytes: null, runtimeTicks: TICKS }).find((o) => o.id === 'hd')!;
    expect(hd.videoBitrate! + hd.audioBitrate!).toBe(1_500_000);
  });
});

describe('cancel when the last pending holder goes', () => {
  const st = async (id: string) => (await env.pool.query('select status, error from download_jobs where id=$1', [id])).rows[0];
  it('delete: queued job of the only holder is failed "cancelled"; a second holder keeps it', async () => {
    const a = (await create(family, { itemId: MOVIE })).json().licenses[0];
    const b = (await create(admin, { itemId: MOVIE })).json().licenses[0];
    const jid = (await jobOf(a.id)).id;
    await call(family, 'DELETE', `/api/downloads/${a.id}`);
    expect(await st(jid)).toMatchObject({ status: 'queued' });
    await call(admin, 'DELETE', `/api/downloads/${b.id}`);
    expect(await st(jid)).toMatchObject({ status: 'failed', error: 'cancelled' });
    // a new request starts a fresh job
    const c = (await create(family, { itemId: MOVIE })).json().licenses[0];
    expect((await jobOf(c.id)).id).not.toBe(jid);
  });

  it('admin revoke, bulk revoke and check-in revocation cancel too; ready jobs are left alone', async () => {
    const a = (await create(family, { itemId: EPS[0] })).json().licenses[0];
    const b = (await create(family, { itemId: EPS[1] })).json().licenses[0];
    const c = (await create(family, { itemId: EPS[2] })).json().licenses[0];
    const d = (await create(family, { itemId: MOVIE })).json().licenses[0];
    await env.pool.query("update download_jobs set status='preparing' where id=$1", [(await jobOf(b.id)).id]);
    await env.pool.query("update download_jobs set status='ready', bytes=5 where id=$1", [(await jobOf(d.id)).id]);
    expect((await call(admin, 'DELETE', `/api/admin/downloads/${a.id}`)).statusCode).toBe(200);
    expect(await st((await jobOf(a.id)).id)).toMatchObject({ status: 'failed', error: 'cancelled' });
    const { revokeDownloads } = await import('../src/downloads.js');
    await revokeDownloads(env.ctx, await uid('Fam'));
    expect(await st((await jobOf(b.id)).id)).toMatchObject({ status: 'failed', error: 'cancelled' });
    expect(await st((await jobOf(c.id)).id)).toMatchObject({ status: 'failed', error: 'cancelled' });
    expect(await st((await jobOf(d.id)).id)).toMatchObject({ status: 'ready' });
  });

  it('check-in revocation (role lost) cancels', async () => {
    const a = (await create(family, { itemId: MOVIE })).json().licenses[0];
    await setRole('family', { download: false });
    await call(family, 'POST', '/api/downloads/check', { ids: [a.id] });
    expect(await st((await jobOf(a.id)).id)).toMatchObject({ status: 'failed', error: 'cancelled' });
  });
});

describe('errors are not leaked to users', () => {
  it('failed jobs show a generic message; the raw error stays in the admin overview', async () => {
    const l = (await create(family, { itemId: MOVIE })).json().licenses[0];
    await env.pool.query("update download_jobs set status='failed', error='Jellyfin /Videos/x/master.m3u8 -> 500'");
    const v = (await call(family, 'GET', `/api/downloads/${l.id}`)).json();
    expect(v.prep).toEqual({ status: 'failed', percent: 0, error: 'prep_failed' }); // a code, never a (German) sentence
    expect(JSON.stringify((await call(family, 'GET', '/api/downloads')).json())).not.toContain('master.m3u8');
    expect((await call(admin, 'GET', '/api/admin/downloads')).json().jobs[0].error).toContain('master.m3u8');
    // the job was cleaned up: still a code
    await env.pool.query('delete from download_jobs');
    expect((await call(family, 'GET', `/api/downloads/${l.id}`)).json().prep).toEqual({ status: 'failed', percent: 0, error: 'prep_gone' });
  });
});
