// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { healthTick } from '../src/health.js';
import { pruneTimings, timingBody } from '../src/playtiming.js';
import { makeEnv, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess, friend: Sess;

beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login();
  const inv = await env.app.inject({ method: 'POST', url: '/api/admin/invites', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { role: 'friend', ttlHours: 1 } });
  const token = inv.json().link.split('/').pop();
  env.claims.current = { sub: 'sub-friend', email: 'f@example.com', name: 'Fred', groups: [] };
  const l = await env.app.inject(`/auth/login?invite=${token}`);
  const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
  const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } });
  const sid = cb.cookies.find((x) => x.name === 'ff_sid')!.value;
  friend = { cookies: { ff_sid: sid }, csrf: (await env.app.inject({ url: '/api/me', cookies: { ff_sid: sid } })).json().csrfToken };
});
afterAll(() => env.close());
beforeEach(async () => { await env.pool.query('delete from playback_timings'); await env.kv.del(`ptiming:h:${(await me(friend)).id}`); });

const me = async (s: Sess) => (await env.app.inject({ url: '/api/me', cookies: s.cookies })).json() as { id: string };
const base = { device: 'phone', mode: 'hls', bitrate: 8_000_000, targetDuration: 6, infoMs: 300, manifestMs: 700, firstFragMs: 2500, firstFragBytes: 4_000_000, firstFragDlMs: 1500, firstFrameMs: 3000, seeks: 2, seekMedianMs: 900, seekMaxMs: 1500, stalls: 1, stallMs: 2000, effectiveType: '4g' };
const post = (s: Sess, payload: unknown, headers: Record<string, string> = {}, csrf = true) =>
  env.app.inject({ method: 'POST', url: '/api/playback/timing', cookies: s.cookies, headers: { ...(csrf ? { 'x-csrf-token': s.csrf } : {}), ...headers }, payload: payload as object });
const rows = async () => (await env.pool.query('select * from playback_timings order by id')).rows;

describe('POST /api/playback/timing', () => {
  it('stores one anonymous row; home comes from the server (remote address = false, home address = true)', async () => {
    expect((await post(friend, base, { 'x-real-ip': '203.0.113.9' })).statusCode).toBe(204);
    expect((await post(friend, { ...base, device: 'pc' }, { 'x-real-ip': '192.168.1.10' })).statusCode).toBe(204);
    const r = await rows();
    expect(r.map((x) => [x.home, x.device])).toEqual([[false, 'phone'], [true, 'pc']]);
    expect(r[0]).toMatchObject({ mode: 'hls', bitrate: 8_000_000, target_duration: 6, info_ms: 300, manifest_ms: 700, first_frag_ms: 2500, first_frag_bytes: 4_000_000, first_frag_dl_ms: 1500, first_frame_ms: 3000, seeks: 2, seek_median_ms: 900, seek_max_ms: 1500, stalls: 1, stall_ms: 2000, effective_type: '4g', quality_switch: false });
  });

  it('never stores personal fields: no user, profile, item, address or user agent column, extra fields are dropped', async () => {
    const id = (await me(friend)).id;
    expect((await post(friend, { ...base, userId: id, profileId: id, itemId: 'a'.repeat(32), ip: '203.0.113.9', userAgent: 'UA', home: true }, { 'x-real-ip': '203.0.113.9', 'user-agent': 'Secret-UA' })).statusCode).toBe(204);
    const cols = (await env.pool.query("select column_name from information_schema.columns where table_name = 'playback_timings'")).rows.map((x) => x.column_name);
    for (const c of cols) expect(c).not.toMatch(/user|profile|item|ip|agent|addr|session/);
    const r = await rows();
    expect(r[0].home).toBe(false); // the client's "home: true" is ignored
    expect(JSON.stringify(r)).not.toMatch(new RegExp(`${id}|aaaaaaaa|Secret-UA|203\\.0\\.113`));
  });

  it('validates with zod and clamps the numbers', async () => {
    expect((await post(friend, { ...base, device: 'watch' })).statusCode).toBe(400);
    expect((await post(friend, { ...base, mode: 'dash' })).statusCode).toBe(400);
    expect((await post(friend, { ...base, infoMs: 'slow' })).statusCode).toBe(400);
    expect((await post(friend, { ...base, firstFrameMs: 1e12, infoMs: -50, targetDuration: 6.04, stallMs: 1e15, seeks: 99_999, effectiveType: 'wifi', bitrate: null })).statusCode).toBe(204);
    expect((await rows())[0]).toMatchObject({ first_frame_ms: 600_000, info_ms: 0, stall_ms: 86_400_000, seeks: 10_000, effective_type: null, bitrate: null });
    expect((await rows())[0].target_duration).toBeCloseTo(6, 3);
    expect(timingBody.parse({ device: 'tv', mode: 'direct' })).toMatchObject({ qualitySwitch: false });
  });

  it('needs a session and the csrf header; per-user hourly limit', async () => {
    expect((await env.app.inject({ method: 'POST', url: '/api/playback/timing', payload: base })).statusCode).toBe(401);
    expect((await post(friend, base, {}, false)).statusCode).toBe(403);
    await env.kv.incr(`ptiming:h:${(await me(friend)).id}`, 3600);
    for (let i = 0; i < 119; i++) await env.kv.incr(`ptiming:h:${(await me(friend)).id}`, 3600);
    expect((await post(friend, base)).statusCode).toBe(429);
    expect(await rows()).toHaveLength(0);
  });
});

describe('GET /api/admin/playback/timing', () => {
  it('is for admins only', async () => {
    expect((await env.app.inject({ url: '/api/admin/playback/timing', cookies: friend.cookies })).statusCode).toBe(403);
  });

  it('medians / p90 of each step per side and device, quality switches not counted as starts; the last 30 rows', async () => {
    const remote = { 'x-real-ip': '203.0.113.9' };
    for (const f of [1000, 2000, 3000, 4000, 5000]) await post(friend, { ...base, firstFrameMs: f + 2500 }, remote);
    await post(friend, { ...base, qualitySwitch: true, firstFrameMs: 60_000 }, remote);
    await post(friend, { device: 'pc', mode: 'direct', infoMs: 200, firstFrameMs: 900 }, { 'x-real-ip': '192.168.1.10' });
    await env.pool.query("insert into playback_timings(home, device, mode, first_frame_ms, created_at) values (false, 'phone', 'hls', 99999, now() - interval '3 days')");
    const r = await env.app.inject({ url: '/api/admin/playback/timing', cookies: admin.cookies });
    expect(r.statusCode).toBe(200);
    const v = r.json();
    const dayPhone = v.day.find((g: any) => !g.home && g.device === 'phone');
    expect(dayPhone).toMatchObject({ n: 5, switches: 1, targetDuration: 6 });
    expect(dayPhone.total).toEqual({ p50: 5500, p90: 7100 });
    expect(dayPhone.phases.info).toEqual({ p50: 300, p90: 300 });
    expect(dayPhone.phases.manifest).toEqual({ p50: 400, p90: 400 });
    expect(dayPhone.phases.firstFrag).toEqual({ p50: 1800, p90: 1800 });
    expect(dayPhone.phases.firstFrame).toEqual({ p50: 3000, p90: 4600 });
    expect(dayPhone.stallsPerSession).toBe(1);
    // direct play: no playlist / fragment, the frame step counts from the info answer
    const home = v.day.find((g: any) => g.home && g.device === 'pc');
    expect(home.phases).toMatchObject({ manifest: { p50: null }, firstFrag: { p50: null }, firstFrame: { p50: 700 } });
    // grouping set: every device of one side
    expect(v.day.find((g: any) => !g.home && g.device === null).n).toBe(5);
    expect(v.week.find((g: any) => !g.home && g.device === 'phone').n).toBe(6);
    expect(v.recent).toHaveLength(8);
    expect(v.recent[0]).toMatchObject({ device: 'pc', mode: 'direct', home: true, firstFrameMs: 900, qualitySwitch: false });
    expect(Object.keys(v.recent[0])).not.toContain('userId');
  });
});

describe('cleanup', () => {
  it('pruneTimings / healthTick delete rows older than 14 days', async () => {
    await env.pool.query("insert into playback_timings(home, device, mode, created_at) values (true, 'pc', 'hls', now() - interval '15 days'), (true, 'pc', 'hls', now() - interval '13 days')");
    expect(await pruneTimings(env.ctx)).toBe(1);
    await env.pool.query("insert into playback_timings(home, device, mode, created_at) values (true, 'tv', 'hls', now() - interval '20 days')");
    await env.kv.del('health:prune');
    await healthTick(env.ctx, { fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch, timeoutMs: 50 });
    expect((await rows()).map((x) => x.device)).toEqual(['pc']);
  });
});
