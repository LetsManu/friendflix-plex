import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

const GOOD = 'a'.repeat(32);
const BAD = 'b'.repeat(32);
const SHOW = 'c'.repeat(32);
const EP = 'd'.repeat(32);
const LIB = [[GOOD, 'Gut', 'Movie'], [BAD, 'HDR', 'Movie'], [SHOW, 'Serie', 'Series']];

let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
const segs: string[] = [];
const get = () => env.app.inject({ url: '/api/admin/playback-check', cookies: admin.cookies });
const start = () => env.app.inject({ method: 'POST', url: '/api/admin/playback-check', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf } });

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': () => ({ json: { Items: LIB.map(([Id, Name, Type]) => ({ Id, Name, Type, UserData: {} })), TotalRecordCount: LIB.length } }),
    'GET /Shows/[^/]+/Episodes': () => ({ json: { Items: [{ Id: EP, RunTimeTicks: 1 }] } }),
    'POST /Items/[^/]+/PlaybackInfo': (u) => ({ json: { PlaySessionId: 'ps-12345678', MediaSources: [{ Id: u.pathname.split('/')[2], Container: 'mkv', Bitrate: 8_000_000, MediaStreams: [] }] } }),
    'GET /Videos/[^/]+/master.m3u8': (u) => (u.search.includes('AllowVideoStreamCopy=false') && u.search.includes('MaxWidth=1280') ? { raw: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1500000\nmain.m3u8?PlaySessionId=ps-12345678\n' } : { status: 400 }),
    'GET /Videos/[^/]+/main.m3u8': () => ({ raw: `#EXTM3U\n${Array.from({ length: 20 }, (_, n) => `#EXTINF:3.0,\nhls1/main/${n}.mp4`).join('\n')}\n#EXT-X-ENDLIST\n` }),
    'GET /Videos/[^/]+/hls1/main/[^/]+': (u) => {
      segs.push(u.pathname);
      if (u.pathname.includes(BAD)) return { status: 500, raw: 'Error processing request.' };
      return { raw: 'segment-bytes' };
    },
    'DELETE /Videos/ActiveEncodings': () => ({ status: 204 }),
  });
  admin = await env.login();
});
afterAll(() => env.close());

describe('playback check', () => {
  it('is admin only', async () => {
    const id = (await env.pool.query(
      `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'bob', 'b@x.de', 'Bob', 'guest', $1, 'bob', $2) returning id`,
      ['1'.repeat(32), encrypt(keyFromBase64(ENC_KEY), 'pw')],
    )).rows[0].id;
    await env.kv.set(`sess:bob-session-${'x'.repeat(30)}`, JSON.stringify({ userId: id, csrf: 'bobcsrf', deviceId: 'd', deviceApproved: true, createdAt: Date.now(), touchedAt: Date.now() }), 600);
    const bob = { cookies: { ff_sid: `bob-session-${'x'.repeat(30)}` }, csrf: 'bobcsrf' };
    expect((await env.app.inject({ url: '/api/admin/playback-check', cookies: bob.cookies })).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'POST', url: '/api/admin/playback-check', cookies: bob.cookies, headers: { 'x-csrf-token': bob.csrf } })).statusCode).toBe(403);
  });

  it('starts, answers 409 while running, marks 500 failed and 200 ok, persists', async () => {
    expect((await get()).json()).toMatchObject({ running: false, results: [] });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = env.ctx.jf.playbackInfo.bind(env.ctx.jf);
    env.ctx.jf.playbackInfo = async (...a) => { await gate; return orig(...a); }; // keeps the job running
    expect((await start()).statusCode).toBe(200);
    expect((await start()).statusCode).toBe(409); // one job per process
    expect((await get()).json()).toMatchObject({ running: true });
    release();
    for (let i = 0; i < 100 && (await get()).json().running; i++) await new Promise((r) => setTimeout(r, 20));
    const j = (await get()).json();
    expect(j).toMatchObject({ running: false, done: 3, total: 3 });
    const by = Object.fromEntries(j.results.map((r: any) => [r.itemId, r]));
    expect(by[GOOD]).toMatchObject({ ok: true, status: 200, bytes: 13, error: null });
    expect(by[SHOW]).toMatchObject({ ok: true, type: 'Series' });
    expect(by[BAD]).toMatchObject({ ok: false, status: 500, name: 'HDR' });
    expect(by[BAD].error).toContain('500');
    expect(segs.every((s) => s.endsWith('/5.mp4'))).toBe(true); // min(5, last) of 20
    expect(segs.some((s) => s.includes(EP))).toBe(true); // series -> first episode
    expect(env.jfCalls.filter((c) => c.method === 'DELETE' && c.path === '/Videos/ActiveEncodings')).toHaveLength(3);
    const row = (await env.pool.query('select results from playback_checks')).rows;
    expect(row).toHaveLength(1);
    expect(row[0].results).toHaveLength(3);
    // a fresh job can start again once finished
    expect((await start()).statusCode).toBe(200);
    for (let i = 0; i < 100 && (await get()).json().running; i++) await new Promise((r) => setTimeout(r, 20));
  });
});
