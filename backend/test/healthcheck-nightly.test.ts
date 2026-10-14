// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkState, nightlyTick, startPlaybackCheck } from '../src/healthcheck.js';
import { makeEnv, type TestEnv } from './helpers.js';

const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((c) => c.repeat(32));
const failing = new Set<string>();
let env: TestEnv;

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': () => ({ json: { Items: ids.map((Id, i) => ({ Id, Name: `Film ${i}`, Type: 'Movie', UserData: {} })), TotalRecordCount: ids.length } }),
    'POST /Items/[^/]+/PlaybackInfo': (u) => ({ json: { PlaySessionId: 'ps-12345678', MediaSources: [{ Id: u.pathname.split('/')[2], Container: 'mkv', Bitrate: 8_000_000, MediaStreams: [] }] } }),
    'GET /Videos/[^/]+/master.m3u8': () => ({ raw: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1500000\nmain.m3u8?PlaySessionId=ps-12345678\n' }),
    'GET /Videos/[^/]+/main.m3u8': () => ({ raw: '#EXTM3U\n#EXTINF:3.0,\nhls1/main/0.mp4\n#EXT-X-ENDLIST\n' }),
    'GET /Videos/[^/]+/hls1/main/[^/]+': (u) => (ids.some((i) => failing.has(i) && u.pathname.includes(i)) ? { status: 500, raw: 'boom' } : { raw: 'segment-bytes' }),
    'DELETE /Videos/ActiveEncodings': () => ({ status: 204 }),
  });
  await env.login(); // creates the admin
  await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'a2', 'a2@x.de', 'Admin2', 'admin', $1, 'a2', 'x')`, ['2'.repeat(32)]);
});
afterAll(() => env.close());

const settle = async () => { for (let i = 0; i < 200 && (await checkState(env.ctx)).running; i++) await new Promise((r) => setTimeout(r, 20)); };
const run = async () => { expect(await startPlaybackCheck(env.ctx)).toBe(true); await settle(); };
const notes = async () => (await env.pool.query("select user_id, title, body, link from notifications where kind='playback_check'")).rows;
const at = (h: number, d = 10) => new Date(2026, 9, d, h, 5);

describe('nightly timer', () => {
  beforeEach(async () => { env.ctx.cfg = { ...env.ctx.cfg, PLAYBACK_CHECK_HOUR: 4 }; await env.pool.query('delete from playback_checks'); await settle(); });

  it('starts only in the configured hour, once per day', async () => {
    expect(await nightlyTick(env.ctx, at(3))).toBe(false);
    expect(await nightlyTick(env.ctx, at(5))).toBe(false);
    expect(await nightlyTick(env.ctx, at(4))).toBe(true);
    await settle();
    expect(await nightlyTick(env.ctx, at(4))).toBe(false); // already ran today
  });

  it('runs again the next day and skips while running', async () => {
    const now = new Date();
    env.ctx.cfg = { ...env.ctx.cfg, PLAYBACK_CHECK_HOUR: now.getHours() };
    await env.pool.query('delete from playback_checks');
    expect(await startPlaybackCheck(env.ctx)).toBe(true);
    expect(await nightlyTick(env.ctx, now)).toBe(false); // running -> skipped
    await settle();
    expect(await nightlyTick(env.ctx, now)).toBe(false); // ran today
    await env.pool.query("update playback_checks set started_at = started_at - interval '2 days'");
    expect(await nightlyTick(env.ctx, now)).toBe(true);
    await settle();
  });

  it('-1 disables it', async () => {
    env.ctx.cfg = { ...env.ctx.cfg, PLAYBACK_CHECK_HOUR: -1 };
    for (let h = 0; h < 24; h++) expect(await nightlyTick(env.ctx, at(h))).toBe(false);
    expect((await env.pool.query('select 1 from playback_checks')).rowCount).toBe(0);
  });
});

describe('failure notifications', () => {
  beforeEach(async () => { await env.pool.query('delete from playback_checks'); await env.pool.query('delete from notifications'); failing.clear(); });

  it('notifies each admin once about new failures only', async () => {
    const admins = (await env.pool.query("select id from users where role='admin'")).rows.map((r) => r.id).sort();
    expect(admins.length).toBe(2);
    await run(); // all fine
    expect(await notes()).toHaveLength(0);
    failing.add(ids[0]!); failing.add(ids[1]!);
    await run();
    let n = await notes();
    expect(n).toHaveLength(2);
    expect(n.map((r) => r.user_id).sort()).toEqual(admins);
    expect(n[0]).toMatchObject({ title: 'Wiedergabe-Check: 2 Titel neu fehlerhaft', body: 'Film 0, Film 1', link: '/admin/playback' });
    await run(); // identical failures
    expect(await notes()).toHaveLength(2);
    failing.delete(ids[0]!); // one recovered -> nothing
    await run();
    expect(await notes()).toHaveLength(2);
    for (const i of ids.slice(2)) failing.add(i); // 5 new + Film 1 stays
    await run();
    n = await notes();
    expect(n).toHaveLength(4);
    expect(n.find((r) => r.title.includes('5 Titel'))?.body).toBe('Film 2, Film 3, Film 4, Film 5, Film 6');
  });
});
