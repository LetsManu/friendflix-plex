// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { normalizePath, upstreamUri } from '../src/mediapath.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

const vectors = JSON.parse(readFileSync(new URL('../../test-vectors/media-paths.json', import.meta.url), 'utf8')) as { allow: string[]; deny: string[]; direct: string[] };
const ID = 'a'.repeat(32);

describe('shared allowlist vectors (same file as the gateway tests)', () => {
  it.each(vectors.allow)('allows %s', (p) => expect(normalizePath(p)).toBeTruthy());
  it.each(vectors.deny)('denies %s', (p) => expect(normalizePath(p)).toBeNull());
});

describe('upstreamUri: direct streams', () => {
  it.each(vectors.direct)('%s is refused for height-capped roles and roles without download rights', (p) => {
    const uri = `/media${p}?static=true`;
    expect(upstreamUri(uri, 1, undefined, true)).toContain(p);
    expect(upstreamUri(uri, 1, undefined)).toContain(p); // default: allowed
    expect(upstreamUri(uri, 1, 1080, true)).toBeNull();
    expect(upstreamUri(uri, 1, undefined, false)).toBeNull();
  });
  it('HLS stays available to restricted roles', () => {
    expect(upstreamUri(`/media/Videos/${ID}/master.m3u8`, 1, 1080, false)).toBe(`/Videos/${ID}/master.m3u8`);
  });
});

describe('upstreamUri', () => {
  it('strips token params, clamps bitrate, keeps benign params, re-encodes', () => {
    const u = upstreamUri(`/media/Videos/${ID}/master.m3u8?api_key=LEAK&ApiKey=X&MaxStreamingBitrate=999999999&MediaSourceId=a%20b&Token=t`, 5_000_000)!;
    expect(u).toBe(`/Videos/${ID}/master.m3u8?MaxStreamingBitrate=5000000&MediaSourceId=a+b`);
    expect(u).not.toMatch(/LEAK|ApiKey|Token/i);
  });
  it('adds a bitrate cap even when the client sends none? no: only clamps what is sent', () => {
    expect(upstreamUri(`/media/Videos/${ID}/master.m3u8`, 1)).toBe(`/Videos/${ID}/master.m3u8`);
    expect(upstreamUri(`/media/Videos/${ID}/master.m3u8?VideoBitRate=abc`, 7)).toContain('VideoBitRate=7');
  });
  it('rejects bad input: wrong prefix, control chars, long/many params, traversal', () => {
    const capped = new URL(upstreamUri(`/media/Videos/${ID}/master.m3u8?MaxHeight=2160&maxwidth=3840&Height=480`, 1, 720)!, 'http://x').searchParams;
    expect([capped.get('MaxHeight'), capped.get('maxwidth'), capped.get('Height')]).toEqual(['720', '1280', '480']);
    expect(upstreamUri(`/media/Videos/${ID}/master.m3u8?MaxHeight=2160`, 1)).toContain('MaxHeight=2160');
    expect(upstreamUri(`/api/me`, 1)).toBeNull();
    expect(upstreamUri('/media/d/123e4567-e89b-42d3-a456-426614174000', 1)).toBeNull(); // offline downloads are gateway-only (Plan B denies them)
    expect(upstreamUri(`/media/Videos/${ID}/master.m3u8\r\nX-Evil: 1`, 1)).toBeNull();
    expect(upstreamUri(`/media/Videos/${ID}/master.m3u8?x=${'a'.repeat(2100)}`, 1)).toBeNull();
    expect(upstreamUri(`/media/Videos/${ID}/master.m3u8?${Array.from({ length: 41 }, (_, i) => `p${i}=1`).join('&')}`, 1)).toBeNull();
    expect(upstreamUri(`/media/Videos/${ID}/hls1/main/..%2f..%2fx`, 1)).toBeNull();
    expect(upstreamUri(`/media//evil.example/x`, 1)).toBeNull();
  });
});

describe('GET /internal/authz-nginx', () => {
  let env: TestEnv;
  afterEach(() => { vi.useRealTimers(); });
  let sid: string;
  const H = { 'x-internal-secret': cfg.INTERNAL_SECRET };
  const call = (headers: Record<string, string>, cookies: Record<string, string> | undefined, uri = `/media/Videos/${ID}/master.m3u8?MaxStreamingBitrate=999999999`) =>
    env.app.inject({ method: 'GET', url: '/internal/authz-nginx', headers: { ...headers, 'x-original-uri': uri }, cookies });

  beforeAll(async () => {
    env = await makeEnv();
    sid = (await env.login()).cookies.ff_sid!;
  });
  afterAll(() => env.close());

  it('requires the internal secret', async () => {
    expect((await call({}, { ff_sid: sid })).statusCode).toBe(403);
    expect((await call({ 'x-internal-secret': 'wrong-secret-wrong' }, { ff_sid: sid })).statusCode).toBe(403);
  });
  it('401 without or with an invalid session', async () => {
    expect((await call(H, undefined)).statusCode).toBe(401);
    expect((await call(H, { ff_sid: 'x'.repeat(30) })).statusCode).toBe(401);
    expect((await call(H, { ff_sid: '../etc' })).statusCode).toBe(401);
  });
  it('returns sanitized uri and the user token header only in response headers', async () => {
    const r = await call(H, { ff_sid: sid });
    expect(r.statusCode).toBe(204);
    expect(r.headers['x-jellyfin-uri']).toBe(`/Videos/${ID}/master.m3u8?MaxStreamingBitrate=60000000`);
    expect(String(r.headers['x-jellyfin-auth'])).toMatch(/^MediaBrowser Client="FriendFlix".*Token="tok-/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toBe('');
  });
  it('403 for paths outside the allowlist, even with a valid session', async () => {
    expect((await call(H, { ff_sid: sid }, '/media/System/Info')).statusCode).toBe(403);
    expect((await call(H, { ff_sid: sid }, `/media/Videos/${ID}/hls1/main/..%2f..%2f..%2fSystem`)).statusCode).toBe(403);
    expect((await call(H, { ff_sid: sid }, '')).statusCode).toBe(403);
  });
  it('a server without Plan B support (capabilities.planB=false): 501 with a clear reason, no token header, secret still checked first', async () => {
    const jf = env.ctx.jf as { capabilities: typeof env.ctx.jf.capabilities; planBAuthHeader: typeof env.ctx.jf.planBAuthHeader };
    const prev = { caps: jf.capabilities, header: jf.planBAuthHeader };
    jf.capabilities = { ...prev.caps, planB: false };
    jf.planBAuthHeader = () => { throw new Error('not supported'); }; // what used to surface as a 500
    try {
      expect((await call({}, { ff_sid: sid })).statusCode).toBe(403);
      for (let i = 0; i < 2; i++) {
        const r = await call(H, { ff_sid: sid });
        expect(r.statusCode).toBe(501);
        expect(r.json()).toEqual({ error: 'plan_b_unsupported', kind: 'jellyfin' });
        expect(r.headers['x-jellyfin-auth']).toBeUndefined();
        expect(r.headers['x-jellyfin-uri']).toBeUndefined();
      }
    } finally {
      Object.assign(jf, { capabilities: prev.caps, planBAuthHeader: prev.header });
    }
    expect((await call(H, { ff_sid: sid })).statusCode).toBe(204);
  });
  it('a disabled user or removed session loses access within the memo window (<= 5 s)', async () => {
    await env.pool.query('update users set disabled = true');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5200); // memo window (5 s) elapses
    expect((await call(H, { ff_sid: sid })).statusCode).toBe(401);
    await env.pool.query('update users set disabled = false');
  });
  it('counts decisions for monitoring', async () => {
    const m = (await env.app.inject('/metrics')).body;
    expect(m).toMatch(/friendflix_authz_nginx_total\{result="unsupported"\} \d+/);
    expect(m).toMatch(/friendflix_authz_nginx_total\{result="ok"\} \d+/);
    expect(m).toMatch(/friendflix_authz_nginx_total\{result="path_denied"\} \d+/);
  });
});
