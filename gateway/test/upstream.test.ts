// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blocksDirectStream, createGateway, normalizeCastPath, normalizePath } from '../src/gateway.js';
import { checkUpstreamConfig, jellyfinUpstream, selectUpstream, UPSTREAMS, type PlaylistContext, type Upstream } from '../src/upstream/index.js';

const ID = 'a'.repeat(32);
const vectors = JSON.parse(readFileSync(new URL('../../test-vectors/media-paths.json', import.meta.url), 'utf8')) as {
  allow: string[]; deny: string[]; direct: string[]; cast: { allow: string[]; deny: string[] };
};

describe('upstream adapter selection', () => {
  it('defaults to jellyfin (unset, empty, any case)', () => {
    for (const v of [undefined, '', '  ', 'jellyfin', 'Jellyfin', ' JELLYFIN ']) expect(selectUpstream(v)).toBe(jellyfinUpstream);
    expect(jellyfinUpstream).toMatchObject({ kind: 'jellyfin', urlEnv: 'JELLYFIN_URL' });
  });
  // only what this repository guarantees: a fork registers further adapters without touching this test
  it('refuses unknown kinds (a typo never starts a gateway), also prototype keys', () => {
    for (const v of ['not-a-server', '__proto__', 'constructor', 'toString']) expect(() => selectUpstream(v)).toThrow(/unknown MEDIA_SERVER/);
    expect(Object.keys(UPSTREAMS)).toContain('jellyfin');
    expect(UPSTREAMS.jellyfin).toBe(jellyfinUpstream);
  });
  it('every registered adapter is selectable by its own kind', () => {
    for (const [k, u] of Object.entries(UPSTREAMS)) expect(selectUpstream(k)).toBe(u);
  });
});

describe('the selected jellyfin adapter gives the shared vector results', () => {
  const up = selectUpstream('jellyfin');
  it.each(vectors.allow)('allows %s', (p) => expect(normalizePath(p, up.paths)).toBe(normalizePath(p)));
  it.each(vectors.deny)('denies %s', (p) => expect(normalizePath(p, up.paths)).toBeNull());
  it.each(vectors.cast.allow)('cast allows %s', (p) => expect(normalizeCastPath(p, up)).toBeTruthy());
  it.each(vectors.cast.deny)('cast denies %s', (p) => expect(normalizeCastPath(p, up)).toBeNull());
  it.each(vectors.direct)('direct stream %s', (p) => {
    expect(blocksDirectStream(p, { canDownload: false }, up)).toBe(true);
    expect(blocksDirectStream(p, { canDownload: true }, up)).toBe(false);
  });
  it('auth header is the MediaBrowser header', () => {
    expect(up.authHeaders({ deviceId: 'd"1', token: 't' })).toEqual({ Authorization: 'MediaBrowser Client="FriendFlix", Device="Gateway", DeviceId="d1", Version="0.1.0", Token="t"' });
  });
});

/** A gateway built with another adapter forwards only that adapter's paths, with that adapter's auth header and credential params. */
describe('createGateway uses the injected adapter', () => {
  const fake: Upstream = {
    kind: 'fake', urlEnv: 'FAKE_URL',
    paths: [new RegExp(`^/thing/${'[0-9a-f]{32}'}/img$`), new RegExp(`^/thing/${'[0-9a-f]{32}'}/raw$`)],
    castPaths: [],
    directStream: /\/raw$/,
    image: /\/img$/,
    stripQuery: new Set(['x-fake-token']),
    castDropQuery: new Set(),
    clampHeight: [], clampWidth: [], clampBitrate: ['br'],
    authHeaders: (c) => ({ 'x-fake-token': `${c.token}@${c.deviceId}` }),
  };
  let up: Server, be: Server, gw: Server;
  let port = 0;
  const seen: Array<{ url: string; tok?: string; auth?: string }> = [];
  const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
  beforeAll(async () => {
    up = createServer((req, res) => {
      seen.push({ url: req.url!, tok: req.headers['x-fake-token'] as string | undefined, auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'image/jpeg' }).end('ok');
    });
    be = createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ userId: 'u1', token: 'TOK', deviceId: 'dev', maxBitrate: 1000, canDownload: false })));
    });
    const [upPort, bePort] = [await listen(up), await listen(be)];
    gw = createGateway({ upstream: fake, upstreamUrl: `http://127.0.0.1:${upPort}`, backendUrl: `http://127.0.0.1:${bePort}`, internalSecret: 's3cret-s3cret-s3cret' }).server;
    port = await listen(gw);
  });
  afterAll(() => [up, be, gw].forEach((s) => s.close()));
  const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { cookie: 'ff_sid=goodsid' } });

  it('forwards an adapter path with the adapter auth, strips its credential param, clamps its bitrate key', async () => {
    const r = await get(`/media/thing/${ID}/img?x-fake-token=LEAK&br=99999&keep=1`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('private'); // the adapter's image pattern decides cacheability
    const last = seen.at(-1)!;
    expect(last.tok).toBe('TOK@dev');
    expect(last.auth).toBeUndefined(); // no Jellyfin header leaks into another upstream
    expect(last.url).toBe(`/thing/${ID}/img?br=1000&keep=1`);
  });
  it('refuses Jellyfin paths and the adapter direct stream for a non-download role', async () => {
    const n = seen.length;
    expect((await get(`/media/Items/${ID}/Images/Primary`)).status).toBe(403);
    expect((await get(`/media/thing/${ID}/raw`)).status).toBe(403);
    expect(seen.length).toBe(n);
  });
});

/** The optional hooks a single-token server (Plex fork) needs: authorize (per-item check), rewrite (public -> upstream path), own credential params in cast playlists. */
describe('adapter hooks: authorize, rewrite, playlist credential params', () => {
  const OTHER = 'c'.repeat(32);
  const CT = 'A'.repeat(43);
  const authorizeCalls: Array<{ path: string; cast: boolean }> = [];
  let failAuthorize = false;
  const hooked: Upstream = {
    kind: 'hooked', urlEnv: 'HOOKED_URL',
    paths: [/^\/thing\/[0-9a-f]{32}\/(img|p\.m3u8|evil)$/],
    castPaths: [/^\/thing\/[0-9a-f]{32}\/p\.m3u8$/],
    directStream: /\/raw$/,
    image: /\/img$/,
    stripQuery: new Set(['x-fake-token']),
    castDropQuery: new Set(),
    clampHeight: [], clampWidth: [], clampBitrate: [],
    authHeaders: (c) => ({ 'x-fake-token': c.token }),
    async authorize(c) {
      authorizeCalls.push({ path: c.path, cast: c.cast });
      if (failAuthorize) throw new Error('backend down');
      return c.checkItem(c.path.split('/')[2]!, c.path.endsWith('/img') ? 'image' : 'media');
    },
    rewrite(path, query) {
      const [, , id, file] = path.split('/');
      if (file === 'evil') return { path: '//evil.example/x', query };
      const q = new URLSearchParams(query);
      q.set('rk', id!.slice(0, 4));
      return { path: file === 'img' ? `/library/metadata/${id}/thumb` : `/video/${id}/start.m3u8`, query: q };
    },
  };
  let up: Server, be: Server, gw: Server;
  let port = 0;
  const seen: string[] = [];
  const itemChecks: Array<Record<string, string>> = [];
  const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
  beforeAll(async () => {
    up = createServer((req, res) => {
      seen.push(req.url!);
      if (req.url!.includes('.m3u8')) return void res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end('#EXTM3U\n#EXTINF:3,\nseg0.ts?x-fake-token=LEAK&api_key=KEEP\n');
      res.writeHead(200, { 'content-type': 'image/jpeg' }).end('ok');
    });
    be = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const j = JSON.parse(b);
        if (req.url === '/internal/authz/item') {
          itemChecks.push(j);
          return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ allow: j.itemId === ID }));
        }
        const base = { userId: 'u1', token: 'TOK', deviceId: 'dev', maxBitrate: 1000, canDownload: true };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(j.ct ? { ...base, scope: { itemId: ID, mediaSourceId: 'b'.repeat(32), playSessionId: 'ps' } } : base));
      });
    });
    const [upPort, bePort] = [await listen(up), await listen(be)];
    gw = createGateway({ upstream: hooked, upstreamUrl: `http://127.0.0.1:${upPort}`, backendUrl: `http://127.0.0.1:${bePort}`, internalSecret: 's3cret-s3cret-s3cret' }).server;
    port = await listen(gw);
  });
  afterAll(() => [up, be, gw].forEach((s) => s.close()));
  const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { cookie: 'ff_sid=goodsid-goodsid-goodsid-1' } });

  it('authorize asks the backend per session + item (memoised) and denies invisible items', async () => {
    expect((await get(`/media/thing/${ID}/img`)).status).toBe(200);
    expect((await get(`/media/thing/${ID}/img?x=1`)).status).toBe(200);
    expect(itemChecks).toEqual([{ sid: 'goodsid-goodsid-goodsid-1', itemId: ID, kind: 'image' }]); // second request: memo
    const n = seen.length;
    expect((await get(`/media/thing/${OTHER}/img`)).status).toBe(403);
    expect(seen.length).toBe(n); // never forwarded
  });
  it('a failing authorize answers 503 and forwards nothing', async () => {
    failAuthorize = true;
    try {
      const n = seen.length;
      expect((await get(`/media/thing/${ID}/img`)).status).toBe(503);
      expect(seen.length).toBe(n);
    } finally {
      failAuthorize = false;
    }
  });
  it('rewrite maps the public shape to the upstream request (query kept, credential params stripped first)', async () => {
    await get(`/media/thing/${ID}/img?tag=t1&x-fake-token=LEAK`);
    expect(seen.at(-1)).toBe(`/library/metadata/${ID}/thumb?tag=t1&rk=aaaa`);
  });
  it('a rewrite that leaves the server is refused', async () => {
    const n = seen.length;
    expect((await get(`/media/thing/${ID}/evil`)).status).toBe(502);
    expect(seen.length).toBe(n);
  });
  it('cast: authorize sees cast=true, checkItem is the token scope; the playlist loses the adapter credential param only', async () => {
    authorizeCalls.length = 0;
    const r = await fetch(`http://127.0.0.1:${port}/media/c/${CT}/thing/${ID}/p.m3u8`);
    expect(r.status).toBe(200);
    expect(authorizeCalls).toEqual([{ path: `/thing/${ID}/p.m3u8`, cast: true }]);
    const body = await r.text();
    expect(body).toContain('seg0.ts?api_key=KEEP');
    expect(body).not.toContain('LEAK');
    expect(seen.at(-1)).toBe(`/video/${ID}/start.m3u8?rk=aaaa`);
  });
  it('the Jellyfin adapter has no hooks (no backend item checks, identity paths, no config check, playlists untouched)', () => {
    expect(jellyfinUpstream.authorize).toBeUndefined();
    expect(jellyfinUpstream.rewrite).toBeUndefined();
    expect(jellyfinUpstream.validateConfig).toBeUndefined();
    expect(jellyfinUpstream.playlist).toBeUndefined();
  });
});

describe('adapter hook: validateConfig (gateway startup)', () => {
  const base: Upstream = { ...jellyfinUpstream, kind: 'cfg' };
  it('no hook (Jellyfin) or no problems: starts', () => {
    expect(() => checkUpstreamConfig(jellyfinUpstream, {})).not.toThrow();
    expect(() => checkUpstreamConfig({ ...base, validateConfig: () => [] }, {})).not.toThrow();
  });
  it('problems: refuses with the kind and every problem in the message', () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const up: Upstream = {
      ...base,
      validateConfig(env) {
        seen.push(env);
        return [env.CFG_TOKEN ? '' : 'CFG_TOKEN is required', env.CFG_MODE === 'x' ? 'CFG_MODE=x is not supported' : ''].filter(Boolean);
      },
    };
    expect(() => checkUpstreamConfig(up, { CFG_MODE: 'x' })).toThrow('MEDIA_SERVER=cfg: invalid gateway configuration: CFG_TOKEN is required; CFG_MODE=x is not supported');
    expect(() => checkUpstreamConfig(up, { CFG_TOKEN: 't' })).not.toThrow();
    expect(seen.at(-1)).toEqual({ CFG_TOKEN: 't' }); // the hook gets the environment it is asked about
  });
});

/** playlist(): a server that puts its credential into segment URIs (Plex: X-Plex-Token) needs it removed on the cookie path too. */
describe('adapter hook: playlist (cookie and cast path)', () => {
  const CT = 'B'.repeat(43);
  const BODY = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4?X-Srv-Token=LEAK0&x=1"\n#EXTINF:3,\nseg0.ts?X-Srv-Token=LEAK1&keep=1\n#EXTINF:3,\nseg1.ts?keep=2&x-srv-token=LEAK2\n';
  const ctxs: PlaylistContext[] = [];
  let mode: 'ok' | 'throw' = 'ok';
  const stripToken = (u: string) => u.replace(/([?&])x-srv-token=[^&"\s]*&?/gi, '$1').replace(/[?&]$/, '');
  const withHook: Upstream = {
    kind: 'pl', urlEnv: 'PL_URL',
    paths: [/^\/v\/[0-9a-f]{32}\/(p\.m3u8|seg\.ts)$/],
    castPaths: [/^\/v\/[0-9a-f]{32}\/p\.m3u8$/],
    directStream: /\/raw$/,
    image: /\/img$/,
    stripQuery: new Set(),
    castDropQuery: new Set(),
    clampHeight: [], clampWidth: [], clampBitrate: [],
    authHeaders: (c) => ({ 'x-srv-token': c.token }),
    playlist(body, c) {
      ctxs.push(c);
      if (mode === 'throw') throw new Error('unparseable');
      return body.split('\n').map(stripToken).join('\n');
    },
  };
  let up: Server, be: Server, gwHook: Server, gwPlain: Server;
  let portHook = 0, portPlain = 0;
  const upHeaders: Array<Record<string, string | string[] | undefined>> = [];
  const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
  beforeAll(async () => {
    up = createServer((req, res) => {
      upHeaders.push(req.headers);
      if (req.url!.includes('.m3u8')) return void res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', etag: '"e1"' }).end(BODY);
      res.writeHead(200, { 'content-type': 'video/mp2t' }).end('seg?X-Srv-Token=NOT-A-PLAYLIST');
    });
    be = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const j = JSON.parse(b);
        const base = { userId: 'u1', token: 'TOK', deviceId: 'dev', maxBitrate: 1000, canDownload: true };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(j.ct ? { ...base, scope: { itemId: ID, mediaSourceId: 'b'.repeat(32), playSessionId: 'ps' } } : base));
      });
    });
    const [upPort, bePort] = [await listen(up), await listen(be)];
    const o = { upstreamUrl: `http://127.0.0.1:${upPort}`, backendUrl: `http://127.0.0.1:${bePort}`, internalSecret: 's3cret-s3cret-s3cret' };
    gwHook = createGateway({ ...o, upstream: withHook }).server;
    const { playlist: _p, ...noHook } = withHook;
    gwPlain = createGateway({ ...o, upstream: noHook }).server;
    [portHook, portPlain] = [await listen(gwHook), await listen(gwPlain)];
  });
  afterAll(() => [up, be, gwHook, gwPlain].forEach((s) => s.close()));
  const get = (port: number, p: string, h: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { cookie: 'ff_sid=goodsid-goodsid-goodsid-1', ...h } });

  it('cookie path: the hook rewrites the playlist (credential gone from every URI, rest kept), sees the request context', async () => {
    ctxs.length = 0;
    const r = await get(portHook, `/media/v/${ID}/p.m3u8?a=1`, { range: 'bytes=0-10', 'if-none-match': '"e1"' });
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toBe('#EXTM3U\n#EXT-X-MAP:URI="init.mp4?x=1"\n#EXTINF:3,\nseg0.ts?keep=1\n#EXTINF:3,\nseg1.ts?keep=2\n');
    expect(r.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));
    expect(r.headers.get('etag')).toBeNull(); // the body changed: the upstream validator no longer describes it
    expect(upHeaders.at(-1)!.range).toBeUndefined(); // rewritten playlists are fetched whole and unconditionally
    expect(upHeaders.at(-1)!['if-none-match']).toBeUndefined();
    expect(ctxs).toHaveLength(1);
    expect(ctxs[0]).toMatchObject({ path: `/v/${ID}/p.m3u8`, requestPath: `/media/v/${ID}/p.m3u8`, cast: false });
    expect(ctxs[0]!.query.get('a')).toBe('1');
  });
  it('cast path: the hook runs first, the cast sanitising still applies', async () => {
    ctxs.length = 0;
    const r = await fetch(`http://127.0.0.1:${portHook}/media/c/${CT}/v/${ID}/p.m3u8`);
    expect(r.status).toBe(200);
    expect(await r.text()).not.toMatch(/LEAK/);
    expect(ctxs).toEqual([expect.objectContaining({ cast: true, requestPath: `/media/c/${CT}/v/${ID}/p.m3u8` })]);
  });
  it('a throwing hook answers 502; segments are never passed to it', async () => {
    mode = 'throw';
    try {
      expect((await get(portHook, `/media/v/${ID}/p.m3u8`)).status).toBe(502);
    } finally {
      mode = 'ok';
    }
    ctxs.length = 0;
    const seg = await get(portHook, `/media/v/${ID}/seg.ts`);
    expect(await seg.text()).toBe('seg?X-Srv-Token=NOT-A-PLAYLIST');
    expect(ctxs).toHaveLength(0);
  });
  it('without the hook (Jellyfin) the cookie playlist is relayed byte for byte, Range and validators pass through', async () => {
    const r = await get(portPlain, `/media/v/${ID}/p.m3u8`, { 'if-none-match': '"e0"' });
    expect(await r.text()).toBe(BODY);
    expect(r.headers.get('etag')).toBe('"e1"');
    expect(upHeaders.at(-1)!['if-none-match']).toBe('"e0"');
  });
});
