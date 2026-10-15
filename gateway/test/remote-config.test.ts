// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGateway } from '../src/gateway.js';
import { createRemoteConfig } from '../src/remoteConfig.js';

const SECRET = 's3cret-s3cret-s3cret';
const BACKEND = 'http://be.invalid:3000';
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fake backend: answers /internal/gateway-config from a queue (last answer repeats); a function answer may hang or throw. */
function fakeBackend(answers: Array<Response | (() => Promise<Response>)>) {
  const calls: Array<{ url: string; secret: string | null }> = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), secret: new Headers(init?.headers).get('x-internal-secret') });
    const a = answers.length > 1 ? answers.shift()! : answers[0]!;
    return typeof a === 'function' ? a() : a.clone();
  }) as typeof fetch;
  return { f, calls };
}
const setupRequired = () => json({ error: 'setup_required' }, 503);
const cfgAnswer = (rev: number, upstreamUrl: string) => json({ rev, upstreamUrl });
/** lets the queued microtasks (fetch, json) of a refresh run */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('createRemoteConfig', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('envUrl set → never fetches', async () => {
    const be = fakeBackend([cfgAnswer(1, 'http://other:8096')]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, envUrl: 'http://jf:8096', fetchImpl: be.f });
    await vi.advanceTimersByTimeAsync(120_000);
    rc.noteRev('99');
    await settle();
    expect(rc.url()).toBe('http://jf:8096');
    expect(rc.value('PLEX_TOKEN')).toBeNull();
    expect(be.calls).toEqual([]);
    rc.stop();
  });

  it('an envUrl that is not an http(s) URL refuses to start without echoing it', () => {
    for (const bad of ['jf:8096', 'ftp://u:pw@jf', 'http://']) {
      expect(() => createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, envUrl: bad })).toThrow(/^gateway: the media server URL from the environment is not an http\(s\) URL$/);
    }
  });

  it('an empty envUrl counts as unset', async () => {
    const be = fakeBackend([cfgAnswer(1, 'http://jf:8096')]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, envUrl: '', fetchImpl: be.f, log: () => {} });
    await settle();
    expect(rc.url()).toBe('http://jf:8096');
    rc.stop();
  });

  it('first fetch 503 → retries after retryMs, then url() returns the value', async () => {
    const be = fakeBackend([setupRequired(), cfgAnswer(3, 'http://jf:8096')]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, fetchImpl: be.f, retryMs: 5000, refreshMs: 30_000, log: () => {} });
    await settle();
    expect(be.calls).toEqual([{ url: `${BACKEND}/internal/gateway-config`, secret: SECRET }]);
    expect(rc.url()).toBeNull();
    await vi.advanceTimersByTimeAsync(4999);
    expect(be.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(be.calls).toHaveLength(2);
    expect(rc.url()).toBe('http://jf:8096');
    // then every refreshMs, not every retryMs
    await vi.advanceTimersByTimeAsync(29_999);
    expect(be.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(be.calls).toHaveLength(3);
    rc.stop();
  });

  it('the defaults are 5 s retry and 30 s refresh', async () => {
    const be = fakeBackend([setupRequired(), cfgAnswer(1, 'http://jf:8096')]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, fetchImpl: be.f, log: () => {} });
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(be.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(be.calls).toHaveLength(3);
    rc.stop();
  });

  it('noteRev(\'7\') with cached rev 6 → refetches immediately', async () => {
    const be = fakeBackend([cfgAnswer(6, 'http://jf:8096'), cfgAnswer(7, 'http://media:8096')]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, fetchImpl: be.f, log: () => {} });
    await settle();
    expect(rc.url()).toBe('http://jf:8096');
    rc.noteRev('7');
    rc.noteRev('7'); // concurrent triggers of one rev: one fetch
    await settle();
    expect(be.calls).toHaveLength(2);
    expect(rc.url()).toBe('http://media:8096');
    rc.noteRev('7'); // the cached rev
    for (const bad of [null, '', 'abc', '7.5', '-8', '1e3', ' 9', String(2 ** 60)]) rc.noteRev(bad);
    await settle();
    expect(be.calls).toHaveLength(2);
    rc.stop();
  });

  it('a rev the backend has not reached yet triggers one refetch, one retry after retryMs, then the normal schedule', async () => {
    const be = fakeBackend([cfgAnswer(6, 'http://jf:8096')]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, fetchImpl: be.f, retryMs: 5000, refreshMs: 30_000, log: () => {} });
    await settle();
    rc.noteRev('8');
    await settle();
    rc.noteRev('8');
    await settle();
    expect(be.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5000); // the answer (6) was behind the noted rev (8): one more try soon
    expect(be.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(5000); // still behind: no further early retry
    expect(be.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(be.calls).toHaveLength(4);
    rc.stop();
  });

  it('a stale instance answering an older rev: the early retry picks up the new upstream', async () => {
    const be = fakeBackend([cfgAnswer(6, 'http://jf:8096'), cfgAnswer(6, 'http://jf:8096'), cfgAnswer(7, 'http://media:8096')]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, fetchImpl: be.f, retryMs: 5000, refreshMs: 30_000, log: () => {} });
    await settle();
    rc.noteRev('7');
    await settle();
    expect(rc.url()).toBe('http://jf:8096');
    await vi.advanceTimersByTimeAsync(5000);
    expect(rc.url()).toBe('http://media:8096');
    rc.stop();
  });

  it('a different rev refetches, also a lower one (a database restored from an older backup); the cached rev does not', async () => {
    const be = fakeBackend([cfgAnswer(10, 'http://jf:8096'), cfgAnswer(4, 'http://restored:8096')]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, fetchImpl: be.f, log: () => {} });
    await settle();
    rc.noteRev('10');
    await settle();
    expect(be.calls).toHaveLength(1);
    rc.noteRev('4');
    await settle();
    expect(be.calls).toHaveLength(2);
    expect(rc.url()).toBe('http://restored:8096');
    rc.noteRev('4');
    await settle();
    expect(be.calls).toHaveLength(2);
    rc.stop();
  });

  it('cancels the body of a refused answer (the connection is released at once)', async () => {
    let cancelled = 0;
    const refused = () => Promise.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503 }));
    const be = fakeBackend([refused, refused, cfgAnswer(1, 'http://jf:8096')]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, fetchImpl: be.f, retryMs: 100, log: () => {} });
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(be.calls).toHaveLength(3);
    expect(cancelled).toBe(2);
    expect(rc.url()).toBe('http://jf:8096');
    rc.stop();
  });

  it('no overlapping fetches: a rev noted during a fetch runs once after it', async () => {
    let release!: () => void;
    const slow = () => new Promise<Response>((r) => { release = () => r(cfgAnswer(6, 'http://jf:8096')); });
    const be = fakeBackend([slow, cfgAnswer(7, 'http://media:8096')]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, fetchImpl: be.f, log: () => {} });
    await settle();
    rc.noteRev('7');
    rc.noteRev('8');
    await vi.advanceTimersByTimeAsync(60_000); // no timer fires while the first fetch hangs
    expect(be.calls).toHaveLength(1);
    release();
    await settle();
    expect(be.calls).toHaveLength(2);
    expect(rc.url()).toBe('http://media:8096');
    rc.stop();
  });

  it('a failed refresh keeps the last good URL and retries after retryMs', async () => {
    const be = fakeBackend([
      cfgAnswer(1, 'http://jf:8096'),
      () => Promise.reject(new TypeError('fetch failed')),
      json({ error: 'forbidden' }, 403),
      json({ rev: 'x', upstreamUrl: 'http://bad:1' }),
      json({ rev: 2, upstreamUrl: 'ftp://bad' }),
      json({ rev: 2, upstreamUrl: 'not a url' }),
      json({ rev: 2 }),
      new Response('not json', { status: 200 }),
      cfgAnswer(2, 'http://media:8096'),
    ]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, fetchImpl: be.f, retryMs: 100, refreshMs: 1000, log: () => {} });
    await settle();
    await vi.advanceTimersByTimeAsync(1000); // refresh: fails
    for (let i = 0; i < 7; i++) {
      expect(rc.url()).toBe('http://jf:8096');
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(be.calls).toHaveLength(9);
    expect(rc.url()).toBe('http://media:8096');
    rc.stop();
  });

  it('stop() clears the timers and drops an answer still in flight', async () => {
    let release!: () => void;
    const be = fakeBackend([setupRequired(), () => new Promise<Response>((r) => { release = () => r(cfgAnswer(1, 'http://jf:8096')); })]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, fetchImpl: be.f, log: () => {} });
    await settle();
    rc.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(be.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    const rc2 = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, fetchImpl: be.f, log: () => {} });
    await settle();
    expect(be.calls).toHaveLength(2);
    rc2.stop();
    release();
    await settle();
    expect(rc2.url()).toBeNull();
    rc2.noteRev('5');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(be.calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs only the origin of the upstream, never credentials or the secret', async () => {
    const lines: string[] = [];
    const be = fakeBackend([setupRequired(), json({ error: 'boom' }, 500), cfgAnswer(1, 'http://user:pa55word@jf:8096/base?api_key=k')]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, fetchImpl: be.f, retryMs: 10, log: (m) => lines.push(m) });
    await vi.advanceTimersByTimeAsync(20);
    expect(rc.url()).toBe('http://user:pa55word@jf:8096/base?api_key=k');
    const all = lines.join('\n');
    expect(all).toContain('http://jf:8096');
    expect(all).toContain('503');
    for (const s of ['pa55word', 'user', 'api_key', SECRET]) expect(all).not.toContain(s);
    // an unchanged URL is not logged again
    const n = lines.length;
    rc.noteRev('2');
    await settle();
    expect(lines).toHaveLength(n);
    rc.stop();
  });
});

// fork: credentials besides the URL (Plex: PLEX_TOKEN) come from the same answer, behind the internal secret, and are never logged
describe('createRemoteConfig with keys (gatewayKeys not pinned in env)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const TOKEN = 'plex-remote-token-ABCDEF-123456';
  const plexAnswer = (rev: number, token: string, upstreamUrl = 'http://plex:32400') => json({ rev, upstreamUrl, upstreamAuth: { PLEX_TOKEN: token } });

  it('keeps the token and exposes it by key; url() only once it is there', async () => {
    const be = fakeBackend([setupRequired(), plexAnswer(3, TOKEN)]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, fetchImpl: be.f, retryMs: 100, keys: ['PLEX_TOKEN'], log: () => {} });
    await settle();
    expect([rc.url(), rc.value('PLEX_TOKEN')]).toEqual([null, null]);
    await vi.advanceTimersByTimeAsync(100);
    expect([rc.url(), rc.value('PLEX_TOKEN')]).toEqual(['http://plex:32400', TOKEN]);
    expect(rc.value('OTHER')).toBeNull();
    expect(rc.value('constructor')).toBeNull(); // no prototype keys
    expect(be.calls.every((c) => c.secret === SECRET)).toBe(true);
    rc.stop();
  });

  it('without keys an answer\'s upstreamAuth is ignored (Jellyfin)', async () => {
    const be = fakeBackend([plexAnswer(1, TOKEN)]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, fetchImpl: be.f, log: () => {} });
    await settle();
    expect([rc.url(), rc.value('PLEX_TOKEN')]).toEqual(['http://plex:32400', null]);
    rc.stop();
  });

  it('an answer without (or with an unusable) wanted key is refused: none yet = null, else the last good one stays', async () => {
    const be = fakeBackend([
      cfgAnswer(1, 'http://plex:32400'),
      json({ rev: 1, upstreamUrl: 'http://plex:32400', upstreamAuth: [TOKEN] }),
      json({ rev: 1, upstreamUrl: 'http://plex:32400', upstreamAuth: { PLEX_TOKEN: '' } }),
      plexAnswer(2, TOKEN),
      json({ rev: 3, upstreamUrl: 'http://plex:32400', upstreamAuth: { PLEX_TOKEN: 'a\r\nInjected: header' } }),
      json({ rev: 3, upstreamUrl: 'http://plex:32400', upstreamAuth: { PLEX_TOKEN: 'x'.repeat(4097) } }),
      json({ rev: 3, upstreamUrl: 'http://plex:32400', upstreamAuth: { PLEX_TOKEN: 7 } }),
      json({ rev: 3, upstreamUrl: 'http://plex:32400', upstreamAuth: null }),
      json({ rev: 3, upstreamUrl: 'http://plex:32400', upstreamAuth: { PLEX_TOKEN: 'two words' } }),
      plexAnswer(4, 'rotated-token'),
    ]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, fetchImpl: be.f, retryMs: 100, refreshMs: 100, keys: ['PLEX_TOKEN'], log: () => {} });
    await settle();
    for (let i = 0; i < 2; i++) {
      expect([rc.url(), rc.value('PLEX_TOKEN')]).toEqual([null, null]);
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 6; i++) {
      expect([rc.url(), rc.value('PLEX_TOKEN')]).toEqual(['http://plex:32400', TOKEN]);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(rc.value('PLEX_TOKEN')).toBe('rotated-token');
    expect(be.calls).toHaveLength(10);
    rc.stop();
  });

  it('a new rev from an authz answer refetches at once and takes over a rotated token', async () => {
    const be = fakeBackend([plexAnswer(6, TOKEN), plexAnswer(7, 'rotated-token')]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, fetchImpl: be.f, keys: ['PLEX_TOKEN'], log: () => {} });
    await settle();
    expect(rc.value('PLEX_TOKEN')).toBe(TOKEN);
    rc.noteRev('7');
    await settle();
    expect(rc.value('PLEX_TOKEN')).toBe('rotated-token');
    rc.stop();
  });

  it('envUrl set with keys: the backend is asked for the keys only; url() is the env URL once they are there', async () => {
    const be = fakeBackend([setupRequired(), plexAnswer(2, TOKEN, 'http://other:32400')]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, envUrl: 'http://plex-env:32400', fetchImpl: be.f, retryMs: 100, keys: ['PLEX_TOKEN'], log: () => {} });
    await settle();
    expect(be.calls).toHaveLength(1);
    expect(rc.url()).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect([rc.url(), rc.value('PLEX_TOKEN')]).toEqual(['http://plex-env:32400', TOKEN]);
    rc.stop();
  });

  it('envUrl set with keys: a backend URL with another origin is logged once (pin both or neither), without the token', async () => {
    const lines: string[] = [];
    const be = fakeBackend([plexAnswer(2, TOKEN, 'http://other:32400/x'), plexAnswer(3, 'rotated-token', 'http://other:32400')]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, envUrl: 'http://plex-env:32400', fetchImpl: be.f, refreshMs: 100, keys: ['PLEX_TOKEN'], log: (m) => lines.push(m) });
    await vi.advanceTimersByTimeAsync(100);
    expect(be.calls).toHaveLength(2);
    const differ = lines.filter((l) => l.includes('pin both or neither'));
    expect(differ).toEqual(["gateway upstream: the environment's URL (http://plex-env:32400) differs from the backend's (http://other:32400); pin both or neither"]);
    expect(lines.join('\n')).not.toContain(TOKEN);
    rc.stop();
  });

  it('envUrl set with keys: an answer without a usable upstreamUrl still carries the keys', async () => {
    const be = fakeBackend([json({ rev: 2, upstreamUrl: 'not a url', upstreamAuth: { PLEX_TOKEN: TOKEN } })]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, envUrl: 'http://plex-env:32400', fetchImpl: be.f, keys: ['PLEX_TOKEN'], log: () => {} });
    await settle();
    expect([rc.url(), rc.value('PLEX_TOKEN')]).toEqual(['http://plex-env:32400', TOKEN]);
    rc.stop();
  });

  it('never logs the token: not on receipt, rotation, refusal, a broken body or a thrown error', async () => {
    const lines: string[] = [];
    const be = fakeBackend([
      json({ error: `boom ${TOKEN}` }, 500),
      () => Promise.reject(new Error(`fetch failed ${TOKEN}`)),
      new Response(`not json ${TOKEN}`, { status: 200 }),
      json({ rev: 1, upstreamUrl: 'http://plex:32400', upstreamAuth: { PLEX_TOKEN: `${TOKEN} bad` } }),
      plexAnswer(1, TOKEN),
      plexAnswer(2, 'rotated-token-ZYX'),
      json({ error: 'forbidden' }, 403),
      plexAnswer(2, 'rotated-token-ZYX'),
    ]);
    const rc = createRemoteConfig({ backendUrl: BACKEND, internalSecret: SECRET, fetchImpl: be.f, retryMs: 10, refreshMs: 10, keys: ['PLEX_TOKEN'], log: (m) => lines.push(m) });
    await vi.advanceTimersByTimeAsync(100);
    expect(rc.value('PLEX_TOKEN')).toBe('rotated-token-ZYX');
    const all = lines.join('\n');
    expect(all).toContain('PLEX_TOKEN received');
    expect(all).toContain('PLEX_TOKEN updated');
    expect(all).toContain('HTTP 500');
    expect(all).toContain('keeping the last upstream');
    for (const s of [TOKEN, 'rotated-token-ZYX', SECRET]) expect(all).not.toContain(s);
    expect(lines.filter((l) => l.includes('credentials'))).toHaveLength(2); // an unchanged token is not announced again
    rc.stop();
  });
});

describe('gateway with a remote upstream', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });
  async function start(upstreamUrl: () => string | null, onConfigRev?: (rev: string | null) => void, calls: string[] = []) {
    const f = (async (input: RequestInfo | URL) => {
      const u = new URL(String(input));
      calls.push(u.origin + u.pathname);
      if (u.pathname === '/internal/authz') return json({ userId: 'u1', token: 'JF', deviceId: 'ff-u1', maxBitrate: 5_000_000 }, 200, { 'x-ff-config-rev': '42' });
      return new Response('img', { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }) as typeof fetch;
    const g = createGateway({ upstreamUrl, backendUrl: BACKEND, internalSecret: SECRET, fetchImpl: f, onConfigRev });
    servers.push(g.server);
    await new Promise<void>((r) => g.server.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(g.server.address() as AddressInfo).port}`;
  }
  const IMG = `/media/Items/${'a'.repeat(32)}/Images/Primary`;
  const get = (base: string, path: string) => fetch(`${base}${path}`, { headers: { cookie: `ff_sid=${'s'.repeat(30)}` } });

  it('url() null → /media/x answers 503, /health 200', async () => {
    const calls: string[] = [];
    const base = await start(() => null, undefined, calls);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    for (const p of ['/media/x', IMG, `/media/c/${'A'.repeat(43)}${IMG.slice(6)}`, '/media/d/11111111-1111-4111-8111-111111111111']) {
      const r = await get(base, p);
      expect([p, r.status, r.headers.get('retry-after')]).toEqual([p, 503, '5']);
    }
    expect(calls).toEqual([]); // not even the backend is asked
  });

  it('a cast request without an upstream: the 503 carries the CORS headers and counts as a cast request', async () => {
    const base = await start(() => null);
    const r = await fetch(`${base}/media/c/${'A'.repeat(43)}${IMG.slice(6)}`);
    expect([r.status, r.headers.get('access-control-allow-origin'), r.headers.get('cache-control')]).toEqual([503, '*', 'no-store']);
    const m = await (await fetch(`${base}/metrics`)).text();
    expect(m).toMatch(/friendflix_gateway_cast_requests_total\{code="503"\} 1/);
    expect(m).not.toMatch(/friendflix_gateway_requests_total\{code="503"\}/);
    expect((await get(base, IMG)).headers.get('access-control-allow-origin')).toBeNull(); // the cookie path stays same-origin
  });

  it('an upstream that goes away between the check and the forward: 503, counted', async () => {
    let n = 0;
    const base = await start(() => (n++ === 0 ? 'http://jf-a:8096' : null));
    expect((await get(base, IMG)).status).toBe(503);
    expect(await (await fetch(`${base}/metrics`)).text()).toMatch(/friendflix_gateway_requests_total\{code="503"\} 1/);
  });

  it('an invalid URL from the getter answers 503 too', async () => {
    const base = await start(() => 'not a url');
    expect((await get(base, IMG)).status).toBe(503);
  });

  it('follows the getter and reports the authz rev', async () => {
    let up = 'http://jf-a:8096';
    const revs: Array<string | null> = [];
    const calls: string[] = [];
    const base = await start(() => up, (r) => revs.push(r), calls);
    expect((await get(base, IMG)).status).toBe(200);
    up = 'http://jf-b:8096';
    expect((await get(base, `${IMG}?tag=x`)).status).toBe(200);
    expect(calls.filter((c) => !c.includes('/internal/'))).toEqual([`http://jf-a:8096${IMG.slice(6)}`, `http://jf-b:8096${IMG.slice(6)}`]);
    expect(revs).toEqual(['42']); // second request hit the authz memo
  });

  it('a static upstreamUrl must still be a URL', () => {
    expect(() => createGateway({ upstreamUrl: '', backendUrl: BACKEND, internalSecret: SECRET })).toThrow('gateway: upstreamUrl missing');
  });
});
