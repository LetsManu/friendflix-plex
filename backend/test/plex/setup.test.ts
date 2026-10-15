// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEDIA_SETUP } from '../../src/media/setup.js';
import { plexSetup } from '../../src/plex/setup.js';
import { probeBlocks } from '../../src/settings/probes.js';
import { PLEX_TOKEN, PlexFake } from '../plexfake.js';

// FriendFlix for Plex (Block 25 port, Task 3): MEDIA_SETUP.plex, the manual setup step and its probe.
const URL_ = 'http://plex.example.com:32400';
const SHARED = 'plex-shared-account-token-placeholder'; // a test placeholder, never a real token
const values = (token: string | undefined = PLEX_TOKEN, url: string | undefined = URL_) => ({ PLEX_URL: url, PLEX_TOKEN: token });

interface Seen { url: string; init: RequestInit }
/** the fake behind a recording fetch; `answer` may replace the fake's answer for a path */
function world(answer?: (path: string) => Response | undefined) {
  const fake = new PlexFake();
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push({ url, init });
    return answer?.(new URL(url).pathname) ?? fake.fetch(input, init);
  }) as typeof fetch;
  return { fake, seen, fetchImpl, paths: () => seen.map((s) => new URL(s.url).pathname) };
}
const tokenOf = (s: Seen) => (s.init.headers as Record<string, string>)['X-Plex-Token'];

describe('plexSetup provider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is MEDIA_SETUP.plex: PLEX_URL and PLEX_TOKEN, the URL key PLEX_URL, no automation', () => {
    expect(MEDIA_SETUP.plex).toBe(plexSetup);
    expect(plexSetup.kind).toBe('plex');
    expect(plexSetup.keys).toEqual(['PLEX_URL', 'PLEX_TOKEN']);
    expect(plexSetup.urlKey).toBe('PLEX_URL');
    expect(plexSetup.auto).toBeUndefined();
  });

  it('ok: /identity without the token, then /library/sections and /status/sessions with the token in the header only', async () => {
    const w = world();
    expect(await plexSetup.probe(values(), { fetchImpl: w.fetchImpl })).toEqual({ ok: true, code: 'ok' });
    expect(w.paths()).toEqual(['/identity', '/library/sections', '/status/sessions']);
    expect(w.seen.map(tokenOf)).toEqual([undefined, PLEX_TOKEN, PLEX_TOKEN]);
    for (const s of w.seen) {
      expect(new URL(s.url).host).toBe('plex.example.com:32400');
      expect(new URL(s.url).search).toBe('');
      expect(s.init).toMatchObject({ redirect: 'manual' });
      expect(s.init.signal).toBeInstanceOf(AbortSignal);
      expect((s.init.headers as Record<string, string>).Accept).toBe('application/json');
    }
  });

  it('keeps a reverse-proxy path prefix', async () => {
    const fake = new PlexFake();
    const paths: string[] = [];
    const f = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(i));
      paths.push(u.pathname);
      return u.pathname.startsWith('/plex/') ? fake.fetch(new URL(u.pathname.slice(5), u.origin), init) : new Response(null, { status: 404 });
    }) as typeof fetch;
    expect(await plexSetup.probe(values(PLEX_TOKEN, `${URL_}/plex/`), { fetchImpl: f })).toEqual({ ok: true, code: 'ok' });
    expect(paths).toEqual(['/plex/identity', '/plex/library/sections', '/plex/status/sessions']);
  });

  it('a wrong token: unauthorized (a hard failure), /status/sessions is not asked', async () => {
    const w = world();
    const r = await plexSetup.probe(values('wrong-token-placeholder'), { fetchImpl: w.fetchImpl });
    expect(r).toEqual({ ok: false, code: 'unauthorized' });
    expect(probeBlocks(r, true)).toBe(true);
    expect(w.paths()).toEqual(['/identity', '/library/sections']);
    // 403 on the libraries is a refusal as well
    const f = world((p) => (p === '/library/sections' ? new Response(null, { status: 403 }) : undefined));
    expect(await plexSetup.probe(values(), { fetchImpl: f.fetchImpl })).toEqual({ ok: false, code: 'unauthorized' });
  });

  it.each([401, 403] as const)('a shared (non-admin) token whose /status/sessions answers %i: a warning (not_admin), the save goes through', async (status) => {
    const w = world();
    w.fake.sharedTokens.set(SHARED, status);
    const r = await plexSetup.probe(values(SHARED), { fetchImpl: w.fetchImpl });
    expect(r).toEqual({ ok: true, code: 'warning', detail: 'not_admin' });
    expect(probeBlocks(r, false)).toBe(false);
    expect(w.paths()).toEqual(['/identity', '/library/sections', '/status/sessions']);
  });

  it('unreachable / timeout: a network error or a deadline is a code, never the error text', async () => {
    const boom = (e: Error) => (async () => { throw e; }) as unknown as typeof fetch;
    const leaky = new TypeError(`fetch failed for ${URL_}/library/sections?X-Plex-Token=${PLEX_TOKEN}`);
    expect(await plexSetup.probe(values(), { fetchImpl: boom(leaky) })).toEqual({ ok: false, code: 'unreachable' });
    const slow = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    expect(await plexSetup.probe(values(), { fetchImpl: boom(slow) })).toEqual({ ok: false, code: 'timeout' });
    // an upstream error on any step
    for (const path of ['/identity', '/library/sections', '/status/sessions']) {
      const w = world((p) => (p === path ? new Response('oops', { status: 502 }) : undefined));
      expect(await plexSetup.probe(values(), { fetchImpl: w.fetchImpl }), path).toEqual({ ok: false, code: 'unreachable', detail: 'upstream_error' });
    }
  });

  it('a redirect is refused on every step and never followed (the token stays with the typed host)', async () => {
    for (const path of ['/identity', '/library/sections', '/status/sessions']) {
      const w = world((p) => (p === path ? new Response(null, { status: 302, headers: { location: 'http://elsewhere.example.com/identity' } }) : undefined));
      const r = await plexSetup.probe(values(), { fetchImpl: w.fetchImpl });
      expect(r, path).toEqual({ ok: false, code: 'invalid', detail: 'redirect' });
      expect(probeBlocks(r, true)).toBe(true);
      expect(w.seen.every((s) => new URL(s.url).host === 'plex.example.com:32400')).toBe(true);
      expect(w.paths().at(-1)).toBe(path);
    }
  });

  it('not a Plex server: /identity 404 -> invalid not_found; another body -> invalid bad_response; the token is never sent', async () => {
    const nf = world((p) => (p === '/identity' ? new Response(null, { status: 404 }) : undefined));
    expect(await plexSetup.probe(values(), { fetchImpl: nf.fetchImpl })).toEqual({ ok: false, code: 'invalid', detail: 'not_found' });
    for (const body of ['<html>hello</html>', JSON.stringify({ MediaContainer: { size: 0 } }), JSON.stringify([1]), 'x'.repeat(10_000)]) {
      const w = world((p) => (p === '/identity' ? new Response(body, { status: 200 }) : undefined));
      expect(await plexSetup.probe(values(), { fetchImpl: w.fetchImpl })).toEqual({ ok: false, code: 'invalid', detail: 'bad_response' });
      expect(w.paths()).toEqual(['/identity']);
      expect(w.seen.map(tokenOf)).toEqual([undefined]);
    }
  });

  it('incomplete or invalid input: no request', async () => {
    const w = world();
    expect(await plexSetup.probe(values(''), { fetchImpl: w.fetchImpl })).toEqual({ ok: false, code: 'invalid', detail: 'incomplete' });
    expect(await plexSetup.probe({ PLEX_URL: undefined, PLEX_TOKEN }, { fetchImpl: w.fetchImpl })).toEqual({ ok: false, code: 'invalid', detail: 'incomplete' });
    for (const url of ['ftp://plex.example.com', 'not a url', 'http://user:pw@plex.example.com:32400']) {
      expect(await plexSetup.probe(values(PLEX_TOKEN, url), { fetchImpl: w.fetchImpl }), url).toEqual({ ok: false, code: 'invalid', detail: 'invalid_url' });
    }
    expect(w.seen).toEqual([]);
  });

  it('fork: a URL with a query (a pasted ?X-Plex-Token=…), a fragment or userinfo is invalid_url: no request, nothing of it echoed', async () => {
    const w = world();
    const canary = 'url-token-canary-placeholder'; // a test placeholder, never a real token
    for (const url of [`${URL_}/?X-Plex-Token=${canary}`, `${URL_}/library/sections?x-plex-token=${canary}`, `${URL_}/#${canary}`, `${URL_}/?`,
      `http://user:${canary}@plex.example.com:32400`]) {
      const r = await plexSetup.probe(values(PLEX_TOKEN, url), { fetchImpl: w.fetchImpl });
      expect(r, url).toEqual({ ok: false, code: 'invalid', detail: 'invalid_url' });
      expect(JSON.stringify(r)).not.toContain(canary);
    }
    expect(w.seen).toEqual([]);
  });

  it('the token is never in a URL, a query, a result or a console line, whatever happens', async () => {
    const lines: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    const results: unknown[] = [];
    const urls: string[] = [];
    const scenarios: Array<(p: string) => Response | undefined> = [
      () => undefined,
      (p) => (p === '/status/sessions' ? new Response(null, { status: 301, headers: { location: `/x?X-Plex-Token=${PLEX_TOKEN}` } }) : undefined),
      (p) => (p === '/library/sections' ? new Response(`bad token ${PLEX_TOKEN}`, { status: 500 }) : undefined),
      (p) => { if (p === '/status/sessions') throw new Error(`socket hang up X-Plex-Token=${PLEX_TOKEN}`); return undefined; },
    ];
    for (const s of scenarios) {
      const w = world(s);
      results.push(await plexSetup.probe(values(), { fetchImpl: w.fetchImpl }));
      urls.push(...w.seen.map((x) => x.url));
    }
    const shared = world();
    shared.fake.sharedTokens.set(SHARED, 403);
    results.push(await plexSetup.probe(values(SHARED), { fetchImpl: shared.fetchImpl }));
    urls.push(...shared.seen.map((x) => x.url));
    expect(urls.length).toBeGreaterThan(10);
    for (const u of urls) {
      expect(u).not.toContain(PLEX_TOKEN);
      expect(u).not.toContain(SHARED);
      expect(u.toLowerCase()).not.toContain('token');
    }
    const out = JSON.stringify(results) + lines.join('\n');
    expect(out).not.toContain(PLEX_TOKEN);
    expect(out).not.toContain(SHARED);
    expect(out).not.toContain('X-Plex-Token');
  });
});
