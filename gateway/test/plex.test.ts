// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { blocksDirectStream, createGateway, normalizeCastPath, normalizePath, sanitizePlaylist } from '../src/gateway.js';
import { internalSecret } from '../src/env.js';
import { createRemoteConfig } from '../src/remoteConfig.js';
import { bindUpstream, checkUpstreamConfig, jellyfinUpstream, remoteKeys, selectUpstream, UPSTREAMS } from '../src/upstream/index.js';
import { createPlexUpstream, decodePlexId, plexOpaqueErrors, plexUpstream, verifyChSig, verifyPartSig, verifySession, verifyTpSig } from '../src/upstream/plex.js';

interface Vectors {
  secret: string; token: string; allow: string[]; deny: string[]; direct: string[]; cast: { allow: string[]; deny: string[] };
  signatures: { part: Array<{ item: string; part: string; sig: string }>; trickplay: Array<{ item: string; part: string; sig: string }>; session: Array<{ item: string; nonce: string; session: string }>; chapter: Array<{ item: string; media: string; sig: string }> };
  authorize: Array<{ path: string; query: string; allow: boolean }>;
  rewrite: Array<{ path: string; query: string; upstream: string }>;
}
const V = JSON.parse(readFileSync(new URL('../../test-vectors/media-paths.plex.json', import.meta.url), 'utf8')) as Vectors;
const IDS = JSON.parse(readFileSync(new URL('../../test-vectors/plex-ids.json', import.meta.url), 'utf8')) as { valid: Array<{ kind: string; value: string; id: string }>; invalid: string[] };
const TOK = V.token;
const up = createPlexUpstream({ token: () => TOK, secret: () => V.secret });
const I = '9f1e0000000000000000000000000001';
const I2 = '9f1e0000000000000000000000000025';
const P = '9f1e3000000000000000000000000001';
const P2 = '9f1e3000000000000000000000000063';
const S1 = V.signatures.session[0]!.session; // bound to I
const S2 = V.signatures.session[1]!.session; // bound to I2
const SIG = V.signatures.part[0]!.sig; // I + P
const TPSIG = V.signatures.trickplay[0]!.sig; // I + P, trickplay domain

describe('registration', () => {
  it('MEDIA_SERVER=plex selects the Plex adapter (case-insensitive); unknown kinds still throw', () => {
    expect(selectUpstream('plex')).toBe(plexUpstream);
    expect(selectUpstream(' PLEX ')).toBe(plexUpstream);
    expect(UPSTREAMS.plex).toBe(plexUpstream);
    expect(plexUpstream).toMatchObject({ kind: 'plex', urlEnv: 'PLEX_URL' });
    expect(() => selectUpstream('emby')).toThrow(/unknown MEDIA_SERVER/);
  });
  it('the registered adapter reads PLEX_TOKEN lazily: importing it in a Jellyfin gateway needs no Plex env', () => {
    expect(() => plexUpstream.paths).not.toThrow();
  });
});

describe('shared vectors (test-vectors/media-paths.plex.json, plex-ids.json)', () => {
  it.each(V.allow)('allows %s', (p) => expect(normalizePath(p, up.paths)).toBe(p));
  it.each(V.deny)('denies %s', (p) => expect(normalizePath(p, up.paths)).toBeNull());
  it.each(V.cast.allow)('cast allows %s', (p) => expect(normalizeCastPath(p, up)).toBeTruthy());
  it.each(V.cast.deny)('cast denies %s', (p) => expect(normalizeCastPath(p, up)).toBeNull());
  it.each(V.direct)('direct stream %s', (p) => {
    expect(blocksDirectStream(p, { canDownload: false }, up)).toBe(true);
    expect(blocksDirectStream(p, { canDownload: true }, up)).toBe(false);
    expect(blocksDirectStream(p, { canDownload: true, maxHeight: 720 }, up)).toBe(true);
  });
  it('trickplay and HLS are not direct streams', () => {
    expect(blocksDirectStream(`/Videos/${I}/hls/${S1}/00000.ts`, { canDownload: false }, up)).toBe(false);
    expect(blocksDirectStream(`/Videos/${I}/${P}/Trickplay/2000/0.jpg`, { canDownload: false }, up)).toBe(false);
  });
  it.each(V.signatures.part)('part signature %#', (s) => {
    expect(verifyPartSig(V.secret, s.item, s.part, s.sig)).toBe(true);
    expect(verifyPartSig('another-secret-another', s.item, s.part, s.sig)).toBe(false);
    expect(verifyPartSig(V.secret, s.item, s.part, s.sig.toUpperCase())).toBe(false);
  });
  it.each(V.signatures.trickplay)('trickplay signature %# (own domain)', (s) => {
    expect(verifyTpSig(V.secret, s.item, s.part, s.sig)).toBe(true);
    expect(verifyPartSig(V.secret, s.item, s.part, s.sig)).toBe(false);
  });
  it.each(V.signatures.chapter)('chapter still signature %# (own domain)', (s) => {
    expect(verifyChSig(V.secret, s.item, s.media, s.sig)).toBe(true);
    expect(verifyChSig(V.secret, s.item, `${s.media}1`, s.sig)).toBe(false);
    expect(verifyChSig(V.secret, s.item === I ? I2 : I, s.media, s.sig)).toBe(false);
    expect(verifyPartSig(V.secret, s.item, s.media, s.sig)).toBe(false);
  });
  it('a chapter still without media never reaches Plex', () => {
    expect(() => up.rewrite!(`/Items/${I}/Images/Chapter/1`, new URLSearchParams())).toThrow();
    expect(() => up.rewrite!(`/Items/${I}/Images/Chapter/1`, new URLSearchParams('media=../1'))).toThrow();
  });
  it.each(V.signatures.session)('session %#', (s) => {
    expect(verifySession(V.secret, s.item, s.session)).toBe(true);
    expect(verifySession(V.secret, s.item === I ? I2 : I, s.session)).toBe(false);
  });
  it.each(V.authorize)('authorize $path?$query -> $allow', async (c) => {
    const checked: string[] = [];
    const ok = await up.authorize!({ path: c.path, query: new URLSearchParams(c.query), cast: false, checkItem: async (id) => { checked.push(id); return true; } });
    expect(ok).toBe(c.allow);
    if (c.allow) expect(checked).toEqual([c.path.match(/9f1e0[0-9a-f]{27}/)![0]]);
  });
  it('authorize: the backend decides about the item even with a valid signature', async () => {
    for (const [path, q] of [[`/Videos/${I}/hls/${S1}/00000.ts`, ''], [`/Videos/${I}/stream`, `MediaSourceId=${P}&sig=${SIG}`], [`/Items/${I}/Images/Primary`, '']]) {
      expect(await up.authorize!({ path: path!, query: new URLSearchParams(q), cast: false, checkItem: async () => false })).toBe(false);
    }
  });
  it.each(V.rewrite)('rewrite $path?$query', (c) => {
    const r = up.rewrite!(c.path, new URLSearchParams(c.query));
    const q = r.query.toString();
    expect(`${r.path}${q ? `?${q}` : ''}`).toBe(c.upstream);
    expect(`${r.path}?${q}`).not.toContain(TOK);
  });
  it('a stream without a media source never reaches Plex', () => {
    expect(() => up.rewrite!(`/Videos/${I}/stream`, new URLSearchParams())).toThrow();
    expect(() => up.rewrite!(`/Videos/${I}/stream`, new URLSearchParams(`MediaSourceId=${I}`))).toThrow();
  });
  it.each(IDS.valid)('codec decodes $id', (v) => expect(decodePlexId(v.id)).toEqual({ kind: v.kind, value: v.value }));
  it.each(IDS.invalid)('codec rejects %s', (id) => expect(decodePlexId(id)).toBeNull());
});

/** Gateway + fake Plex + fake backend: what a browser / Chromecast can see. */
describe('end to end through createGateway', () => {
  const CT = 'C'.repeat(43);
  let plex: Server, be: Server, gw: Server;
  let port = 0;
  const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
  const itemChecks: string[] = [];
  const authzBodies: Array<{ sid?: string; ip?: string }> = [];
  const visible = new Set([I, I2]);
  const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
  const PLAYLIST = '#EXTM3U\n#EXT-X-TARGETDURATION:8\n#EXT-X-ALLOW-CACHE:NO\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:8, nodesc\n00000.ts\n#EXTINF:8, nodesc\n00001.ts\n#EXT-X-ENDLIST\n';

  beforeAll(async () => {
    plex = createServer((req, res) => {
      seen.push({ url: req.url!, headers: req.headers });
      if (req.headers['x-plex-token'] !== TOK) return void res.writeHead(401, { 'content-type': 'text/html' }).end('<html>401</html>');
      // a chatty server: Plex headers (and even the token) on every answer must never reach the client
      const plexHeaders = { 'x-plex-protocol': '1.0', 'x-plex-token': TOK, 'x-plex-content-original-length': '1', server: 'Plex' };
      const u = new URL(req.url!, 'http://x');
      if (u.pathname.endsWith('/index.m3u8')) return void res.writeHead(200, { ...plexHeaders, 'content-type': 'application/vnd.apple.mpegurl' }).end(PLAYLIST);
      if (u.pathname.endsWith('.ts')) return void res.writeHead(200, { ...plexHeaders, 'content-type': 'video/MP2T' }).end('TSDATA');
      if (u.pathname === '/photo/:/transcode') return void res.writeHead(200, { ...plexHeaders, 'content-type': 'image/jpeg' }).end('JPEG');
      if (u.pathname.startsWith('/library/parts/') && u.pathname.includes('/indexes/sd/')) return void res.writeHead(200, { ...plexHeaders, 'content-type': 'image/jpeg' }).end('FRAME');
      if (u.pathname.startsWith('/library/parts/')) {
        const range = req.headers.range;
        return void res.writeHead(range ? 206 : 200, { ...plexHeaders, 'content-type': 'video/mp4', 'accept-ranges': 'bytes', ...(range ? { 'content-range': 'bytes 0-3/4' } : {}), 'content-disposition': 'attachment; filename="secret-path.mkv"' }).end('PART');
      }
      res.writeHead(404, { ...plexHeaders, 'content-type': 'text/html' }).end(`<html>404 ${TOK}</html>`);
    });
    be = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const j = JSON.parse(b);
        const json = (o: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
        if (req.url === '/internal/authz/item') {
          itemChecks.push(j.itemId);
          return json({ allow: visible.has(j.itemId) });
        }
        if (req.url === '/internal/authz') authzBodies.push(j);
        const base = { userId: 'u1', token: 'p-identity', deviceId: 'ff-u1', maxBitrate: 8_000_000, canDownload: j.sid !== 'nodownload-nodownload-1' };
        if (j.ct) return json(j.ct === CT ? { ...base, scope: { itemId: I, mediaSourceId: P, playSessionId: S1 } } : {}, j.ct === CT ? 200 : 401);
        if (j.dl) return json({ ...base, download: { kind: 'static', path: `/Videos/${I}/stream`, query: { static: 'true', MediaSourceId: P } } });
        return json(base);
      });
    });
    const [pp, bp] = [await listen(plex), await listen(be)];
    gw = createGateway({ upstream: up, upstreamUrl: `http://127.0.0.1:${pp}`, backendUrl: `http://127.0.0.1:${bp}`, internalSecret: 'internal-secret-internal' }).server;
    port = await listen(gw);
  });
  afterAll(() => [plex, be, gw].forEach((s) => s.close()));

  const get = (p: string, sid = 'goodsid-goodsid-goodsid-1', headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${p}`, { headers: { cookie: `ff_sid=${sid}`, ...headers } });
  /** the full client-visible answer must not contain the token or any X-Plex header */
  async function clean(r: Response) {
    const body = await r.text();
    const hdrs = [...r.headers].map(([k, v]) => `${k}: ${v}`).join('\n');
    expect(body).not.toContain(TOK);
    expect(hdrs).not.toContain(TOK);
    expect(hdrs.toLowerCase()).not.toContain('x-plex');
    return body;
  }
  const last = () => seen.at(-1)!;

  it('HLS: playlist relayed unchanged (relative URIs), every URI resolves to an allowed, authorized, fetchable public path', async () => {
    const hls = `/media/Videos/${I}/hls/${S1}/index.m3u8`;
    const r = await get(hls);
    expect(r.status).toBe(200);
    const body = await clean(r);
    expect(last().url).toBe(`/video/:/transcode/universal/session/${S1}/base/index.m3u8`);
    expect(last().headers['x-plex-token']).toBe(TOK);
    const uris = body.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(uris.length).toBe(2);
    for (const u of uris) {
      const abs = new URL(u, `http://h${hls}`);
      expect(abs.origin).toBe('http://h');
      expect(normalizePath(abs.pathname.slice('/media'.length), up.paths)).not.toBeNull();
      const s = await get(abs.pathname);
      expect(s.status).toBe(200);
      expect(await clean(s)).toBe('TSDATA');
      expect(last().url).toBe(`/video/:/transcode/universal/session/${S1}/base/${u}`);
    }
  });

  it('client query parameters never reach Plex (token / download / url injection)', async () => {
    await get(`/media/Videos/${I}/hls/${S1}/00001.ts?X-Plex-Token=LEAK&download=1&url=/x`);
    expect(last().url).toBe(`/video/:/transcode/universal/session/${S1}/base/00001.ts`);
    await get(`/media/Items/${I}/Images/Primary?maxWidth=300&url=%2Flibrary%2Fparts%2F1&X-Plex-Token=LEAK`);
    expect(last().url).toBe('/photo/:/transcode?url=%2Flibrary%2Fmetadata%2F1%2Fthumb&width=300&height=1200&minSize=0&upscale=0');
    expect(seen.some((s) => s.url.includes('LEAK'))).toBe(false);
  });

  it('Block 20: the client address goes to /internal/authz as ip (X-Real-IP, else the last X-Forwarded-For entry, else a loopback peer)', async () => {
    const ask = async (sid: string, headers: Record<string, string>) => {
      expect((await get(`/media/Videos/${I}/hls/${S1}/00000.ts`, sid, headers)).status).toBe(200);
      return authzBodies.filter((b) => b.sid === sid).at(-1);
    };
    expect(await ask('ipsid-ipsid-ipsid-ipsid-1', { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '192.168.1.5' })).toEqual({ sid: 'ipsid-ipsid-ipsid-ipsid-1', ip: '203.0.113.9' });
    expect((await ask('ipsid-ipsid-ipsid-ipsid-2', { 'x-forwarded-for': '192.168.1.5, 198.51.100.7' }))?.ip).toBe('198.51.100.7');
    expect((await ask('ipsid-ipsid-ipsid-ipsid-3', {}))?.ip).toBe('127.0.0.1'); // the test client is a loopback peer
    expect(authzBodies.every((b) => typeof b.ip === 'string' && b.ip.length > 0)).toBe(true);
  });

  it('Block 20: no bitrate params are injected or relayed on HLS paths (the backend fixed them at transcode start)', async () => {
    expect(up.requireBitrate).toBeUndefined();
    await get(`/media/Videos/${I}/hls/${S1}/index.m3u8?maxVideoBitrate=200000&videoResolution=3840x2160&MaxStreamingBitrate=1&VideoBitrate=1&videoQuality=100`);
    expect(last().url).toBe(`/video/:/transcode/universal/session/${S1}/base/index.m3u8`);
    await get(`/media/Videos/${I}/hls/${S1}/00002.ts?maxVideoBitrate=200000`);
    expect(last().url).toBe(`/video/:/transcode/universal/session/${S1}/base/00002.ts`);
  });

  it('chapter stills: signed media version -> Plex chapterImages via the photo transcoder; unsigned / foreign / hidden -> 403', async () => {
    const ch = V.signatures.chapter[0]!; // I + media 11
    const r = await get(`/media/Items/${I}/Images/Chapter/2?media=${ch.media}&sig=${ch.sig}&maxWidth=320&X-Plex-Token=LEAK`);
    expect(r.status).toBe(200);
    expect(await clean(r)).toBe('JPEG');
    expect(last().url).toBe('/photo/:/transcode?url=%2Flibrary%2Fmedia%2F11%2FchapterImages%2F2&width=320&height=1280&minSize=0&upscale=0');
    const n = seen.length;
    expect((await get(`/media/Items/${I}/Images/Chapter/2?media=12&sig=${ch.sig}`)).status).toBe(403);
    expect((await get(`/media/Items/${I}/Images/Chapter/2?media=${ch.media}`)).status).toBe(403);
    expect((await get(`/media/Items/${I2}/Images/Chapter/2?media=${ch.media}&sig=${ch.sig}`)).status).toBe(403);
    const ch2 = V.signatures.chapter[1]!; // I2 + media 11, valid signature but the item is hidden from this viewer
    visible.delete(I2);
    try {
      expect((await get(`/media/Items/${I2}/Images/Chapter/2?media=${ch2.media}&sig=${ch2.sig}`)).status).toBe(403);
    } finally {
      visible.add(I2);
    }
    expect(seen.length).toBe(n);
  });

  it('denied items: 403 for every path kind, nothing forwarded', async () => {
    visible.delete(I2);
    try {
      const n = seen.length;
      for (const p of [`/media/Items/${I2}/Images/Primary`, `/media/Videos/${I2}/hls/${S2}/index.m3u8`, `/media/Videos/${I2}/hls/${S2}/00000.ts`,
        `/media/Videos/${I2}/stream?MediaSourceId=${P2}&sig=${V.signatures.part[1]!.sig}`, `/media/Videos/${I2}/${P2}/Trickplay/2000/1.jpg?sig=${V.signatures.part[1]!.sig}`]) {
        const r = await get(p);
        expect(r.status, p).toBe(403);
        await clean(r);
      }
      expect(seen.length).toBe(n);
      expect(itemChecks).toContain(I2);
    } finally {
      visible.add(I2);
    }
  });

  it('visible item but foreign part / session / missing signature: 403 without asking Plex', async () => {
    const n = seen.length;
    for (const p of [
      `/media/Videos/${I}/hls/${S2}/00000.ts`, // session of I2
      `/media/Videos/${I}/stream?MediaSourceId=${P2}&sig=${SIG}`,
      `/media/Videos/${I}/stream?MediaSourceId=${P}`,
      `/media/Videos/${I}/stream`,
      `/media/Videos/${I}/${P2}/Trickplay/2000/1.jpg?sig=${SIG}`,
      `/media/Videos/${I}/${P}/Trickplay/2000/1.jpg`,
      `/media/library/parts/1/0/file`,
      `/media/video/:/transcode/universal/start.m3u8?path=%2Flibrary%2Fmetadata%2F1`,
    ]) expect((await get(p)).status, p).toBe(403);
    expect(seen.length).toBe(n);
  });

  it('direct stream: signed part with Range, no file name leak beyond content-disposition of Plex itself; refused for non-download roles', async () => {
    const r = await get(`/media/Videos/${I}/stream?MediaSourceId=${P}&sig=${SIG}`, undefined, { range: 'bytes=0-3' });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 0-3/4');
    await clean(r);
    expect(last().url).toBe('/library/parts/1/0/file');
    expect(last().headers.range).toBe('bytes=0-3');
    const n = seen.length;
    expect((await get(`/media/Videos/${I}/stream?MediaSourceId=${P}&sig=${SIG}`, 'nodownload-nodownload-1')).status).toBe(403);
    expect(seen.length).toBe(n);
  });

  it('trickplay: frame n of the signed part at n x interval ms', async () => {
    expect((await get(`/media/Videos/${I}/${P}/Trickplay/2000/7.jpg?sig=${SIG}`)).status).toBe(403); // direct-stream sig: wrong domain
    const r = await get(`/media/Videos/${I}/${P}/Trickplay/2000/7.jpg?sig=${TPSIG}`);
    expect(r.status).toBe(200);
    expect(await clean(r)).toBe('FRAME');
    expect(last().url).toBe('/library/parts/1/indexes/sd/14000');
  });

  it('images: private cache, transcoded via /photo/:/transcode', async () => {
    const r = await get(`/media/Items/${I}/Images/Backdrop?maxWidth=1600&quality=80`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('private');
    expect(await clean(r)).toBe('JPEG');
  });

  it('upstream errors are relayed without the Plex body leaking the token', async () => {
    // a rejected token: Plex' 401 is relayed as is (status + safe headers only)
    const bad = createPlexUpstream({ token: () => 'wrong-token', secret: () => V.secret });
    const g = createGateway({ upstream: bad, upstreamUrl: `http://127.0.0.1:${(plex.address() as AddressInfo).port}`, backendUrl: `http://127.0.0.1:${(be.address() as AddressInfo).port}`, internalSecret: 'internal-secret-internal' }).server;
    const p = await listen(g);
    try {
      const r = await fetch(`http://127.0.0.1:${p}/media/Items/${I}/Images/Primary`, { headers: { cookie: 'ff_sid=goodsid-goodsid-goodsid-1' } });
      expect(r.status).toBe(401);
      await clean(r);
    } finally {
      g.close();
    }
  });

  it('missing PLEX_TOKEN: the request fails (5xx) and nothing is forwarded', async () => {
    const none = createPlexUpstream({ token: () => { throw new Error('missing env PLEX_TOKEN'); }, secret: () => V.secret });
    const g = createGateway({ upstream: none, upstreamUrl: `http://127.0.0.1:${(plex.address() as AddressInfo).port}`, backendUrl: `http://127.0.0.1:${(be.address() as AddressInfo).port}`, internalSecret: 'internal-secret-internal' }).server;
    const p = await listen(g);
    try {
      const n = seen.length;
      const r = await fetch(`http://127.0.0.1:${p}/media/Items/${I}/Images/Primary`, { headers: { cookie: 'ff_sid=goodsid-goodsid-goodsid-1' } });
      expect(r.status).toBeGreaterThanOrEqual(500);
      expect(seen.length).toBe(n);
    } finally {
      g.close();
    }
  });

  it('cast: token-scoped HLS playlist sanitized and segments served; direct stream / trickplay / foreign items refused', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/media/c/${CT}/Videos/${I}/hls/${S1}/index.m3u8`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect((await clean(r)).split('\n').filter((l) => l && !l.startsWith('#'))).toEqual(['00000.ts', '00001.ts']);
    const s = await fetch(`http://127.0.0.1:${port}/media/c/${CT}/Videos/${I}/hls/${S1}/00000.ts`);
    expect(s.status).toBe(200);
    await clean(s);
    for (const p of [`/Videos/${I}/stream?MediaSourceId=${P}&sig=${SIG}`, `/Videos/${I}/${P}/Trickplay/2000/1.jpg?sig=${SIG}`, `/Videos/${I2}/hls/${S2}/00000.ts`, `/Videos/${I}/hls/${S2}/00000.ts`]) {
      expect((await fetch(`http://127.0.0.1:${port}/media/c/${CT}${p}`)).status, p).toBe(403);
    }
    expect((await fetch(`http://127.0.0.1:${port}/media/c/${CT}/Items/${I}/Images/Primary`)).status).toBe(200);
  });

  it('offline download of an original: the licence names the part, Plex gets /library/parts/<id>/0/file', async () => {
    const r = await get('/media/d/12345678-1234-1234-1234-123456789abc');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    await clean(r);
    expect(last().url).toBe('/library/parts/1/0/file');
    expect(last().headers['x-plex-token']).toBe(TOK);
  });

  it('every upstream request carried the token as a header and never in the URL', () => {
    expect(seen.length).toBeGreaterThan(5);
    for (const s of seen.filter((x) => x.headers['x-plex-token'] === TOK)) expect(s.url).not.toContain(TOK);
    expect(seen.every((s) => !/x-plex-token=/i.test(s.url))).toBe(true);
  });
});

describe('Plex adapter hooks', () => {
  it('collection poster tag m<member>: the member must be visible too; composites are never fetched', async () => {
    const M = '9f1e0000000000000000000000000025';
    const seen: string[] = [];
    const ctx = (allow: (id: string) => boolean) => ({
      path: `/Items/${I}/Images/Primary`, query: new URLSearchParams(`tag=m${M}`), cast: false,
      checkItem: async (id: string) => (seen.push(id), allow(id)),
    });
    expect(await up.authorize!(ctx(() => true))).toBe(true);
    expect(seen).toEqual([M, I]);
    expect(await up.authorize!(ctx((id) => id !== M))).toBe(false);
    expect(up.rewrite!(`/Items/${I}/Images/Primary`, new URLSearchParams('tag=c1791800022')).query.get('url')).toBe('/library/metadata/1/thumb');
    // the member tag only means something on Primary
    expect(up.rewrite!(`/Items/${I}/Images/Backdrop`, new URLSearchParams(`tag=m${M}`)).query.get('url')).toBe('/library/metadata/1/art');
  });

  it('validateConfig: a set PLEX_URL must be http(s), a set PLEX_TOKEN_FILE readable; neither set is remote mode (settings in the DB)', () => {
    const v = up.validateConfig!;
    expect(v({ PLEX_URL: 'http://plex:32400', PLEX_TOKEN: 't' })).toEqual([]);
    expect(v({})).toEqual([]);
    expect(v({ PLEX_URL: '', PLEX_TOKEN: '' })).toEqual([]); // compose passes ${VAR:-}
    expect(v({ PLEX_URL: 'http://plex:32400' })).toEqual([]); // token from the backend
    expect(v({ PLEX_TOKEN: 't' })).toEqual([]); // URL from the backend
    expect(v({ PLEX_URL: 'ftp://x', PLEX_TOKEN: 't' })).toEqual(['PLEX_URL must be an http(s) URL']);
    expect(v({ PLEX_URL: 'nope', PLEX_TOKEN: 't' })).toEqual(['PLEX_URL is not a valid URL']);
    const dir = mkdtempSync(join(tmpdir(), 'ffgw-'));
    writeFileSync(join(dir, 'tok'), 'secret\n');
    writeFileSync(join(dir, 'empty'), '\n');
    expect(v({ PLEX_URL: 'http://plex:32400', PLEX_TOKEN_FILE: join(dir, 'tok') })).toEqual([]);
    expect(v({ PLEX_URL: 'http://plex:32400', PLEX_TOKEN_FILE: join(dir, 'empty') })).toEqual(['PLEX_TOKEN_FILE is empty']);
    expect(v({ PLEX_URL: 'http://plex:32400', PLEX_TOKEN_FILE: join(dir, 'missing') })).toEqual(['PLEX_TOKEN_FILE cannot be read']);
    expect(() => checkUpstreamConfig(selectUpstream('plex'), { MEDIA_SERVER: 'plex' })).not.toThrow();
    expect(() => checkUpstreamConfig(selectUpstream('plex'), { MEDIA_SERVER: 'plex', PLEX_URL: 'nope' })).toThrow(/PLEX_URL/);
  });

  it('playlist: credentials stripped from every URI, URIs outside the session refused', () => {
    const p = (b: string) => up.playlist!(b, { path: '', query: new URLSearchParams(), requestPath: '', cast: false });
    const body = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4?X-Plex-Token=SECRET&x=1"\n#EXTINF:8,\n00000.ts?X-Plex-Token=SECRET&X-Plex-Client-Identifier=c\n#EXTINF:8,\n00001.ts\n';
    const out = p(body);
    expect(out).not.toContain('SECRET');
    expect(out).toBe('#EXTM3U\n#EXT-X-MAP:URI="init.mp4?x=1"\n#EXTINF:8,\n00000.ts\n#EXTINF:8,\n00001.ts\n');
    for (const bad of ['http://plex:32400/x.ts', '//plex/x.ts', '/video/x.ts', '../x.ts', '#EXT-X-MAP:URI="http://plex/i.mp4"']) expect(() => p(`#EXTM3U\n${bad}\n`)).toThrow();
  });

  it('cast / AirPlay compatibility playlist on the Plex cast path: session playlists pass unchanged, a master is made strict', () => {
    const CTK = 'A'.repeat(43);
    const req = `/media/c/${CTK}/Videos/${I}/hls/${S1}/index.m3u8`;
    expect(normalizeCastPath(req.slice(`/media/c/${CTK}`.length), up)).toBeTruthy();
    // what Plex's transcoder answers for base/index.m3u8 (after the adapter's playlist hook): a media playlist, kept byte for byte
    const media = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:8\n#EXT-X-ALLOW-CACHE:NO\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:8, nodesc\n00000.ts\n#EXTINF:8, nodesc\n00001.ts\n#EXT-X-ENDLIST';
    const hooked = up.playlist!(media, { path: '', query: new URLSearchParams(), requestPath: req, cast: true });
    expect(sanitizePlaylist(hooked, req, up.stripQuery)).toBe(media);
    // credentials in a segment URI never survive (Plex strip set), relative URIs stay inside the token directory
    expect(sanitizePlaylist('#EXTM3U\n#EXTINF:8,\n00000.ts?X-Plex-Token=SECRET&a=1', req, up.stripQuery)).toBe('#EXTM3U\n#EXTINF:8,\n00000.ts?a=1');
    expect(sanitizePlaylist('#EXTM3U\nhttp://plex:32400/x.ts', req, up.stripQuery)).toBeNull();
    // should a PMS ever answer with a master: subtitle groups, image playlists and newer STREAM-INF attributes are dropped
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="en",URI="subs.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="avc1.640029,mp4a.40.2",VIDEO-RANGE=SDR,SUBTITLES="subs"',
      'index.m3u8?X-Plex-Token=SECRET',
      '#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=1000,CODECS="jpeg"',
      'img.m3u8',
    ].join('\n');
    expect(sanitizePlaylist(master, req, up.stripQuery)).toBe('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="avc1.640029,mp4a.40.2"\nindex.m3u8');
  });
});

/**
 * fork: settings in the database. A no-.env install has neither PLEX_TOKEN nor INTERNAL_SECRET in the gateway env: the secret comes from
 * the bootstrap volume (FF_GATEWAY_BOOTSTRAP_DIR), the token from the backend's /internal/gateway-config (behind that secret). What
 * server.ts wires up: internalSecret(env) + createRemoteConfig({ keys: remoteKeys() }) + bindUpstream().
 */
describe('remote mode: bootstrap-volume secret and the token from the backend', () => {
  const REMOTE_TOK = 'remote-plex-token-QWERTY-987654';
  const ROTATED = 'rotated-plex-token-ASDFGH-123987';
  const ENV_TOK = 'env-plex-token-ZXCVBN-555111';
  const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
  const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));
  const servers: Server[] = [];
  const stops: Array<() => void> = [];
  afterEach(async () => {
    stops.splice(0).forEach((f) => f());
    await Promise.all(servers.splice(0).map(close));
  });

  /** fake Plex (accepts `accept`), fake backend (gateway-config + authz) and a gateway as server.ts builds it from `env` */
  async function stack(env: NodeJS.ProcessEnv, opts: { accept: string; backendToken: () => string | null; errors?: boolean }) {
    const seen: Array<{ url: string; token: unknown }> = [];
    const gwCfg: Array<string | undefined> = [];
    let rev = 1;
    const plex = createServer((req, res) => {
      seen.push({ url: req.url!, token: req.headers['x-plex-token'] });
      // a hostile / chatty server: every error echoes the sent token in a header AND the body (plexOpaqueErrors must hide both)
      const sent = String(req.headers['x-plex-token']);
      const fail = (status: number) => void res.writeHead(status, { 'content-type': 'text/html', 'x-plex-token': sent, 'x-plex-server': 'plex.example.com' }).end(req.method === 'HEAD' ? undefined : `<html>${status} token=${sent}</html>`);
      if (sent !== opts.accept) return fail(401);
      if (opts.errors && req.url!.includes('/indexes/sd/')) return fail(500); // trickplay
      if (opts.errors && req.url!.endsWith('/index.m3u8')) return fail(404); // a non-200 HLS playlist
      if (opts.errors && req.url!.includes('/library/parts/')) return fail(403); // direct stream
      res.writeHead(200, { 'content-type': 'image/jpeg', 'x-plex-token': opts.accept }).end('JPEG');
    });
    const plexPort = await listen(plex);
    const be = createServer((req, res) => {
      const json = (o: unknown, status = 200, h: Record<string, string> = {}) => res.writeHead(status, { 'content-type': 'application/json', 'x-ff-config-rev': String(rev), ...h }).end(JSON.stringify(o));
      const secretOk = req.headers['x-internal-secret'] === V.secret;
      if (req.url === '/internal/gateway-config') {
        gwCfg.push(req.headers['x-internal-secret'] as string | undefined);
        if (!secretOk) return json({ error: 'forbidden' }, 403);
        const t = opts.backendToken();
        if (!t) return json({ error: 'setup_required' }, 503, { 'cache-control': 'no-store' });
        return json({ rev, upstreamUrl: `http://127.0.0.1:${plexPort}`, upstreamAuth: { PLEX_TOKEN: t } }, 200, { 'cache-control': 'no-store' });
      }
      req.resume();
      req.on('end', () => {
        if (!secretOk) return json({ error: 'forbidden' }, 403);
        if (req.url === '/internal/authz/item') return json({ allow: true });
        return json({ userId: 'u1', token: 'p-identity', deviceId: 'ff-u1', maxBitrate: 8_000_000, canDownload: true });
      });
    });
    const bePort = await listen(be);
    servers.push(plex, be);
    const logs: string[] = [];
    const base = selectUpstream(env.MEDIA_SERVER);
    checkUpstreamConfig(base, env);
    const secret = internalSecret(env);
    const remote = createRemoteConfig({ backendUrl: `http://127.0.0.1:${bePort}`, internalSecret: secret, envUrl: env.PLEX_URL || undefined, keys: remoteKeys(base, env), retryMs: 20, refreshMs: 60_000, log: (m) => logs.push(m) });
    stops.push(remote.stop);
    const bound = bindUpstream(base, env, secret, remote);
    const gw = createGateway({ upstream: bound, fetchImpl: bound.wrapFetch?.(fetch), upstreamUrl: remote.url, onConfigRev: remote.noteRev, backendUrl: `http://127.0.0.1:${bePort}`, internalSecret: secret }).server;
    const port = await listen(gw);
    servers.push(gw);
    const responses: string[] = [];
    const get = async (p: string, method = 'GET') => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { cookie: 'ff_sid=goodsid-goodsid-goodsid-1' } });
      responses.push(`${r.status}\n${[...r.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${await r.clone().text()}`);
      return r;
    };
    const until = async (p: string, ok: (status: number) => boolean) => {
      for (let i = 0; i < 100; i++) {
        const r = await get(p);
        if (ok(r.status)) return r;
        await new Promise((d) => setTimeout(d, 10));
      }
      throw new Error(`no answer for ${p}`);
    };
    return { seen, gwCfg, logs, responses, get, until, remote, port, bumpRev: () => { rev++; } };
  }
  const bootstrapDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffgw-boot-'));
    writeFileSync(join(dir, 'internal_secret'), `${V.secret}\n`);
    return dir;
  };
  const TRICK = `/media/Videos/${I}/${P}/Trickplay/2000/1.jpg?sig=${TPSIG}`;
  const STREAMP = `/media/Videos/${I}/stream?MediaSourceId=${P}&sig=${SIG}`;
  const HLSP = `/media/Videos/${I}/hls/${S1}/00000.ts`;

  it('remoteKeys: PLEX_TOKEN unless the env pins it (VAR or VAR_FILE); Jellyfin asks for none; bind-less adapters stay as they are', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffgw-'));
    writeFileSync(join(dir, 'tok'), 'tok\n');
    expect(remoteKeys(plexUpstream, {})).toEqual(['PLEX_TOKEN']);
    expect(remoteKeys(plexUpstream, { PLEX_TOKEN: '' })).toEqual(['PLEX_TOKEN']);
    expect(remoteKeys(plexUpstream, { PLEX_TOKEN: 't' })).toEqual([]);
    expect(remoteKeys(plexUpstream, { PLEX_TOKEN_FILE: join(dir, 'tok') })).toEqual([]);
    expect(remoteKeys(jellyfinUpstream, {})).toEqual([]);
    expect(bindUpstream(jellyfinUpstream, {}, 's', { value: () => null })).toBe(jellyfinUpstream);
  });

  it('no env secret, token or URL: starts, /media 503 until the backend has the setup, then signatures verify with the bootstrap-dir secret and the remote token is sent', async () => {
    let backendToken: string | null = null;
    const env = { MEDIA_SERVER: 'plex', FF_GATEWAY_BOOTSTRAP_DIR: bootstrapDir() };
    const st = await stack(env, { accept: REMOTE_TOK, backendToken: () => backendToken });
    const health = await st.get('/health');
    expect(health.status).toBe(200);
    expect((await st.get(`/media/Items/${I}/Images/Primary`)).status).toBe(503);
    expect(st.seen).toEqual([]);
    backendToken = REMOTE_TOK; // the setup wizard saved PLEX_URL + PLEX_TOKEN
    await st.until(`/media/Items/${I}/Images/Primary`, (s) => s !== 503);
    expect(st.gwCfg.every((h) => h === V.secret)).toBe(true); // the bootstrap-volume secret authenticates the gateway
    for (const p of [TRICK, STREAMP, HLSP, `/media/Items/${I}/Images/Primary`]) expect((await st.get(p)).status, p).toBe(200);
    // a wrong signature still fails: the secret is really checked (not just "some" secret)
    expect((await st.get(`/media/Videos/${I}/${P}/Trickplay/2000/1.jpg?sig=${'0'.repeat(32)}`)).status).toBe(403);
    expect(st.seen.length).toBeGreaterThanOrEqual(4);
    expect(st.seen.every((x) => x.token === REMOTE_TOK && !x.url.includes(REMOTE_TOK))).toBe(true);
  });

  it('a token rotation in the backend applies after the next authz answer carries the new rev', async () => {
    let backendToken = REMOTE_TOK;
    const accept = { v: REMOTE_TOK };
    const env = { MEDIA_SERVER: 'plex', FF_GATEWAY_BOOTSTRAP_DIR: bootstrapDir() };
    const st = await stack(env, { get accept() { return accept.v; }, backendToken: () => backendToken });
    await st.until(`/media/Items/${I}/Images/Primary`, (s) => s === 200);
    backendToken = ROTATED;
    accept.v = ROTATED;
    st.bumpRev();
    // the authz memo of the first session may hide the new rev for a moment: another session asks the backend at once
    for (let i = 0; i < 100 && st.remote.value('PLEX_TOKEN') !== ROTATED; i++) {
      await fetch(`http://127.0.0.1:${st.port}/media/Items/${I}/Images/Primary`, { headers: { cookie: `ff_sid=othersid-othersid-othe${i}` } });
      await new Promise((d) => setTimeout(d, 10));
    }
    expect(st.remote.value('PLEX_TOKEN')).toBe(ROTATED);
    expect((await st.get(`/media/Items/${I}/Images/Primary?tag=2`)).status).toBe(200);
    expect(st.seen.at(-1)!.token).toBe(ROTATED);
  });

  it('env PLEX_TOKEN wins over the backend\'s token (and the backend is not asked when PLEX_URL is pinned too)', async () => {
    const env = { MEDIA_SERVER: 'plex', FF_GATEWAY_BOOTSTRAP_DIR: bootstrapDir(), PLEX_TOKEN: ENV_TOK };
    const st = await stack(env, { accept: ENV_TOK, backendToken: () => REMOTE_TOK });
    expect((await st.until(TRICK, (s) => s !== 503)).status).toBe(200);
    expect(st.seen.every((x) => x.token === ENV_TOK)).toBe(true);
    expect(st.remote.value('PLEX_TOKEN')).toBeNull(); // not even fetched
  });

  it('env PLEX_TOKEN_FILE wins too; with PLEX_URL pinned but no token the backend is asked for the token only', async () => {
    const dir = bootstrapDir();
    writeFileSync(join(dir, 'tok'), `${ENV_TOK}\n`);
    const pinnedTok = await stack({ MEDIA_SERVER: 'plex', FF_GATEWAY_BOOTSTRAP_DIR: dir, PLEX_TOKEN_FILE: join(dir, 'tok') }, { accept: ENV_TOK, backendToken: () => REMOTE_TOK });
    expect((await pinnedTok.until(TRICK, (s) => s !== 503)).status).toBe(200);
    expect(pinnedTok.seen.every((x) => x.token === ENV_TOK)).toBe(true);
  });

  it('the token never reaches a client or a log line (also when Plex refuses it and echoes it in a header)', async () => {
    const env = { MEDIA_SERVER: 'plex', FF_GATEWAY_BOOTSTRAP_DIR: bootstrapDir() };
    const st = await stack(env, { accept: 'something-else', backendToken: () => REMOTE_TOK });
    const r = await st.until(`/media/Items/${I}/Images/Primary`, (s) => s !== 503);
    expect([r.status, await r.clone().text(), r.headers.get('content-type')]).toEqual([401, 'upstream error', 'text/plain']); // status kept, Plex' body and headers not
    for (const p of ['/health', '/metrics', TRICK, STREAMP, HLSP, `/media/Items/${I}/Images/Primary?X-Plex-Token=${REMOTE_TOK}`, '/media/nope', `/media/c/${'C'.repeat(43)}/Videos/${I}/hls/${S1}/00000.ts`]) await st.get(p);
    expect(st.seen.length).toBeGreaterThan(1);
    expect(st.seen.every((x) => x.token === REMOTE_TOK)).toBe(true); // sent upstream, as a header only
    expect(st.seen.every((x) => !x.url.includes(REMOTE_TOK))).toBe(true);
    expect(st.logs.join('\n')).toContain('PLEX_TOKEN received');
    for (const text of [...st.responses, ...st.logs]) {
      expect(text, text).not.toContain(REMOTE_TOK);
      expect(text.toLowerCase()).not.toContain('x-plex');
    }
  });

  it('Plex error answers (404 playlist, 500 trickplay, 403 stream, HEAD) keep their status but reach the client opaque', async () => {
    const env = { MEDIA_SERVER: 'plex', FF_GATEWAY_BOOTSTRAP_DIR: bootstrapDir() };
    const st = await stack(env, { accept: REMOTE_TOK, backendToken: () => REMOTE_TOK, errors: true });
    await st.until(`/media/Items/${I}/Images/Primary`, (s) => s === 200);
    const cases: Array<[string, string, number, string]> = [
      [`/media/Videos/${I}/hls/${S1}/index.m3u8`, 'GET', 404, 'upstream error'],
      [TRICK, 'GET', 500, 'upstream error'],
      [STREAMP, 'GET', 403, 'upstream error'],
      [STREAMP, 'HEAD', 403, ''],
      [`/media/Videos/${I}/hls/${S1}/index.m3u8`, 'HEAD', 404, ''],
    ];
    for (const [p, method, status, body] of cases) {
      const r = await st.get(p, method);
      expect([p, method, r.status, await r.text(), r.headers.get('content-type')]).toEqual([p, method, status, body, 'text/plain']);
    }
    expect(st.seen.filter((x) => x.token === REMOTE_TOK).length).toBeGreaterThanOrEqual(cases.length);
    for (const text of st.responses) {
      expect(text, text).not.toContain(REMOTE_TOK);
      expect(text.toLowerCase()).not.toContain('x-plex');
      expect(text).not.toContain('plex.example.com');
    }
  });

  it('plexOpaqueErrors leaves answers below 400 and requests without X-Plex-Token (backend calls) untouched', async () => {
    const answer = (status: number) => (async () => new Response(status === 204 ? null : 'BODY', { status, headers: { 'x-upstream': '1' } })) as unknown as typeof fetch;
    const ok = await plexOpaqueErrors(answer(206))('http://p/x', { headers: { 'X-Plex-Token': 't' } });
    expect([ok.status, await ok.text(), ok.headers.get('x-upstream')]).toEqual([206, 'BODY', '1']);
    const be = await plexOpaqueErrors(answer(503))('http://backend/internal/authz', { method: 'POST', headers: { 'x-internal-secret': 's' } });
    expect([be.status, await be.text(), be.headers.get('x-upstream')]).toEqual([503, 'BODY', '1']);
    const be2 = await plexOpaqueErrors(answer(401))('http://backend/internal/gateway-config');
    expect(await be2.text()).toBe('BODY');
    const err = await plexOpaqueErrors(answer(502))('http://p/x', { headers: new Headers({ 'x-plex-token': 't' }) });
    expect([err.status, await err.text(), err.headers.get('x-upstream')]).toEqual([502, 'upstream error', null]);
    expect(plexUpstream.wrapFetch).toBe(plexOpaqueErrors);
    expect(jellyfinUpstream.wrapFetch).toBeUndefined();
  });

  it('a bound adapter with an empty secret never verifies a signature', async () => {
    const b = bindUpstream(plexUpstream, {}, '', { value: () => REMOTE_TOK });
    const ctx = { path: `/Videos/${I}/${P}/Trickplay/2000/1.jpg`, query: new URLSearchParams(`sig=${TPSIG}`), cast: false, checkItem: async () => true };
    await expect(b.authorize!(ctx)).rejects.toThrow(/^plex: no internal secret$/); // the gateway answers 503
  });

  it('the registered adapter bound to a runtime without a token yet throws a message without any value', () => {
    const b = bindUpstream(plexUpstream, {}, V.secret, { value: () => null });
    expect(b.kind).toBe('plex');
    expect(() => b.authHeaders({ token: 'id', deviceId: 'd' })).toThrow(/^plex: no token yet$/);
    const t = bindUpstream(plexUpstream, {}, V.secret, { value: () => REMOTE_TOK });
    expect(t.authHeaders({ token: 'id', deviceId: 'd' })['X-Plex-Token']).toBe(REMOTE_TOK);
    expect(bindUpstream(plexUpstream, { PLEX_TOKEN: ENV_TOK }, V.secret, { value: () => REMOTE_TOK }).authHeaders({ token: 'id', deviceId: 'd' })['X-Plex-Token']).toBe(ENV_TOK);
  });
});
