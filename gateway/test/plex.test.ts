import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blocksDirectStream, createGateway, normalizeCastPath, normalizePath } from '../src/gateway.js';
import { checkUpstreamConfig, selectUpstream, UPSTREAMS } from '../src/upstream/index.js';
import { createPlexUpstream, decodePlexId, plexUpstream, verifyPartSig, verifySession, verifyTpSig } from '../src/upstream/plex.js';

interface Vectors {
  secret: string; token: string; allow: string[]; deny: string[]; direct: string[]; cast: { allow: string[]; deny: string[] };
  signatures: { part: Array<{ item: string; part: string; sig: string }>; trickplay: Array<{ item: string; part: string; sig: string }>; session: Array<{ item: string; nonce: string; session: string }> };
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

  it('validateConfig: PLEX_URL (http/https) and PLEX_TOKEN or a readable PLEX_TOKEN_FILE', () => {
    const v = up.validateConfig!;
    expect(v({ PLEX_URL: 'http://plex:32400', PLEX_TOKEN: 't' })).toEqual([]);
    expect(v({})).toEqual(['PLEX_URL is not set', 'PLEX_TOKEN (or PLEX_TOKEN_FILE) is not set']);
    expect(v({ PLEX_URL: 'ftp://x', PLEX_TOKEN: 't' })).toEqual(['PLEX_URL must be an http(s) URL']);
    expect(v({ PLEX_URL: 'nope', PLEX_TOKEN: 't' })).toEqual(['PLEX_URL is not a valid URL']);
    const dir = mkdtempSync(join(tmpdir(), 'ffgw-'));
    writeFileSync(join(dir, 'tok'), 'secret\n');
    writeFileSync(join(dir, 'empty'), '\n');
    expect(v({ PLEX_URL: 'http://plex:32400', PLEX_TOKEN_FILE: join(dir, 'tok') })).toEqual([]);
    expect(v({ PLEX_URL: 'http://plex:32400', PLEX_TOKEN_FILE: join(dir, 'empty') })).toEqual(['PLEX_TOKEN_FILE is empty']);
    expect(v({ PLEX_URL: 'http://plex:32400', PLEX_TOKEN_FILE: join(dir, 'missing') })).toEqual(['PLEX_TOKEN_FILE cannot be read']);
    expect(() => checkUpstreamConfig(selectUpstream('plex'), { MEDIA_SERVER: 'plex' })).toThrow(/PLEX_URL/);
  });

  it('playlist: credentials stripped from every URI, URIs outside the session refused', () => {
    const p = (b: string) => up.playlist!(b, { path: '', query: new URLSearchParams(), requestPath: '', cast: false });
    const body = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4?X-Plex-Token=SECRET&x=1"\n#EXTINF:8,\n00000.ts?X-Plex-Token=SECRET&X-Plex-Client-Identifier=c\n#EXTINF:8,\n00001.ts\n';
    const out = p(body);
    expect(out).not.toContain('SECRET');
    expect(out).toBe('#EXTM3U\n#EXT-X-MAP:URI="init.mp4?x=1"\n#EXTINF:8,\n00000.ts\n#EXTINF:8,\n00001.ts\n');
    for (const bad of ['http://plex:32400/x.ts', '//plex/x.ts', '/video/x.ts', '../x.ts', '#EXT-X-MAP:URI="http://plex/i.mp4"']) expect(() => p(`#EXTM3U\n${bad}\n`)).toThrow();
  });
});
