import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authClientIp, blocksDirectStream, compatPlaylist, createGateway, hlsAttrs, matchDownloadPath, normalizeCastPath, normalizePath, sanitizePlaylist } from '../src/gateway.js';

const ID = 'a'.repeat(32);
let jf: Server, be: Server, gw: Server;
let gwPort: number;
const seen: Array<{ url: string; auth?: string; range?: string; acceptEncoding?: string; cookie?: string }> = [];
const authzBodies: string[] = [];
const authzCalls: Array<{ ct: string; client?: string }> = [];
const sidCalls: Array<{ sid: string; ip?: string }> = [];
const REMOTE_IP = '203.0.113.9';
const MS = 'b'.repeat(32);
const CT = 'A'.repeat(43); // valid cast token of the fake backend
const CT_BAD = 'B'.repeat(43);
const CT_IMG = 'I'.repeat(43); // poster-only token
const CT_PIN = 'P'.repeat(43); // valid only for client PIN_CLIENT (the backend pins tokens to the first client)
const CT_LOW = 'L'.repeat(43); // role limited to 720p
const PIN_CLIENT = '198.51.100.50';
const D_FILE = '11111111-1111-4111-8111-111111111111';
const D_BADNAME = '22222222-2222-4222-8222-222222222222';
const D_LINK = '33333333-3333-4333-8333-333333333333';
const D_STATIC = '44444444-4444-4444-8444-444444444444';
const D_STATIC_BAD = '55555555-5555-4555-8555-555555555555';
const D_MISMATCH = '66666666-6666-4666-8666-666666666666';
const D_BIG = '77777777-7777-4777-8777-777777777777';
const D_MISSING = '88888888-8888-4888-8888-888888888888';
const DL_SIZE = 1000;
const dlDir = mkdtempSync(join(tmpdir(), 'ff-dl-'));
const dlOutside = mkdtempSync(join(tmpdir(), 'ff-dl-out-'));
const dlBody = Buffer.from(Array.from({ length: DL_SIZE }, (_, i) => i % 251));
const castBase = `/media/c/${CT}`;
/** a Jellyfin 10.10 master as the cast path gets it: subtitle group, VIDEO-RANGE, trickplay image playlist (field: LG webOS rejects it) */
const JF_MASTER = [
  '#EXTM3U',
  `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,LANGUAGE="eng",URI="${MS}/Subtitles/3/subtitles.m3u8?SegmentLength=3&api_key=LEAK"`,
  '#EXT-X-STREAM-INF:BANDWIDTH=11088278,AVERAGE-BANDWIDTH=11088278,VIDEO-RANGE=SDR,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=23.976,SUBTITLES="subs"',
  `main.m3u8?DeviceId=d&MediaSourceId=${MS}&VideoCodec=h264&AudioCodec=aac&PlaySessionId=ps-1&api_key=LEAK&TranscodeReasons=ContainerNotSupported`,
  `#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=9768,RESOLUTION=320x180,CODECS="jpeg",URI="Trickplay/320/tiles.m3u8?MediaSourceId=${MS}&api_key=LEAK"`,
  '',
].join('\n');
const JF_COMPAT = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=11088278,AVERAGE-BANDWIDTH=11088278,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=23.976',
  `main.m3u8?DeviceId=d&MediaSourceId=${MS}&VideoCodec=h264&AudioCodec=aac&PlaySessionId=ps-1&TranscodeReasons=ContainerNotSupported`,
  '',
].join('\n');

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

beforeAll(async () => {
  jf = createServer((req, res) => {
    seen.push({ url: req.url!, auth: req.headers.authorization, range: req.headers.range, acceptEncoding: req.headers['accept-encoding'], cookie: req.headers.cookie });
    if (req.url!.includes('/master.m3u8') && req.url!.includes('jfmaster=1')) {
      return void res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(JF_MASTER);
    }
    if (req.url!.includes('/main.m3u8')) {
      if (req.url!.includes('big=1')) {
        // ~3 MB playlist (far above the old 1 MB cap)
        const seg = (i: number) => `#EXTINF:3,\nhls1/main/${i}.ts?MediaSourceId=${MS}&PlaySessionId=ps-1\n`;
        return void res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end('#EXTM3U\n' + Array.from({ length: 40_000 }, (_, i) => seg(i)).join(''));
      }
      const body = req.url!.includes('evil=1')
        ? '#EXTM3U\nhttps://evil.example/seg.ts\n'
        : req.url!.includes('evil=2')
          ? '#EXTM3U\n/Videos/x/hls1/main/0.ts\n'
          : `#EXTM3U\n#EXT-X-MAP:URI="init.mp4?api_key=LEAK2&x=1"\n#EXTINF:3,\nhls1/main/0.ts?MediaSourceId=${MS}&api_key=LEAK&PlaySessionId=ps-1&ApiKey=LEAK3\n`;
      return void res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', etag: '"pl"' }).end(body);
    }
    if (req.url!.includes('/Images/')) return void res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=60', etag: '"abc"' }).end('img');
    if (req.url!.includes('/stream')) { /* falls through to range handling below */ }
    if (req.url!.includes('redirect')) return void res.writeHead(302, { location: 'http://evil.example/' }).end();
    const payload = Buffer.alloc(1_000_000, 1);
    if (req.headers.range) {
      res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 0-99/1000000', 'content-length': '100', 'set-cookie': 'x=1' });
      return void res.end(payload.subarray(0, 100));
    }
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'set-cookie': 'x=1' });
    res.end(payload);
  });
  be = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (req.headers['x-internal-secret'] !== 's3cret-s3cret-s3cret') return void res.writeHead(403).end();
      const j = JSON.parse(b);
      authzBodies.push(b);
      if (j.ct !== undefined) {
        authzCalls.push({ ct: j.ct, client: j.client });
        if (j.ct === 'E'.repeat(43)) return void res.writeHead(500).end();
        if (![CT, CT_IMG, CT_PIN, CT_LOW].includes(j.ct)) return void res.writeHead(401).end();
        if (j.ct === CT_PIN && j.client !== PIN_CLIENT) return void res.writeHead(401).end();
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ userId: 'u1', token: 'CASTJF', deviceId: 'ff-u1', maxBitrate: 5_000_000, maxHeight: j.ct === CT_LOW ? 720 : 1080, kind: j.ct === CT_IMG ? 'img' : 'media', scope: { itemId: ID, mediaSourceId: MS, playSessionId: 'ps-1' } }));
      }
      if (j.dl !== undefined) {
        if (j.sid !== 'goodsid' && j.sid !== 'othersid') return void res.writeHead(401).end();
        const targets: Record<string, unknown> = {
          [D_FILE]: { kind: 'file', file: `${D_FILE}.mp4`, size: DL_SIZE, etag: 'e1' },
          [D_BADNAME]: { kind: 'file', file: '../../../etc/passwd', size: 1, etag: 'e2' },
          [D_LINK]: { kind: 'file', file: `${D_LINK}.mp4`, size: DL_SIZE, etag: 'e3' },
          [D_STATIC]: { kind: 'static', path: `/Videos/${ID}/stream`, query: { static: 'true', MediaSourceId: MS } },
          [D_STATIC_BAD]: { kind: 'static', path: '/System/Info' },
          [D_MISMATCH]: { kind: 'file', file: `${D_MISMATCH}.mp4`, size: 5, etag: 'e4' },
          [D_BIG]: { kind: 'file', file: `${D_BIG}.mp4`, size: 32_000_000, etag: 'e5' },
          [D_MISSING]: { kind: 'file', file: `${D_MISSING}.mp4`, size: 5, etag: 'e6' },
        };
        const target = targets[String(j.dl)];
        if (!target) return void res.writeHead(404).end();
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ userId: j.sid === 'othersid' ? 'u2' : 'u1', token: 'JFTOKEN', deviceId: 'ff-u1', maxBitrate: 5_000_000, download: target }));
      }
      const ok = ['goodsid', 'guestsid', 'nodlsid', 'legacysid', 'remotesid'].includes(j.sid);
      if (!ok) return void res.writeHead(401).end();
      sidCalls.push({ sid: j.sid, ip: j.ip });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        userId: 'u1', token: 'JFTOKEN', deviceId: 'ff-u1', maxBitrate: j.sid === 'remotesid' && j.ip === REMOTE_IP ? 2_000_000 : 5_000_000, // remote callers get a lower cap
        ...(j.sid === 'legacysid' ? {} : { canDownload: j.sid === 'goodsid' }), // legacysid: answer of a backend that does not know the flag yet
        ...(j.sid === 'guestsid' ? { maxHeight: 720 } : {}),
      }));
    });
  });
  const jfp = await listen(jf);
  const bep = await listen(be);
  writeFileSync(join(dlDir, `${D_FILE}.mp4`), dlBody);
  writeFileSync(join(dlOutside, 'secret.mp4'), dlBody);
  symlinkSync(join(dlOutside, 'secret.mp4'), join(dlDir, `${D_LINK}.mp4`));
  writeFileSync(join(dlDir, `${D_MISMATCH}.mp4`), dlBody);
  writeFileSync(join(dlDir, `${D_BIG}.mp4`), '');
  truncateSync(join(dlDir, `${D_BIG}.mp4`), 32_000_000);
  const g = createGateway({ jellyfinUrl: `http://127.0.0.1:${jfp}`, backendUrl: `http://127.0.0.1:${bep}`, internalSecret: 's3cret-s3cret-s3cret', downloadDir: dlDir });
  gw = g.server;
  gwPort = await listen(gw);
});
afterAll(() => {
  [jf, be, gw].forEach((s) => s.close());
  rmSync(dlDir, { recursive: true, force: true });
  rmSync(dlOutside, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${gwPort}${path}`, { headers: { cookie: 'ff_sid=goodsid', ...headers } });

const vectors = JSON.parse(readFileSync(new URL('../../test-vectors/media-paths.json', import.meta.url), 'utf8')) as { allow: string[]; deny: string[]; direct: string[] };
describe('remote bitrate cap', () => {
  const rget = (headers: Record<string, string>) => get(`/media/Videos/${ID}/master.m3u8?MaxStreamingBitrate=999999999&MediaSourceId=x`, { cookie: 'ff_sid=remotesid', ...headers });
  it('sends the client ip with the authz call; the auth cache is per sid AND ip', async () => {
    sidCalls.length = 0;
    await (await rget({ 'x-real-ip': REMOTE_IP })).arrayBuffer();
    await (await rget({ 'x-real-ip': '192.168.1.10' })).arrayBuffer();
    await (await rget({ 'x-real-ip': REMOTE_IP })).arrayBuffer(); // cached
    expect(sidCalls.map((c) => c.ip)).toEqual([REMOTE_IP, '192.168.1.10']);
  });
  it('derives the ip like clientKey (x-real-ip, else the LAST x-forwarded-for entry)', async () => {
    sidCalls.length = 0;
    await (await rget({ 'x-forwarded-for': '192.168.1.99, 198.51.100.7' })).arrayBuffer();
    expect(sidCalls.at(-1)!.ip).toBe('198.51.100.7');
  });
  it('clamps the bitrate query param to the cap returned for that ip', async () => {
    seen.length = 0;
    await (await rget({ 'x-real-ip': REMOTE_IP })).arrayBuffer();
    expect(seen.at(-1)!.url).toContain('MaxStreamingBitrate=2000000');
    await (await rget({ 'x-real-ip': '192.168.1.10' })).arrayBuffer();
    expect(seen.at(-1)!.url).toContain('MaxStreamingBitrate=5000000');
  });
});

describe('authClientIp', () => {
  it('uses x-real-ip, else the last x-forwarded-for entry', () => {
    expect(authClientIp({ 'x-real-ip': '203.0.113.1', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, '172.18.0.2')).toBe('203.0.113.1');
    expect(authClientIp({ 'x-forwarded-for': '192.168.1.10, 203.0.113.9' }, '172.18.0.2')).toBe('203.0.113.9');
  });
  it('without a usable forwarding header only a loopback peer is passed on; others are unknown (remote)', () => {
    expect(authClientIp({}, '127.0.0.1')).toBe('127.0.0.1');
    expect(authClientIp({}, '::1')).toBe('::1');
    expect(authClientIp({}, '::ffff:127.0.0.1')).toBe('::ffff:127.0.0.1');
    expect(authClientIp({}, '172.18.0.2')).toBe('unknown');
    expect(authClientIp({}, '192.168.1.5')).toBe('unknown');
    expect(authClientIp({}, undefined)).toBe('unknown');
    expect(authClientIp({ 'x-forwarded-for': ',' }, '172.18.0.2')).toBe('unknown');
  });
});

describe('shared allowlist vectors', () => {
  it.each(vectors.direct)('direct stream %s: blocked for capped / non-download roles only', (p) => {
    expect(blocksDirectStream(p, { maxHeight: 1080, canDownload: true })).toBe(true);
    expect(blocksDirectStream(p, { canDownload: false })).toBe(true);
    expect(blocksDirectStream(p, {})).toBe(true);
    expect(blocksDirectStream(p, { canDownload: true })).toBe(false);
  });
  it.each(vectors.allow.filter((p) => !vectors.direct.includes(p)))('%s is never a direct stream', (p) => expect(blocksDirectStream(p, { maxHeight: 720, canDownload: false })).toBe(false));
  it.each(vectors.allow)('allows %s', (p) => expect(normalizePath(p)).toBeTruthy());
  it.each(vectors.deny)('denies %s', (p) => expect(normalizePath(p)).toBeNull());
});

describe('normalizePath', () => {
  it('accepts allowed paths and rejects traversal / others', () => {
    expect(normalizePath(`/Videos/${ID}/master.m3u8`)).toBe(`/Videos/${ID}/master.m3u8`);
    expect(normalizePath(`/Videos/${ID}/hls1/main/0.ts`)).toBeTruthy();
    expect(normalizePath(`/Videos/${ID}/%2e%2e/x`)).toBeNull();
    expect(normalizePath(`/Videos/${ID}/hls1/main/..%2f..%2fetc`)).toBeNull();
    expect(normalizePath('/System/Info')).toBeNull();
    expect(normalizePath('/Users/x/Policy')).toBeNull();
    expect(normalizePath(`//evil.example/Videos/${ID}/master.m3u8`)).toBeNull();
  });
});

describe('gateway', () => {
  it('requires a valid session', async () => {
    const r = await fetch(`http://127.0.0.1:${gwPort}/media/Videos/${ID}/master.m3u8`);
    expect(r.status).toBe(401);
    const r2 = await fetch(`http://127.0.0.1:${gwPort}/media/Videos/${ID}/master.m3u8`, { headers: { cookie: 'ff_sid=bad' } });
    expect(r2.status).toBe(401);
  });
  it('blocks non-allowlisted paths', async () => {
    expect((await get('/media/System/Info')).status).toBe(403);
    expect((await get('/media/Users/abc/Policy')).status).toBe(403);
  });
  it('injects the token server-side, strips api keys, clamps bitrate, drops set-cookie', async () => {
    seen.length = 0;
    const r = await get(`/media/Videos/${ID}/master.m3u8?api_key=LEAK&MaxStreamingBitrate=999999999&MediaSourceId=x`);
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toBeNull();
    expect((await r.arrayBuffer()).byteLength).toBe(1_000_000);
    const u = seen[0]!;
    expect(u.auth).toContain('Token="JFTOKEN"');
    expect(u.url).not.toContain('LEAK');
    expect(u.url).toContain('MaxStreamingBitrate=5000000');
    expect(u.url).toContain('MediaSourceId=x');
  });
  it('adds missing bitrate params at the cap on HLS paths; present higher values are clamped; direct streams are untouched', async () => {
    seen.length = 0;
    await (await get(`/media/Videos/${ID}/master.m3u8?MediaSourceId=x`)).arrayBuffer();
    let q = new URL(seen[0]!.url, 'http://x').searchParams;
    expect([q.get('MaxStreamingBitrate'), q.get('VideoBitrate')]).toEqual(['5000000', '5000000']);
    seen.length = 0;
    await (await get(`/media/Videos/${ID}/hls1/main/0.ts?maxstreamingbitrate=999999999&MediaSourceId=x`)).arrayBuffer();
    q = new URL(seen[0]!.url, 'http://x').searchParams;
    expect([q.get('maxstreamingbitrate'), q.get('MaxStreamingBitrate'), q.get('VideoBitrate')]).toEqual(['5000000', null, '5000000']); // no duplicate in another casing
    seen.length = 0;
    await (await get(`/media/Videos/${ID}/main.m3u8?VideoBitrate=1000000&MediaSourceId=x`)).arrayBuffer();
    q = new URL(seen[0]!.url, 'http://x').searchParams;
    expect([q.get('VideoBitrate'), q.get('MaxStreamingBitrate')]).toEqual(['1000000', '5000000']);
    seen.length = 0;
    await (await get(`/media/Videos/${ID}/stream?static=true`)).arrayBuffer();
    expect(seen[0]!.url).not.toMatch(/bitrate/i);
  });
  it('clamps resolution params to the role cap on the cookie path, and leaves them alone without a cap', async () => {
    seen.length = 0;
    await (await get(`/media/Videos/${ID}/master.m3u8?MaxHeight=2160&MaxWidth=3840&Height=4000&Width=9000&MediaSourceId=x`, { cookie: 'ff_sid=guestsid' })).arrayBuffer();
    const u = new URL(seen[0]!.url, 'http://x');
    expect(u.searchParams.get('MaxHeight')).toBe('720');
    expect(u.searchParams.get('Height')).toBe('720');
    expect(u.searchParams.get('MaxWidth')).toBe('1280');
    expect(u.searchParams.get('Width')).toBe('1280');
    seen.length = 0;
    await (await get(`/media/Videos/${ID}/master.m3u8?MaxHeight=480&MediaSourceId=x`, { cookie: 'ff_sid=guestsid' })).arrayBuffer();
    expect(new URL(seen[0]!.url, 'http://x').searchParams.get('MaxHeight')).toBe('480');
    seen.length = 0;
    await (await get(`/media/Videos/${ID}/master.m3u8?MaxHeight=2160&MediaSourceId=x`)).arrayBuffer();
    expect(new URL(seen[0]!.url, 'http://x').searchParams.get('MaxHeight')).toBe('2160');
  });
  it('passes HTTP Range through (206)', async () => {
    const r = await get(`/media/Videos/${ID}/stream?static=true`, { range: 'bytes=0-99' });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 0-99/1000000');
    expect(seen.at(-1)!.range).toBe('bytes=0-99');
  });
  it('asks upstream for identity encoding so relayed content-length matches the body', async () => {
    seen.length = 0;
    const r = await get(`/media/Videos/${ID}/master.m3u8`);
    expect(r.status).toBe(200);
    expect(seen.at(-1)!.acceptEncoding).toBe('identity');
  });
  it('never follows upstream redirects', async () => {
    expect((await get(`/media/Videos/${ID}/master.m3u8?redirect=1`)).status).toBe(502);
  });
  it('serves chapter stills (player "Szenen" panel) like other item images', async () => {
    const r = await get(`/media/Items/${ID}/Images/Chapter/3?tag=c1&maxWidth=320`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
    expect(r.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect((await get(`/media/Items/${ID}/Images/Chapter/1000`)).status).toBe(403);
  });
  it('makes images browser-cacheable but private; media stays uncacheable', async () => {
    const img = await get(`/media/Items/${ID}/Images/Backdrop?maxWidth=480&tag=t1`);
    expect(img.status).toBe(200);
    expect(img.headers.get('cache-control')).toBe('private, max-age=31536000, immutable'); // tagged URL: versioned
    const untagged = await get(`/media/Items/${ID}/Images/Backdrop?maxWidth=480`);
    expect(untagged.headers.get('cache-control')).toBe('private, max-age=86400, stale-while-revalidate=604800');
    expect(img.headers.get('etag')).toBe('"abc"');
    expect(img.headers.get('vary')).toBe('Cookie');
    const pl = await get(`/media/Videos/${ID}/master.m3u8`);
    expect(pl.headers.get('cache-control')).toBe('no-store');
  });
  it('rejects oversized queries', async () => {
    expect((await get(`/media/Videos/${ID}/master.m3u8?x=${'a'.repeat(3000)}`)).status).toBe(414);
    expect((await get(`/media/Videos/${ID}/master.m3u8?${Array.from({ length: 45 }, (_, i) => `p${i}=1`).join('&')}`)).status).toBe(414);
  });
  it('exposes metrics', async () => {
    const t = await (await fetch(`http://127.0.0.1:${gwPort}/metrics`)).text();
    expect(t).toContain('friendflix_gateway_bytes_total');
  });
});

const cget = (path: string, headers: Record<string, string> = {}, base = castBase) => fetch(`http://127.0.0.1:${gwPort}${base}${path}`, { headers });
const castVectors = (JSON.parse(readFileSync(new URL('../../test-vectors/media-paths.json', import.meta.url), 'utf8')) as { cast: { allow: string[]; deny: string[] } }).cast;

describe('cast allowlist vectors', () => {
  it.each(castVectors.allow)('allows %s', (p) => expect(normalizeCastPath(p)).toBeTruthy());
  it.each(castVectors.deny)('denies %s', (p) => expect(normalizeCastPath(p)).toBeNull());
});

describe('sanitizePlaylist', () => {
  const T = 'A'.repeat(43);
  const P = `/media/c/${T}/Videos/${ID}/main.m3u8`;
  const sp = (t: string) => sanitizePlaylist(t, P);
  it('strips token params and keeps URIs that stay under /media/c/<token>/', () => {
    expect(sp('#EXTM3U\nhls1/main/0.ts?a=1&api_key=X&ApiKey=Y\n')).toBe('#EXTM3U\nhls1/main/0.ts?a=1\n');
    expect(sp('#EXT-X-MAP:URI="i.mp4?api_key=X"')).toBe('#EXT-X-MAP:URI="i.mp4"');
    expect(sp("#EXT-X-KEY:METHOD=AES-128,URI = 'k.key?api_key=X',IV=0x1")).toBe("#EXT-X-KEY:METHOD=AES-128,URI = 'k.key',IV=0x1");
    expect(sp('../other/seg.ts')).toBe('../other/seg.ts');
    expect(sp(`/media/c/${T}/Videos/${ID}/hls1/main/0.ts`)).toBeTruthy(); // absolute path, but inside the token prefix
  });
  it('rejects absolute, protocol-relative, host-less-path and backslash URIs', () => {
    for (const bad of [
      'http://x/y.ts', '//x/y.ts', '/Videos/a/b.ts', 'https://evil.example/seg.ts', '\\\\evil', '\\evil/seg.ts', 'a\\b.ts',
      '#EXT-X-MAP:URI="https://x/i.mp4"', '#EXT-X-MAP:URI = "//evil"', "#EXT-X-MAP:URI='https://evil'", '#EXT-X-KEY:METHOD=AES-128,URI=//evil/k', '#EXT-X-MAP:URI="\\\\evil"',
      '/media/c/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/x.ts', '../../../../x.ts', 'data:text/plain,x', 'javascript:alert(1)',
    ]) expect(sp(bad), bad).toBeNull();
  });
  it('rejects a request path that is not a cast path', () => {
    expect(sanitizePlaylist('x.ts', '/media/Videos/a/main.m3u8')).toBeNull();
  });
  it('compatibility master: no trickplay line, no subtitle group, no VIDEO-RANGE (realistic Jellyfin master)', () => {
    expect(sanitizePlaylist(JF_MASTER, `/media/c/${T}/Videos/${ID}/master.m3u8`)).toBe(JF_COMPAT);
  });
  it('a bad URI on a line the compat rewrite drops still rejects the playlist (hardening first)', () => {
    expect(sp('#EXTM3U\n#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=1,CODECS="jpeg",URI="https://evil.example/t.m3u8"\n')).toBeNull();
    expect(sp('#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",URI="//evil/s.m3u8"\n')).toBeNull();
  });
  it('media playlists pass unchanged (only token params stripped)', () => {
    const media = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:7\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:6.006,\nhls1/main/0.ts?a=1\n#EXT-X-ENDLIST\n';
    expect(sp(media)).toBe(media);
  });
});

describe('compatPlaylist', () => {
  const c = (lines: string[]) => compatPlaylist(lines);
  it('keeps AUDIO / VIDEO group refs only while the group is declared; drops CLOSED-CAPTIONS and unknown attributes', () => {
    expect(c([
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="de",URI="a.m3u8"',
      '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="cc",INSTREAM-ID="CC1"',
      '#EXT-X-STREAM-INF:BANDWIDTH=5,HDCP-LEVEL=NONE,AUDIO="aud",VIDEO="vid",CLOSED-CAPTIONS="cc",PROGRAM-ID=1,CODECS="avc1.64001f,mp4a.40.2"',
      'v.m3u8',
    ])).toEqual([
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="de",URI="a.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=5,AUDIO="aud",CODECS="avc1.64001f,mp4a.40.2"',
      'v.m3u8',
    ]);
  });
  it('drops every #EXT-X-IMAGE-* tag; an image tag without URI= takes its URI line along', () => {
    expect(c(['#EXTM3U', '#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=1,CODECS="jpeg"', 'img.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=2', 'v.m3u8'])).toEqual(['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=2', 'v.m3u8']);
    expect(c(['#EXTM3U', '#EXT-X-IMAGE-MEDIA-SEQUENCE:0', '#EXT-X-STREAM-INF:BANDWIDTH=2', 'v.m3u8'])).toEqual(['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=2', 'v.m3u8']);
  });
  it('keeps the other standard tags as they are', () => {
    const l = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="i.m3u8"', '#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=1280x720', 'v.m3u8'];
    expect(c(l)).toEqual(l);
  });
});

describe('cast route /media/c/<token>/', () => {
  it('streams playlist + segment with the profile token in the header and the cast token never upstream', async () => {
    seen.length = 0;
    const m = await cget(`/Videos/${ID}/master.m3u8?MediaSourceId=${MS}&PlaySessionId=ps-1&DeviceId=d`);
    expect(m.status).toBe(200);
    expect(m.headers.get('access-control-allow-origin')).toBe('*');
    expect(m.headers.get('access-control-expose-headers')).toContain('Content-Range');
    expect(m.headers.get('cache-control')).toBe('no-store');
    await m.arrayBuffer();
    const seg = await cget(`/Videos/${ID}/hls1/main/0.ts?MediaSourceId=${MS}&PlaySessionId=ps-1`, { range: 'bytes=0-99' });
    expect(seg.status).toBe(206);
    expect(seg.headers.get('access-control-allow-origin')).toBe('*');
    expect(seg.headers.get('access-control-expose-headers')).toContain('Accept-Ranges');
    for (const u of seen) {
      expect(u.auth).toContain('Token="CASTJF"');
      expect(u.url).not.toContain(CT);
      expect(u.url).not.toContain('/media/c');
      expect(u.url.startsWith(`/Videos/${ID}/`)).toBe(true);
    }
    expect(seen.at(-1)!.range).toBe('bytes=0-99');
  });
  it('serves the compatibility master on the cast path; the cookie path gets Jellyfin\'s master unchanged', async () => {
    const cm = await cget(`/Videos/${ID}/master.m3u8?MediaSourceId=${MS}&PlaySessionId=ps-1&jfmaster=1`);
    expect(cm.status).toBe(200);
    expect(await cm.text()).toBe(JF_COMPAT);
    const wm = await get(`/media/Videos/${ID}/master.m3u8?MediaSourceId=${MS}&jfmaster=1`);
    expect(wm.status).toBe(200);
    expect(await wm.text()).toBe(JF_MASTER);
  });
  it('clamps bitrate to the token limit', async () => {
    seen.length = 0;
    await (await cget(`/Videos/${ID}/master.m3u8?MaxStreamingBitrate=999999999&MediaSourceId=${MS}`)).arrayBuffer();
    expect(seen[0]!.url).toContain('MaxStreamingBitrate=5000000');
  });
  it('sends only the token to the backend authz (never a cookie) and ignores cookies on this path', async () => {
    authzBodies.length = 0;
    seen.length = 0;
    const r = await cget(`/Images-ignored`, { cookie: 'ff_sid=goodsid' });
    expect(r.status).toBe(403);
    const ok = await cget(`/Videos/${ID}/master.m3u8`, { cookie: 'ff_sid=goodsid' });
    await ok.arrayBuffer();
    expect(seen.every((u) => u.cookie === undefined)).toBe(true);
    expect(authzBodies.every((b) => !b.includes('goodsid'))).toBe(true);
    const bad = await cget(`/Videos/${ID}/master.m3u8`, { cookie: 'ff_sid=goodsid' }, `/media/c/${CT_BAD}`);
    expect(bad.status).toBe(401); // a valid cookie does not help with a bad token
  });
  it('denies a different item, a different MediaSourceId / PlaySessionId (403)', async () => {
    expect((await cget(`/Videos/${'c'.repeat(32)}/master.m3u8`)).status).toBe(403);
    expect((await cget(`/Items/${'c'.repeat(32)}/Images/Primary`)).status).toBe(403);
    expect((await cget(`/Videos/${ID}/master.m3u8?MediaSourceId=${'c'.repeat(32)}`)).status).toBe(403);
    expect((await cget(`/Videos/${ID}/master.m3u8?mediasourceid=${MS}&mediasourceid=${'c'.repeat(32)}`)).status).toBe(403);
    expect((await cget(`/Videos/${ID}/master.m3u8?playsessionid=other`)).status).toBe(403);
    expect((await cget(`/Videos/${ID}/${'c'.repeat(32)}/Subtitles/1/0/Stream.vtt`)).status).toBe(403);
    expect((await cget(`/Videos/${ID}/${MS}/Subtitles/1/0/Stream.vtt`)).status).toBe(200);
    expect((await cget(`/Items/${ID}/Images/Primary?maxWidth=600`)).status).toBe(200);
  });
  it('drops LiveStreamId/DeviceId and clamps resolution params to the token cap (720p token)', async () => {
    seen.length = 0;
    const low = `/media/c/${CT_LOW}`;
    await (await cget(`/Videos/${ID}/master.m3u8?MaxHeight=2160&maxwidth=3840&Height=99999&Width=abc&DeviceId=x&livestreamid=y&Keep=1&MediaSourceId=${MS}`, {}, low)).arrayBuffer();
    const u = new URL(seen[0]!.url, 'http://x').searchParams;
    expect(u.get('MaxHeight')).toBe('720');
    expect(u.get('maxwidth')).toBe('1280');
    expect(u.get('Height')).toBe('720');
    expect(u.get('Width')).toBe('1280');
    expect(u.has('DeviceId')).toBe(false);
    expect(u.has('livestreamid')).toBe(false);
    expect(u.get('Keep')).toBe('1');
    seen.length = 0;
    await (await cget(`/Videos/${ID}/master.m3u8?MaxHeight=480`)).arrayBuffer(); // below the cap stays; default cap 1080
    expect(new URL(seen[0]!.url, 'http://x').searchParams.get('MaxHeight')).toBe('480');
  });
  it('sends the client key with the authz call and caches per client', async () => {
    authzCalls.length = 0;
    await (await cget(`/Videos/${ID}/master.m3u8`, { 'x-real-ip': '192.0.2.77' })).arrayBuffer();
    expect(authzCalls.at(-1)!.client).toBe('192.0.2.77');
    await (await cget(`/Videos/${ID}/master.m3u8`, { 'x-forwarded-for': '1.2.3.4, 192.0.2.78' })).arrayBuffer();
    expect(authzCalls.at(-1)!.client).toBe('192.0.2.78');
  });
  it('a pinned token only works for its client (backend answers 401 for others; no cross-client cache)', async () => {
    const pin = `/media/c/${CT_PIN}`;
    expect((await cget(`/Videos/${ID}/master.m3u8`, { 'x-real-ip': PIN_CLIENT }, pin)).status).toBe(200);
    expect((await cget(`/Videos/${ID}/master.m3u8`, { 'x-real-ip': '192.0.2.99' }, pin)).status).toBe(401);
    expect((await cget(`/Videos/${ID}/master.m3u8`, { 'x-real-ip': PIN_CLIENT }, pin)).status).toBe(200);
  });
  it('image token: images only (media paths 403), and a media token may fetch images too', async () => {
    const img = `/media/c/${CT_IMG}`;
    expect((await cget(`/Items/${ID}/Images/Primary?maxWidth=600`, {}, img)).status).toBe(200);
    expect((await cget(`/Items/${ID}/Images/Backdrop`, {}, img)).status).toBe(200);
    expect((await cget(`/Videos/${ID}/master.m3u8`, {}, img)).status).toBe(403);
    expect((await cget(`/Videos/${ID}/hls1/main/0.ts`, {}, img)).status).toBe(403);
    expect((await cget(`/Videos/${ID}/${MS}/Subtitles/1/0/Stream.vtt`, {}, img)).status).toBe(403);
    expect((await cget(`/Items/${'c'.repeat(32)}/Images/Primary`, {}, img)).status).toBe(403); // other item
    expect((await cget(`/Items/${ID}/Images/Primary`)).status).toBe(200);
  });
  it('passes a large (3 MB) playlist', async () => {
    const r = await cget(`/Videos/${ID}/main.m3u8?big=1&MediaSourceId=${MS}`);
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(t.length).toBeGreaterThan(2_000_000);
    expect(t).toContain('hls1/main/39999.ts');
  });
  it('blocks /stream, Trickplay and other non-cast paths', async () => {
    expect((await cget(`/Videos/${ID}/stream?static=true`)).status).toBe(403);
    expect((await cget(`/Videos/${ID}/Trickplay/320/0.jpg`)).status).toBe(403);
    expect((await cget(`/Items/${ID}/Images/Logo`)).status).toBe(403);
    expect((await cget(`/System/Info`)).status).toBe(403);
  });
  it('401 for bad/unknown tokens, 403 for malformed ones, 503 (not 401) when the backend fails', async () => {
    expect((await cget(`/Videos/${ID}/master.m3u8`, {}, `/media/c/${CT_BAD}`)).status).toBe(401);
    expect((await cget(`/Videos/${ID}/master.m3u8`, {}, `/media/c/short`)).status).toBe(403);
    expect((await cget(`/Videos/${ID}/master.m3u8`, {}, `/media/c/${'E'.repeat(43)}`)).status).toBe(503);
  });
  it('answers CORS preflight on the cast path only (no credentials), cookie path stays without CORS', async () => {
    const o = await fetch(`http://127.0.0.1:${gwPort}${castBase}/Videos/${ID}/master.m3u8`, { method: 'OPTIONS', headers: { origin: 'https://x', 'access-control-request-method': 'GET' } });
    expect(o.status).toBe(204);
    expect(o.headers.get('access-control-allow-origin')).toBe('*');
    expect(o.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS');
    expect(o.headers.get('access-control-allow-headers')).toBe('Range, Content-Type');
    expect(o.headers.get('access-control-max-age')).toBe('600');
    expect(o.headers.get('access-control-allow-credentials')).toBeNull();
    const c = await get(`/media/Videos/${ID}/master.m3u8`, { origin: 'https://x' });
    expect(c.headers.get('access-control-allow-origin')).toBeNull();
    expect((await fetch(`http://127.0.0.1:${gwPort}/media/Videos/${ID}/master.m3u8`, { method: 'OPTIONS' })).status).toBe(405);
    expect((await fetch(`http://127.0.0.1:${gwPort}${castBase}/Videos/${ID}/master.m3u8`, { method: 'POST' })).status).toBe(405);
  });
  it('sanitizes playlists: strips api_key params, keeps the rest', async () => {
    const r = await cget(`/Videos/${ID}/main.m3u8?MediaSourceId=${MS}`);
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(t).not.toMatch(/LEAK|api_key|ApiKey/i);
    expect(t).toContain(`hls1/main/0.ts?MediaSourceId=${MS}&PlaySessionId=ps-1`);
    expect(t).toContain('URI="init.mp4?x=1"');
    expect(r.headers.get('content-length')).toBe(String(Buffer.byteLength(t)));
  });
  it('502 for playlists with absolute URIs', async () => {
    expect((await cget(`/Videos/${ID}/main.m3u8?evil=1`)).status).toBe(502);
    expect((await cget(`/Videos/${ID}/main.m3u8?evil=2`)).status).toBe(502);
  });
  it('exposes a cast metric without the token', async () => {
    const t = await (await fetch(`http://127.0.0.1:${gwPort}/metrics`)).text();
    expect(t).toContain('friendflix_gateway_cast_requests_total{code="200"}');
    expect(t).not.toContain(CT);
  });
});

describe('cast failed-auth rate limit', () => {
  const bad = (i: number) => `/media/c/Q${String(i).padStart(42, '0')}`;
  it('one revoked token retried 100x does not trigger 429', async () => {
    const h = { 'x-real-ip': '198.51.100.20' };
    for (let i = 0; i < 100; i++) expect((await cget(`/Videos/${ID}/master.m3u8`, h, `/media/c/${CT_BAD}`)).status).toBe(401);
    expect((await cget(`/Videos/${ID}/master.m3u8`, h)).status).toBe(200); // the client is not blocked
  });
  it('blocks a client address after >30 DISTINCT failing tokens/min with 429 (even for a valid token)', async () => {
    const h = { 'x-real-ip': '198.51.100.7' };
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await cget(`/Videos/${ID}/master.m3u8`, h, bad(i))).status);
    expect(codes.slice(0, 30).every((c) => c === 401)).toBe(true);
    expect(codes[30]).toBe(401); // the 31st distinct failure trips the block
    const r = await cget(`/Videos/${ID}/master.m3u8`, h);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('300');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    // other addresses are unaffected
    expect((await cget(`/Videos/${ID}/master.m3u8`, { 'x-real-ip': '198.51.100.8' })).status).toBe(200);
  });
});

const dvectors = (JSON.parse(readFileSync(new URL('../../test-vectors/media-paths.json', import.meta.url), 'utf8')) as { download: { allow: string[]; deny: string[] } }).download;
describe('download route vectors', () => {
  it.each(dvectors.allow)('allows %s', (p) => expect(matchDownloadPath(p)).toBeTruthy());
  it.each(dvectors.deny)('denies %s', (p) => expect(matchDownloadPath(p)).toBeNull());
});

describe('download route /media/d/<uuid>', () => {
  const dget = (id: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${gwPort}/media/d/${id}`, { ...init, headers: { cookie: 'ff_sid=goodsid', ...headers } });

  it('needs a session cookie and a licence, never caches', async () => {
    const r = await fetch(`http://127.0.0.1:${gwPort}/media/d/${D_FILE}`);
    expect(r.status).toBe(401);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect((await dget(D_FILE, { cookie: 'ff_sid=bad' })).status).toBe(401);
    expect((await dget(D_MISSING.replace(/8/g, '9'))).status).toBe(404);
  });
  it('rejects query params, bad ids and other methods', async () => {
    expect((await fetch(`http://127.0.0.1:${gwPort}/media/d/${D_FILE}?x=1`, { headers: { cookie: 'ff_sid=goodsid' } })).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${gwPort}/media/d/${D_FILE}?`, { headers: { cookie: 'ff_sid=goodsid' } })).status).toBe(200);
    expect((await dget('not-a-uuid')).status).toBe(404);
    expect((await dget('-'.repeat(36))).status).toBe(404); // strict 8-4-4-4-12 lower-case hex, not just 36 chars of [0-9a-f-]
    expect((await dget('1'.repeat(36))).status).toBe(404);
    expect((await dget('11111111-1111-4111-8111-11111111111g')).status).toBe(404);
    expect((await dget('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')).status).toBe(404);
    expect((await dget(`..%2f${D_FILE}`)).status).toBe(404);
    expect((await dget(D_FILE, {}, { method: 'POST' })).status).toBe(405);
    expect((await dget(D_FILE, { origin: 'https://evil.example' })).headers.get('access-control-allow-origin')).toBeNull();
  });
  it('serves a file: 200 with full headers, then HEAD', async () => {
    const r = await dget(D_FILE);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('video/mp4');
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('etag')).toBe('"e1"');
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(Buffer.from(await r.arrayBuffer()).equals(dlBody)).toBe(true);
    const h = await dget(D_FILE, {}, { method: 'HEAD' });
    expect(h.status).toBe(200);
    expect(h.headers.get('content-length')).toBe(String(DL_SIZE));
    expect((await h.arrayBuffer()).byteLength).toBe(0);
  });
  it('serves single ranges (206), open-ended and suffix ranges', async () => {
    const r = await dget(D_FILE, { range: 'bytes=10-19' });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(`bytes 10-19/${DL_SIZE}`);
    expect(Buffer.from(await r.arrayBuffer()).equals(dlBody.subarray(10, 20))).toBe(true);
    const o = await dget(D_FILE, { range: 'bytes=990-' });
    expect(o.headers.get('content-range')).toBe(`bytes 990-999/${DL_SIZE}`);
    expect(Buffer.from(await o.arrayBuffer()).equals(dlBody.subarray(990))).toBe(true);
    const sfx = await dget(D_FILE, { range: 'bytes=-5' });
    expect(Buffer.from(await sfx.arrayBuffer()).equals(dlBody.subarray(995))).toBe(true);
    const over = await dget(D_FILE, { range: 'bytes=990-5000' });
    expect(over.headers.get('content-range')).toBe(`bytes 990-999/${DL_SIZE}`);
  });
  it('answers 416 for unsatisfiable, multiple or malformed ranges', async () => {
    for (const range of [`bytes=${DL_SIZE}-`, 'bytes=5000-6000', 'bytes=0-1,5-6', 'bytes=-0', 'bytes=-', 'items=0-1', 'bytes=9-1', 'bytes=a-b']) {
      const r = await dget(D_FILE, { range });
      expect(r.status, range).toBe(416);
      expect(r.headers.get('content-range'), range).toBe(`bytes */${DL_SIZE}`);
      await r.arrayBuffer();
    }
  });
  it('honours If-Range: matching ETag -> 206, other validator -> full 200', async () => {
    expect((await dget(D_FILE, { range: 'bytes=0-9', 'if-range': '"e1"' })).status).toBe(206);
    const stale = await dget(D_FILE, { range: 'bytes=0-9', 'if-range': '"old"' });
    expect(stale.status).toBe(200);
    expect((await stale.arrayBuffer()).byteLength).toBe(DL_SIZE);
    expect((await dget(D_FILE, { range: 'bytes=0-9', 'if-range': 'Wed, 21 Oct 2015 07:28:00 GMT' })).status).toBe(200);
  });
  it('never serves a file name the backend should not have sent, symlinks, or size mismatches', async () => {
    expect((await dget(D_BADNAME)).status).toBe(500);
    expect((await dget(D_LINK)).status).toBe(404);
    expect((await dget(D_MISSING)).status).toBe(404);
    expect((await dget(D_MISMATCH)).status).toBe(503);
  });
  it('forwards static downloads through the allowlist with Range, no-store and no leaked credentials', async () => {
    seen.length = 0;
    const r = await dget(D_STATIC, { range: 'bytes=0-99' });
    expect(r.status).toBe(206);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    await r.arrayBuffer();
    const u = seen[0]!;
    expect(u.url).toBe(`/Videos/${ID}/stream?static=true&MediaSourceId=${MS}`);
    expect(u.range).toBe('bytes=0-99');
    expect(u.auth).toContain('Token="JFTOKEN"');
    expect(u.cookie).toBeUndefined();
    expect((await dget(D_STATIC_BAD)).status).toBe(403);
  });
  it('allows at most 2 open responses per user (429), counted per user and freed on close', async () => {
    const a = await dget(D_BIG);
    const b = await dget(D_BIG);
    expect([a.status, b.status]).toEqual([200, 200]);
    const c = await dget(D_BIG);
    expect(c.status).toBe(429);
    await c.arrayBuffer();
    expect((await dget(D_FILE, {}, { method: 'HEAD' })).status).toBe(200); // HEAD is not counted
    const other = await fetch(`http://127.0.0.1:${gwPort}/media/d/${D_FILE}`, { headers: { cookie: 'ff_sid=othersid' } });
    expect(other.status).toBe(200); // another user is unaffected
    await other.arrayBuffer();
    await a.body!.cancel();
    let d: Response | undefined;
    for (let i = 0; i < 20; i++) {
      d = await dget(D_BIG);
      if (d.status === 200) break;
      await d.arrayBuffer();
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(d!.status).toBe(200);
    await d!.body!.cancel();
    await b.body!.cancel();
  });
  it('counts served bytes in friendflix_gateway_download_bytes_total', async () => {
    const m = await (await fetch(`http://127.0.0.1:${gwPort}/metrics`)).text();
    expect(m).toMatch(/friendflix_gateway_download_bytes_total [1-9]/);
  });
  it('does not treat /media/d/ as a Jellyfin path', async () => {
    expect((await get('/media/d/Videos')).status).toBe(404);
  });
});

describe('direct (static) streams vs. role limits', () => {
  const paths = [`/media/Videos/${ID}/stream?static=true`, `/media/Videos/${ID}/stream.mp4?static=true&MediaSourceId=${MS}`, `/media/Videos/${ID}/stream?Static=TRUE`, `/media/Videos/${ID}/stream`];
  const as = (path: string, sid: string) => fetch(`http://127.0.0.1:${gwPort}${path}`, { headers: { cookie: `ff_sid=${sid}` } });

  it('role without cap that may download keeps direct play', async () => {
    for (const p of paths) expect((await as(p, 'goodsid')).status, p).toBe(200);
  });
  it('height-capped role gets 403 for every /stream form and nothing reaches Jellyfin', async () => {
    seen.length = 0;
    for (const p of paths) expect((await as(p, 'guestsid')).status, p).toBe(403);
    expect(seen).toHaveLength(0);
  });
  it('role without download rights gets 403 even without a height cap', async () => {
    for (const p of paths) expect((await as(p, 'nodlsid')).status, p).toBe(403);
  });
  it('fails closed when the backend does not report the download flag', async () => {
    expect((await as(paths[0]!, 'legacysid')).status).toBe(403);
  });
  it('HLS, subtitles and images stay available to restricted roles', async () => {
    for (const sid of ['guestsid', 'nodlsid']) {
      expect((await as(`/media/Videos/${ID}/main.m3u8?MediaSourceId=${MS}`, sid)).status).toBe(200);
      expect((await as(`/media/Videos/${ID}/hls1/main/0.ts`, sid)).status).toBe(200);
      expect((await as(`/media/Items/${ID}/Images/Primary`, sid)).status).toBe(200);
    }
  });
  it('the offline download path (own licence check) is unaffected', async () => {
    const r = await fetch(`http://127.0.0.1:${gwPort}/media/d/${D_STATIC}`, { headers: { cookie: 'ff_sid=goodsid' } });
    expect(r.status).toBe(200);
    await r.arrayBuffer();
  });
  it('/Items/<id>/Download is not in the allowlist at all', async () => {
    expect((await as(`/media/Items/${ID}/Download`, 'goodsid')).status).toBe(403);
  });
});

describe('hlsAttrs', () => {
  it('parses quoted values with commas and plain values', () => {
    expect(hlsAttrs('BANDWIDTH=11088278,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,VIDEO-RANGE=SDR')).toEqual([
      ['BANDWIDTH', '11088278'],
      ['CODECS', '"avc1.640028,mp4a.40.2"'],
      ['RESOLUTION', '1920x1080'],
      ['VIDEO-RANGE', 'SDR'],
    ]);
  });
  it('ignores malformed keys and stays linear on hostile input', () => {
    expect(hlsAttrs('bad key=1,OK=2')).toEqual([['OK', '2']]);
    const hostile = '-'.repeat(200_000);
    const t0 = performance.now();
    expect(hlsAttrs(hostile)).toEqual([]);
    expect(hlsAttrs(`${hostile}=x,${hostile}`)).toHaveLength(1);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
