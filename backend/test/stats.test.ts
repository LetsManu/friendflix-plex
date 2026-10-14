// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluate, grant } from '../src/achievements.js';
import { bus } from '../src/bus.js';
import { playbackHooks } from '../src/hooks.js';
import type { Live } from '../src/live.js';
import { makeEnv, type TestEnv } from './helpers.js';
import type { UserRow } from '../src/types.js';

const HIDDEN = 'd'.repeat(32), SECRET = 's'.repeat(31) + '1';
let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
let user: UserRow;
const live = (over: Partial<Live> = {}): Live => ({ userId: user.id, userName: 'Admin', itemId: 'a'.repeat(32), title: 'Film', type: 'Movie', positionTicks: 0, isPaused: false, playSessionId: 'ps-1', updatedAt: Date.now(), source: 'portal', ...over });

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': (u) => ({ json: { Items: (u.searchParams.get('ids') ?? '').split(',').filter((i) => i && i !== HIDDEN).map((id) => ({ Id: id, Name: id, Type: 'Movie' })) } }),
  });
  admin = await env.login();
  user = (await env.pool.query('select * from users')).rows[0];
});
afterAll(() => env.close());
const get = (url: string) => env.app.inject({ url, cookies: admin.cookies });

describe('statistics', () => {
  it('counts watch time from progress events, ignores pause and start events', async () => {
    await playbackHooks.run(env.ctx, { kind: 'Playing', user, live: live(), elapsedMs: 30000 });
    await playbackHooks.run(env.ctx, { kind: 'Playing/Progress', user, live: live({ isPaused: true }), elapsedMs: 30000 });
    await playbackHooks.run(env.ctx, { kind: 'Playing/Progress', user, live: live(), elapsedMs: 10000 });
    await playbackHooks.run(env.ctx, { kind: 'Playing/Progress', user, live: live(), elapsedMs: 20000 });
    const s = (await get('/api/stats/me')).json();
    expect(s.totalMinutes).toBe(1); // 30 s -> rounds to 1 min (display)
    const row = (await env.pool.query('select seconds from play_seconds')).rows[0];
    expect(row.seconds).toBe(30);
    expect(s.movies).toBe(1);
    expect(s.topItems[0]).toMatchObject({ name: 'Film' });
  });

  it('groups episodes by series and detects binge + hour achievements', async () => {
    for (let i = 1; i <= 3; i++) {
      await env.pool.query(`insert into play_seconds(user_id,item_id,day,seconds,item_name,item_type,series_name) values ($1,$2,current_date,1500,$3,'Episode','Bright Valley')`, [user.id, `e${i}`.padEnd(32, '0'), `Folge ${i}`]);
    }
    const got = await evaluate(env.ctx, user.id);
    expect(got).toContain('binge');
    expect((await get('/api/achievements')).json().earned).toContain('first_play'); // granted earlier by the playback hook
    expect(got).not.toContain('hours_10');
    await env.pool.query(`insert into play_seconds(user_id,item_id,day,seconds,item_name) values ($1,'big',current_date - 1,40000,'Marathon')`, [user.id]);
    expect(await evaluate(env.ctx, user.id)).toContain('hours_10');
    const s = (await get('/api/stats/me')).json();
    expect(s.topItems[0].name).toBe('Marathon');
    expect(s.topItems.find((t: any) => t.name === 'Bright Valley').minutes).toBe(75);
    expect(s.achievements.filter((a: any) => a.earnedAt).length).toBeGreaterThanOrEqual(3);
  });

  it('achievements are granted once and notify the user; event-driven ones work', async () => {
    expect(await grant(env.ctx, user.id, 'party_goer')).toBe(true);
    expect(await grant(env.ctx, user.id, 'party_goer')).toBe(false);
    bus.emitT('party.join', { userId: user.id, roomId: 'r' });
    const n = (await get('/api/notifications')).json().notifications.filter((x: any) => x.kind === 'achievement');
    expect(n.filter((x: any) => x.title.includes('Partylöwe'))).toHaveLength(1);
  });

  it('community stats expose names/minutes only', async () => {
    const c = (await get('/api/stats/community')).json();
    expect(c.leaderboard[0]).toMatchObject({ name: 'Admin' });
    expect(Object.keys(c.leaderboard[0]).sort()).toEqual(['minutes', 'name']);
    expect(c.topTitles.length).toBeGreaterThan(0);
  });
  it('top titles respect shareHistory and the viewer\'s Jellyfin visibility', async () => {
    const other = (await env.pool.query(`insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'o', 'o@x.de', 'Other', 'friend', 'jf-o', 'other', 'x') returning id`)).rows[0].id;
    const ins = (uid: string, item: string, name: string) => env.pool.query(`insert into play_seconds(user_id,item_id,day,seconds,item_name) values ($1,$2,current_date,999999,$3)`, [uid, item, name]);
    await ins(other, SECRET, 'Heimlich'); // other user did not opt in
    await ins(other, HIDDEN, 'Unsichtbar'); await ins(user.id, HIDDEN, 'Unsichtbar'); // not visible to the viewer
    let names = (await get('/api/stats/community')).json().topTitles.map((t: any) => t.name);
    expect(names).not.toContain('Heimlich');
    expect(names).not.toContain('Unsichtbar');
    expect(names).toContain('Marathon');
    await env.pool.query(`insert into user_prefs(user_id, data) values ($1, '{"shareHistory": true}')`, [other]);
    names = (await get('/api/stats/community')).json().topTitles.map((t: any) => t.name);
    expect(names[0]).toBe('Heimlich');
    expect(names).not.toContain('Unsichtbar');
    await env.pool.query('delete from users where id=$1', [other]);
    await env.pool.query('delete from play_seconds where item_id=$1', [HIDDEN]);
  });
  it('validates year', async () => expect((await get('/api/stats/me?year=abc')).statusCode).toBe(400));
});

describe('admin status and metrics', () => {
  it('status is admin-only data; metrics expose app gauges and security headers are set', async () => {
    const st = (await get('/api/admin/status')).json();
    expect(st).toMatchObject({ users: 1, activeStreams: 0, jellyfin: true });
    const m = await env.app.inject('/metrics');
    expect(m.body).toMatch(/friendflix_users_total 1/);
    expect(m.body).toMatch(/friendflix_dependency_up\{dependency="postgres"\} 1/);
    const h = await env.app.inject('/health');
    expect(h.headers['x-content-type-options']).toBe('nosniff');
    expect(h.headers['cache-control']).toBe('no-store');
  });
});
