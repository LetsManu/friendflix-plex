// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fork: the in-app sign-in (upstream Block 23 phase 3, /auth/flow → resolveLogin) on Plex. Everything account-related runs through
 * the media seam, so on Plex an invite creates a synthetic identity with its role policy (plex_identities / plex_media_policies),
 * ended access at sign-in locks the account AND closes its Plex policy (expireAccess → setDisabled), a locked account gets no
 * session, and the cover wall served on the sign-in page leaks nothing Plex-internal. No Plex token in any answer.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { createInvite } from '../../src/invites.js';
import type { OidcClaims, OidcProvider } from '../../src/oidc.js';
import { provisionUser } from '../../src/users.js';
import { AK_URL, type AkCall, type FakeAuthentik, fakeAuthentik, type FakeStage, fixture } from '../akflow-fake.js';
import { makeEnv, type TestEnv } from '../helpers.js';
import { PLEX_TOKEN, PLEX_URL, PlexFake } from '../plexfake.js';

const AK: Partial<Config> = { AUTHENTIK_URL: AK_URL, AUTHENTIK_API_TOKEN: 'api-token-placeholder', OIDC_ISSUER: 'https://auth.example.com/application/o/friendflix/' };
const RIGHT = 'right-password-placeholder';
const AUTHORIZE = '/application/o/authorize/';

const loginStages = (): FakeStage[] => [
  { challenge: fixture('identification'), answer: (b: { uid_field?: string }) => (b.uid_field ? true : fixture('identification')) },
  { challenge: fixture('password'), answer: (b: { password?: string }) => (b.password === RIGHT ? true : fixture('password-invalid')), hops: 2 },
];
/** what Authentik answers a logged-in session: the browser-facing callback (on the test cfg's PUBLIC_URL) with the request's state */
const toCallback = (publicUrl: string) => (call: AkCall) => new Response(null, {
  status: 302, headers: { location: `${publicUrl}/auth/callback?code=c-placeholder&state=${call.url.searchParams.get('state')}` },
});

let ipN = 0;
const freshIp = () => `10.45.${Math.floor(++ipN / 250)}.${ipN % 250}`;
let subN = 0;
const person = (extra: Partial<OidcClaims> = {}): OidcClaims => {
  const n = ++subN;
  return { sub: `sub-plex-p${n}`, email: `plexperson${n}@example.com`, name: `Plex Person ${n}`, groups: [], ...extra };
};

describe('in-app sign-in on Plex', () => {
  let env: TestEnv;
  let ak: FakeAuthentik;
  const fake = new PlexFake();
  fake.addMovie({ title: 'Wall', rating: 'de/12' });
  const bodies: string[] = [];

  const oidc: OidcProvider = {
    async start() {
      const state = `st${Math.random().toString(36).slice(2)}`;
      const url = new URL(AUTHORIZE, 'https://auth.example.com');
      url.searchParams.set('state', state);
      url.searchParams.set('prompt', 'none');
      return { url: url.toString(), state, nonce: `n-${state}`, codeVerifier: `v-${state}` };
    },
    async finish(url, saved) {
      if (url.searchParams.get('state') !== saved.state) throw new Error('state mismatch');
      return { authTime: Math.floor(Date.now() / 1000), ...env.claims.current };
    },
  };

  beforeEach(async () => {
    env ??= await makeEnv({}, { server: 'plex', plexFake: fake, logger: { stream: { write: (m: string) => { if (process.env.DBG) console.log(m); } }, level: 'debug' } });
    env.ctx.cfg = { ...env.ctx.cfg, ...AK, LOGIN_UI: undefined, AUTHENTIK_ENROLL_FLOW: undefined };
    env.ctx.oidc = oidc;
    ak = fakeAuthentik(loginStages(), { [`GET ${AUTHORIZE}`]: toCallback(env.ctx.cfg.PUBLIC_URL!) });
    env.ctx.fetchImpl = ak.fetch;
  }, 60_000);
  afterAll(async () => {
    for (const b of bodies) {
      expect(b).not.toContain(PLEX_TOKEN);
      expect(b).not.toContain(PLEX_URL);
    }
    await env.close();
  });

  async function appLogin(claims: OidcClaims, opts: { invite?: string } = {}) {
    env.claims.current = claims;
    const cookies: Record<string, string> = {};
    const remoteAddress = freshIp();
    const absorb = (r: { body: string; headers: object; cookies: Array<{ name: string; value: string }> }) => {
      bodies.push(r.body, JSON.stringify(r.headers));
      for (const c of r.cookies) if (c.value) cookies[c.name] = c.value; else delete cookies[c.name];
    };
    const post = async (path: string, payload: object) => {
      const r = await env.app.inject({ method: 'POST', url: `/auth/flow/${path}`, payload, cookies, remoteAddress, headers: { 'x-ff-flow-csrf': cookies.ff_flow_csrf! } });
      absorb(r);
      return r;
    };
    absorb(await env.app.inject({ url: '/auth/flow/config', cookies, remoteAddress }));
    const s0 = (await post('start', { kind: 'login', ...(opts.invite ? { invite: opts.invite } : {}) })).json() as { step: string };
    const pw = (await post('answer', { step: s0.step, stage: 'identify', identifier: `${claims.sub}@example.com` })).json() as { step: string };
    const end = await post('answer', { step: pw.step, stage: 'password', password: RIGHT });
    return { body: end.json() as Record<string, unknown>, setCookies: end.cookies };
  }

  const userBySub = async (sub: string) => (await env.pool.query<{ id: string; role: string; disabled: boolean; locked_reason: string | null; jellyfin_user_id: string }>(
    'select id, role, disabled, locked_reason, jellyfin_user_id from users where authentik_sub=$1', [sub])).rows[0];
  const policy = async (identity: string) => (await env.pool.query<{ disabled: boolean; libraries: string[] | null }>(
    'select disabled, libraries from plex_media_policies where identity_id=$1', [identity])).rows[0];
  const anAdmin = async () => (await env.pool.query<{ id: string }>("select id from users where role='admin' order by created_at limit 1")).rows[0]?.id
    ?? (await provisionUser(env.ctx, person({ groups: ['friendflix-admins'] }), 'admin')).id;

  it('an invite creates the account with a synthetic Plex identity and the role policy, and signs in', async () => {
    const adminId = await anAdmin();
    const inv = await createInvite(env.ctx, adminId, { role: 'friend', ttlHours: 1, maxUses: 1 }, { warn: () => {} });
    const claims = person();
    const { body, setCookies } = await appLogin(claims, { invite: inv.token });
    expect(body).toEqual({ stage: 'done', next: '/' });
    expect(setCookies.find((c) => c.name === 'ff_sid')?.value).toBeTruthy();
    const u = (await userBySub(claims.sub))!;
    expect(u.role).toBe('friend');
    expect(u.jellyfin_user_id).toMatch(/^[0-9a-f]{32}$/);
    expect((await env.pool.query('select 1 from plex_identities where id=$1', [u.jellyfin_user_id])).rowCount).toBe(1);
    expect(await policy(u.jellyfin_user_id)).toMatchObject({ disabled: false });
  });

  it('ended access at sign-in locks the account and closes its Plex policy; no session', async () => {
    await anAdmin();
    const claims = person();
    const u = await provisionUser(env.ctx, claims, 'friend');
    expect(await policy(u.jellyfin_user_id)).toMatchObject({ disabled: false });
    await env.pool.query('update users set access_until=$2 where id=$1', [u.id, new Date(Date.now() - 60e3)]);
    const { body, setCookies } = await appLogin(claims);
    expect(body).toEqual({ stage: 'locked' });
    expect(setCookies.find((c) => c.name === 'ff_sid')).toBeUndefined();
    expect(await userBySub(claims.sub)).toMatchObject({ disabled: true, locked_reason: 'expired' });
    expect(await policy(u.jellyfin_user_id)).toMatchObject({ disabled: true });
  });

  it('the sign-in page\'s cover wall on Plex: paths only, nothing Plex-internal', async () => {
    const r = await env.app.inject('/api/public/login-art');
    bodies.push(r.body, JSON.stringify(r.headers));
    expect(r.statusCode).toBe(200);
    expect((r.json().images as string[]).length).toBeGreaterThan(0);
    for (const bad of ['9f1e', 'plex.test', '32400', '/library/']) expect(r.body).not.toContain(bad);
  });
});
