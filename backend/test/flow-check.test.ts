// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { lastAkFailures } from '../src/akdiag.js';
import { checkLoginFlows } from '../src/flowCheck.js';
import { MemoryKV } from '../src/kv.js';
import { cfg, fakeHttp, type Call, type Handler } from './helpers.js';

// Block 23 phase 3, Task 9: the sign-in status check over a fake Authentik API (fictional hosts, fake token).
const MODEL = {
  ident: 'authentik_stages_identification.identificationstage', password: 'authentik_stages_password.passwordstage',
  validate: 'authentik_stages_authenticator_validate.authenticatorvalidatestage', login: 'authentik_stages_user_login.userloginstage',
  email: 'authentik_stages_email.emailstage', prompt: 'authentik_stages_prompt.promptstage', consent: 'authentik_stages_consent.consentstage',
  captcha: 'authentik_stages_captcha.captchastage', logout: 'authentik_stages_user_logout.userlogoutstage',
  write: 'authentik_stages_user_write.userwritestage',
};
const OK_STAGES: Record<string, string[]> = {
  'default-authentication-flow': [MODEL.ident, MODEL.password, MODEL.validate, MODEL.login],
  'default-recovery-flow': [MODEL.ident, MODEL.email, MODEL.prompt],
  'default-invalidation-flow': [MODEL.logout],
  'default-authenticator-totp-setup': [MODEL.prompt],
  'default-authenticator-static-setup': [MODEL.prompt],
  'default-authenticator-webauthn-setup': [MODEL.prompt],
  'default-password-change': [MODEL.prompt],
  'friendflix-email-change': [MODEL.prompt, MODEL.email, MODEL.write],
  'default-provider-authorization-implicit-consent': [],
};

interface Opts {
  stages?: Record<string, string[] | null>; // null = flow missing
  provider?: { grant_types?: unknown; authorization_flow_obj?: { slug: string } } | null;
  issuer?: string; // what the discovery answers
  cfgOver?: Record<string, unknown>;
  down?: boolean;
  /** the token lacks view_oauth2provider / view_authenticatorvalidatestage: Authentik answers 403 */
  providerForbidden?: boolean;
  validateForbidden?: boolean;
  /** the service token: refused by Authentik altogether, or without some read permissions (403 on their list endpoints) */
  tokenInvalid?: boolean;
  missingPerms?: string[];
  /** the login flow's executor answer (default: the identification challenge) */
  executor?: ReturnType<Handler>;
}
const PERM_PATHS: Record<string, string> = {
  view_user: '/api/v3/core/users/', view_flow: '/api/v3/flows/instances/', view_flowstagebinding: '/api/v3/flows/bindings/',
  view_emailstage: '/api/v3/stages/email/', view_invitation: '/api/v3/stages/invitation/invitations/', view_totpdevice: '/api/v3/authenticators/admin/totp/',
  view_staticdevice: '/api/v3/authenticators/admin/static/', view_webauthndevice: '/api/v3/authenticators/admin/webauthn/',
  view_authenticatorvalidatestage: '/api/v3/stages/authenticator/validate/', view_oauth2provider: '/api/v3/providers/oauth2/',
};
function setup(o: Opts = {}) {
  const calls: Call[] = [];
  const stages = { ...OK_STAGES, ...o.stages };
  const denied = new Set(o.missingPerms ?? []);
  const perm = (name: string): ReturnType<Handler> => (denied.has(name) ? { status: 403, json: { detail: 'You do not have permission to perform this action.' } } : undefined);
  const lists: Record<string, Handler> = Object.fromEntries(Object.entries(PERM_PATHS)
    .filter(([n]) => !['view_flowstagebinding', 'view_oauth2provider'].includes(n))
    .map(([n, path]) => [`GET ${path}`, () => perm(n) ?? { json: { pagination: { next: 0 }, results: [] } }]));
  const routes: Record<string, Handler> = {
    ...lists,
    'GET /api/v3/core/users/me/': () => (o.tokenInvalid ? { status: 403, json: { detail: 'Token invalid/expired' } } : { json: { user: { pk: 9, username: 'friendflix-invites' } } }),
    'GET /api/v3/flows/executor/default-authentication-flow/': () => o.executor ?? { json: { component: 'ak-stage-identification', user_fields: ['username', 'email'] } },
    'GET /api/v3/flows/instances/[^/]+/': (u) => {
      const slug = decodeURIComponent(u.pathname.split('/')[5]!);
      return stages[slug] ? { json: { pk: `pk-${slug}`, slug } } : { status: 404, json: { detail: 'no' } };
    },
    'GET /api/v3/flows/bindings/': (u) => {
      if (denied.has('view_flowstagebinding')) return perm('view_flowstagebinding');
      if (!u.searchParams.get('target')) return { json: { pagination: { next: 0 }, results: [] } };
      const slug = (u.searchParams.get('target') ?? '').replace(/^pk-/, '');
      return { json: { pagination: { next: 0 }, results: (stages[slug] ?? []).map((m, i) => ({ order: i * 10, stage: `s${i}`, stage_obj: { component: `ak-stage-${i}-form`, meta_model_name: m } })) } };
    },
    'GET /api/v3/stages/authenticator/validate/[^/]+/': () => (o.validateForbidden ? { status: 403, json: { detail: 'no' } } : { json: { not_configured_action: 'configure' } }),
    'GET /api/v3/providers/oauth2/': () => (o.providerForbidden || denied.has('view_oauth2provider') ? { status: 403, json: { detail: 'no' } } : {
      json: { pagination: { next: 0 }, results: o.provider === null ? [] : [{ authorization_flow_obj: { slug: 'default-provider-authorization-implicit-consent' }, grant_types: ['authorization_code', 'refresh_token'], ...o.provider }] },
    }),
    'GET /application/o/friendflix/.well-known/openid-configuration': () => ({ json: { issuer: o.issuer ?? 'https://friend.example.com/application/o/friendflix/' } }),
  };
  const inner = fakeHttp(routes, calls);
  const fetchImpl = (o.down ? async () => { throw new Error('boom'); } : o.tokenInvalid ? (async (input: RequestInfo | URL, init?: RequestInit) => {
    // a refused token: every API call with it answers 403 (the executor and discovery need no token)
    const u = new URL(String(input));
    if (u.pathname.startsWith('/api/v3/') && !u.pathname.startsWith('/api/v3/flows/executor/')) {
      calls.push({ method: 'GET', path: u.pathname, search: u.search, body: undefined });
      return new Response(JSON.stringify({ detail: 'Token invalid/expired' }), { status: 403, headers: { 'content-type': 'application/json' } });
    }
    return inner(input, init);
  }) : inner) as typeof fetch;
  const ctx = {
    cfg: {
      ...cfg, AUTHENTIK_URL: 'https://auth.example.com', AUTHENTIK_API_TOKEN: 'ak-fake-token-0001', OIDC_ISSUER: 'https://auth.example.com/application/o/friendflix/',
      OIDC_CLIENT_ID: 'friendflix', PUBLIC_URL: 'https://friend.example.com', LOGIN_UI: undefined, AUTHENTIK_ENROLL_FLOW: undefined, ...o.cfgOver,
    },
    kv: new MemoryKV(), db: null, fetchImpl,
  } as unknown as Parameters<typeof checkLoginFlows>[0];
  return { ctx, calls };
}
const row = (r: Awaited<ReturnType<typeof checkLoginFlows>>, kind: string) => r.flows.find((f) => f.kind === kind)!;

describe('checkLoginFlows', () => {
  it('a healthy install: every flow ok, implicit consent, auth-code grant, same issuer origin, passkeys in-app, no warnings', async () => {
    const r = await checkLoginFlows(setup().ctx);
    expect(r).toMatchObject({
      mode: 'app', implicitConsent: true, authCodeGrant: true, issuerMatches: true, passkeys: 'in-app', passkeysReason: 'ok', unreachable: false, warnings: [],
      serviceToken: { token: 'ok', missing: [] }, executor: { ok: true }, lastFailures: [],
    });
    expect(r.flows.map((f) => [f.kind, f.state])).toEqual([
      ['login', 'ok'], ['recovery', 'ok'], ['invalidation', 'ok'], ['setup-totp', 'ok'], ['setup-static', 'ok'], ['setup-webauthn', 'ok'], ['change-password', 'ok'], ['change-email', 'ok'],
    ]);
    expect(row(r, 'login').stages).toEqual([MODEL.ident, MODEL.password, MODEL.validate, MODEL.login]);
  });

  it('missing flow -> missing', async () => {
    const r = await checkLoginFlows(setup({ stages: { 'default-recovery-flow': null } }).ctx);
    expect(row(r, 'recovery')).toEqual({ kind: 'recovery', slug: 'default-recovery-flow', state: 'missing', stages: [] });
    expect(r.warnings).toEqual(['flow_missing:recovery']);
    expect(r.mode).toBe('app'); // a failing check never changes the mode
  });

  it('the e-mail change flow (blueprint not imported, or a custom slug) is checked too; missing is no warning (an optional manual import)', async () => {
    const r = await checkLoginFlows(setup({ stages: { 'friendflix-email-change': null } }).ctx);
    expect(row(r, 'change-email')).toEqual({ kind: 'change-email', slug: 'friendflix-email-change', state: 'missing', stages: [] });
    expect(r.warnings).toEqual(['optional:change-email']); // a hint (template + repair), not a broken flow
    const odd = await checkLoginFlows(setup({ stages: { 'friendflix-email-change': [MODEL.prompt, MODEL.captcha] } }).ctx);
    expect(odd.warnings).toEqual(['flow_unsupported:change-email']);
    const custom = await checkLoginFlows(setup({ stages: { 'my-email-change': [MODEL.prompt, MODEL.email, MODEL.write] }, cfgOver: { AUTHENTIK_EMAIL_CHANGE_FLOW: 'my-email-change' } }).ctx);
    expect(row(custom, 'change-email')).toMatchObject({ slug: 'my-email-change', state: 'ok', stages: [MODEL.prompt, MODEL.email, MODEL.write] });
  });

  it('a token without view_oauth2provider (403): a distinct permission warning, never a silent pass of the consent and grant checks', async () => {
    const r = await checkLoginFlows(setup({ providerForbidden: true, stages: { 'default-provider-authorization-implicit-consent': [MODEL.consent] } }).ctx);
    expect([r.implicitConsent, r.authCodeGrant, r.unreachable]).toEqual([null, null, false]);
    expect(r.warnings).toEqual(['permission:provider']);
  });

  it('a token without view_authenticatorvalidatestage (403): a permission warning; the flow rows stay ok', async () => {
    const r = await checkLoginFlows(setup({ validateForbidden: true }).ctx);
    expect(row(r, 'login').state).toBe('ok');
    expect(r.unreachable).toBe(false);
    expect(r.warnings).toEqual(['permission:validate_stage']);
  });

  it('flow with a captcha stage -> unsupported with stages listed', async () => {
    const r = await checkLoginFlows(setup({ stages: { 'default-authentication-flow': [MODEL.ident, MODEL.captcha, MODEL.password] } }).ctx);
    expect(row(r, 'login')).toMatchObject({ state: 'unsupported', stages: [MODEL.ident, MODEL.captcha, MODEL.password] });
    expect(r.warnings).toContain('flow_unsupported:login');
  });

  it('bindings are classified by meta_model_name, not by the -form component', async () => {
    // the component says "email-form" for a stage whose model is not an e-mail stage, and the model decides
    const { ctx } = setup({ stages: { 'default-recovery-flow': [MODEL.ident, MODEL.email] } });
    const r = await checkLoginFlows(ctx);
    expect(row(r, 'recovery')).toMatchObject({ state: 'ok', stages: [MODEL.ident, MODEL.email] });
    const odd = await checkLoginFlows(setup({ stages: { 'default-recovery-flow': ['authentik_stages_email.somethingelse'] } }).ctx);
    expect(row(odd, 'recovery').state).toBe('unsupported');
  });

  it('explicit-consent authorization flow -> implicitConsent false', async () => {
    const r = await checkLoginFlows(setup({ stages: { 'default-provider-authorization-implicit-consent': [MODEL.consent] } }).ctx);
    expect(r.implicitConsent).toBe(false);
    expect(r.warnings).toContain('consent');
  });

  it('issuer on another host -> issuerMatches false', async () => {
    const r = await checkLoginFlows(setup({ cfgOver: { OIDC_ISSUER: 'https://sso.example.com/application/o/friendflix/' } }).ctx);
    expect(r.issuerMatches).toBe(false);
    expect(r.warnings).toContain('issuer');
  });

  it('provider with grant_types [] -> authCodeGrant false and a warning', async () => {
    const r = await checkLoginFlows(setup({ provider: { grant_types: [] } }).ctx);
    expect(r.authCodeGrant).toBe(false);
    expect(r.warnings).toContain('auth_code_grant');
    // objects with a name (other releases) count too; an answer without the field is unknown
    expect((await checkLoginFlows(setup({ provider: { grant_types: [{ name: 'authorization_code' }] } }).ctx)).authCodeGrant).toBe(true);
    expect((await checkLoginFlows(setup({ provider: { grant_types: undefined } }).ctx)).authCodeGrant).toBeNull();
    const none = await checkLoginFlows(setup({ provider: null }).ctx);
    expect([none.authCodeGrant, none.implicitConsent]).toEqual([null, null]);
  });

  it('discovery probe: issuer on the app host -> passkeys in-app; on Authentik\'s host -> sign-in page, forwarded_host_ignored', async () => {
    const ok = setup();
    expect(await checkLoginFlows(ok.ctx)).toMatchObject({ passkeys: 'in-app', passkeysReason: 'ok' });
    const probe = ok.calls.find((c) => c.path.endsWith('openid-configuration'))!;
    expect(probe.host).toBe('auth.example.com');
    const bad = await checkLoginFlows(setup({ issuer: 'https://auth.example.com/application/o/friendflix/' }).ctx);
    expect(bad).toMatchObject({ passkeys: 'sign-in page', passkeysReason: 'forwarded_host_ignored' });
    expect(bad.warnings).toContain('passkeys:forwarded_host_ignored');
  });

  it('PASSKEYS_IN_APP=off -> sign-in page, disabled, no probe call; http PUBLIC_URL -> not_https', async () => {
    const off = setup({ cfgOver: { PASSKEYS_IN_APP: 'off' } });
    expect(await checkLoginFlows(off.ctx)).toMatchObject({ passkeys: 'sign-in page', passkeysReason: 'disabled', warnings: [] });
    expect(off.calls.some((c) => c.path.endsWith('openid-configuration'))).toBe(false);
    const http = setup({ cfgOver: { PUBLIC_URL: 'http://friend.example.com' } });
    expect(await checkLoginFlows(http.ctx)).toMatchObject({ passkeys: 'sign-in page', passkeysReason: 'not_https' });
    expect(http.calls.some((c) => c.path.endsWith('openid-configuration'))).toBe(false);
  });

  it('no API -> mode authentik and flows []', async () => {
    const s = setup({ cfgOver: { AUTHENTIK_URL: undefined, AUTHENTIK_API_TOKEN: undefined } });
    expect(await checkLoginFlows(s.ctx)).toMatchObject({ mode: 'authentik', flows: [], implicitConsent: null, authCodeGrant: null, warnings: [] });
    expect(s.calls.filter((c) => c.path.startsWith('/api/v3'))).toEqual([]);
  });

  it('an unreachable Authentik is a warning, not a pile of "missing" flows', async () => {
    const r = await checkLoginFlows(setup({ down: true }).ctx);
    expect(r.unreachable).toBe(true);
    expect(r.warnings).toContain('unreachable');
    expect(r.warnings.some((w) => w.startsWith('flow_missing'))).toBe(false);
    expect(r.mode).toBe('app');
  });

  it('enrolment is checked when AUTHENTIK_ENROLL_FLOW is set; custom slugs are used', async () => {
    const r = await checkLoginFlows(setup({ cfgOver: { AUTHENTIK_ENROLL_FLOW: 'friendflix-enroll', AUTHENTIK_LOGIN_FLOW: 'my-login' }, stages: { 'friendflix-enroll': [MODEL.prompt], 'my-login': [MODEL.ident] } }).ctx);
    expect(row(r, 'enroll')).toMatchObject({ slug: 'friendflix-enroll', state: 'ok' });
    expect(row(r, 'login')).toMatchObject({ slug: 'my-login', state: 'ok' });
  });

  it('is cached for 10 minutes under a hash of its inputs', async () => {
    const s = setup();
    await checkLoginFlows(s.ctx);
    const n = s.calls.length;
    await checkLoginFlows(s.ctx);
    expect(s.calls.length).toBe(n);
    s.ctx.cfg = { ...s.ctx.cfg, AUTHENTIK_RECOVERY_FLOW: 'other-recovery' };
    await checkLoginFlows(s.ctx);
    expect(s.calls.length).toBeGreaterThan(n);
  });
});

describe('checkLoginFlows: service token and executor diagnostics (the 502 on /auth/flow/start)', () => {
  it('a token Authentik refuses: token:invalid, never "unreachable" and no missing-flow or permission noise', async () => {
    const r = await checkLoginFlows(setup({ tokenInvalid: true }).ctx);
    expect(r.serviceToken).toEqual({ token: 'invalid', missing: [] });
    expect(r.unreachable).toBe(false);
    expect(r.warnings).toEqual(['token:invalid']);
    expect(r.executor).toEqual({ ok: true }); // the sign-in itself needs no token
  });

  it('a service account without some read permissions: one permission warning each (the provider and validate reads keep their own codes)', async () => {
    const r = await checkLoginFlows(setup({ missingPerms: ['view_user', 'view_totpdevice', 'view_oauth2provider'] }).ctx);
    expect(r.serviceToken).toEqual({ token: 'ok', missing: ['view_user', 'view_totpdevice', 'view_oauth2provider'] });
    expect(r.warnings).toEqual(['permission:view_user', 'permission:view_totpdevice', 'permission:provider']);
  });

  it.each([
    ['an HTML page from a proxy', { raw: '<html>blocked</html>', type: 'text/html' }, 'non_json', 200],
    ['a 403 from a WAF', { status: 403, raw: '<html>no</html>', type: 'text/html' }, 'permission', 403],
    ['a redirect to https', { status: 301, raw: '', type: 'text/html' }, 'redirect', 301],
    ['a 500', { status: 500, json: { detail: 'x' } }, 'http_error', 500],
  ] as const)('the login flow executor fails from the server (%s): executor:<class> with status and endpoint, kept for 24 h', async (_n, answer, cls, status) => {
    const { ctx } = setup({ executor: answer as ReturnType<Handler> });
    const r = await checkLoginFlows(ctx);
    expect(r.executor).toEqual({ ok: false, cls, status, endpoint: 'api/v3/flows/executor/default-authentication-flow/' });
    expect(r.warnings).toContain(`executor:${cls}`);
    expect(await lastAkFailures(ctx)).toEqual([expect.objectContaining({ area: 'executor', cls, status, endpoint: 'api/v3/flows/executor/default-authentication-flow/' })]);
    expect(r.lastFailures).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain('ak-fake-token-0001');
  });

  it('a failing check is cached briefly only, and `fresh` skips the cache', async () => {
    const { ctx, calls } = setup({ tokenInvalid: true });
    await checkLoginFlows(ctx);
    const n = calls.length;
    await checkLoginFlows(ctx);
    expect(calls.length).toBe(n); // cached
    await checkLoginFlows(ctx, { fresh: true });
    expect(calls.length).toBeGreaterThan(n);
  });
});
