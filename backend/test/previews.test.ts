// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { previews } from '../src/previews.js';
import { ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

const MOVIE = 'a'.repeat(32); // 90 min -> clip starts at 1800 s = segment 600
const BAD = 'b'.repeat(32); // Jellyfin answers segments with 500
const SECRET = 'c'.repeat(32); // not visible to Lea
const FRESH = 'f'.repeat(32); // in the library listing, never requested: the background warmer's pick
const LEA_JF = '1'.repeat(32);

const box = (type: string, body: Buffer) => { const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]); };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const INIT = Buffer.concat([box('ftyp', Buffer.from('iso5')), box('moov', Buffer.from('init'))]);
const segment = (n: number) => Buffer.concat([
  box('moof', Buffer.concat([box('mfhd', Buffer.concat([u32(0), u32(n)])), box('traf', Buffer.concat([box('tfhd', Buffer.concat([u32(0), u32(1)])), box('tfdt', Buffer.concat([u32(0), u32(n * 3000)]))]))])),
  box('mdat', Buffer.from(`seg${n}`)),
]);
const tfdts = (b: Buffer) => [...b.toString('latin1').matchAll(/tfdt/g)].map((m) => b.readUInt32BE(m.index! + 8));

let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
let lea: { cookies: Record<string, string>; csrf: string };
let dir: string;
const requested: string[] = [];
const item = (id: string) => ({ Id: id, Name: 'T', Type: 'Movie', RunTimeTicks: 90 * 600_000_000, UserData: {} });
const itemHandler = (u: URL) => {
  const id = u.pathname.split('/').pop()!;
  if (id === SECRET && (u.searchParams.get('userId') === LEA_JF || u.pathname.startsWith(`/Users/${LEA_JF}/`))) return { status: 404 }; // both item paths (compat fallback)
  return { json: item(id) };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ff-prev-'));
  env = await makeEnv({
    'GET /Items/[^/]+': itemHandler,
    'GET /Users/[^/]+/Items/[^/]+': itemHandler,
    'GET /Items': () => ({ json: { Items: [MOVIE, BAD, FRESH].map(item), TotalRecordCount: 3 } }),
    'GET /Users/[^/]+/Items': () => ({ json: { Items: [MOVIE, BAD, FRESH].map(item), TotalRecordCount: 3 } }),
    'GET /Items/[^/]+/LocalTrailers': () => ({ json: [] }),
    'POST /Items/[^/]+/PlaybackInfo': (u) => ({ json: { PlaySessionId: 'ps-12345678', MediaSources: [{ Id: u.pathname.split('/')[2], Container: 'mkv', Bitrate: 8_000_000, MediaStreams: [] }] } }),
    'GET /Videos/[^/]+/master.m3u8': (u) => { requested.push(`master${u.search}`); return { raw: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1500000\nmain.m3u8?PlaySessionId=ps-12345678\n' }; },
    'GET /Videos/[^/]+/main.m3u8': () => ({ raw: `#EXTM3U\n#EXT-X-MAP:URI="hls1/main/-1.mp4?x=1"\n${Array.from({ length: 1800 }, (_, n) => `#EXTINF:3.0,\nhls1/main/${n}.mp4?x=1`).join('\n')}\n#EXT-X-ENDLIST\n` }),
    'GET /Videos/[^/]+/hls1/main/[^/]+': (u) => {
      const n = parseInt(u.pathname.split('/').pop()!, 10);
      requested.push(`seg${n}`);
      if (u.pathname.includes(BAD)) return { status: 500, raw: 'Error processing request.' };
      return { raw: n < 0 ? INIT : segment(n) };
    },
    'DELETE /Videos/ActiveEncodings': () => ({ status: 204 }),
  }, { ctxPatch: (c) => { c.cfg = { ...c.cfg, PREVIEW_DIR: dir }; } });
  admin = await env.login();
  const id = (await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'lea', 'l@x.de', 'Lea', 'guest', $1, 'lea', $2) returning id`,
    [LEA_JF, encrypt(keyFromBase64(ENC_KEY), 'pw')],
  )).rows[0].id;
  await env.kv.set(`sess:lea-session-${'x'.repeat(30)}`, JSON.stringify({ userId: id, csrf: 'leacsrf', deviceId: 'd', deviceApproved: true, createdAt: Date.now(), touchedAt: Date.now() }), 600);
  lea = { cookies: { ff_sid: `lea-session-${'x'.repeat(30)}` }, csrf: 'leacsrf' };
});
afterAll(() => env.close());
const get = (url: string, who = admin, headers: Record<string, string> = {}) => env.app.inject({ url, cookies: who.cookies, headers });

describe('cached preview clips', () => {
  it('first request: preparing + enqueue; after generation: the mp4 url', async () => {
    const both = await Promise.all([get(`/api/items/${MOVIE}/trailer`), get(`/api/items/${MOVIE}/trailer`)]); // single-flight
    expect(both[0]!.json()).toEqual({ error: 'preparing' }); // the 2nd may already see the finished clip; either way only one transcode runs (master requested once, below)
    await previews(env.ctx).whenIdle();
    const r = await get(`/api/items/${MOVIE}/trailer`);
    expect(r.json()).toEqual({ url: `/api/items/${MOVIE}/preview.mp4`, start: 0, mp4: true });
    // init + segments 600..609, once, sequentially
    expect(requested.filter((x) => x.startsWith('seg'))).toEqual(['seg-1', ...Array.from({ length: 10 }, (_, i) => `seg${600 + i}`)]);
    expect(requested.filter((x) => x.startsWith('master'))).toHaveLength(1);
    const q = new URL(requested.find((x) => x.startsWith('master'))!.slice(6), 'http://x').searchParams;
    expect(Object.fromEntries(q)).toMatchObject({ SegmentContainer: 'mp4', VideoCodec: 'h264', AudioCodec: 'aac', AllowVideoStreamCopy: 'false', AllowAudioStreamCopy: 'false', VideoBitrate: '1200000', AudioBitrate: '128000', MaxWidth: '1280', MaxStreamingBitrate: '1500000', PlaySessionId: 'ps-12345678' });
    const file = readFileSync(join(dir, `${MOVIE}.mp4`));
    expect(tfdts(file)).toEqual(Array.from({ length: 10 }, (_, i) => i * 3000)); // rebased to 0
    expect((await env.pool.query('select status, bytes from preview_clips')).rows[0]).toEqual({ status: 'ok', bytes: file.length });
    expect(env.jfCalls.some((c) => c.path.startsWith('/Sessions/Playing'))).toBe(false);
    expect(env.jfCalls.some((c) => c.method === 'DELETE' && c.path === '/Videos/ActiveEncodings' && c.search.includes('playSessionId=ps-12345678'))).toBe(true);
    expect(existsSync(join(dir, `${MOVIE}.mp4.${process.pid}.tmp`))).toBe(false);
  });

  it('transcodes as the admin service user, whoever asked', async () => {
    const tokens = new Set(env.jfCalls.filter((c) => c.path.startsWith('/Videos/')).map((c) => c.auth?.match(/Token="([^"]+)"/)?.[1]));
    expect([...tokens]).toEqual(['tok-Admin']);
  });

  it('serves the file with Range support to any logged-in viewer with access', async () => {
    const file = readFileSync(join(dir, `${MOVIE}.mp4`));
    const full = await get(`/api/items/${MOVIE}/preview.mp4`, lea);
    expect(full.statusCode).toBe(200);
    expect(full.headers).toMatchObject({ 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=86400' });
    expect(full.rawPayload.equals(file)).toBe(true);
    const part = await get(`/api/items/${MOVIE}/preview.mp4`, admin, { range: 'bytes=10-29' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 10-29/${file.length}`);
    expect(part.rawPayload.equals(file.subarray(10, 30))).toBe(true);
    const tail = await get(`/api/items/${MOVIE}/preview.mp4`, admin, { range: 'bytes=-5' });
    expect(tail.rawPayload.equals(file.subarray(file.length - 5))).toBe(true);
    expect((await get(`/api/items/${MOVIE}/preview.mp4`, admin, { range: `bytes=${file.length + 5}-` })).statusCode).toBe(416);
    expect((await env.app.inject(`/api/items/${MOVIE}/preview.mp4`)).statusCode).toBe(401);
  });

  it('a Jellyfin 500 records a failure and the endpoint answers no_preview afterwards', async () => {
    expect((await get(`/api/items/${BAD}/trailer`)).json()).toEqual({ error: 'preparing' });
    await previews(env.ctx).whenIdle();
    expect((await get(`/api/items/${BAD}/trailer`)).json()).toEqual({ error: 'no_preview' });
    const row = (await env.pool.query('select status, error from preview_clips where item_id=$1', [BAD])).rows[0];
    expect(row.status).toBe('failed');
    expect(row.error).toContain('500');
    expect(existsSync(join(dir, `${BAD}.mp4`))).toBe(false);
    // after 7 days it is tried again
    await env.pool.query("update preview_clips set created_at = now() - interval '8 days' where item_id=$1", [BAD]);
    expect((await get(`/api/items/${BAD}/trailer`)).json()).toEqual({ error: 'preparing' });
    await previews(env.ctx).whenIdle();
  });

  it('viewers without access get 404 and nothing is generated', async () => {
    expect((await get(`/api/items/${SECRET}/trailer`, lea)).statusCode).toBe(404);
    expect((await get(`/api/items/${SECRET}/preview.mp4`, lea)).statusCode).toBe(404);
    expect((await env.pool.query('select 1 from preview_clips where item_id=$1', [SECRET])).rowCount).toBe(0);
  });

  it('admin regenerate removes row + file and enqueues again', async () => {
    const r = await env.app.inject({ method: 'POST', url: '/api/admin/previews/regenerate', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { itemId: MOVIE } });
    expect(r.statusCode).toBe(200);
    await new Promise((res) => setTimeout(res, 20));
    await previews(env.ctx).whenIdle();
    expect((await env.pool.query('select status from preview_clips where item_id=$1', [MOVIE])).rows[0].status).toBe('ok');
  });
});

describe('background warmer', () => {
  it('stays out of the way while paused or a download is prepared', async () => {
    const p = previews(env.ctx);
    p.paused = true;
    await p.warmTick();
    p.paused = false;
    p.downloadBusy = true;
    await p.warmTick();
    p.downloadBusy = false;
    expect((await env.pool.query('select 1 from preview_clips where item_id=$1', [FRESH])).rowCount).toBe(0);
  });

  it('generates the clip of the first library title that has no row yet, then has nothing left to do', async () => {
    const p = previews(env.ctx);
    await p.warmTick();
    await p.whenIdle();
    expect((await env.pool.query('select status from preview_clips where item_id=$1', [FRESH])).rows[0]?.status).toBe('ok');
    const before = requested.length;
    await p.warmTick(); // every listed title has a row now
    await p.whenIdle();
    expect(requested.length).toBe(before);
  });
});
