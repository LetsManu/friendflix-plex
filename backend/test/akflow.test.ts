// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  absorbCookies, akExec, akGet, appHost, continueJar, createJar, dropJar, endAkSession, flowSlug, FORWARD_HOST_KINDS, JAR_TTL_S,
  type Jar, loadJar, loginUi, passkeysInApp, passkeysStatus, probeForwardedHost, saveJar,
} from '../src/akflow.js';
import type { Config } from '../src/config.js';
import { encrypt, keyFromBase64, sha256 } from '../src/crypto.js';
import { MemoryKV } from '../src/kv.js';
import { HttpError } from '../src/users.js';
import { AK_URL, type AkCall, fakeAuthentik, fixture } from './akflow-fake.js';
import { cfg as baseCfg, ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

const APP = 'https://friend.example.com';
const ISSUER = 'https://auth.example.com/application/o/friendflix/';
const cfgFor = (patch: Partial<Config> = {}): Config =>
  ({ ...baseCfg, PUBLIC_URL: APP, OIDC_ISSUER: ISSUER, AUTHENTIK_URL: AK_URL, AUTHENTIK_API_TOKEN: 'api-token-placeholder', ...patch });

interface TestCtx { cfg: Config; kv: MemoryKV; encKey: Buffer; fetchImpl: typeof fetch }
const ctxWith = (fetchImpl: typeof fetch, patch: Partial<Config> = {}): TestCtx =>
  ({ cfg: cfgFor(patch), kv: new MemoryKV(), encKey: keyFromBase64(ENC_KEY), fetchImpl });

const jarOf = (patch: Partial<Jar> = {}): Jar =>
  ({ cookies: {}, slug: 'default-authentication-flow', query: '', kind: 'login', createdAt: Date.now(), step: 'st1', challenges: 0, forwardHost: false, ...patch });

/** the discovery document Authentik answers, with the issuer on the forwarded host or on its own */
const discovery = (honour: boolean) => (call: AkCall) =>
  new Response(JSON.stringify({ issuer: honour ? `${call.headers['x-forwarded-proto']}://${call.headers['x-forwarded-host']}/application/o/friendflix/` : ISSUER }),
    { headers: { 'content-type': 'application/json' } });
const DISCOVERY = 'GET /application/o/friendflix/.well-known/openid-configuration';

const identifyThenPassword = () => [
  { challenge: fixture('identification'), answer: (b: { uid_field?: string }) => (b.uid_field ? true as const : fixture('identification')) },
  { challenge: fixture('password'), answer: (b: { password?: string }) => (b.password === 'right' ? true as const : fixture('password-invalid')), hops: 2 },
];

async function codeOf(p: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    return { status: (e as HttpError).statusCode, code: (e as HttpError).message };
  }
  throw new Error('expected an HttpError');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('config helpers', () => {
  it('loginUi: the setting wins, else app exactly when the Authentik API is configured', () => {
    expect(loginUi(cfgFor())).toBe('app');
    expect(loginUi(cfgFor({ AUTHENTIK_API_TOKEN: undefined }))).toBe('authentik');
    expect(loginUi(cfgFor({ AUTHENTIK_URL: undefined }))).toBe('authentik');
    expect(loginUi(cfgFor({ LOGIN_UI: 'authentik' }))).toBe('authentik');
    expect(loginUi(cfgFor({ LOGIN_UI: 'app', AUTHENTIK_URL: undefined }))).toBe('app');
  });

  it('flowSlug maps every kind; the opt keys fall back to the registry defaults; enroll has none without its key', () => {
    const c = cfgFor({ AUTHENTIK_ENROLL_FLOW: 'ff-enroll' });
    expect(flowSlug(c, 'login')).toBe('default-authentication-flow');
    expect(flowSlug(c, 'reauth')).toBe('default-authentication-flow');
    expect(flowSlug(c, 'recovery')).toBe('default-recovery-flow');
    expect(flowSlug(c, 'recovery-resume')).toBe('default-recovery-flow');
    expect(flowSlug(c, 'enroll')).toBe('ff-enroll');
    expect(flowSlug(c, 'setup-totp')).toBe('default-authenticator-totp-setup');
    expect(flowSlug(c, 'setup-static')).toBe('default-authenticator-static-setup');
    expect(flowSlug(c, 'setup-webauthn')).toBe('default-authenticator-webauthn-setup');
    expect(flowSlug(c, 'change-password')).toBe('default-password-change');
    expect(flowSlug(c, 'change-email')).toBe('friendflix-email-change');
    expect(flowSlug(c, 'email-confirm')).toBe('friendflix-email-change');
    expect(flowSlug(cfgFor(), 'enroll')).toBeUndefined();
    const custom = cfgFor({ AUTHENTIK_RECOVERY_FLOW: 'ff-recovery', AUTHENTIK_TOTP_SETUP_FLOW: 'ff-totp', AUTHENTIK_LOGIN_FLOW: 'ff-login', AUTHENTIK_EMAIL_CHANGE_FLOW: 'ff-mail' });
    expect([flowSlug(custom, 'recovery-resume'), flowSlug(custom, 'setup-totp'), flowSlug(custom, 'reauth'), flowSlug(custom, 'email-confirm')])
      .toEqual(['ff-recovery', 'ff-totp', 'ff-login', 'ff-mail']);
    // registry-only defaults: '' (e.g. an override in a test) still yields a slug
    const blank = cfgFor({ AUTHENTIK_LOGIN_FLOW: '', AUTHENTIK_STATIC_SETUP_FLOW: '', AUTHENTIK_WEBAUTHN_SETUP_FLOW: '', AUTHENTIK_PASSWORD_CHANGE_FLOW: '', AUTHENTIK_EMAIL_CHANGE_FLOW: '' });
    expect(['login', 'setup-static', 'setup-webauthn', 'change-password', 'change-email'].map((k) => flowSlug(blank, k as never)))
      .toEqual(['default-authentication-flow', 'default-authenticator-static-setup', 'default-authenticator-webauthn-setup', 'default-password-change', 'friendflix-email-change']);
  });

  it('appHost is the PUBLIC_URL host name, null while it is unset or invalid', () => {
    expect(appHost({ PUBLIC_URL: 'https://friend.example.com:8443/x' })).toBe('friend.example.com');
    expect(appHost({ PUBLIC_URL: '' })).toBeNull();
    expect(appHost({ PUBLIC_URL: 'not a url' })).toBeNull();
  });

  it('FORWARD_HOST_KINDS are exactly the kinds that can meet WebAuthn', () => {
    expect([...FORWARD_HOST_KINDS].sort()).toEqual(['login', 'reauth', 'setup-webauthn']);
  });
});

describe('akExec', () => {
  it('exec GET sends the query double-encoded and stores set-cookie in the jar', async () => {
    const ak = fakeAuthentik(identifyThenPassword());
    const jar = jarOf({ query: 'next=%2F' });
    const { challenge } = await akExec(ctxWith(ak.fetch), jar, 'GET');
    expect(ak.calls[0]!.search).toBe('?query=next%3D%252F');
    expect(ak.calls[0]!.url.origin + ak.calls[0]!.path).toBe(`${AK_URL}/api/v3/flows/executor/default-authentication-flow/`);
    expect(ak.calls[0]!.headers.accept).toBe('application/json');
    expect(ak.calls[0]!.headers.cookie).toBeUndefined();
    expect(jar.cookies.authentik_session).toBe('s1');
    expect(challenge.component).toBe('ak-stage-identification');
    expect(jar.challenges).toBe(1);
  });

  it('POST follows the 302 to self with a GET carrying the new cookie', async () => {
    const ak = fakeAuthentik(identifyThenPassword());
    const jar = jarOf({ query: 'next=%2F' });
    const ctx = ctxWith(ak.fetch);
    ak.calls.length = 0;
    const { challenge, jar: out } = await akExec(ctx, jar, 'POST', { uid_field: 'anna' });
    expect(ak.calls.map((c) => c.method)).toEqual(['POST', 'GET']);
    expect(ak.calls[0]!.body).toEqual({ uid_field: 'anna' });
    expect(ak.calls[0]!.headers['content-type']).toBe('application/json');
    expect(ak.calls[1]!.headers.cookie).toBe('authentik_session=s1');
    expect(ak.calls[1]!.search).toBe('?query=next%3D%252F');
    expect(challenge.component).toBe('ak-stage-password');
    expect(out).toBe(jar);
  });

  it('302 -> 302 -> 200 chain is followed with the jar (2 hops, as recorded)', async () => {
    const ak = fakeAuthentik(identifyThenPassword());
    const ctx = ctxWith(ak.fetch);
    const jar = jarOf({ query: 'next=%2F' });
    await akExec(ctx, jar, 'GET');
    await akExec(ctx, jar, 'POST', { uid_field: 'anna' });
    ak.calls.length = 0;
    const { challenge } = await akExec(ctx, jar, 'POST', { password: 'right' });
    expect(ak.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v3/flows/executor/default-authentication-flow/',
      'GET /api/v3/flows/executor/default-authentication-flow/',
      'GET /api/v3/flows/executor/default-authentication-flow/',
    ]);
    expect(ak.calls.every((c) => c.headers.cookie?.includes('authentik_session=s1'))).toBe(true);
    expect(challenge).toEqual({ component: 'xak-flow-redirect', to: '/', final_redirect: true });
    expect(jar.cookies.authentik_csrf).toBe('c1');
    expect(jar.challenges).toBe(3);
  });

  it('an invalid answer comes back as the same stage with response_errors (no redirect)', async () => {
    const ak = fakeAuthentik(identifyThenPassword());
    const ctx = ctxWith(ak.fetch);
    const jar = jarOf();
    await akExec(ctx, jar, 'POST', { uid_field: 'anna' });
    ak.calls.length = 0;
    const { challenge } = await akExec(ctx, jar, 'POST', { password: 'wrong' });
    expect(ak.calls).toHaveLength(1);
    expect(challenge.response_errors).toEqual({ password: [{ string: 'Invalid password', code: 'invalid' }] });
  });

  it('x-forwarded-for carries the client ip', async () => {
    const ak = fakeAuthentik(identifyThenPassword());
    const ctx = ctxWith(ak.fetch);
    const jar = jarOf();
    await akExec(ctx, jar, 'POST', { uid_field: 'anna' }, '203.0.113.7');
    expect(ak.calls.map((c) => c.headers['x-forwarded-for'])).toEqual(['203.0.113.7', '203.0.113.7']);
    await akExec(ctx, jar, 'GET');
    expect(ak.calls.at(-1)!.headers['x-forwarded-for']).toBeUndefined();
  });

  it('csrf header is sent only when the jar has authentik_csrf, and only on POST', async () => {
    const ak = fakeAuthentik([{ challenge: fixture('prompt-password-change') }]);
    const ctx = ctxWith(ak.fetch);
    const anon = jarOf({ kind: 'change-password', slug: 'default-password-change', cookies: { authentik_session: 's9' } });
    await akExec(ctx, anon, 'POST', { password: 'x', password_repeat: 'x' });
    expect(ak.calls.some((c) => 'x-authentik-csrf' in c.headers || 'origin' in c.headers || 'referer' in c.headers)).toBe(false);

    const ak2 = fakeAuthentik([{ challenge: fixture('prompt-password-change') }]);
    const logged = jarOf({ kind: 'change-password', slug: 'default-password-change', cookies: { authentik_session: 's9', authentik_csrf: 'csrf-placeholder' } });
    await akExec(ctxWith(ak2.fetch), logged, 'GET');
    expect(ak2.calls[0]!.headers['x-authentik-csrf']).toBeUndefined();
    await akExec(ctxWith(ak2.fetch), logged, 'POST', { password: 'x', password_repeat: 'x' });
    const [post, follow] = ak2.calls.slice(1);
    expect(post!.headers['x-authentik-csrf']).toBe('csrf-placeholder');
    expect(follow!.method).toBe('GET');
    expect(follow!.headers['x-authentik-csrf']).toBeUndefined();
  });

  it('logged-in jar without forwardHost sends origin = AUTHENTIK_URL origin; with forwardHost sends origin = PUBLIC_URL origin and x-forwarded-host/proto', async () => {
    const cookies = { authentik_session: 's9', authentik_csrf: 'csrf-placeholder' };
    const ak = fakeAuthentik([{ challenge: fixture('webauthn-setup-unforwarded') }]);
    await akExec(ctxWith(ak.fetch), jarOf({ kind: 'setup-totp', slug: 'default-authenticator-totp-setup', cookies: { ...cookies } }), 'POST', { code: '123456' });
    const plain = ak.calls[0]!.headers;
    expect(plain.origin).toBe(AK_URL);
    expect(plain.referer).toBe(`${AK_URL}/api/v3/flows/executor/default-authenticator-totp-setup/`);
    expect(plain['x-forwarded-host']).toBeUndefined();
    expect(plain['x-forwarded-proto']).toBeUndefined();

    const ak2 = fakeAuthentik([{ challenge: fixture('webauthn-setup') }]);
    const ctx2 = ctxWith(ak2.fetch);
    const jar = jarOf({ kind: 'setup-webauthn', slug: 'default-authenticator-webauthn-setup', cookies: { ...cookies }, forwardHost: true });
    await akExec(ctx2, jar, 'GET');
    await akExec(ctx2, jar, 'POST', { response: {} });
    for (const c of ak2.calls) {
      expect(c.headers['x-forwarded-host']).toBe('friend.example.com');
      expect(c.headers['x-forwarded-proto']).toBe('https');
      expect(c.headers.origin).toBe(APP);
    }
    expect(ak2.calls[1]!.headers.referer).toBe(`${APP}/api/v3/flows/executor/default-authenticator-webauthn-setup/`);
  });

  it('a forwardHost jar on an http localhost PUBLIC_URL forwards its scheme and port (the browser origin)', async () => {
    const ak = fakeAuthentik([{ challenge: fixture('identification') }]);
    await akExec(ctxWith(ak.fetch, { PUBLIC_URL: 'http://localhost:5173' }), jarOf({ forwardHost: true }), 'GET');
    expect(ak.calls[0]!.headers).toMatchObject({ 'x-forwarded-host': 'localhost:5173', 'x-forwarded-proto': 'http', origin: 'http://localhost:5173' });
  });

  it('recovery and enroll jars never send x-forwarded-host, even when passkeys are in-app', async () => {
    const ak = fakeAuthentik([{ challenge: fixture('identification-recovery') }], { [DISCOVERY]: discovery(true) });
    const ctx = ctxWith(ak.fetch, { AUTHENTIK_ENROLL_FLOW: 'ff-enroll' });
    expect(await passkeysInApp(ctx)).toBe(true);
    const login = await createJar(ctx, 'login');
    expect(login.forwardHost).toBe(true);
    for (const kind of ['recovery', 'recovery-resume', 'enroll', 'change-email', 'email-confirm', 'setup-totp'] as const) {
      const jar = await createJar(ctx, kind, { query: kind === 'enroll' ? 'itoken=invite-placeholder' : '' });
      expect(jar.forwardHost).toBe(false);
      ak.calls.length = 0;
      await akExec(ctx, jar, 'GET');
      await akExec(ctx, jar, 'POST', { uid_field: 'anna@example.com' });
      expect(ak.calls.length).toBeGreaterThan(0);
      for (const c of ak.calls) {
        expect(c.headers['x-forwarded-host']).toBeUndefined();
        expect(c.headers['x-forwarded-proto']).toBeUndefined();
        expect(c.headers.origin).toBeUndefined();
      }
      ak.state.index = 0;
    }
  });

  it('network error -> 503 authentik_unavailable, message has no URL', async () => {
    const ctx = ctxWith((async () => { throw new TypeError(`fetch failed: ${AK_URL}/api/v3/flows/executor/x/ cookie=s1`); }) as typeof fetch);
    const e = await codeOf(akExec(ctx, jarOf({ cookies: { authentik_session: 's1' } }), 'GET'));
    expect(e).toEqual({ status: 503, code: 'authentik_unavailable' });
    expect(e.code).not.toMatch(/http|example|s1/);
  });

  it('a timeout counts as unreachable (8 s for the whole exchange)', async () => {
    let signal: AbortSignal | undefined;
    const ctx = ctxWith((async (_u: unknown, init: RequestInit) => {
      signal = init.signal ?? undefined;
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as typeof fetch);
    expect(await codeOf(akExec(ctx, jarOf(), 'GET'))).toEqual({ status: 503, code: 'authentik_unavailable' });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('without AUTHENTIK_URL -> 503 authentik_unavailable and no call', async () => {
    const ak = fakeAuthentik([]);
    expect(await codeOf(akExec(ctxWith(ak.fetch, { AUTHENTIK_URL: undefined }), jarOf(), 'GET'))).toEqual({ status: 503, code: 'authentik_unavailable' });
    expect(await codeOf(akExec(ctxWith(ak.fetch, { AUTHENTIK_URL: 'not a url' }), jarOf(), 'GET'))).toEqual({ status: 503, code: 'authentik_unavailable' });
    expect(ak.calls).toHaveLength(0);
  });

  it('a 500 text/html answer (Authentik CSRF failure) -> 502 authentik_error', async () => {
    const ak = fakeAuthentik([{ challenge: fixture('prompt-password-change') }]);
    ak.override = () => new Response('<!DOCTYPE html><html>CSRF Failed: Origin checking failed - https://friend.example.com</html>',
      { status: 500, headers: { 'content-type': 'text/html; charset=utf-8' } });
    const e = await codeOf(akExec(ctxWith(ak.fetch), jarOf({ cookies: { authentik_session: 's1', authentik_csrf: 'c' } }), 'POST', {}));
    expect(e).toEqual({ status: 502, code: 'authentik_error' });
  });

  it('non-JSON, JSON without component, a 404 page, a redirect elsewhere and a redirect loop -> 502 authentik_error', async () => {
    const answers: Array<() => Response> = [
      () => new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      () => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
      () => new Response(JSON.stringify({ detail: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } }),
      () => new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }),
      () => new Response('<html>Not Found</html>', { status: 404, headers: { 'content-type': 'text/html' } }),
      () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.com/api/v3/flows/executor/default-authentication-flow/' } }),
      () => new Response(null, { status: 302, headers: { location: '/if/flow/default-authentication-flow/' } }),
      () => new Response(null, { status: 302 }),
      () => new Response(null, { status: 302, headers: { location: 'http://[bad' } }),
      () => new Response(null, { status: 302, headers: { location: '/api/v3/flows/executor/default-authentication-flow/?query=' } }),
    ];
    for (const answer of answers) {
      const ak = fakeAuthentik([]);
      ak.override = answer;
      expect(await codeOf(akExec(ctxWith(ak.fetch), jarOf(), 'GET'))).toEqual({ status: 502, code: 'authentik_error' });
    }
    const loop = fakeAuthentik([]);
    loop.override = () => new Response(null, { status: 302, headers: { location: '/api/v3/flows/executor/default-authentication-flow/?query=' } });
    await codeOf(akExec(ctxWith(loop.fetch), jarOf(), 'GET'));
    expect(loop.calls).toHaveLength(6); // the call plus 5 hops
  });

  it('set-cookie with an empty value deletes the cookie', async () => {
    const ak = fakeAuthentik([]);
    ak.override = () => {
      const h = new Headers({ 'content-type': 'application/json' });
      h.append('set-cookie', 'authentik_device=; Path=/; SameSite=Lax');
      h.append('set-cookie', 'authentik_user_switching=""; Path=/');
      h.append('set-cookie', 'authentik_new=n1; Path=/');
      return new Response(JSON.stringify(fixture('redirect-final')), { headers: h });
    };
    const jar = jarOf({ cookies: { authentik_session: 's1', authentik_device: 'd1', authentik_user_switching: 'u1' } });
    await akExec(ctxWith(ak.fetch), jar, 'GET');
    expect(jar.cookies).toEqual({ authentik_session: 's1', authentik_new: 'n1' });
  });

  it('the invalidation answer (Max-Age=0, expires 1970, as recorded) and a past Expires delete the cookie; a future one keeps it', () => {
    const jar = jarOf({ cookies: { authentik_session: 's1', a: '1', b: '2' } });
    const h = new Headers();
    const recorded = (fixture('exchange-login') as unknown as Array<{ setCookie: string[] }>).flatMap((e) => e.setCookie)
      .find((c) => c.includes('Max-Age=0'))!;
    expect(recorded).toMatch(/^authentik_session=/);
    h.append('set-cookie', recorded.replace('<redacted>', '""'));
    h.append('set-cookie', 'a=x; expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/');
    h.append('set-cookie', 'b=y; expires=Thu, 14 Oct 2100 07:11:37 GMT; Path=/');
    h.append('set-cookie', 'broken');
    h.append('set-cookie', 'c=z; Max-Age=60; Path=/');
    absorbCookies(jar, new Response(null, { headers: h }));
    expect(jar.cookies).toEqual({ b: 'y', c: 'z' });
  });
});

describe('akGet and endAkSession', () => {
  it('akGet never sends x-forwarded-host, carries the jar and keeps the redirect for the caller', async () => {
    const ak = fakeAuthentik([], {
      'GET /application/o/authorize/': () => new Response(null, { status: 302, headers: { location: `${APP}/auth/callback?code=c&state=s`, 'set-cookie': 'authentik_extra=e1; Path=/' } }),
    });
    const ctx = ctxWith(ak.fetch);
    const jar = jarOf({ forwardHost: true, cookies: { authentik_session: 's1', authentik_csrf: 'c1' } });
    const r = await akGet(ctx, jar, '/application/o/authorize/?client_id=c&prompt=none');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(`${APP}/auth/callback?code=c&state=s`);
    const h = ak.calls[0]!.headers;
    expect(h['x-forwarded-host']).toBeUndefined();
    expect(h['x-forwarded-proto']).toBeUndefined();
    expect(h.origin).toBeUndefined();
    expect(h.cookie).toBe('authentik_session=s1; authentik_csrf=c1');
    expect(ak.calls[0]!.url.origin).toBe(AK_URL);
    expect(jar.cookies.authentik_extra).toBe('e1');
  });

  it('akGet sends the jar to the OIDC issuer origin, but never to another host', async () => {
    const ak = fakeAuthentik([]);
    const ctx = ctxWith(ak.fetch);
    const jar = jarOf({ cookies: { authentik_session: 's1' } });
    await akGet(ctx, jar, 'https://auth.example.com/application/o/authorize/?x=1');
    expect(ak.calls[0]!.url.host).toBe('auth.example.com');
    expect(await codeOf(akGet(ctx, jar, 'https://evil.example.net/steal'))).toEqual({ status: 502, code: 'authentik_error' });
    expect(await codeOf(akGet(ctx, jar, 'http://[bad'))).toEqual({ status: 502, code: 'authentik_error' });
    expect(await codeOf(akGet(ctxWith(ak.fetch, { OIDC_ISSUER: '' }), jar, 'https://auth.example.com/x'))).toEqual({ status: 502, code: 'authentik_error' });
    expect(ak.calls).toHaveLength(1);
    const down = ctxWith((async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch);
    expect(await codeOf(akGet(down, jar, '/x'))).toEqual({ status: 503, code: 'authentik_unavailable' });
  });

  it('endAkSession runs the invalidation flow with the jar and the session cookie is gone', async () => {
    const ak = fakeAuthentik([], {
      'GET /api/v3/flows/executor/default-invalidation-flow/': () => new Response(JSON.stringify(fixture('invalidation-end')), {
        headers: { 'content-type': 'application/json', 'set-cookie': 'authentik_session=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/; SameSite=Lax' },
      }),
    });
    const jar = jarOf({ forwardHost: true, cookies: { authentik_session: 's1', authentik_csrf: 'c1' } });
    await endAkSession(ctxWith(ak.fetch), jar);
    expect(ak.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v3/flows/executor/default-invalidation-flow/']);
    expect(ak.calls[0]!.headers.cookie).toContain('authentik_session=s1');
    expect(ak.calls[0]!.headers['x-forwarded-host']).toBeUndefined();
    expect(jar.cookies.authentik_session).toBeUndefined();

    const custom = fakeAuthentik([]);
    await endAkSession(ctxWith(custom.fetch, { AUTHENTIK_INVALIDATION_FLOW: 'ff-logout' }), jarOf({ cookies: { authentik_session: 's2' } }));
    expect(custom.calls[0]!.path).toBe('/api/v3/flows/executor/ff-logout/');
  });

  it('endAkSession never throws and skips a jar without cookies', async () => {
    const down = ctxWith((async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch);
    await expect(endAkSession(down, jarOf({ cookies: { authentik_session: 's1' } }))).resolves.toBeUndefined();
    await expect(endAkSession(ctxWith(fetch, { AUTHENTIK_URL: undefined }), jarOf({ cookies: { authentik_session: 's1' } }))).resolves.toBeUndefined();
    const ak = fakeAuthentik([]);
    await endAkSession(ctxWith(ak.fetch), jarOf());
    expect(ak.calls).toHaveLength(0);
  });
});

describe('the jar in kv', () => {
  const key = (flowId: string) => `akflow:${sha256(flowId)}`;

  it('jar round-trips encrypted and the kv value contains no cookie value', async () => {
    const ctx = ctxWith(fetch);
    // long, distinctive values: a two-letter value can turn up in random ciphertext by chance
    const jar = jarOf({ cookies: { authentik_session: 'session-value-QX7', authentik_csrf: 'csrf-value-1' }, identifier: 'anna@example.com', challenges: 2 });
    await saveJar(ctx, 'flow-1', jar);
    const raw = (await ctx.kv.get(key('flow-1')))!;
    expect(raw).toBeTruthy();
    expect(raw).not.toContain('session-value-QX7');
    expect(raw).not.toContain('csrf-value-1');
    expect(raw).not.toContain('anna');
    expect(await ctx.kv.keys('akflow:')).toEqual([key('flow-1')]); // the flow id itself is not the key
    expect(await loadJar(ctx, 'flow-1')).toEqual(jar);
    expect(await loadJar(ctx, 'flow-2')).toBeNull();
    await dropJar(ctx, 'flow-1');
    expect(await loadJar(ctx, 'flow-1')).toBeNull();
  });

  it('jar older than 600 s is null', async () => {
    const ctx = ctxWith(fetch);
    // saved while fresh, read back after its createdAt is 601 s old (the kv entry still exists here)
    const old = jarOf({ createdAt: Date.now() - (JAR_TTL_S + 1) * 1000 });
    await ctx.kv.set(key('old'), encrypt(ctx.encKey, JSON.stringify({ fid: sha256('old'), jar: old })), 3600);
    expect(await loadJar(ctx, 'old')).toBeNull();
    expect(await ctx.kv.get(key('old'))).toBeNull();
    // saving an expired jar stores nothing (and removes what was there)
    await ctx.kv.set(key('old2'), 'x', 3600);
    await saveJar(ctx, 'old2', old);
    expect(await ctx.kv.get(key('old2'))).toBeNull();
  });

  it('saving again does not extend the 10-minute limit', async () => {
    vi.useFakeTimers();
    const ctx = ctxWith(fetch);
    const jar = jarOf();
    await saveJar(ctx, 'f', jar);
    vi.advanceTimersByTime(590_000);
    await saveJar(ctx, 'f', { ...jar, step: 'st2' }); // a step later
    expect((await loadJar(ctx, 'f'))?.step).toBe('st2');
    vi.advanceTimersByTime(11_000);
    expect(await loadJar(ctx, 'f')).toBeNull();
  });

  it('a damaged or foreign entry reads as no jar; an old entry without a challenge count reads as 0', async () => {
    const ctx = ctxWith(fetch);
    await ctx.kv.set(key('bad'), 'not-encrypted', 600);
    expect(await loadJar(ctx, 'bad')).toBeNull();
    await ctx.kv.set(key('foreign'), encrypt(Buffer.alloc(32, 9), JSON.stringify({ fid: sha256('foreign'), jar: jarOf() })), 600);
    expect(await loadJar(ctx, 'foreign')).toBeNull();
    const { challenges: _c, ...legacy } = jarOf();
    await ctx.kv.set(key('legacy'), encrypt(ctx.encKey, JSON.stringify({ fid: sha256('legacy'), jar: legacy })), 600);
    expect((await loadJar(ctx, 'legacy'))?.challenges).toBe(0);
    await ctx.kv.set(key('noage'), encrypt(ctx.encKey, JSON.stringify({ fid: sha256('noage'), jar: { ...jarOf(), createdAt: 'x' } })), 600);
    expect(await loadJar(ctx, 'noage')).toBeNull();
  });

  it('createJar fixes slug, kind and forwardHost; continueJar keeps the session, the age and forwardHost', async () => {
    const ak = fakeAuthentik([], { [DISCOVERY]: discovery(true) });
    const ctx = ctxWith(ak.fetch);
    const reauth = await createJar(ctx, 'reauth', { userId: 'u1', identifier: 'anna', then: 'setup-webauthn', step: 'st' });
    expect(reauth).toMatchObject({ kind: 'reauth', slug: 'default-authentication-flow', forwardHost: true, userId: 'u1', challenges: 0, cookies: {}, query: '', step: 'st' });
    reauth.cookies.authentik_session = 's1';
    reauth.challenges = 4;
    const next = continueJar(ctx.cfg, reauth, reauth.then!);
    expect(next).toMatchObject({ kind: 'setup-webauthn', slug: 'default-authenticator-webauthn-setup', forwardHost: true, userId: 'u1', challenges: 0, createdAt: reauth.createdAt, cookies: { authentik_session: 's1' } });
    expect(next.then).toBeUndefined();
    for (const kind of ['change-email', 'setup-totp', 'setup-static', 'change-password'] as const) expect(continueJar(ctx.cfg, reauth, kind).forwardHost).toBe(false);
    const plain = { ...reauth, forwardHost: false };
    expect(continueJar(ctx.cfg, plain, 'setup-webauthn').forwardHost).toBe(false);
    expect(await codeOf(createJar(ctx, 'enroll'))).toEqual({ status: 409, code: 'flow_not_configured' });
    expect(() => continueJar(ctx.cfg, reauth, 'enroll')).toThrow('flow_not_configured');
    const off = ctxWith(ak.fetch, { PASSKEYS_IN_APP: 'off' });
    expect((await createJar(off, 'login')).forwardHost).toBe(false);
  });
});

describe('fix round 1', () => {
  it('reauth -> change-email after a forwarded re-authentication sends no forwarded host; the CSRF origin is AUTHENTIK_URL', async () => {
    const ak = fakeAuthentik([{ challenge: fixture('prompt-password-change') }], { [DISCOVERY]: discovery(true) });
    const ctx = ctxWith(ak.fetch);
    const reauth = await createJar(ctx, 'reauth', { then: 'change-email' });
    expect(reauth.forwardHost).toBe(true);
    reauth.cookies = { authentik_session: 's1', authentik_csrf: 'csrf-placeholder' };
    const mail = continueJar(ctx.cfg, reauth, 'change-email');
    ak.calls.length = 0;
    await akExec(ctx, mail, 'GET');
    await akExec(ctx, mail, 'POST', { email: 'new@example.com' });
    for (const c of ak.calls) {
      expect(c.headers['x-forwarded-host']).toBeUndefined();
      expect(c.headers['x-forwarded-proto']).toBeUndefined();
    }
    expect(ak.calls[0]!.headers.origin).toBeUndefined();
    expect(ak.calls[1]!.headers).toMatchObject({ 'x-authentik-csrf': 'csrf-placeholder', origin: AK_URL });
  });

  it('a jar blob copied under another flow id does not load there', async () => {
    const ctx = ctxWith(fetch);
    await saveJar(ctx, 'flow-a', jarOf({ cookies: { authentik_session: 's1' } }));
    await ctx.kv.set(`akflow:${sha256('flow-b')}`, (await ctx.kv.get(`akflow:${sha256('flow-a')}`))!, 600);
    expect(await loadJar(ctx, 'flow-b')).toBeNull();
    expect((await loadJar(ctx, 'flow-a'))?.cookies.authentik_session).toBe('s1');
  });

  it('a declared body over 1 MB is refused unread (executor 502, probe unreachable)', async () => {
    const big = () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '5000000' } });
    const ak = fakeAuthentik([], { [DISCOVERY]: big });
    ak.override = (c) => (c.path.includes('/flows/executor/') ? big() : undefined);
    expect(await codeOf(akExec(ctxWith(ak.fetch), jarOf(), 'GET'))).toEqual({ status: 502, code: 'authentik_error' });
    expect(await probeForwardedHost(ctxWith(ak.fetch))).toBe('unreachable');
  });

  it('a 404 from the probe is probe_not_found; concurrent first callers share one probe', async () => {
    const missing = fakeAuthentik([]);
    expect(await passkeysStatus(ctxWith(missing.fetch))).toEqual({ inApp: false, reason: 'probe_not_found' });
    const ak = fakeAuthentik([], { [DISCOVERY]: discovery(true) });
    const ctx = ctxWith(ak.fetch);
    expect(await Promise.all([passkeysInApp(ctx), passkeysInApp(ctx), passkeysInApp(ctx)])).toEqual([true, true, true]);
    expect(ak.calls).toHaveLength(1);
  });
});

describe('passkeys in-app and the forwarded-host probe', () => {
  it('honoured: issuer on the app host; the probe goes to AUTHENTIK_URL with the app host forwarded, without auth', async () => {
    const ak = fakeAuthentik([], { [DISCOVERY]: discovery(true) });
    const ctx = ctxWith(ak.fetch);
    expect(await passkeysStatus(ctx)).toEqual({ inApp: true, reason: 'ok' });
    const c = ak.calls[0]!;
    expect(c.url.origin).toBe(AK_URL);
    expect(c.path).toBe('/application/o/friendflix/.well-known/openid-configuration');
    expect(c.headers).toMatchObject({ 'x-forwarded-host': 'friend.example.com', 'x-forwarded-proto': 'https' });
    expect(c.headers.authorization).toBeUndefined();
    expect(c.headers.cookie).toBeUndefined();
  });

  it('ignored: issuer on Authentik\'s host -> forwarded_host_ignored', async () => {
    const ak = fakeAuthentik([], { [DISCOVERY]: discovery(false) });
    expect(await passkeysStatus(ctxWith(ak.fetch))).toEqual({ inApp: false, reason: 'forwarded_host_ignored' });
  });

  it('PASSKEYS_IN_APP=off, an http PUBLIC_URL, no PUBLIC_URL or no AUTHENTIK_URL -> no probe call', async () => {
    const ak = fakeAuthentik([], { [DISCOVERY]: discovery(true) });
    expect(await passkeysStatus(ctxWith(ak.fetch, { PASSKEYS_IN_APP: 'off' }))).toEqual({ inApp: false, reason: 'disabled' });
    expect(await passkeysStatus(ctxWith(ak.fetch, { PUBLIC_URL: 'http://friend.example.com' }))).toEqual({ inApp: false, reason: 'not_https' });
    expect(await passkeysStatus(ctxWith(ak.fetch, { PUBLIC_URL: '' }))).toEqual({ inApp: false, reason: 'not_https' });
    expect(await passkeysStatus(ctxWith(ak.fetch, { AUTHENTIK_URL: undefined }))).toEqual({ inApp: false, reason: 'not_configured' });
    expect(ak.calls).toHaveLength(0);
    expect(await passkeysInApp(ctxWith(ak.fetch, { PUBLIC_URL: 'http://localhost:5173' }))).toBe(true); // development
    expect(ak.calls[0]!.headers).toMatchObject({ 'x-forwarded-host': 'localhost:5173', 'x-forwarded-proto': 'http' });
  });

  it('unreachable: network error, timeout, a non-2xx or odd answer -> false, cached for a minute only', async () => {
    vi.useFakeTimers();
    let mode: 'down' | 'html' | 'nojson' | 'noissuer' | 'up' = 'down';
    const ak = fakeAuthentik([], {
      [DISCOVERY]: (call) => {
        if (mode === 'down') throw new Error(`connect ECONNREFUSED ${call.url.host}`);
        if (mode === 'html') return new Response('<html>502</html>', { status: 502 });
        if (mode === 'nojson') return new Response('{', { status: 200 });
        if (mode === 'noissuer') return new Response('{}', { status: 200 });
        return discovery(true)(call);
      },
    });
    const ctx = ctxWith(ak.fetch);
    expect(await passkeysStatus(ctx)).toEqual({ inApp: false, reason: 'unreachable' });
    mode = 'up';
    expect(await passkeysInApp(ctx)).toBe(false); // still cached
    expect(ak.calls).toHaveLength(1);
    vi.advanceTimersByTime(61_000);
    expect(await passkeysInApp(ctx)).toBe(true);
    for (const m of ['html', 'nojson', 'noissuer'] as const) {
      mode = m;
      expect(await probeForwardedHost(ctxWith(ak.fetch))).toBe('unreachable');
    }
    expect(await probeForwardedHost(ctxWith(ak.fetch, { OIDC_ISSUER: 'nonsense' }))).toBe('unreachable');
  });

  it('the cache is keyed by its inputs: a changed PUBLIC_URL probes again at once; otherwise one probe per 10 minutes', async () => {
    vi.useFakeTimers();
    const ak = fakeAuthentik([], { [DISCOVERY]: discovery(true) });
    const ctx = ctxWith(ak.fetch);
    await passkeysInApp(ctx);
    await passkeysInApp(ctx);
    expect(ak.calls).toHaveLength(1);
    const key = (await ctx.kv.keys('akflow:fwdhost:'))[0]!;
    expect(key).toBe(`akflow:fwdhost:${sha256(`${APP}|${ISSUER}|${AK_URL}`)}`);
    ctx.cfg = cfgFor({ PUBLIC_URL: 'https://films.example.com' });
    expect(await passkeysInApp(ctx)).toBe(true);
    expect(ak.calls).toHaveLength(2);
    expect(ak.calls[1]!.headers['x-forwarded-host']).toBe('films.example.com');
    vi.advanceTimersByTime(601_000);
    await passkeysInApp(ctx);
    expect(ak.calls).toHaveLength(3);
  });
});

describe('error logs of routes with secret bodies (/api/setup/, /api/admin/settings; /auth/flow/ in auth-flow.test.ts)', () => {
  const logs: string[] = [];
  let env: TestEnv;
  const PASSWORD = 'Sup3r-Secret-Passw0rd!';
  // stand-ins for the real routes: an error that quotes the request body
  const BOOM = ['/api/setup/boom', '/api/admin/settings/boom'];
  beforeAll(async () => {
    env = await makeEnv({}, {
      logger: { stream: { write: (m: string) => { logs.push(m); } }, level: 'trace' },
      register: [(app) => {
        for (const url of [...BOOM, '/api/plain/boom']) {
          app.post(url, async (req) => {
            throw Object.assign(new Error(`stage failed for ${JSON.stringify(req.body)}`), { code: 'E_TEST' });
          });
        }
      }],
    });
  });
  afterAll(() => env.close());
  const post = (url: string) => env.app.inject({ method: 'POST', url, payload: { step: 'st1', stage: 'password', password: PASSWORD } });

  it('a thrown error under a sensitive prefix is logged by type and code only, never with the body', async () => {
    logs.length = 0;
    const r = await post('/api/setup/boom');
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: 'internal' });
    const text = logs.join('\n');
    expect(text).toContain('unhandled error');
    expect(text).toContain('E_TEST');
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('stage failed');
  });

  it('no path trick (percent-encoding, case, double slashes) gets the body into the log, for both prefixes', async () => {
    const variants = [
      '/api/setup/boom', '/%61pi/setup/boom', '/api/%73etup/boom', '/API/setup/boom', '//api/setup/boom', '/api//setup/boom',
      '/api/admin/settings/boom', '/%61pi/admin/settings/boom', '/api/admin/%73ettings/boom', '/api/%61dmin/settings/boom', '/api/ADMIN/settings/boom', '/api/admin//settings/boom',
    ];
    let reached = 0;
    for (const url of variants) {
      logs.length = 0;
      const r = await post(url);
      expect([404, 500]).toContain(r.statusCode);
      if (r.statusCode === 500) reached++;
      const text = logs.join('\n');
      expect(text, url).not.toContain(PASSWORD);
      expect(text, url).not.toContain('stage failed');
    }
    expect(reached).toBeGreaterThanOrEqual(6); // the encoded variants do reach the handlers
  });

  it('other routes still log the error object (the capture works)', async () => {
    logs.length = 0;
    expect((await post('/api/plain/boom')).statusCode).toBe(500);
    expect(logs.join('\n')).toContain('stage failed');
  });
});
