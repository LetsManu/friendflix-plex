// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { setLive } from '../src/live.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

// Block 22 Task 7: aggregated per-account usage (no titles).
type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess;
let adminId = '';
const fritzId = randomUUID();
const lenaId = randomUUID();
const ITEM_A = 'a'.repeat(32), ITEM_B = 'b'.repeat(32), ITEM_C = 'c'.repeat(32), ITEM_D = 'd'.repeat(32);
const SECRET_TITLES = ['Matrix Geheim', 'Dark Folge', 'Dark Serie', 'Alter Film'];
const as = (s: Sess, method: string, url: string) => env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf } });

beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login(ADMIN);
  adminId = (await env.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id;
  const ins = "insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc, disabled) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)";
  await env.pool.query(ins, [fritzId, 'sub-f', 'f@example.com', 'Fritz', 'friend', 'jffritz', 'Fritz', encrypt(env.ctx.encKey, 'pw'), false]);
  await env.pool.query(ins, [lenaId, 'sub-l', 'l@example.com', 'Lena', 'friend', 'jflena', 'Lena', encrypt(env.ctx.encKey, 'pw'), true]);
  const ps = 'insert into play_seconds(user_id, item_id, day, seconds, item_name, item_type, series_name) values ($1,$2,current_date - $3::int,$4,$5,$6,$7)';
  await env.pool.query(ps, [fritzId, ITEM_A, 0, 3600, 'Matrix Geheim', 'Movie', null]);
  await env.pool.query(ps, [fritzId, ITEM_B, 0, 1800, 'Dark Folge', 'Episode', 'Dark Serie']);
  await env.pool.query(ps, [fritzId, ITEM_C, 10, 600, 'Dark Folge 2', 'Episode', 'Dark Serie']);
  await env.pool.query(ps, [fritzId, ITEM_D, 40, 999, 'Alter Film', 'Movie', null]);
  await env.pool.query(ps, [lenaId, ITEM_A, 1, 120, 'Matrix Geheim', 'Movie', null]);
  const pd = 'insert into play_daily(user_id, day, device_id, streams, transcodes, reasons) values ($1, current_date - $2::int, $3, $4, $5, $6)';
  await env.pool.query(pd, [fritzId, 0, 'dev1', 3, 2, JSON.stringify({ videoCodec: 2 })]);
  await env.pool.query(pd, [fritzId, 3, 'app:Infuse', 1, 1, JSON.stringify({ audioCodec: 1 })]);
  await env.pool.query(pd, [fritzId, 20, 'dev1', 4, 0, '{}']);
  await env.pool.query(pd, [fritzId, 50, 'dev2', 1, 0, '{}']);
  const dv = "insert into devices(user_id, device_id, label, approved, last_seen) values ($1, $2, $3, $4, now() - $5::interval)";
  await env.pool.query(dv, [fritzId, 'dev1', 'Wohnzimmer TV', true, '1 hour']);
  await env.pool.query(dv, [fritzId, 'dev2', 'Handy', true, '2 days']);
  await env.pool.query(dv, [fritzId, 'dev3', 'Neu', false, '5 minutes']);
  await setLive(env.ctx, { userId: fritzId, userName: 'Fritz', itemId: ITEM_A, title: 'Matrix Geheim', positionTicks: 0, isPaused: false, playSessionId: 'ps1', updatedAt: Date.now(), source: 'portal' });
});
afterAll(() => env.close());
beforeEach(async () => {
  for (const k of await env.kv.keys('usage:')) await env.kv.del(k);
});

const usage = async (qs: string) => {
  const r = await as(admin, 'GET', `/api/admin/usage${qs}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { users: Array<Record<string, any>>; since: string | null };
};

describe('usage API', () => {
  it('30 days: seconds, movie vs series split, titles count, streams, transcodes, topReason', async () => {
    const u = await usage('?days=30');
    const f = u.users.find((x) => x.userId === fritzId)!;
    expect(f).toMatchObject({
      name: 'Fritz', role: 'friend', disabled: false, seconds: 6000, movieSeconds: 3600, seriesSeconds: 2400, titles: 2,
      streams: 8, transcodes: 3, topReason: 'videoCodec', devices: 2, devicesUsed: 2, liveNow: 1,
    });
    expect(u.since).toBe(new Date(Date.now() - 50 * 86400_000).toISOString().slice(0, 10));
    const a = u.users.find((x) => x.userId === adminId)!;
    expect(a).toMatchObject({ seconds: 0, titles: 0, streams: 0, transcodes: 0, topReason: null, liveNow: 0 });
  });

  it('period 7 excludes older rows; days array has 7 entries with zeros', async () => {
    const f = (await usage('?days=7')).users.find((x) => x.userId === fritzId)!;
    expect(f).toMatchObject({ seconds: 5400, movieSeconds: 3600, seriesSeconds: 1800, titles: 2, streams: 4, transcodes: 3, devicesUsed: 2 });
    const d = (await as(admin, 'GET', `/api/admin/usage/${fritzId}?days=7`)).json();
    expect(d.days).toHaveLength(7);
    expect(d.days[6]).toEqual({ day: new Date().toISOString().slice(0, 10), seconds: 5400 });
    expect(d.days.slice(0, 6).every((x: { seconds: number }) => x.seconds === 0)).toBe(true);
    expect(d.reasons).toEqual({ videoCodec: 2, audioCodec: 1 });
    expect(d.since).toBe(new Date(Date.now() - 50 * 86400_000).toISOString().slice(0, 10));
    expect((await as(admin, 'GET', `/api/admin/usage/${fritzId}?days=90`)).json().days).toHaveLength(90);
  });

  it('devices: approved count, devicesUsed from play_daily in the period, labels from devices; app:Infuse → label "Infuse", app true', async () => {
    const d = (await as(admin, 'GET', `/api/admin/usage/${fritzId}?days=30`)).json();
    expect(d.userId).toBe(fritzId);
    const byLabel = Object.fromEntries(d.devices.map((x: { label: string }) => [x.label, x]));
    expect(byLabel['Wohnzimmer TV']).toMatchObject({ streams: 7, transcodes: 2, app: false });
    expect(byLabel['Wohnzimmer TV'].lastSeen).toBeTruthy();
    expect(byLabel.Infuse).toMatchObject({ streams: 1, transcodes: 1, app: true });
    expect(byLabel.Handy).toMatchObject({ streams: 0, transcodes: 0, app: false }); // approved, not used in the period
    expect(byLabel.Neu).toBeUndefined(); // not approved, not used
    expect(d.devices[0].label).toBe('Wohnzimmer TV'); // most streams first
    expect(JSON.stringify(d)).not.toContain('dev1');
  });

  it('lastSeen = max devices.last_seen; liveNow from listLive', async () => {
    const f = (await usage('?days=30')).users.find((x) => x.userId === fritzId)!;
    const max = (await env.pool.query('select max(last_seen) m from devices where user_id = $1', [fritzId])).rows[0].m as Date;
    expect(f.lastSeen).toBe(max.toISOString());
    expect(f.liveNow).toBe(1);
  });

  it('no response contains a seeded title, series name or item id', async () => {
    const bodies = [
      (await as(admin, 'GET', '/api/admin/usage?days=90')).body,
      (await as(admin, 'GET', `/api/admin/usage/${fritzId}?days=90`)).body,
      (await as(admin, 'GET', `/api/admin/usage/${lenaId}?days=90`)).body,
    ];
    for (const b of bodies) {
      for (const t of [...SECRET_TITLES, 'Dark', ITEM_A, ITEM_B, ITEM_C, ITEM_D]) expect(b, t).not.toContain(t);
    }
  });

  it('disabled users listed with disabled true; sort streams desc; sort name', async () => {
    const u = await usage('?days=90&sort=streams&dir=desc');
    expect(u.users.find((x) => x.userId === lenaId)).toMatchObject({ disabled: true, seconds: 120, titles: 1 });
    expect(u.users[0]!.userId).toBe(fritzId);
    expect(u.users[0]!.streams).toBe(9);
    const n = await usage('?days=90&sort=name');
    expect(n.users.map((x) => x.name)).toEqual(['Admin', 'Fritz', 'Lena']);
    const nd = await usage('?days=90&sort=name&dir=desc');
    expect(nd.users.map((x) => x.name)).toEqual(['Lena', 'Fritz', 'Admin']);
  });

  it('cached 60 s per period; liveNow stays current', async () => {
    await usage('?days=30');
    await env.pool.query("update play_daily set streams = streams + 100 where user_id = $1 and device_id = 'dev1' and day = current_date", [fritzId]);
    try {
      let f = (await usage('?days=30')).users.find((x) => x.userId === fritzId)!;
      expect(f.streams).toBe(8);
      await env.kv.del('usage:rows:30');
      f = (await usage('?days=30')).users.find((x) => x.userId === fritzId)!;
      expect(f.streams).toBe(108);
      await setLive(env.ctx, { userId: fritzId, userName: 'Fritz', itemId: ITEM_B, title: 'Dark Folge', positionTicks: 0, isPaused: false, playSessionId: 'ps2', updatedAt: Date.now(), source: 'portal' });
      f = (await usage('?days=30')).users.find((x) => x.userId === fritzId)!;
      expect(f.liveNow).toBe(2);
      await env.kv.del(`play:${fritzId}:ps2`);
    } finally {
      await env.pool.query("update play_daily set streams = streams - 100 where user_id = $1 and device_id = 'dev1' and day = current_date", [fritzId]);
    }
  });

  it('friend 403; admin on a non-owner profile 403; no session 401; bad days → 400; unknown user 404', async () => {
    const fritz = await env.login({ sub: 'sub-f', email: 'f@example.com', name: 'Fritz', groups: [] });
    const s = await env.login(ADMIN);
    const pid = randomUUID();
    await env.pool.query('insert into profiles(id, user_id, name, is_owner, kids, jellyfin_user_id) values ($1, $2, $3, false, false, $4)', [pid, adminId, 'Gast', 'f'.repeat(32)]);
    const raw = JSON.parse((await env.kv.get(`sess:${s.cookies.ff_sid}`))!);
    await env.kv.set(`sess:${s.cookies.ff_sid}`, JSON.stringify({ ...raw, profileId: pid }), 600);
    for (const u of ['/api/admin/usage?days=30', `/api/admin/usage/${fritzId}?days=30`]) {
      expect((await as(fritz, 'GET', u)).statusCode, `friend ${u}`).toBe(403);
      expect((await as(s, 'GET', u)).statusCode, `non-owner ${u}`).toBe(403);
      expect((await env.app.inject({ url: u })).statusCode, `anon ${u}`).toBe(401);
    }
    await env.pool.query('delete from profiles where id=$1', [pid]);
    expect((await as(admin, 'GET', '/api/admin/usage?days=14')).statusCode).toBe(400);
    expect((await as(admin, 'GET', '/api/admin/usage?sort=title')).statusCode).toBe(400);
    expect((await as(admin, 'GET', `/api/admin/usage/${fritzId}?days=1`)).statusCode).toBe(400);
    expect((await as(admin, 'GET', `/api/admin/usage/${randomUUID()}?days=30`)).statusCode).toBe(404);
    expect((await as(admin, 'GET', '/api/admin/usage/not-a-uuid')).statusCode).toBe(400);
    expect((await usage('')).users.length).toBe(3); // days defaults to 30
  });
});
