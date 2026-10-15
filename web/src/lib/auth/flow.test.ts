// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// The in-app sign-in client (Block 23 phase 3, Task 7): transport, csrf, reply mapping, the passkey ceremony and the small helpers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ goto: vi.fn(async (_to: string, _o?: unknown) => undefined) }));
vi.mock('$app/navigation', () => nav);
const csrf = vi.hoisted(() => ({ token: '' }));
vi.mock('#lib/api', () => ({ getCsrf: () => csrf.token }));

import {
  answer, artPaths, cancelFlow, classicHref, codeFromBoxes, credentialJSON, errorKey, fallbackArt, fieldLabel, flowConfig, inviteToken,
  passkeyCreate, passkeyGet, pasteCode, resumeFlow, safeNext, startFlow, wallColumns,
  type FlowStep, type PasskeyCreate, type PasskeyGet,
} from './flow';

// ---------------------------------------------------------------------------------------------------------------------------
// fakes

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];
let cookie = '';
/** queued answers: status + body (or a thrown error) */
let queue: Array<{ status: number; body?: unknown; raw?: string; setCookie?: string } | Error> = [];

function installFetch() {
  calls = [];
  queue = [];
  cookie = 'ff_flow_csrf=tok-1';
  vi.stubGlobal('document', { get cookie() { return cookie; } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) }, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const next = queue.shift() ?? { status: 200, body: {} };
    if (next instanceof Error) throw next;
    if (next.setCookie !== undefined) cookie = next.setCookie;
    const text = next.raw ?? (next.body === undefined ? '' : JSON.stringify(next.body));
    return { ok: next.status >= 200 && next.status < 300, status: next.status, text: async () => text } as Response;
  }));
}
const pending = <T>(p: Promise<T>) => Promise.race([p.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 20))]);

beforeEach(() => {
  nav.goto.mockClear();
  installFetch();
});
afterEach(() => vi.unstubAllGlobals());

const IDENTIFY: Extract<FlowStep, { stage: 'identify' }> = { stage: 'identify', step: 's1', passwordInline: false, canRecover: true, canEnroll: false, passkey: null };
const MFA: Extract<FlowStep, { stage: 'mfa' }> = { stage: 'mfa', step: 's2', totp: true, recovery: true, passkey: null, passkeyClassic: false };

// ---------------------------------------------------------------------------------------------------------------------------

describe('type sync with the backend FlowStep (preflight P11)', () => {
  it('one literal sample per stage from the backend fixtures type-checks against the web copy', () => {
    // Taken from backend/test/flow-steps.test.ts (Task 2 fixtures). A stage or field the web copy lacks fails `npm run typecheck`.
    const samples: Record<FlowStep['stage'], FlowStep> = {
      identify: {
        stage: 'identify', step: 'step-0001', passwordInline: true, canRecover: true, canEnroll: true,
        passkey: { challenge: 'fake-challenge-0011', rpId: 'friend.example.com', allowCredentials: [], userVerification: 'preferred', timeout: 60000 },
      },
      password: { stage: 'password', step: 'step-0001', identity: 'anna@example.com', canRecover: false },
      mfa: {
        stage: 'mfa', step: 'step-0001', totp: true, recovery: true, passkeyClassic: false,
        passkey: { challenge: 'fake-challenge-0001', rpId: 'friend.example.com', allowCredentials: [{ id: 'fake-id-0002', type: 'public-key' }], userVerification: 'preferred', timeout: 60000 },
      },
      'passkey-setup': {
        stage: 'passkey-setup', step: 'step-0001',
        options: {
          challenge: 'fake-challenge-0008', rp: { id: 'friend.example.com', name: 'FriendFlix' }, user: { id: 'fake-id-0007', name: 'anna', displayName: 'Anna Beispiel' },
          pubKeyCredParams: [{ type: 'public-key', alg: -8 }, { type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          excludeCredentials: [], authenticatorSelection: { residentKey: 'preferred', requireResidentKey: false, userVerification: 'preferred' },
          attestation: 'direct', timeout: 60000,
        },
      },
      'email-sent': { stage: 'email-sent', step: 'step-0001', to: 'a•••@example.com' },
      prompt: {
        stage: 'prompt', step: 'step-0001', fields: [
          { key: 'password', type: 'password', label: 'ff:password', required: true },
          { key: 'password_repeat', type: 'password', label: 'ff:password_repeat', required: true },
        ],
      },
      'totp-setup': { stage: 'totp-setup', step: 'step-0001', otpauth: 'otpauth://totp/authentik%3Aanna?secret=FAKESECRETFAKESECRETFAKESECRETAA&algorithm=SHA1&digits=6&period=30&issuer=authentik' },
      'recovery-codes': { stage: 'recovery-codes', step: 'step-0001', codes: ['fakecode0001', 'fakecode0002', 'fakecode0003', 'fakecode0004', 'fakecode0005', 'fakecode0006'] },
      denied: { stage: 'denied' },
      classic: { stage: 'classic', reason: 'passkey_origin' },
      expired: { stage: 'expired' },
      unavailable: { stage: 'unavailable' },
      locked: { stage: 'locked' },
      done: { stage: 'done', next: '/' },
    };
    for (const [stage, s] of Object.entries(samples)) expect(s.stage).toBe(stage);
    expect(Object.keys(samples)).toHaveLength(14);
  });
});

describe('codes', () => {
  it("pasteCode('12 34-56x') → ['1','2','3','4','5','6']", () => {
    expect(pasteCode('12 34-56x')).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(pasteCode('1234567890')).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(pasteCode('ab')).toEqual([]);
  });
  it('codeFromBoxes joins the digits and drops anything else', () => {
    expect(codeFromBoxes(['1', '2', '3', '4', '5', '6'])).toBe('123456');
    expect(codeFromBoxes(['1', '', 'x', '4'])).toBe('14');
  });
});

describe('cover wall', () => {
  it('wallColumns(36 images) gives 5 columns, each doubled', () => {
    const imgs = Array.from({ length: 36 }, (_, i) => `/api/public/login-art/abcdefghijkl/${i}`);
    const cols = wallColumns(imgs);
    expect(cols).toHaveLength(5);
    for (const c of cols) {
      const half = c.length / 2;
      expect(Number.isInteger(half)).toBe(true);
      expect(c.slice(0, half)).toEqual(c.slice(half));
    }
    // round robin: column 0 starts with images 0, 5, 10 …
    expect(cols[0]!.slice(0, 3)).toEqual([imgs[0], imgs[5], imgs[10]]);
    expect(cols.flatMap((c) => c.slice(0, c.length / 2)).sort()).toEqual([...imgs].sort());
  });
  it('a few images still fill every column; none gives none', () => {
    const cols = wallColumns(['/a', '/b'], 3);
    expect(cols).toHaveLength(3);
    for (const c of cols) expect(c.length).toBeGreaterThanOrEqual(12);
    expect(wallColumns([])).toEqual([]);
  });
  it('fallbackArt is deterministic for a seed', () => {
    const a = fallbackArt(7, 12);
    expect(a).toHaveLength(12);
    expect(fallbackArt(7, 12)).toEqual(a);
    expect(fallbackArt(8, 12)).not.toEqual(a);
    for (const t of a) {
      expect(t.from).toMatch(/^#[0-9a-f]{6}$/);
      expect(t.to).toMatch(/^#[0-9a-f]{6}$/);
      expect(t.angle).toBeGreaterThanOrEqual(100);
      expect(t.angle).toBeLessThan(190);
      expect(Object.keys(t).sort()).toEqual(['angle', 'from', 'to']); // no text, no titles
    }
  });
  it('artPaths keeps only same-origin /api/public/login-art image paths', () => {
    expect(artPaths({ images: ['/api/public/login-art/abcdefghijkl/0', 'https://evil.example.com/x.jpg', '//evil.example.com/y', '/api/public/login-art/abc/1', 5, '/api/public/login-art/A_b-c1234567/35'] }))
      .toEqual(['/api/public/login-art/abcdefghijkl/0', '/api/public/login-art/A_b-c1234567/35']);
    expect(artPaths(null)).toEqual([]);
    expect(artPaths({ images: 'x' })).toEqual([]);
  });
});

describe('small helpers', () => {
  it('classicHref keeps the invite', () => {
    expect(classicHref()).toBe('/auth/login?classic=1');
    expect(classicHref('')).toBe('/auth/login?classic=1');
    expect(classicHref('inv 1&x')).toBe('/auth/login?classic=1&invite=inv%201%26x');
  });
  it('safeNext allows same-origin paths only', () => {
    expect(safeNext('/pending')).toBe('/pending');
    expect(safeNext('/item/abc?x=1')).toBe('/item/abc?x=1');
    for (const bad of ['https://evil.example.com/', '//evil.example.com', '/\\evil.example.com', 'javascript:alert(1)', '', 42]) expect(safeNext(bad)).toBe('/');
  });
  it('inviteToken takes a token or an invite link', () => {
    expect(inviteToken('  abcDEF123_-xyz ')).toBe('abcDEF123_-xyz');
    expect(inviteToken('https://friend.example.com/invite/abcDEF123_-xyz')).toBe('abcDEF123_-xyz');
    expect(inviteToken('https://friend.example.com/invite/abcDEF123?x=1#y')).toBe('abcDEF123');
    expect(inviteToken('/invite/tok-000001/')).toBe('tok-000001');
    for (const bad of ['', 'a b c', 'https://friend.example.com/', 'x'.repeat(200), '<script>', 'abc']) expect(inviteToken(bad)).toBeNull();
  });
  it('fieldLabel maps FriendFlix label keys to locale texts and never shows a raw key', () => {
    const tr = (k: string) => `T(${k})`;
    expect(fieldLabel('ff:password', tr)).toBe('T(login.fields.password)');
    expect(fieldLabel('ff:password_repeat', tr)).toBe('T(login.fields.password_repeat)');
    expect(fieldLabel('ff:new_email', tr)).toBe('T(login.fields.new_email)');
    expect(fieldLabel('ff:something_new', tr)).toBe('T(login.fields.generic)');
    expect(fieldLabel('Benutzername', tr)).toBe('Benutzername');
    expect(fieldLabel('', tr)).toBe('T(login.fields.generic)');
  });
  it('errorKey maps every flow error to a login.errors text', () => {
    expect(errorKey('code_invalid')).toBe('login.errors.code_invalid');
    expect(errorKey('rate_limited')).toBe('login.errors.rate_limited');
    expect(errorKey('nonsense' as never)).toBe('login.errors.invalid');
  });
});

describe('transport', () => {
  it('flowConfig reads the mode and sets nothing itself', async () => {
    queue.push({ status: 200, body: { mode: 'app', recovery: true, enroll: false, extra: 'x' } });
    expect(await flowConfig()).toEqual({ mode: 'app', recovery: true, enroll: false });
    expect(calls[0]).toMatchObject({ url: '/auth/flow/config', method: 'GET' });
    queue.push({ status: 200, body: { mode: 'weird' } });
    expect(await flowConfig()).toEqual({ mode: 'authentik', recovery: false, enroll: false });
  });

  it('flowConfig: 503 setup_required goes to /setup', async () => {
    queue.push({ status: 503, body: { error: 'setup_required' } });
    expect(await pending(flowConfig())).toBe('pending');
    expect(nav.goto).toHaveBeenCalledWith('/setup', { replaceState: true });
  });

  it('flowConfig: other failures reject', async () => {
    queue.push({ status: 500, body: { error: 'internal' } });
    await expect(flowConfig()).rejects.toThrow('flow_config_500');
    queue.push(new TypeError('network'));
    await expect(flowConfig()).rejects.toThrow('network');
  });

  it('answer sends x-ff-flow-csrf from the cookie', async () => {
    cookie = 'other=1; ff_flow_csrf=tok%2D9; x=y';
    queue.push({ status: 200, body: { ...MFA, step: 's3' } });
    const r = await answer(IDENTIFY, { identifier: 'anna@example.com' });
    expect(r).toEqual({ ...MFA, step: 's3' });
    expect(calls[0]).toMatchObject({ url: '/auth/flow/answer', method: 'POST', body: { step: 's1', stage: 'identify', identifier: 'anna@example.com' } });
    expect(calls[0]!.headers['x-ff-flow-csrf']).toBe('tok-9');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
  });

  it('resumeFlow posts the token in the body only and maps the reply', async () => {
    queue.push({ status: 200, body: { stage: 'expired' } });
    expect(await resumeFlow('tok_abc-1')).toEqual({ stage: 'expired' });
    expect(calls[0]).toMatchObject({ url: '/auth/flow/resume', method: 'POST' });
    expect(calls[0]!.body).toEqual({ token: 'tok_abc-1' }); // recovery: no kind
    expect(calls[0]!.url).not.toContain('tok_abc');
  });

  it('startFlow sends the kind and extras', async () => {
    queue.push({ status: 200, body: IDENTIFY });
    expect(await startFlow('login', { invite: 'inv-1' })).toEqual(IDENTIFY);
    expect(calls[0]).toMatchObject({ url: '/auth/flow/start', method: 'POST', body: { kind: 'login', invite: 'inv-1' } });
    expect(calls[0]!.headers['x-ff-flow-csrf']).toBe('tok-1');
  });

  it('a re-authentication: then is sent, and the signed-in session csrf token goes along (the sign-in page has none)', async () => {
    queue.push({ status: 200, body: IDENTIFY }, { status: 200, body: IDENTIFY });
    await startFlow('login');
    expect(calls[0]!.headers['x-csrf-token']).toBeUndefined();
    csrf.token = 'session-csrf';
    await startFlow('reauth', { then: 'setup-totp' });
    csrf.token = '';
    expect(calls[1]).toMatchObject({ url: '/auth/flow/start', body: { kind: 'reauth', then: 'setup-totp' } });
    expect(calls[1]!.headers['x-csrf-token']).toBe('session-csrf');
  });

  it('a re-authentication that cannot start rejects with its code (passkey_classic, flow_not_configured, unauthenticated)', async () => {
    queue.push({ status: 409, body: { error: 'passkey_classic' } }, { status: 409, body: { error: 'flow_not_configured' } }, { status: 401, body: { error: 'unauthenticated' } }, { status: 429, body: {} });
    await expect(startFlow('reauth', { then: 'setup-webauthn' })).rejects.toMatchObject({ status: 409, code: 'passkey_classic' });
    await expect(startFlow('reauth', { then: 'change-email' })).rejects.toMatchObject({ code: 'flow_not_configured' });
    await expect(startFlow('reauth')).rejects.toMatchObject({ status: 401 });
    expect(await startFlow('reauth')).toEqual({ stage: 'unavailable' }); // too many starts: the same notice as for a login
  });

  it('resumeFlow posts the token with kind email-confirm; done, expired and unavailable come back as stages', async () => {
    queue.push({ status: 200, body: { stage: 'done', next: '/confirm-email?ok=1' } }, { status: 200, body: { stage: 'expired' } }, { status: 502, body: {} });
    expect(await resumeFlow('tok-abcdefghijklmnop', 'email-confirm')).toEqual({ stage: 'done', next: '/confirm-email?ok=1' });
    expect(calls[0]).toMatchObject({ url: '/auth/flow/resume', method: 'POST', body: { token: 'tok-abcdefghijklmnop', kind: 'email-confirm' } });
    expect(calls[0]!.headers['x-ff-flow-csrf']).toBe('tok-1');
    expect(await resumeFlow('tok-abcdefghijklmnop', 'email-confirm')).toEqual({ stage: 'expired' });
    expect(await resumeFlow('tok-abcdefghijklmnop', 'email-confirm')).toEqual({ stage: 'unavailable' });
  });

  it('a stale csrf cookie: flowConfig() and one retry', async () => {
    queue.push({ status: 403, body: { error: 'csrf' } }, { status: 200, body: { mode: 'app', recovery: false, enroll: false }, setCookie: 'ff_flow_csrf=tok-2' }, { status: 200, body: IDENTIFY });
    expect(await startFlow('login')).toEqual(IDENTIFY);
    expect(calls.map((c) => c.url)).toEqual(['/auth/flow/start', '/auth/flow/config', '/auth/flow/start']);
    expect(calls[2]!.headers['x-ff-flow-csrf']).toBe('tok-2');
  });

  it('a second csrf refusal is not retried again: expired', async () => {
    queue.push({ status: 403, body: { error: 'csrf' } }, { status: 200, body: { mode: 'app', recovery: false, enroll: false } }, { status: 403, body: { error: 'csrf' } });
    expect(await answer(MFA, { code: '123456' })).toEqual({ stage: 'expired' });
    expect(calls).toHaveLength(3);
  });

  it('cancel clears the csrf cookie, so cancelFlow fetches a fresh one before the next start', async () => {
    queue.push({ status: 200, body: { ok: true }, setCookie: '' }, { status: 200, body: { mode: 'app', recovery: false, enroll: false }, setCookie: 'ff_flow_csrf=tok-3' }, { status: 200, body: IDENTIFY });
    await cancelFlow();
    await startFlow('login');
    expect(calls.map((c) => c.url)).toEqual(['/auth/flow/cancel', '/auth/flow/config', '/auth/flow/start']);
    expect(calls[2]!.headers['x-ff-flow-csrf']).toBe('tok-3');
  });

  it('cancelFlow never throws', async () => {
    queue.push(new TypeError('network'), new TypeError('network'));
    await expect(cancelFlow()).resolves.toBeUndefined();
  });

  it('rate_limited arrives as the same stage with a new step and errors', async () => {
    queue.push({ status: 200, body: { ...MFA, step: 's9', errors: ['rate_limited'] } });
    expect(await answer(MFA, { code: '123456' })).toEqual({ ...MFA, step: 's9', errors: ['rate_limited'] });
  });

  it('400 {errors} keeps the shown step with the errors; other 400s are "invalid"', async () => {
    queue.push({ status: 400, body: { errors: ['password_mismatch', 42] } }, { status: 400, body: { error: 'bad_request' } });
    expect(await answer(MFA, { code: 'x' })).toEqual({ ...MFA, errors: ['password_mismatch'] });
    expect(await answer(MFA, { code: 'x' })).toEqual({ ...MFA, errors: ['invalid'] });
  });

  it('maps transport errors: step_used → expired, classic → classic, 429 → rate_limited, 5xx/network/garbage → unavailable', async () => {
    queue.push(
      { status: 409, body: { error: 'step_used' } },
      { status: 409, body: { error: 'classic' } },
      { status: 429, body: { error: 'too_many' } },
      { status: 500, body: { error: 'internal' } },
      new TypeError('network'),
      { status: 200, raw: '<html>proxy</html>' },
      { status: 200, body: { nope: 1 } },
    );
    expect(await answer(MFA, { code: '1' })).toEqual({ stage: 'expired' });
    expect(await answer(MFA, { code: '1' })).toEqual({ stage: 'classic', reason: 'unsupported_stage' });
    expect(await answer(MFA, { code: '1' })).toEqual({ ...MFA, errors: ['rate_limited'] });
    expect(await answer(MFA, { code: '1' })).toEqual({ stage: 'unavailable' });
    expect(await answer(MFA, { code: '1' })).toEqual({ stage: 'unavailable' });
    expect(await answer(MFA, { code: '1' })).toEqual({ stage: 'unavailable' });
    expect(await answer(MFA, { code: '1' })).toEqual({ stage: 'unavailable' });
  });

  it('start: 429 → unavailable, 410 invite_invalid rejects, 503 setup_required goes to /setup', async () => {
    queue.push({ status: 429, body: {} }, { status: 410, body: { error: 'invite_invalid' } });
    expect(await startFlow('login')).toEqual({ stage: 'unavailable' });
    await expect(startFlow('login', { invite: 'gone' })).rejects.toThrow('invite_invalid');
    queue.push({ status: 503, body: { error: 'setup_required' } });
    expect(await pending(startFlow('login'))).toBe('pending');
    expect(nav.goto).toHaveBeenCalledWith('/setup', { replaceState: true });
  });

  it('after unavailable, a retry is a new start', async () => {
    queue.push({ status: 200, body: { stage: 'unavailable' } }, { status: 200, body: IDENTIFY });
    expect(await startFlow('login')).toEqual({ stage: 'unavailable' });
    expect(await startFlow('login')).toEqual(IDENTIFY);
    expect(calls.map((c) => c.url)).toEqual(['/auth/flow/start', '/auth/flow/start']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// passkeys

const b64url = (bytes: number[]) => Buffer.from(bytes).toString('base64url');
const buf = (bytes: number[]) => new Uint8Array(bytes).buffer;
const GET: PasskeyGet = { challenge: b64url([1, 2, 3, 250, 251]), rpId: 'friend.example.com', allowCredentials: [{ id: b64url([9, 8, 7]), type: 'public-key', transports: ['internal'] }], userVerification: 'preferred', timeout: 60000 };
const CREATE: PasskeyCreate = {
  challenge: b64url([4, 5, 6]), rp: { id: 'friend.example.com', name: 'FriendFlix' }, user: { id: b64url([7, 7]), name: 'anna', displayName: 'Anna' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }], excludeCredentials: [{ id: b64url([1]), type: 'public-key' }], attestation: 'none', timeout: 60000,
};

/** an assertion like the browser hands out, without toJSON (older browsers) */
function rawAssertion() {
  return {
    id: b64url([9, 8, 7]), rawId: buf([9, 8, 7]), type: 'public-key', authenticatorAttachment: 'platform',
    response: { clientDataJSON: buf([123, 125]), authenticatorData: buf([1]), signature: buf([2]), userHandle: buf([3]) },
    getClientExtensionResults: () => ({ credProps: { rk: true } }),
  };
}

function installWebAuthn(opts: { json?: boolean; get?: (o: unknown) => Promise<unknown>; create?: (o: unknown) => Promise<unknown> } = {}) {
  const seen: { get?: any; create?: any } = {};
  class PKC {}
  if (opts.json) {
    Object.assign(PKC, {
      parseRequestOptionsFromJSON: vi.fn((o: unknown) => ({ parsed: 'request', o })),
      parseCreationOptionsFromJSON: vi.fn((o: unknown) => ({ parsed: 'creation', o })),
    });
  }
  vi.stubGlobal('PublicKeyCredential', PKC);
  vi.stubGlobal('window', { PublicKeyCredential: PKC });
  vi.stubGlobal('navigator', {
    credentials: {
      get: vi.fn(async (o: { publicKey: unknown }) => { seen.get = o.publicKey; return opts.get ? opts.get(o) : rawAssertion(); }),
      create: vi.fn(async (o: { publicKey: unknown }) => { seen.create = o.publicKey; return opts.create ? opts.create(o) : null; }),
    },
  });
  return { seen, PKC };
}

describe('passkeys', () => {
  it('passkeyGet converts base64url options and returns JSON; NotAllowedError → passkey_cancelled', async () => {
    const { seen } = installWebAuthn();
    const cred = await passkeyGet(GET);
    expect(new Uint8Array(seen.get.challenge)).toEqual(new Uint8Array([1, 2, 3, 250, 251]));
    expect(new Uint8Array(seen.get.allowCredentials[0].id)).toEqual(new Uint8Array([9, 8, 7]));
    expect(seen.get).toMatchObject({ rpId: 'friend.example.com', userVerification: 'preferred', timeout: 60000, allowCredentials: [{ type: 'public-key', transports: ['internal'] }] });
    expect(cred).toEqual({
      id: b64url([9, 8, 7]), rawId: b64url([9, 8, 7]), type: 'public-key', authenticatorAttachment: 'platform',
      response: { clientDataJSON: b64url([123, 125]), authenticatorData: b64url([1]), signature: b64url([2]), userHandle: b64url([3]) },
      clientExtensionResults: {},
    });

    for (const name of ['NotAllowedError', 'AbortError']) {
      installWebAuthn({ get: async () => { throw Object.assign(new Error('x'), { name }); } });
      await expect(passkeyGet(GET)).rejects.toThrow('passkey_cancelled');
    }
    installWebAuthn({ get: async () => null });
    await expect(passkeyGet(GET)).rejects.toThrow('passkey_cancelled');
    installWebAuthn({ get: async () => { throw Object.assign(new Error('x'), { name: 'SecurityError' }); } });
    await expect(passkeyGet(GET)).rejects.toThrow('passkey_unsupported');
    installWebAuthn({ get: async () => { throw Object.assign(new Error('boom'), { name: 'UnknownError' }); } });
    await expect(passkeyGet(GET)).rejects.toThrow('boom');
  });

  it('uses the browser JSON helpers and toJSON where present, without publicKey and with empty clientExtensionResults', async () => {
    const json = {
      id: 'cred-1', rawId: 'cred-1', type: 'public-key', authenticatorAttachment: 'cross-platform',
      response: { clientDataJSON: 'cdj', attestationObject: 'att', authenticatorData: 'ad', transports: ['usb'], publicKey: 'pk', publicKeyAlgorithm: -7 },
      clientExtensionResults: { credProps: { rk: true } },
      extra: 'dropped',
    };
    const { seen, PKC } = installWebAuthn({ json: true, create: async () => ({ toJSON: () => json }) });
    const cred = await passkeyCreate(CREATE);
    expect((PKC as any).parseCreationOptionsFromJSON).toHaveBeenCalledWith(CREATE);
    expect(seen.create).toEqual({ parsed: 'creation', o: CREATE });
    expect(cred).toEqual({
      id: 'cred-1', rawId: 'cred-1', type: 'public-key', authenticatorAttachment: 'cross-platform',
      response: { clientDataJSON: 'cdj', attestationObject: 'att', authenticatorData: 'ad', transports: ['usb'] },
      clientExtensionResults: {},
    });
    installWebAuthn({ json: true, get: async () => ({ toJSON: () => ({ ...json, response: { clientDataJSON: 'c', userHandle: null } }) }) });
    expect((await passkeyGet(GET)).response).toEqual({ clientDataJSON: 'c', userHandle: null });
  });

  it('passkeyCreate converts the creation options without the JSON helpers', async () => {
    const att = {
      id: 'n1', rawId: buf([5]), type: 'public-key', authenticatorAttachment: null,
      response: { clientDataJSON: buf([1]), attestationObject: buf([2]), getTransports: () => ['internal', 7], getPublicKey: () => buf([9]) },
    };
    const { seen } = installWebAuthn({ create: async () => att });
    const cred = await passkeyCreate(CREATE);
    expect(new Uint8Array(seen.create.challenge)).toEqual(new Uint8Array([4, 5, 6]));
    expect(new Uint8Array(seen.create.user.id)).toEqual(new Uint8Array([7, 7]));
    expect(new Uint8Array(seen.create.excludeCredentials[0].id)).toEqual(new Uint8Array([1]));
    expect(seen.create).toMatchObject({ rp: CREATE.rp, user: { name: 'anna', displayName: 'Anna' }, attestation: 'none' });
    expect(cred).toEqual({ id: 'n1', rawId: b64url([5]), type: 'public-key', authenticatorAttachment: null, response: { clientDataJSON: b64url([1]), attestationObject: b64url([2]), transports: ['internal'] }, clientExtensionResults: {} });
    installWebAuthn({ create: async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); } });
    await expect(passkeyCreate(CREATE)).rejects.toThrow('passkey_cancelled');
  });

  it('no PublicKeyCredential → passkey_unsupported', async () => {
    vi.stubGlobal('window', {});
    await expect(passkeyGet(GET)).rejects.toThrow('passkey_unsupported');
    await expect(passkeyCreate(CREATE)).rejects.toThrow('passkey_unsupported');
  });

  it('credentialJSON drops unknown and malformed fields', () => {
    expect(credentialJSON({ toJSON: () => ({ id: 1, rawId: 'r', type: 'public-key', response: { clientDataJSON: 'c', signature: 5 } }) })).toEqual({
      id: '', rawId: 'r', type: 'public-key', response: { clientDataJSON: 'c' }, clientExtensionResults: {},
    });
    expect(credentialJSON({ toJSON: () => null })).toEqual({ id: '', rawId: '', type: 'public-key', response: { clientDataJSON: '' }, clientExtensionResults: {} });
  });
});
