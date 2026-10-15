// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Jar } from '../src/akflow.js';
import type { Config } from '../src/config.js';
import { sha256 } from '../src/crypto.js';
import { createInvite } from '../src/invites.js';
import type { OidcClaims, OidcProvider } from '../src/oidc.js';
import { completeFlow, flowFailKey } from '../src/routes/authFlow.js';
import { HttpError, provisionUser } from '../src/users.js';
import { AK_URL, type AkCall, type FakeAuthentik, fakeAuthentik, type FakeStage, fixture } from './akflow-fake.js';
import { makeEnv, type TestEnv } from './helpers.js';

// Block 23 phase 3, Task 4: the end of an in-app sign-in (silent authorize, resolveLogin, issueSession, the Authentik session ended) and
// its parity with the classic /auth/callback (preflight D4): the same claims come to the same outcome on both paths.

const AK: Partial<Config> = { AUTHENTIK_URL: AK_URL, AUTHENTIK_API_TOKEN: 'api-token-placeholder', OIDC_ISSUER: 'https://auth.example.com/application/o/friendflix/' };
const RIGHT = 'right-password-placeholder';
const AUTHORIZE = '/application/o/authorize/';
const INVALIDATION = '/api/v3/flows/executor/default-invalidation-flow/';
const DAY = 86400e3;

const loginStages = (): FakeStage[] => [
  { challenge: fixture('identification'), answer: (b: { uid_field?: string }) => (b.uid_field ? true : fixture('identification')) },
  { challenge: fixture('password'), answer: (b: { password?: string }) => (b.password === RIGHT ? true : fixture('password-invalid')), hops: 2 },
];

let ipN = 0;
const freshIp = () => `10.44.${Math.floor(++ipN / 250)}.${ipN % 250}`;
let subN = 0;
const person = (extra: Partial<OidcClaims> = {}): OidcClaims => {
  const n = ++subN;
  return { sub: `sub-p${n}`, email: `person${n}@example.com`, name: `Person ${n}`, groups: [], ...extra };
};

type Authorize = (call: AkCall) => Response;
/** the browser-facing callback with a code for the state of the authorize request (what Authentik answers a logged-in session) */
const toCallback: Authorize = (call) => new Response(null, {
  status: 302, headers: { location: `https://portal.example.com/auth/callback?code=c-placeholder&state=${call.url.searchParams.get('state')}` },
});

describe('finishing a sign-in', () => {
  let env: TestEnv;
  let ak: FakeAuthentik;
  let authorize: Authorize = toCallback;
  const starts: Array<{ silent?: boolean; forceLogin?: boolean }> = [];
  const finishes: Array<{ url: URL; state: string }> = [];
  const logs: string[] = [];

  /** an OIDC fake that checks the state like openid-client does (the code exchange itself is the library's) */
  const oidc: OidcProvider = {
    async start(o) {
      starts.push({ ...o });
      const state = `st${Math.random().toString(36).slice(2)}`;
      const url = new URL(AUTHORIZE, 'https://auth.example.com');
      url.searchParams.set('state', state);
      if (o?.silent) url.searchParams.set('prompt', 'none');
      return { url: url.toString(), state, nonce: `n-${state}`, codeVerifier: `v-${state}` };
    },
    async finish(url, saved) {
      finishes.push({ url, state: saved.state });
      if (url.searchParams.get('state') !== saved.state || saved.nonce !== `n-${saved.state}` || saved.codeVerifier !== `v-${saved.state}`) throw new Error('state mismatch');
      return { authTime: Math.floor(Date.now() / 1000), ...env.claims.current };
    },
  };

  const useFake = (stages: FakeStage[] = loginStages()) => {
    ak = fakeAuthentik(stages, { [`GET ${AUTHORIZE}`]: (c) => authorize(c) });
    env.ctx.fetchImpl = ak.fetch;
    return ak;
  };

  beforeEach(async () => {
    env ??= await makeEnv({}, { logger: { stream: { write: (m: string) => { logs.push(m); } }, level: 'trace' } });
    env.ctx.cfg = { ...env.ctx.cfg, ...AK, LOGIN_UI: undefined, AUTHENTIK_ENROLL_FLOW: undefined };
    env.ctx.oidc = oidc;
    authorize = toCallback;
    starts.length = 0;
    finishes.length = 0;
    useFake();
  });
  afterAll(() => env.close());

  /** one in-app sign-in through /auth/flow: identification → password → end; returns the final answer and the browser's cookies */
  async function appLogin(claims: OidcClaims, opts: { invite?: string; kind?: 'login' | 'enroll'; cookies?: Record<string, string> } = {}) {
    env.claims.current = claims;
    const cookies: Record<string, string> = { ...opts.cookies };
    const remoteAddress = freshIp();
    const absorb = (r: { cookies: Array<{ name: string; value: string }> }) => {
      for (const c of r.cookies) if (c.value) cookies[c.name] = c.value; else delete cookies[c.name];
    };
    const post = async (path: string, payload: object) => {
      const r = await env.app.inject({ method: 'POST', url: `/auth/flow/${path}`, payload, cookies, remoteAddress, headers: { 'x-ff-flow-csrf': cookies.ff_flow_csrf! } });
      absorb(r);
      return r;
    };
    absorb(await env.app.inject({ url: '/auth/flow/config', cookies, remoteAddress }));
    const s0 = (await post('start', { kind: opts.kind ?? 'login', ...(opts.invite ? { invite: opts.invite } : {}) })).json() as { step: string; stage: string };
    expect(s0.stage).toBe('identify');
    const flowId = cookies.ff_flow!;
    const pw = (await post('answer', { step: s0.step, stage: 'identify', identifier: `${claims.sub}@example.com` })).json() as { step: string };
    const end = await post('answer', { step: pw.step, stage: 'password', password: RIGHT });
    return { res: end, body: end.json() as Record<string, unknown>, cookies, flowId, setCookies: end.cookies };
  }

  /** the classic sign-in: /auth/login?classic=1 → (IdP) → /auth/callback with the same claims */
  async function classicLogin(claims: OidcClaims, opts: { invite?: string; cookies?: Record<string, string> } = {}) {
    env.claims.current = claims;
    const remoteAddress = freshIp();
    const l = await env.app.inject({ url: `/auth/login?classic=1${opts.invite ? `&invite=${opts.invite}` : ''}`, remoteAddress });
    const state = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
    const cb = await env.app.inject({ url: `/auth/callback?state=${state}&code=c-placeholder`, cookies: { ...opts.cookies, ff_oidc: state }, remoteAddress });
    return cb;
  }

  const userBySub = async (sub: string) => (await env.pool.query<{ id: string; role: string; disabled: boolean; locked_reason: string | null }>(
    'select id, role, disabled, locked_reason from users where authentik_sub=$1', [sub])).rows[0];
  const auditsFor = async (action: string, target: string) => (await env.pool.query<{ meta: Record<string, unknown> }>(
    'select meta from audit_log where action=$1 and target=$2 order by id', [action, target])).rows.map((r) => r.meta);
  const anAdmin = async () => (await env.pool.query<{ id: string }>("select id from users where role='admin' order by created_at limit 1")).rows[0]?.id
    ?? (await provisionUser(env.ctx, person({ groups: ['friendflix-admins'] }), 'admin')).id;

  it('silent authorize carries the jar cookie and yields a session', async () => {
    const claims = person();
    const user = await provisionUser(env.ctx, claims, 'friend');
    const { body, setCookies, flowId } = await appLogin(claims);
    expect(body).toEqual({ stage: 'done', next: '/' });
    const sid = setCookies.find((c) => c.name === 'ff_sid');
    expect(sid?.value).toBeTruthy();
    expect([sid!.httpOnly, sid!.sameSite, sid!.path]).toEqual([true, 'Lax', '/']);
    expect((await env.app.inject({ url: '/api/me', cookies: { ff_sid: sid!.value } })).json()).toMatchObject({ id: user.id });
    // the authorize request: prompt=none, the jar's Authentik session, on the browser-facing issuer origin, no forwarded host
    expect(starts).toEqual([{ silent: true }]);
    const az = ak.calls.find((c) => c.path === AUTHORIZE)!;
    expect(az.url.origin).toBe('https://auth.example.com');
    expect(az.url.searchParams.get('prompt')).toBe('none');
    expect(az.headers.cookie).toMatch(/authentik_session=/);
    expect(az.headers['x-forwarded-host']).toBeUndefined();
    // the code exchange got the callback URL Authentik named, with this start's state
    expect(finishes).toHaveLength(1);
    expect(finishes[0]!.url.origin + finishes[0]!.url.pathname).toBe('https://portal.example.com/auth/callback');
    expect(finishes[0]!.url.searchParams.get('state')).toBe(finishes[0]!.state);
    // the FriendFlix session first, then the Authentik session ended; the jar is gone, the flow cookie cleared
    const order = ak.calls.map((c) => c.path).filter((p) => p === AUTHORIZE || p === INVALIDATION);
    expect(order).toEqual([AUTHORIZE, INVALIDATION]);
    expect(ak.calls.find((c) => c.path === INVALIDATION)!.headers.cookie).toMatch(/authentik_session=/);
    expect(await env.kv.get(`akflow:${sha256(flowId)}`)).toBeNull();
    expect(setCookies.find((c) => c.name === 'ff_flow')?.value).toBe('');
    expect(await auditsFor('login', user.id)).toEqual([expect.objectContaining({ ui: 'app' })]);
    // nothing secret in the answer or the log
    const text = JSON.stringify(body) + logs.join('');
    for (const secret of ['c-placeholder', RIGHT, 'authentik_session=s', sid!.value]) expect(text).not.toContain(secret);
  });

  it('unknown user without invite → pending, ff_pending cookie set, one approval request', async () => {
    const claims = person();
    const { body, setCookies } = await appLogin(claims);
    expect(body).toEqual({ stage: 'done', next: '/pending' });
    expect(setCookies.find((c) => c.name === 'ff_pending')?.value).toBeTruthy();
    expect(setCookies.find((c) => c.name === 'ff_sid')).toBeUndefined();
    expect((await env.pool.query('select 1 from approval_requests where authentik_sub=$1', [claims.sub])).rowCount).toBe(1);
    expect(await userBySub(claims.sub)).toBeUndefined();
    const pending = setCookies.find((c) => c.name === 'ff_pending')!.value;
    expect((await env.app.inject({ url: '/api/pending', cookies: { ff_pending: pending } })).json()).toEqual({ state: 'pending' });
    expect(ak.calls.some((c) => c.path === INVALIDATION)).toBe(true);
  });

  it('with invite → account provisioned and the invite use recorded (login and enrolment)', async () => {
    const adminId = await anAdmin();
    const inv = await createInvite(env.ctx, adminId, { role: 'friend', ttlHours: 1, maxUses: 2 }, { warn: () => {} });
    const a = person();
    expect((await appLogin(a, { invite: inv.token })).body).toEqual({ stage: 'done', next: '/' });
    const ua = (await userBySub(a.sub))!;
    expect(ua.role).toBe('friend');
    // enrolment: the jar keeps the portal invite (P16), so the new account is not sent to the approval queue
    env.ctx.cfg = { ...env.ctx.cfg, AUTHENTIK_ENROLL_FLOW: 'default-enrollment-flow' };
    await env.pool.query("update invites set authentik_invite='a0000000-0000-4000-8000-000000000001' where id=$1", [inv.id]);
    useFake();
    const b = person();
    expect((await appLogin(b, { invite: inv.token, kind: 'enroll' })).body).toEqual({ stage: 'done', next: '/' });
    const ub = (await userBySub(b.sub))!;
    const uses = (await env.pool.query<{ user_id: string }>('select user_id from invite_uses where invite_id=$1 order by at', [inv.id])).rows.map((r) => r.user_id);
    expect(uses).toEqual([ua.id, ub.id]);
    expect((await env.pool.query('select 1 from approval_requests where authentik_sub = any($1)', [[a.sub, b.sub]])).rowCount).toBe(0);
  });

  it('disabled user → locked', async () => {
    const claims = person();
    const u = await provisionUser(env.ctx, claims, 'friend');
    await env.pool.query("update users set disabled=true, locked_reason='manual' where id=$1", [u.id]);
    const { body, setCookies } = await appLogin(claims);
    expect(body).toEqual({ stage: 'locked' });
    expect(setCookies.find((c) => c.name === 'ff_sid')).toBeUndefined();
    expect(ak.calls.some((c) => c.path === INVALIDATION)).toBe(true);
  });

  it('access_until in the past → locked, users.disabled=true, locked_reason=expired, audit user.expired, no ff_sid', async () => {
    await anAdmin();
    const claims = person();
    const u = await provisionUser(env.ctx, claims, 'friend');
    const until = new Date(Date.now() - 60e3);
    await env.pool.query('update users set access_until=$2 where id=$1', [u.id, until]);
    const { body, setCookies } = await appLogin(claims);
    expect(body).toEqual({ stage: 'locked' });
    expect(setCookies.find((c) => c.name === 'ff_sid')).toBeUndefined();
    expect(await userBySub(claims.sub)).toMatchObject({ disabled: true, locked_reason: 'expired' });
    expect(await auditsFor('user.expired', u.id)).toEqual([{ accessUntil: until.toISOString() }]);
    expect(await auditsFor('login', u.id)).toEqual([]);
    // the person is told like by the expiry tick
    expect((await env.pool.query("select 1 from notifications where user_id=$1 and kind='access_ended'", [u.id])).rowCount).toBe(1);
  });

  it('access_until in the past for the last active admin → the admin signs in, the skip is audited (expireAccess guard)', async () => {
    const claims = person({ groups: ['friendflix-admins'] });
    const u = await provisionUser(env.ctx, claims, 'admin');
    const others = (await env.pool.query<{ id: string }>("update users set role='friend' where role='admin' and id<>$1 returning id", [u.id])).rows.map((r) => r.id);
    try {
      await env.pool.query('update users set access_until=$2 where id=$1', [u.id, new Date(Date.now() - 60e3)]);
      const { body } = await appLogin(claims);
      expect(body).toEqual({ stage: 'done', next: '/' });
      expect(await userBySub(claims.sub)).toMatchObject({ disabled: false, locked_reason: null, role: 'admin' });
      expect(await auditsFor('user.expiry_skipped_last_admin', u.id)).toHaveLength(1);
      expect(await auditsFor('user.expired', u.id)).toEqual([]);
    } finally {
      await env.pool.query("update users set role='admin' where id = any($1::uuid[])", [others]);
      await env.pool.query('update users set access_until=null where id=$1', [u.id]);
    }
  });

  it('deletion grace → restore (ff_restore cookie); a claimed deletion → locked', async () => {
    const a = person();
    const ua = await provisionUser(env.ctx, a, 'friend');
    await env.pool.query("update users set disabled=true, locked_reason='deletion', deletion_at=$2 where id=$1", [ua.id, new Date(Date.now() + 7 * DAY)]);
    const r = await appLogin(a);
    expect(r.body).toEqual({ stage: 'done', next: '/restore' });
    const restore = r.setCookies.find((c) => c.name === 'ff_restore')!.value;
    expect((await env.app.inject({ url: '/api/restore', cookies: { ff_restore: restore } })).json()).toMatchObject({ state: 'scheduled' });
    useFake();
    const b = person();
    await env.pool.query("insert into account_deletions(user_id, pseudonym, authentik_sub) values ($1, 'deleted-y', $2)", [crypto.randomUUID(), b.sub]);
    expect((await appLogin(b)).body).toEqual({ stage: 'locked' });
    expect(await userBySub(b.sub)).toBeUndefined();
    expect((await env.pool.query('select 1 from approval_requests where authentik_sub=$1', [b.sub])).rowCount).toBe(0);
  });

  it('authorize redirects to an authorization flow → classic consent', async () => {
    const claims = person();
    await provisionUser(env.ctx, claims, 'friend');
    authorize = () => new Response(null, { status: 302, headers: { location: 'https://auth.example.com/if/flow/default-provider-authorization-explicit-consent/?next=%2F' } });
    const r = await appLogin(claims);
    expect(r.body).toEqual({ stage: 'classic', reason: 'consent' });
    expect(r.setCookies.find((c) => c.name === 'ff_sid')).toBeUndefined();
    expect(finishes).toHaveLength(0);
    expect(ak.calls.some((c) => c.path === INVALIDATION)).toBe(true);
    expect(await env.kv.get(`akflow:${sha256(r.flowId)}`)).toBeNull();
    // the Authentik URL never reaches the browser
    expect(r.res.body).not.toContain('auth.example.com');
  });

  it('authorize errors: consent_required → classic, login_required or a foreign state → unavailable; nothing is exchanged', async () => {
    const claims = person();
    await provisionUser(env.ctx, claims, 'friend');
    const cb = (q: string) => () => new Response(null, { status: 302, headers: { location: `https://portal.example.com/auth/callback?${q}` } });
    const cases: Array<[Authorize, unknown]> = [
      [cb('error=consent_required&state=x'), { stage: 'classic', reason: 'consent' }],
      [cb('error=login_required&state=x'), { stage: 'unavailable' }],
      [cb('error=invalid_request'), { stage: 'unavailable' }],
      [cb('code=c-placeholder&state=planted-state'), { stage: 'unavailable' }],
      [cb('code=c-placeholder'), { stage: 'unavailable' }],
      // not the app's callback: another host, another path, a look-alike prefix
      [() => new Response(null, { status: 302, headers: { location: 'https://portal.example.com.evil.example/auth/callback?code=c' } }), { stage: 'unavailable' }],
      [() => new Response(null, { status: 302, headers: { location: 'https://portal.example.com/auth/callbackx?code=c' } }), { stage: 'unavailable' }],
      [() => new Response(null, { status: 302, headers: { location: 'http://[bad' } }), { stage: 'unavailable' }],
      [() => new Response(null, { status: 302 }), { stage: 'unavailable' }],
      [() => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }), { stage: 'unavailable' }],
    ];
    for (const [answer, want] of cases) {
      authorize = answer;
      useFake();
      const r = await appLogin(claims);
      expect(r.body).toEqual(want);
      expect(r.setCookies.find((c) => c.name === 'ff_sid')).toBeUndefined();
      expect(ak.calls.some((c) => c.path === INVALIDATION)).toBe(true);
      expect(await env.kv.get(`akflow:${sha256(r.flowId)}`)).toBeNull();
    }
    expect(finishes).toHaveLength(0);
  });

  it('OIDC unavailable, a refused code exchange or a failing provisioning → unavailable, the Authentik session still ended', async () => {
    const claims = person();
    await provisionUser(env.ctx, claims, 'friend');
    const failing = (err: unknown): OidcProvider => ({ start: oidc.start, finish: async () => { throw err; } });
    for (const p of [
      { start: async () => { throw new HttpError(503, 'oidc_unavailable'); }, finish: oidc.finish } as OidcProvider,
      failing(new Error('invalid_grant (code: c-placeholder)')),
    ]) {
      env.ctx.oidc = p;
      useFake();
      const r = await appLogin(claims);
      expect(r.body).toEqual({ stage: 'unavailable' });
      expect(r.setCookies.find((c) => c.name === 'ff_sid')).toBeUndefined();
      expect(ak.calls.some((c) => c.path === INVALIDATION)).toBe(true);
    }
    env.ctx.oidc = oidc;
    // a new account whose media server user cannot be created: no account, no session
    const fresh = person({ groups: ['friendflix-admins'] });
    const jf = env.ctx.jf.admin;
    const create = jf.createIdentity.bind(jf);
    jf.createIdentity = async () => { throw new HttpError(502, 'jellyfin_error'); };
    try {
      useFake();
      expect((await appLogin(fresh)).body).toEqual({ stage: 'unavailable' });
    } finally {
      jf.createIdentity = create;
    }
    expect(await userBySub(fresh.sub)).toBeUndefined();
    expect(logs.join('')).not.toContain('c-placeholder');
    expect(logs.some((l) => l.includes('"code":"oidc_unavailable"'))).toBe(true);
  });

  it('the invalidation flow is called and the jar is gone after done; a recovery end → /login?reset=1 without a session', async () => {
    const claims = person();
    await provisionUser(env.ctx, claims, 'friend');
    const r = await appLogin(claims);
    expect(r.body).toMatchObject({ stage: 'done' });
    const inval = ak.calls.filter((c) => c.path === INVALIDATION);
    expect(inval).toHaveLength(1);
    expect(await env.kv.get(`akflow:${sha256(r.flowId)}`)).toBeNull();
    // the same flow id is finished: another answer finds no jar
    const again = await env.app.inject({ method: 'POST', url: '/auth/flow/answer', payload: { step: 'x', stage: 'password', password: RIGHT },
      cookies: { ...r.cookies, ff_flow: r.flowId }, headers: { 'x-ff-flow-csrf': r.cookies.ff_flow_csrf! }, remoteAddress: freshIp() });
    expect(again.json()).toEqual({ stage: 'expired' });

    // recovery: identification → (end); no authorize, no session
    useFake([{ challenge: fixture('identification-recovery') }]);
    const cookies: Record<string, string> = {};
    const ip = freshIp();
    const cfgR = await env.app.inject({ url: '/auth/flow/config', remoteAddress: ip });
    for (const c of cfgR.cookies) cookies[c.name] = c.value;
    const st = await env.app.inject({ method: 'POST', url: '/auth/flow/start', payload: { kind: 'recovery' }, cookies, headers: { 'x-ff-flow-csrf': cookies.ff_flow_csrf! }, remoteAddress: ip });
    for (const c of st.cookies) cookies[c.name] = c.value;
    const step = st.json() as { step: string; stage: string };
    expect(step.stage).toBe('identify');
    const done = await env.app.inject({ method: 'POST', url: '/auth/flow/answer', payload: { step: step.step, stage: 'identify', identifier: 'anna@example.com' }, cookies, headers: { 'x-ff-flow-csrf': cookies.ff_flow_csrf! }, remoteAddress: ip });
    expect(done.json()).toEqual({ stage: 'done', next: '/login?reset=1' });
    expect(done.cookies.find((c) => c.name === 'ff_sid')).toBeUndefined();
    expect(ak.calls.some((c) => c.path === AUTHORIZE)).toBe(false);
    expect(ak.calls.some((c) => c.path === INVALIDATION)).toBe(true);
  });

  it('a reserved slot goes back only when the flow moved on: a denial after a password keeps it, an MFA step gives it back', async () => {
    const run = async (after: FakeStage, id: string) => {
      useFake([loginStages()[0]!, { challenge: fixture('password'), answer: () => true }, after]);
      const cookies: Record<string, string> = {};
      const ip = freshIp();
      const post = async (path: string, payload: object) => {
        const r = await env.app.inject({ method: 'POST', url: `/auth/flow/${path}`, payload, cookies, headers: { 'x-ff-flow-csrf': cookies.ff_flow_csrf! }, remoteAddress: ip });
        for (const c of r.cookies) if (c.value) cookies[c.name] = c.value; else delete cookies[c.name];
        return r;
      };
      for (const c of (await env.app.inject({ url: '/auth/flow/config', remoteAddress: ip })).cookies) cookies[c.name] = c.value;
      const s0 = (await post('start', { kind: 'login' })).json() as { step: string };
      const pw = (await post('answer', { step: s0.step, stage: 'identify', identifier: id })).json() as { step: string };
      return (await post('answer', { step: pw.step, stage: 'password', password: RIGHT })).json() as { stage: string };
    };
    expect((await run({ challenge: fixture('access-denied') }, 'ida')).stage).toBe('denied');
    expect(await env.kv.get(flowFailKey('ida'))).toBe('1');
    expect((await run({ challenge: fixture('validate-all') }, 'ivo')).stage).toBe('mfa');
    expect(Number((await env.kv.get(flowFailKey('ivo'))) ?? 0)).toBe(0);
    // a restart (identification again) is no progress either
    expect((await run({ challenge: fixture('identification') }, 'ina')).stage).toBe('identify');
    expect(await env.kv.get(flowFailKey('ina'))).toBe('1');
  });

  it('completeFlow refuses during setup (defence in depth behind the gate) and for kinds it does not finish', async () => {
    const setupEnv = await makeEnv({}, { setupComplete: false });
    try {
      setupEnv.ctx.cfg = { ...setupEnv.ctx.cfg, ...AK };
      const fake = fakeAuthentik([]);
      setupEnv.ctx.fetchImpl = fake.fetch;
      const req = { log: { warn: () => {} }, routeOptions: { url: '/auth/flow/answer' }, cookies: {}, ip: '10.0.0.1' } as unknown as FastifyRequest;
      const reply = { setCookie: () => { throw new Error('no cookie may be set'); } } as unknown as FastifyReply;
      const jar = (kind: Jar['kind']): Jar => ({ cookies: { authentik_session: 'sess-placeholder' }, slug: 'x', query: '', kind, createdAt: Date.now(), step: 's', challenges: 2, forwardHost: false });
      await setupEnv.kv.set(`akflow:${sha256('fid')}`, 'x', 600);
      expect(await completeFlow(setupEnv.ctx, req, reply, 'fid', jar('login'))).toEqual({ stage: 'classic', reason: 'unsupported_stage' });
      expect(await setupEnv.kv.get(`akflow:${sha256('fid')}`)).toBeNull();
      expect(await completeFlow(setupEnv.ctx, req, reply, 'fid', jar('reauth'))).toEqual({ stage: 'unavailable' });
      expect(fake.calls.filter((c) => c.path === INVALIDATION)).toHaveLength(2);
      expect(fake.calls.some((c) => c.path === AUTHORIZE)).toBe(false);
      expect((await setupEnv.pool.query('select 1 from users')).rowCount).toBe(0);
    } finally {
      await setupEnv.close();
    }
  });

  describe('parity: the same claims come to the same outcome on both paths', () => {
    type Outcome = 'session' | 'pending' | 'restore' | 'refused:disabled' | 'refused:account_deleted';
    type Case = { name: string; claims: () => OidcClaims; prepare?: (c: OidcClaims) => Promise<{ invite?: string }>; want: Outcome; check?: (c: OidcClaims) => Promise<unknown> };

    const appOutcome = (b: Record<string, unknown>, deleted: boolean): Outcome | string => {
      if (b.stage === 'done') return b.next === '/' ? 'session' : b.next === '/pending' ? 'pending' : b.next === '/restore' ? 'restore' : `done:${String(b.next)}`;
      if (b.stage === 'locked') return deleted ? 'refused:account_deleted' : 'refused:disabled';
      return JSON.stringify(b);
    };
    const classicOutcome = (r: { statusCode: number; headers: Record<string, unknown>; json: () => { error?: string } }): Outcome | string => {
      if (r.statusCode === 302) return r.headers.location === '/' ? 'session' : r.headers.location === '/pending' ? 'pending' : r.headers.location === '/restore' ? 'restore' : `302:${String(r.headers.location)}`;
      return r.statusCode === 403 ? `refused:${r.json().error}` : `${r.statusCode}`;
    };

    const cases: Case[] = [
      { name: 'known user', claims: () => person(), prepare: async (c) => { await provisionUser(env.ctx, c, 'friend'); return {}; }, want: 'session' },
      { name: 'unknown, no invite', claims: () => person(), want: 'pending',
        check: async (c) => expect((await env.pool.query('select 1 from approval_requests where authentik_sub=$1', [c.sub])).rowCount).toBe(1) },
      { name: 'unknown, admin group', claims: () => person({ groups: ['friendflix-admins'] }), want: 'session',
        check: async (c) => expect(await userBySub(c.sub)).toMatchObject({ role: 'admin' }) },
      { name: 'unknown, valid invite', claims: () => person(), want: 'session',
        prepare: async () => ({ invite: (await createInvite(env.ctx, await anAdmin(), { role: 'friend', ttlHours: 1 }, { warn: () => {} })).token }),
        check: async (c) => expect((await env.pool.query('select 1 from invite_uses u join users x on x.id=u.user_id where x.authentik_sub=$1', [c.sub])).rowCount).toBe(1) },
      { name: 'known user in the admin group is promoted', claims: () => person({ groups: ['friendflix-admins'] }), want: 'session',
        prepare: async (c) => { await provisionUser(env.ctx, c, 'friend'); return {}; },
        check: async (c) => expect(await userBySub(c.sub)).toMatchObject({ role: 'admin' }) },
      { name: 'locked by an admin', claims: () => person(), want: 'refused:disabled',
        prepare: async (c) => { const u = await provisionUser(env.ctx, c, 'friend'); await env.pool.query("update users set disabled=true, locked_reason='manual' where id=$1", [u.id]); return {}; } },
      { name: 'access ended', claims: () => person(), want: 'refused:disabled',
        prepare: async (c) => { await anAdmin(); const u = await provisionUser(env.ctx, c, 'friend'); await env.pool.query('update users set access_until=$2 where id=$1', [u.id, new Date(Date.now() - 1000)]); return {}; },
        check: async (c) => expect(await userBySub(c.sub)).toMatchObject({ disabled: true, locked_reason: 'expired' }) },
      { name: 'deletion grace period', claims: () => person(), want: 'restore',
        prepare: async (c) => { const u = await provisionUser(env.ctx, c, 'friend'); await env.pool.query("update users set disabled=true, locked_reason='deletion', deletion_at=$2 where id=$1", [u.id, new Date(Date.now() + DAY)]); return {}; } },
      { name: 'deletion past its date', claims: () => person(), want: 'refused:disabled',
        prepare: async (c) => { const u = await provisionUser(env.ctx, c, 'friend'); await env.pool.query("update users set disabled=true, locked_reason='deletion', deletion_at=$2 where id=$1", [u.id, new Date(Date.now() - DAY)]); return {}; } },
      { name: 'deletion in progress', claims: () => person(), want: 'refused:account_deleted',
        prepare: async (c) => { await env.pool.query("insert into account_deletions(user_id, pseudonym, authentik_sub) values ($1, 'deleted-z', $2)", [crypto.randomUUID(), c.sub]); return {}; },
        check: async (c) => expect(await userBySub(c.sub)).toBeUndefined() },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const results: Record<string, unknown> = {};
        for (const path of ['classic', 'app'] as const) {
          const claims = c.claims();
          const { invite } = (await c.prepare?.(claims)) ?? {};
          const deleted = c.want === 'refused:account_deleted';
          let sid: string | undefined;
          if (path === 'classic') {
            const r = await classicLogin(claims, { invite });
            results.classic = classicOutcome(r);
            sid = r.cookies.find((x) => x.name === 'ff_sid')?.value;
          } else {
            useFake();
            const r = await appLogin(claims, { invite });
            results.app = appOutcome(r.body, deleted);
            sid = r.setCookies.find((x) => x.name === 'ff_sid')?.value;
          }
          expect(Boolean(sid)).toBe(c.want === 'session');
          const u = await userBySub(claims.sub);
          if (u && c.want === 'session') expect(await auditsFor('login', u.id)).toEqual([expect.objectContaining({ ui: path })]);
          await c.check?.(claims);
        }
        expect(results).toEqual({ classic: c.want, app: c.want });
      });
    }
  });
});
