// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGateway } from '../src/gateway.js';

// Gateway latency features: single-flight authz, tag-immutable images, Server-Timing. Backend and Jellyfin are faked via fetchImpl.
const ID = 'c'.repeat(32);
const SID = 'perf-session-0123456789abcdef';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let authzCalls = 0;
let authzMode: 'ok' | 'error' | 'deny' = 'ok';
let authzDelay = 50;
let gw: Server;
let base: string;

const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
  if (url.pathname === '/internal/authz') {
    authzCalls++;
    await sleep(authzDelay);
    if (authzMode === 'error') return new Response('boom', { status: 500 });
    if (authzMode === 'deny') return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ userId: 'u1', token: 'JF', deviceId: 'ff-u1', maxBitrate: 8_000_000, canDownload: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  await sleep(5);
  if (url.pathname.includes('/Images/')) return new Response('img', { status: 200, headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=60' } });
  if (url.pathname.endsWith('.m3u8')) return new Response('#EXTM3U\n', { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
  return new Response('seg', { status: 200, headers: { 'content-type': 'video/mp2t' } });
}) as typeof fetch;

const get = (path: string, sid = SID) => fetch(`${base}${path}`, { headers: { cookie: `ff_sid=${sid}` } });

beforeAll(async () => {
  gw = createGateway({ jellyfinUrl: 'http://jf.invalid:8096', backendUrl: 'http://be.invalid:3000', internalSecret: 's3cret-s3cret-s3cret', fetchImpl: fakeFetch }).server;
  await new Promise<void>((r) => gw.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => gw.close(() => r())));
beforeEach(() => {
  authzMode = 'ok';
  authzDelay = 50;
});

describe('authorize() single flight', () => {
  it('30 concurrent image requests of one session make ONE /internal/authz call', async () => {
    const sid = 'burst-session-0123456789abcdef';
    const before = authzCalls;
    const rs = await Promise.all(Array.from({ length: 30 }, () => get(`/media/Items/${ID}/Images/Primary?maxWidth=300`, sid)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(authzCalls - before).toBe(1);
    // memo hit afterwards: no further call
    await get(`/media/Items/${ID}/Images/Backdrop`, sid);
    expect(authzCalls - before).toBe(1);
  });

  it('different sessions are not merged', async () => {
    const before = authzCalls;
    await Promise.all(['a', 'b', 'c'].map((x) => get(`/media/Items/${ID}/Images/Primary`, `${x}-separate-session-0123456789`)));
    expect(authzCalls - before).toBe(3);
  });

  it('a failing backend answer is shared by the concurrent burst but not remembered', async () => {
    const sid = 'failing-session-0123456789abcdef';
    authzMode = 'error';
    const before = authzCalls;
    const rs = await Promise.all(Array.from({ length: 10 }, () => get(`/media/Items/${ID}/Images/Primary`, sid)));
    expect(rs.every((r) => r.status === 503)).toBe(true); // backend trouble, not a logout
    expect(authzCalls - before).toBe(1);
    authzMode = 'ok';
    const r = await get(`/media/Items/${ID}/Images/Primary`, sid); // backend recovered: retried at once
    expect(r.status).toBe(200);
    expect(authzCalls - before).toBe(2);
  });

  it('a denial is still remembered briefly (no backend call per request)', async () => {
    const sid = 'denied-session-0123456789abcdef';
    authzMode = 'deny';
    const before = authzCalls;
    expect((await get(`/media/Items/${ID}/Images/Primary`, sid)).status).toBe(401);
    expect((await get(`/media/Items/${ID}/Images/Primary`, sid)).status).toBe(401);
    expect(authzCalls - before).toBe(1);
  });
});

describe('image caching by tag', () => {
  it('a tagged image URL is immutable for a year (still private, Vary: Cookie)', async () => {
    const r = await get(`/media/Items/${ID}/Images/Primary?maxWidth=300&quality=85&tag=0123abcdef`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(r.headers.get('vary')).toBe('Cookie');
  });

  it('without a tag (or with an invalid one) the old revalidating policy stays', async () => {
    for (const q of ['?maxWidth=300', '?tag=', '?tag=a%20b']) {
      const r = await get(`/media/Items/${ID}/Images/Primary${q}`);
      expect(r.headers.get('cache-control')).toBe('private, max-age=86400, stale-while-revalidate=604800');
      expect(r.headers.get('vary')).toBe('Cookie');
    }
  });

  it('a tag never makes playlists or segments cacheable', async () => {
    const r = await get(`/media/Videos/${ID}/main.m3u8?tag=abc`);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
});

describe('Server-Timing', () => {
  it('reports authz and upstream time on images, playlists and segments', async () => {
    authzDelay = 30;
    const sid = 'timing-session-0123456789abcdef';
    for (const p of [`/media/Items/${ID}/Images/Primary`, `/media/Videos/${ID}/main.m3u8`, `/media/Videos/${ID}/hls1/main/0.ts`]) {
      const r = await get(p, sid);
      const st = r.headers.get('server-timing') ?? '';
      expect(st).toMatch(/^authz;dur=[\d.]+, upstream;dur=[\d.]+$/);
      expect(Number(/upstream;dur=([\d.]+)/.exec(st)![1])).toBeGreaterThanOrEqual(4);
    }
    // the first request paid for the backend call, later ones hit the memo
    const first = await get(`/media/Items/${ID}/Images/Primary`, 'timing2-session-0123456789abcdef');
    expect(Number(/authz;dur=([\d.]+)/.exec(first.headers.get('server-timing')!)![1])).toBeGreaterThanOrEqual(25);
    const second = await get(`/media/Items/${ID}/Images/Primary`, 'timing2-session-0123456789abcdef');
    expect(Number(/authz;dur=([\d.]+)/.exec(second.headers.get('server-timing')!)![1])).toBeLessThan(25);
  });
});
