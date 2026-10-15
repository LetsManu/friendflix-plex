// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Test helpers for the signed-in flows (re-authentication, security setup, e-mail change): a fake Authentik that serves one executor
 * flow per slug in the same session (the re-authentication continues in the follow-up flow with the same cookies), the admin API
 * answers the account routes need, and a browser that carries the flow csrf cookie and the session.
 */
import { expect } from 'vitest';
import type { Config } from '../src/config.js';
import { AK_URL, type AkCall, type FakeAuthentik, fakeAuthentik, type FakeStage, fixture } from './akflow-fake.js';
import type { TestEnv } from './helpers.js';

export const APP = 'https://friend.example.com';
export const ISSUER = 'https://auth.example.com/application/o/friendflix/';
export const AK_CFG: Partial<Config> = {
  AUTHENTIK_URL: AK_URL, AUTHENTIK_API_TOKEN: 'api-token-placeholder', OIDC_ISSUER: ISSUER, PUBLIC_URL: APP, LOGIN_UI: undefined, PASSKEYS_IN_APP: 'auto',
};
export const RIGHT = 'right-password-placeholder';
export const LOGIN = 'default-authentication-flow';

export const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** identification (the username only) → password (only RIGHT passes) → end */
export const loginStages = (): FakeStage[] => [
  { challenge: fixture('identification'), answer: (b: { uid_field?: string }) => (b.uid_field ? true : fixture('identification')) },
  { challenge: fixture('password'), answer: (b: { password?: string }) => (b.password === RIGHT ? true : fixture('password-invalid')), hops: 2 },
];

export interface Person { pk: number; username: string; email: string; uid: string }
export const ANNA: Person = { pk: 5, username: 'anna', email: 'admin@example.com', uid: 'sub-admin' };
export const BEN: Person = { pk: 6, username: 'ben', email: 'ben@elsewhere.example.com', uid: 'sub-ben' };

export interface Device { pk: number; type: string; name: string; confirmed?: boolean; owner: number }
export const TOTP_TYPE = 'authentik_stages_authenticator_totp.totpdevice';
export const STATIC_TYPE = 'authentik_stages_authenticator_static.staticdevice';
export const WEBAUTHN_TYPE = 'authentik_stages_authenticator_webauthn.webauthndevice';

export interface World {
  /** one fake executor per flow slug (all share the browser's cookies); `default-invalidation-flow` is always there */
  flows: Record<string, FakeStage[]>;
  people: Person[];
  devices: Device[];
  /** the login flow's bindings as the API lists them (the validate stage's not_configured_action) */
  /** the login flow's validate stage: deny (true), configure (false), Authentik down ('error'), the stage read refused ('forbidden') */
  mfaMandatory: boolean | 'error' | 'forbidden';
  /** every Authentik call in order */
  calls: AkCall[];
  /** DELETE calls on devices (type/id) */
  deleted: string[];
  fakes: Record<string, FakeAuthentik>;
}

/** installs the fake on the env; returns the world to inspect and change */
export function installWorld(env: TestEnv, flows: Record<string, FakeStage[]>, opts: { extraRoutes?: Parameters<typeof fakeAuthentik>[1] } = {}): World {
  const w: World = { flows, people: [ANNA, BEN], devices: [], mfaMandatory: false, calls: [], deleted: [], fakes: {} };
  const authorize = (call: AkCall) => new Response(null, {
    status: 302, headers: { location: `${APP}/auth/callback?code=c-placeholder&state=${call.url.searchParams.get('state')}` },
  });
  const api: Parameters<typeof fakeAuthentik>[1] = {
    'GET /application/o/authorize/': authorize,
    'GET /api/v3/core/users/': (c) => {
      const q = c.url.searchParams;
      const rows = w.people.filter((p) => (!q.get('username') || p.username === q.get('username')) && (!q.get('email') || p.email.toLowerCase() === q.get('email')!.toLowerCase()));
      return jsonResponse({ pagination: { next: 0 }, results: rows });
    },
    'GET /api/v3/authenticators/admin/all/': (c) => jsonResponse(
      w.devices.filter((d) => d.owner === Number(c.url.searchParams.get('user'))).map((d) => ({ pk: String(d.pk), type: d.type, name: d.name, confirmed: d.confirmed ?? true }))),
    'GET /application/o/friendflix/.well-known/openid-configuration': () => jsonResponse({ issuer: `${APP}/application/o/friendflix/` }),
    [`GET /api/v3/flows/instances/${LOGIN}/`]: () => (w.mfaMandatory === 'error' ? new Response('boom', { status: 500 }) : jsonResponse({ pk: 'flow-login' })),
    'GET /api/v3/flows/instances/friendflix-email-change/': () => jsonResponse({ pk: 'flow-email' }),
    'GET /api/v3/flows/bindings/': (c) => jsonResponse({
      results: c.url.searchParams.get('target') === 'flow-login'
        // like Authentik's bindings API: stage_obj is the base StageSerializer, without the validate stage's own settings
        ? [{ order: 10, stage: 'stage-validate', stage_obj: { component: 'ak-stage-authenticator-validate-form', meta_model_name: 'authentik_stages_authenticator_validate.authenticatorvalidatestage' } }]
        : [],
    }),
    // the validate stage's settings come only from its own endpoint (needs view_authenticatorvalidatestage)
    'GET /api/v3/stages/authenticator/validate/stage-validate/': () => (w.mfaMandatory === 'forbidden'
      ? new Response('{"detail":"no"}', { status: 403 })
      : jsonResponse({ pk: 'stage-validate', not_configured_action: w.mfaMandatory === true ? 'deny' : 'configure' })),
    ...opts.extraRoutes,
  };
  for (const kind of ['totp', 'static', 'webauthn']) {
    for (let id = 1; id < 100; id++) {
      api[`DELETE /api/v3/authenticators/admin/${kind}/${id}/`] = () => {
        w.deleted.push(`${kind}/${id}`);
        w.devices = w.devices.filter((d) => d.pk !== id);
        return new Response(null, { status: 204 });
      };
    }
  }
  const base = fakeAuthentik([], api);
  w.fakes.base = base;
  env.ctx.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    const m = /^\/api\/v3\/flows\/executor\/([^/]+)\/$/.exec(url.pathname);
    let target = base;
    if (m) {
      const slug = m[1]!;
      target = w.fakes[slug] ??= fakeAuthentik(w.flows[slug] ?? [], api);
    }
    const r = await target.fetch(input, init);
    w.calls.push(target.calls.at(-1)!);
    return r;
  }) as typeof fetch;
  return w;
}

export const executorPosts = (w: World, slug?: string) =>
  w.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/api/v3/flows/executor/') && (!slug || c.path === `/api/v3/flows/executor/${slug}/`));

let ipN = 0;
export const freshIp = () => `10.77.${Math.floor(++ipN / 250)}.${ipN % 250}`;

/** one browser: its cookies (incl. the FriendFlix session when given), IP, the flow csrf header and the session csrf token */
export function browser(env: TestEnv, session?: { cookies: Record<string, string>; csrf: string }) {
  const cookies: Record<string, string> = { ...session?.cookies };
  const ip = freshIp();
  const absorb = (r: { cookies: Array<{ name: string; value: string }> }) => {
    for (const c of r.cookies) {
      if (c.value) cookies[c.name] = c.value;
      else delete cookies[c.name];
    }
  };
  return {
    cookies,
    ip,
    async config() {
      const r = await env.app.inject({ url: '/auth/flow/config', cookies, remoteAddress: ip });
      absorb(r);
      return r;
    },
    async post(path: string, payload: unknown, opts: { csrf?: string | null; token?: string | null; headers?: Record<string, string> } = {}) {
      const csrf = opts.csrf === undefined ? cookies.ff_flow_csrf : opts.csrf;
      const token = opts.token === undefined ? session?.csrf : opts.token;
      const r = await env.app.inject({
        method: 'POST', url: `/auth/flow/${path}`, payload: payload as object, cookies, remoteAddress: ip,
        headers: { ...(csrf ? { 'x-ff-flow-csrf': csrf } : {}), ...(token ? { 'x-csrf-token': token } : {}), ...opts.headers },
      });
      absorb(r);
      return r;
    },
    /** start a re-authentication and walk it through the password; returns the answer to the password */
    async reauth(then?: string) {
      await this.config();
      const s = await this.post('start', { kind: 'reauth', ...(then ? { then } : {}) });
      expect(s.statusCode).toBe(200);
      const pw = s.json() as { stage: string; step: string };
      expect(pw.stage).toBe('password');
      return this.post('answer', { step: pw.step, stage: 'password', password: RIGHT });
    },
  };
}
