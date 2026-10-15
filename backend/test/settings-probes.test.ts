// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { Ctx } from '../src/ctx.js';
import { MemoryKV } from '../src/kv.js';
import { OMDB_COUNT_KEY, OMDB_DAILY_BUDGET } from '../src/sources/keys.js';
import { probeBlocks, probeConfigured, runProbe } from '../src/settings/probes.js';
import { cfg, fakeHttp, type Call, type Handler } from './helpers.js';

/** a probe context over a fake HTTP world; `inits` records what each call was sent with (headers, redirect) */
function world(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const inits: RequestInit[] = [];
  const inner = fakeHttp(routes, calls);
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    inits.push(init);
    return inner(input, init);
  }) as typeof fetch;
  const kv = new MemoryKV();
  const ctx = { fetchImpl, kv, cfg } as unknown as Ctx;
  return { ctx, calls, inits, kv };
}
const throwing = (err: unknown) => ({ fetchImpl: (async () => { throw err; }) as typeof fetch, kv: new MemoryKV(), cfg } as unknown as Ctx);
const withCfg = (patch: Partial<Config>): Config => ({ ...cfg, ...patch });

describe('settings probes', () => {
  it('oidc: discovery issuer must match OIDC_ISSUER exactly', async () => {
    const issuer = 'https://auth.example.com/application/o/friendflix/';
    const w = world({ 'GET /application/o/friendflix/.well-known/openid-configuration': () => ({ json: { issuer: 'https://auth.example.com/application/o/other/' } }) });
    expect(await runProbe(w.ctx, 'oidc', withCfg({ OIDC_ISSUER: issuer }))).toEqual({ ok: false, code: 'issuer_mismatch' });
    const ok = world({ 'GET /application/o/friendflix/.well-known/openid-configuration': () => ({ json: { issuer } }) });
    expect(await runProbe(ok.ctx, 'oidc', withCfg({ OIDC_ISSUER: issuer }))).toEqual({ ok: true, code: 'ok' });
    // an issuer without trailing slash gets /.well-known appended
    const bare = world({ 'GET /realm/.well-known/openid-configuration': () => ({ json: { issuer: 'https://auth.example.com/realm' } }) });
    expect(await runProbe(bare.ctx, 'oidc', withCfg({ OIDC_ISSUER: 'https://auth.example.com/realm' }))).toEqual({ ok: true, code: 'ok' });
  });

  it('oidc: 404, a non-JSON answer, an http issuer and a missing client are refused', async () => {
    const w = world({});
    expect(await runProbe(w.ctx, 'oidc', cfg)).toEqual({ ok: false, code: 'invalid', detail: 'not_found' });
    const html = world({ 'GET /.well-known/openid-configuration': () => ({ raw: '<html>' }) });
    expect(await runProbe(html.ctx, 'oidc', cfg)).toEqual({ ok: false, code: 'invalid', detail: 'bad_response' });
    expect(await runProbe(w.ctx, 'oidc', withCfg({ OIDC_ISSUER: 'http://auth.example.com/' }))).toEqual({ ok: false, code: 'invalid', detail: 'insecure_issuer' });
    expect(await runProbe(w.ctx, 'oidc', withCfg({ OIDC_CLIENT_SECRET: '' }))).toEqual({ ok: false, code: 'invalid', detail: 'incomplete' });
    expect(await runProbe(w.ctx, 'oidc', withCfg({ OIDC_ISSUER: '' }))).toEqual({ ok: false, code: 'invalid', detail: 'not_set' });
    expect(w.calls).toHaveLength(1);
  });

  it('authentik: the candidate token is sent; 401 -> unauthorized; a missing enrollment flow -> invalid', async () => {
    const ak = withCfg({ AUTHENTIK_URL: 'https://auth.example.com/', AUTHENTIK_API_TOKEN: 'candidate-token', AUTHENTIK_ENROLL_FLOW: 'friendflix-enrollment' });
    const denied = world({ 'GET /api/v3/core/users/me/': () => ({ status: 401, json: { detail: 'Token invalid/expired' } }) });
    expect(await runProbe(denied.ctx, 'authentik', ak)).toEqual({ ok: false, code: 'unauthorized' });
    expect(denied.calls[0]).toMatchObject({ host: 'auth.example.com', auth: 'Bearer candidate-token' });

    const noFlow = world({ 'GET /api/v3/core/users/me/': () => ({ json: { user: { pk: 1 } } }) });
    expect(await runProbe(noFlow.ctx, 'authentik', ak)).toEqual({ ok: false, code: 'invalid', detail: 'enroll_flow_missing' });
    expect(noFlow.calls.map((c) => c.path)).toEqual(['/api/v3/core/users/me/', '/api/v3/flows/instances/friendflix-enrollment/']);

    const ok = world({ 'GET /api/v3/core/users/me/': () => ({ json: {} }), 'GET /api/v3/flows/instances/[^/]+/': () => ({ json: {} }) });
    expect(await runProbe(ok.ctx, 'authentik', ak)).toEqual({ ok: true, code: 'ok' });
    // no enrollment flow set: only the token is checked
    expect(await runProbe(ok.ctx, 'authentik', { ...ak, AUTHENTIK_ENROLL_FLOW: undefined })).toEqual({ ok: true, code: 'ok' });
    expect(await runProbe(ok.ctx, 'authentik', { ...ak, AUTHENTIK_API_TOKEN: undefined })).toEqual({ ok: false, code: 'invalid', detail: 'incomplete' });
  });

  it('media: GET /Auth/Keys with the key; 401/403 -> not_admin, 200 -> ok', async () => {
    for (const status of [401, 403]) {
      const w = world({ 'GET /Auth/Keys': () => ({ status }) });
      expect(await runProbe(w.ctx, 'media', cfg)).toEqual({ ok: false, code: 'not_admin' });
    }
    const w = world({ 'GET (/jellyfin)?/Auth/Keys': () => ({ json: { Items: [] } }) });
    expect(await runProbe(w.ctx, 'media', withCfg({ JELLYFIN_URL: 'http://jf.local:8096/jellyfin/' }))).toEqual({ ok: true, code: 'ok' });
    expect(w.calls[0]).toMatchObject({ host: 'jf.local:8096', path: '/jellyfin/Auth/Keys' });
    expect(w.calls[0]!.auth).toContain('Token="adminkey"');
    const server = world({ 'GET /Auth/Keys': () => ({ status: 502 }) });
    expect(await runProbe(server.ctx, 'media', cfg)).toEqual({ ok: false, code: 'unreachable', detail: 'upstream_error' });
  });

  it('credentialed probes never follow a redirect', async () => {
    const w = world({ 'GET /Auth/Keys': () => ({ status: 302 }) });
    expect(await runProbe(w.ctx, 'media', cfg)).toEqual({ ok: false, code: 'invalid', detail: 'redirect' });
    expect(w.inits[0]!.redirect).toBe('manual');
  });

  it('unreachable host and timeout are codes only (never the error text)', async () => {
    const err = new TypeError('fetch failed: http://jellyfin:8096/Auth/Keys?api_key=adminkey');
    expect(await runProbe(throwing(err), 'media', cfg)).toEqual({ ok: false, code: 'unreachable' });
    expect(await runProbe(throwing(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'media', cfg)).toEqual({ ok: false, code: 'timeout' });
    // a hanging server: the probe gives up after timeoutMs
    const hang = { fetchImpl: (() => new Promise(() => {})) as unknown as typeof fetch, kv: new MemoryKV(), cfg } as unknown as Ctx;
    const t0 = Date.now();
    expect(await runProbe(hang, 'authentik', withCfg({ AUTHENTIK_URL: 'https://auth.example.com', AUTHENTIK_API_TOKEN: 't' }), { timeoutMs: 30 })).toEqual({ ok: false, code: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await runProbe(throwing(err), 'media', withCfg({ JELLYFIN_URL: 'not a url' }))).toEqual({ ok: false, code: 'invalid', detail: 'invalid_url' });
  });

  it('requests: the request-count call with the candidate key', async () => {
    const denied = world({ 'GET /api/v1/request/count': () => ({ status: 403 }) });
    expect(await runProbe(denied.ctx, 'requests', cfg)).toEqual({ ok: false, code: 'unauthorized' });
    const ok = world({ 'GET /api/v1/request/count': (_u, init) => ((init.headers as Record<string, string>)['X-Api-Key'] === 'seerrkey' ? { json: { total: 0 } } : { status: 401 }) });
    expect(await runProbe(ok.ctx, 'requests', cfg)).toEqual({ ok: true, code: 'ok' });
    expect(await runProbe(ok.ctx, 'requests', withCfg({ REQUESTS_API_KEY: 'other' }))).toEqual({ ok: false, code: 'unauthorized' });
    expect(await runProbe(ok.ctx, 'requests', withCfg({ REQUESTS_API_KEY: '' }))).toEqual({ ok: false, code: 'invalid', detail: 'incomplete' });
    const missing = world({});
    expect(await runProbe(missing.ctx, 'requests', cfg)).toEqual({ ok: false, code: 'invalid', detail: 'not_found' });
    expect(await runProbe(throwing(new TypeError('x')), 'requests', cfg)).toEqual({ ok: false, code: 'unreachable' });
  });

  it('tmdb / omdb: the source test functions', async () => {
    const tmdb = withCfg({ TMDB_API_KEY: 'tmdbkey-12345678' });
    expect(await runProbe(world({ 'GET /3/configuration': () => ({ status: 401 }) }).ctx, 'tmdb', tmdb)).toEqual({ ok: false, code: 'unauthorized' });
    expect(await runProbe(world({ 'GET /3/configuration': () => ({ json: {} }) }).ctx, 'tmdb', tmdb)).toEqual({ ok: true, code: 'ok' });
    expect(await runProbe(throwing(new TypeError('x')), 'tmdb', tmdb)).toEqual({ ok: false, code: 'unreachable' });
    const omdb = withCfg({ OMDB_API_KEY: 'omdbkey-12345678' });
    expect(await runProbe(world({ 'GET /': () => ({ json: { Response: 'False', Error: 'Invalid API key!' } }) }).ctx, 'omdb', omdb)).toEqual({ ok: false, code: 'unauthorized' });
    const w = world({ 'GET /': () => ({ json: { Response: 'True' } }) });
    expect(await runProbe(w.ctx, 'omdb', omdb)).toEqual({ ok: true, code: 'ok' });
    // the daily budget is used up: cannot test, a warning that does not block
    await w.kv.set(OMDB_COUNT_KEY(new Date().toISOString().slice(0, 10)), String(OMDB_DAILY_BUDGET), 60);
    expect(await runProbe(w.ctx, 'omdb', omdb)).toEqual({ ok: true, code: 'warning', detail: 'budget' });
  });

  it('portainer: API mode reads the stack; webhook mode is only checked for its form', async () => {
    const api = withCfg({ PORTAINER_URL: 'https://portainer.example.com', PORTAINER_API_KEY: 'ptr_key', PORTAINER_STACK_ID: '7' });
    const w = world({ 'GET /api/stacks/7': (_u, init) => ((init.headers as Record<string, string>)['x-api-key'] === 'ptr_key' ? { json: { Id: 7 } } : { status: 401 }) });
    expect(await runProbe(w.ctx, 'portainer', api)).toEqual({ ok: true, code: 'ok' });
    expect(await runProbe(w.ctx, 'portainer', { ...api, PORTAINER_API_KEY: 'wrong' })).toEqual({ ok: false, code: 'unauthorized' });
    expect(await runProbe(w.ctx, 'portainer', { ...api, PORTAINER_STACK_ID: '8' })).toEqual({ ok: false, code: 'invalid', detail: 'not_found' });
    expect(await runProbe(w.ctx, 'portainer', { ...api, PORTAINER_STACK_ID: undefined })).toEqual({ ok: false, code: 'invalid', detail: 'incomplete' });
    const calls = w.calls.length;
    expect(await runProbe(w.ctx, 'portainer', withCfg({ PORTAINER_WEBHOOK_URL: 'https://portainer.example.com/api/stacks/webhooks/abc' }))).toEqual({ ok: true, code: 'ok' });
    expect(await runProbe(w.ctx, 'portainer', withCfg({ PORTAINER_WEBHOOK_URL: 'ftp://x' }))).toEqual({ ok: false, code: 'invalid', detail: 'invalid_url' });
    expect(w.calls.length).toBe(calls); // the webhook is never called (it would start an update)
  });

  it('github: the token must be accepted for the update repository', async () => {
    const gh = withCfg({ GITHUB_TOKEN: 'ghp_x' });
    const w = world({ 'GET /repos/LetsManu/friendflix': (_u, init) => ((init.headers as Record<string, string>).authorization === 'Bearer ghp_x' ? { json: {} } : { status: 401 }) });
    expect(await runProbe(w.ctx, 'github', gh)).toEqual({ ok: true, code: 'ok' });
    expect(w.calls[0]!.host).toBe('api.github.com');
    expect(await runProbe(w.ctx, 'github', withCfg({ GITHUB_TOKEN: 'bad' }))).toEqual({ ok: false, code: 'unauthorized' });
    expect(await runProbe(world({ 'GET /repos/.*': () => ({ status: 403 }) }).ctx, 'github', gh)).toEqual({ ok: false, code: 'unreachable', detail: 'rate_limited' });
  });

  it('publicUrl: the stored answer for the nonce -> ok; anything else is a warning, never a failure; no redirect is followed', async () => {
    const kv = new MemoryKV();
    const inits: RequestInit[] = [];
    const urls: URL[] = [];
    const echo = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const u = new URL(String(input));
      urls.push(u);
      inits.push(init);
      return Response.json({ answer: await kv.get(`setup:echo:${u.pathname.split('/').pop()}`) });
    }) as typeof fetch;
    const ctx = { fetchImpl: echo, kv, cfg } as unknown as Ctx;
    expect(await runProbe(ctx, 'publicUrl', cfg)).toEqual({ ok: true, code: 'ok' });
    expect(urls[0]!.origin).toBe('https://portal.example.com');
    expect(urls[0]!.pathname).toMatch(/^\/api\/setup\/echo\/[A-Za-z0-9_-]{43}$/);
    expect(inits[0]!.redirect).toBe('manual');
    expect(await kv.keys('setup:echo:')).toEqual([]); // used once
    expect(await runProbe(ctx, 'publicUrl', withCfg({ PUBLIC_URL: 'http://portal.example.com' }))).toEqual({ ok: true, code: 'warning', detail: 'insecure' });
    // a reflector (answers with the nonce itself) does not pass: only the stored random answer does
    const reflect = world({ 'GET /api/setup/echo/.*': (u) => ({ json: { answer: u.pathname.split('/').pop() } }) });
    expect(await runProbe(reflect.ctx, 'publicUrl', cfg)).toEqual({ ok: true, code: 'warning', detail: 'echo_mismatch' });
    expect(await runProbe(world({}).ctx, 'publicUrl', cfg)).toEqual({ ok: true, code: 'warning', detail: 'echo_mismatch' });
    const big = world({ 'GET /api/setup/echo/.*': () => ({ raw: 'x'.repeat(10_000) }) });
    expect(await runProbe(big.ctx, 'publicUrl', cfg)).toEqual({ ok: true, code: 'warning', detail: 'echo_mismatch' });
    const html = world({ 'GET /api/setup/echo/.*': () => ({ raw: '<html>' }) });
    expect(await runProbe(html.ctx, 'publicUrl', cfg)).toEqual({ ok: true, code: 'warning', detail: 'echo_mismatch' });
    expect(await runProbe(throwing(new TypeError('fetch failed')), 'publicUrl', cfg)).toEqual({ ok: true, code: 'warning', detail: 'unreachable' });
    expect(await runProbe(throwing(Object.assign(new Error('t'), { name: 'TimeoutError' })), 'publicUrl', cfg)).toEqual({ ok: true, code: 'warning', detail: 'timeout' });
  });

  it('probeConfigured and probeBlocks', () => {
    expect(probeConfigured('authentik', cfg)).toBe(false);
    expect(probeConfigured('media', cfg)).toBe(true);
    expect(probeConfigured('tmdb', cfg)).toBe(false);
    expect(probeConfigured('portainer', withCfg({ PORTAINER_WEBHOOK_URL: 'https://x' }))).toBe(true);
    for (const code of ['unauthorized', 'invalid', 'not_admin', 'issuer_mismatch', 'wizard_pending'] as const) {
      expect(probeBlocks({ ok: false, code }, true)).toBe(true);
    }
    expect(probeBlocks({ ok: false, code: 'timeout' }, false)).toBe(true);
    expect(probeBlocks({ ok: false, code: 'unreachable' }, true)).toBe(false);
    expect(probeBlocks({ ok: true, code: 'warning' }, false)).toBe(false);
    expect(probeBlocks({ ok: true, code: 'ok' }, false)).toBe(false);
  });
});
