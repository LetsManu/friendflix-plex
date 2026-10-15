// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGateway, normalizePath, sanitizePlaylist } from '../src/gateway.js';
import { jellyfinUpstream } from '../src/upstream/jellyfin.js';
import type { Upstream } from '../src/upstream/types.js';

// Failure paths of the gateway: backend/upstream unreachable or misbehaving, adapter hooks throwing.
// Backend and Jellyfin are faked through fetchImpl so every failure can be produced on demand.
const ID = 'd'.repeat(32);
const MS = 'e'.repeat(32);
const CT = 'C'.repeat(43);
const DL = '99999999-9999-4999-8999-999999999999';
const SECRET = 's3cret-s3cret-s3cret';

type BackendMode = 'ok' | 'throw' | '500' | '403' | 'noscope' | 'badDownload';
type UpstreamMode = 'ok' | 'throw' | 'hugePlaylist';
let backendMode: BackendMode = 'ok';
let upstreamMode: UpstreamMode = 'ok';
let backendCalls = 0;
let upstreamCalls = 0;

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const authzAnswer = { userId: 'u1', token: 'JF', deviceId: 'ff-u1', maxBitrate: 5_000_000 };
const scope = { itemId: ID, mediaSourceId: MS, playSessionId: 'ps-1' };

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
  if (url.pathname.startsWith('/internal/')) {
    backendCalls++;
    const body = JSON.parse(String(init?.body ?? '{}')) as { ct?: string; dl?: string };
    if (backendMode === 'throw') throw new TypeError('fetch failed');
    if (backendMode === '500') return new Response('boom', { status: 500 });
    if (backendMode === '403') return json({ error: 'forbidden' }, 403); // a wrong INTERNAL_SECRET
    if (body.ct !== undefined) return json(backendMode === 'noscope' ? authzAnswer : { ...authzAnswer, kind: 'media', scope });
    if (body.dl !== undefined) return json(backendMode === 'badDownload' ? { ...authzAnswer, download: { kind: 'ftp' } } : { ...authzAnswer, download: { kind: 'static', path: `/Videos/${ID}/stream` } });
    return json(authzAnswer);
  }
  upstreamCalls++;
  if (upstreamMode === 'throw') throw new TypeError('fetch failed');
  if (url.pathname.endsWith('.m3u8')) {
    const headers: Record<string, string> = { 'content-type': 'application/vnd.apple.mpegurl' };
    if (upstreamMode === 'hugePlaylist') headers['content-length'] = String(9 * 1024 * 1024);
    return new Response(upstreamMode === 'hugePlaylist' ? null : '#EXTM3U\n#EXTINF:3,\nhls1/main/0.ts\n', { status: 200, headers });
  }
  return new Response('seg', { status: 200, headers: { 'content-type': 'video/mp2t' } });
}) as typeof fetch;

const servers: Server[] = [];
async function start(upstream: Upstream = jellyfinUpstream): Promise<{ base: string; metrics: () => string }> {
  const g = createGateway({ upstream, upstreamUrl: 'http://jf.invalid:8096', backendUrl: 'http://be.invalid:3000', internalSecret: SECRET, fetchImpl: fakeFetch });
  servers.push(g.server);
  await new Promise<void>((r) => g.server.listen(0, '127.0.0.1', () => r()));
  return { base: `http://127.0.0.1:${(g.server.address() as AddressInfo).port}`, metrics: g.metrics };
}

let gw: { base: string; metrics: () => string };
beforeAll(async () => {
  gw = await start();
});
afterAll(() => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))));
beforeEach(() => {
  backendMode = 'ok';
  upstreamMode = 'ok';
});

const cookieGet = (base: string, path: string, sid: string, method = 'GET') => fetch(`${base}${path}`, { method, headers: { cookie: `ff_sid=${sid}` } });
// every cast request comes from a fresh client address: the cast memo is keyed by token + client, so tests never see another test's answer
let client = 0;
const castGet = (base: string, path: string, method = 'GET') => fetch(`${base}/media/c/${CT}${path}`, { method, headers: { 'x-real-ip': `198.51.100.${++client}` } });

describe('session authorization failures', () => {
  it('an unreachable backend answers 503 and is not memoised, so the next request asks again', async () => {
    backendMode = 'throw';
    const before = backendCalls;
    expect((await cookieGet(gw.base, `/media/Items/${ID}/Images/Primary`, 'net-down-session-0123')).status).toBe(503);
    backendMode = 'ok';
    const r = await cookieGet(gw.base, `/media/Items/${ID}/Images/Primary`, 'net-down-session-0123');
    expect(r.status).toBe(200);
    expect(backendCalls - before).toBe(2);
  });

  it('a backend 5xx (503 setup_required during setup) answers 503 and is never memoised', async () => {
    backendMode = '500';
    const before = backendCalls;
    for (let i = 0; i < 2; i++) {
      const r = await cookieGet(gw.base, `/media/Items/${ID}/Images/Primary`, 'setup-mode-session-01');
      expect([r.status, r.headers.get('cache-control')]).toEqual([503, 'no-store']);
    }
    backendMode = 'ok';
    expect((await cookieGet(gw.base, `/media/Items/${ID}/Images/Primary`, 'setup-mode-session-01')).status).toBe(200);
    expect(backendCalls - before).toBe(3);
    expect(gw.metrics()).toMatch(/friendflix_gateway_requests_total\{code="503"\} [1-9]/);
  });
  it('a backend 403 (wrong INTERNAL_SECRET) answers 503 and is never memoised', async () => {
    backendMode = '403';
    const before = backendCalls;
    for (let i = 0; i < 2; i++) {
      const r = await cookieGet(gw.base, `/media/Items/${ID}/Images/Primary`, 'wrong-secret-session-01');
      expect([r.status, r.headers.get('cache-control')]).toEqual([503, 'no-store']);
    }
    backendMode = 'ok';
    expect((await cookieGet(gw.base, `/media/Items/${ID}/Images/Primary`, 'wrong-secret-session-01')).status).toBe(200);
    expect(backendCalls - before).toBe(3);
  });
});

describe('upstream failures', () => {
  it('a network error towards the media server is a 502 and counted as such', async () => {
    upstreamMode = 'throw';
    const r = await cookieGet(gw.base, `/media/Items/${ID}/Images/Primary`, 'upstream-down-0123456');
    expect(r.status).toBe(502);
    expect(await r.text()).toBe('bad gateway');
    expect(gw.metrics()).toMatch(/friendflix_gateway_requests_total\{code="502"\} [1-9]/);
  });

  it('a cast request whose upstream fails still carries the CORS headers on the 502', async () => {
    upstreamMode = 'throw';
    const r = await castGet(gw.base, `/Videos/${ID}/hls1/main/0.ts?MediaSourceId=${MS}&PlaySessionId=ps-1`);
    expect(r.status).toBe(502);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('a cast playlist announced above the 8 MB buffer limit is refused with 502 instead of being buffered', async () => {
    upstreamMode = 'hugePlaylist';
    const r = await castGet(gw.base, `/Videos/${ID}/main.m3u8?MediaSourceId=${MS}&PlaySessionId=ps-1`);
    expect(r.status).toBe(502);
  });
});

describe('cast authorization failures', () => {
  it('an unreachable backend is 503 (never counted as a failed token)', async () => {
    backendMode = 'throw';
    const r = await castGet(gw.base, `/Items/${ID}/Images/Primary`);
    expect(r.status).toBe(503);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(gw.metrics()).toMatch(/friendflix_gateway_cast_requests_total\{code="503"\} [1-9]/);
  });

  it('a backend answer without scope is never used (it would be an unscoped token): 503', async () => {
    backendMode = 'noscope';
    const before = upstreamCalls;
    const r = await castGet(gw.base, `/Items/${ID}/Images/Backdrop`);
    expect(r.status).toBe(503);
    expect(upstreamCalls).toBe(before);
  });

  it('a query beyond the length limit is 414 before the backend is asked', async () => {
    const before = backendCalls;
    const r = await castGet(gw.base, `/Videos/${ID}/main.m3u8?MediaSourceId=${MS}&x=${'a'.repeat(2100)}`);
    expect(r.status).toBe(414);
    expect(backendCalls).toBe(before);
  });

  it('HEAD on a cast playlist answers the headers without a body or a stale content-length', async () => {
    const r = await castGet(gw.base, `/Videos/${ID}/master.m3u8?MediaSourceId=${MS}&PlaySessionId=ps-1`, 'HEAD');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.text()).toBe('');
  });
});

describe('download authorization failures', () => {
  it('an unreachable backend is 503', async () => {
    backendMode = 'throw';
    expect((await cookieGet(gw.base, `/media/d/${DL}`, 'dl-session-0123456789')).status).toBe(503);
  });

  it('a backend 5xx is 503', async () => {
    backendMode = '500';
    expect((await cookieGet(gw.base, `/media/d/${DL}`, 'dl-session-0123456789')).status).toBe(503);
  });

  it('a download answer with an unknown target kind is 503, nothing is fetched', async () => {
    backendMode = 'badDownload';
    const before = upstreamCalls;
    expect((await cookieGet(gw.base, `/media/d/${DL}`, 'dl-badkind-0123456789')).status).toBe(503);
    expect(upstreamCalls).toBe(before);
  });
});

describe('adapter hooks failing', () => {
  it('a cast authorize hook that throws is 503, one that denies is 403', async () => {
    let mode: 'throw' | 'deny' = 'throw';
    const g = await start({ ...jellyfinUpstream, authorize: async () => {
      if (mode === 'throw') throw new Error('adapter down');
      return false;
    } });
    expect((await castGet(g.base, `/Items/${ID}/Images/Primary`)).status).toBe(503);
    mode = 'deny';
    expect((await castGet(g.base, `/Items/${ID}/Images/Primary`)).status).toBe(403);
    expect(g.metrics()).toMatch(/cast_requests_total\{code="403"\} 1/);
  });

  it('an unexpected exception while handling a request is a 500, the server keeps running', async () => {
    const g = await start({ ...jellyfinUpstream, authHeaders: () => {
      throw new Error('adapter bug');
    } });
    const r = await cookieGet(g.base, `/media/Items/${ID}/Images/Primary`, 'adapter-bug-0123456789');
    expect(r.status).toBe(500);
    expect((await fetch(`${g.base}/health`)).status).toBe(200);
  });
});

describe('path and playlist validation edge cases', () => {
  it('a malformed percent-encoding in the path is rejected', () => {
    expect(normalizePath(`/Items/${ID}/Images/Primary%E0%A4%A`, jellyfinUpstream.paths)).toBeNull();
  });

  it('a playlist URI that cannot be parsed as a URL rejects the whole playlist', () => {
    expect(sanitizePlaylist('#EXTM3U\nhttp://[broken/seg.ts\n', `/media/c/${CT}/Videos/${ID}/main.m3u8`, jellyfinUpstream.stripQuery)).toBeNull();
  });
});
