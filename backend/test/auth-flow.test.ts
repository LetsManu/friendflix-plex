// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { sha256 } from '../src/crypto.js';
import { createInvite } from '../src/invites.js';
import { flowFailKey } from '../src/routes/authFlow.js';
import { issueSetupCode } from '../src/setup/code.js';
import { isSetupComplete } from '../src/setup/state.js';
import { AK_URL, type AkCall, type FakeAuthentik, fakeAuthentik, type FakeStage, fixture } from './akflow-fake.js';
import { makeEnv, type TestEnv } from './helpers.js';

// Block 23 phase 3, Task 3: the /auth/flow routes (CSRF, single-use steps, rate limits, errors) and the LOGIN_UI switch on /auth/login.

const AK: Partial<Config> = { AUTHENTIK_URL: AK_URL, AUTHENTIK_API_TOKEN: 'api-token-placeholder', OIDC_ISSUER: 'https://auth.example.com/application/o/friendflix/' };
const PASSWORD = 'Sup3r-Secret-Passw0rd!';
const RIGHT = 'right-password-placeholder';
const AK_INVITE = 'a0000000-0000-4000-8000-000000000001';

/** identification → password (only RIGHT passes) → end */
const loginStages = (): FakeStage[] => [
  { challenge: fixture('identification'), answer: (b: { uid_field?: string }) => (b.uid_field ? true : fixture('identification')) },
  { challenge: fixture('password'), answer: (b: { password?: string }) => (b.password === RIGHT ? true : fixture('password-invalid')), hops: 2 },
];
/** recovery: identification → e-mail stage (every answer is a resend) */
const recoveryStages = (): FakeStage[] => [
  { challenge: fixture('identification-recovery') },
  { challenge: fixture('email-sent'), answer: () => fixture('email-resent') },
];

const flowsRoute = { 'GET /api/v3/flows/instances/default-recovery-flow/': () => new Response('{"pk":"f1"}', { headers: { 'content-type': 'application/json' } }) };

let ipN = 0;
const freshIp = () => `10.23.${Math.floor(++ipN / 250)}.${ipN % 250}`;

/** one browser: its cookies, its IP, and the flow csrf header taken from its cookie */
function browser(env: TestEnv, extra: Record<string, string> = {}) {
  const cookies: Record<string, string> = { ...extra };
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
    async post(path: string, payload: unknown, opts: { csrf?: string | null; headers?: Record<string, string> } = {}) {
      const csrf = opts.csrf === undefined ? cookies.ff_flow_csrf : opts.csrf;
      const r = await env.app.inject({
        method: 'POST', url: `/auth/flow/${path}`, payload: payload as object, cookies, remoteAddress: ip,
        headers: { ...(csrf ? { 'x-ff-flow-csrf': csrf } : {}), ...opts.headers },
      });
      absorb(r);
      return r;
    },
  };
}

const executorPosts = (ak: FakeAuthentik) => ak.calls.filter((c: AkCall) => c.method === 'POST' && c.path.startsWith('/api/v3/flows/executor/'));

describe('/auth/flow', () => {
  let env: TestEnv;
  let ak: FakeAuthentik;
  const logs: string[] = [];
  const useFake = (stages: FakeStage[]) => {
    ak = fakeAuthentik(stages, flowsRoute);
    env.ctx.fetchImpl = ak.fetch;
    return ak;
  };
  beforeAll(async () => {
    env = await makeEnv({}, { logger: { stream: { write: (m: string) => { logs.push(m); } }, level: 'trace' } });
  });
  beforeEach(async () => {
    env.ctx.cfg = { ...env.ctx.cfg, ...AK, LOGIN_UI: undefined, AUTHENTIK_ENROLL_FLOW: undefined };
    useFake(loginStages());
    for (const k of [...(await env.kv.keys('flowfail:')), ...(await env.kv.keys('recoverymail:'))]) await env.kv.del(k); // each test counts its own
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  afterAll(() => env.close());

  async function started(b = browser(env), kind = 'login') {
    await b.config();
    const r = await b.post('start', { kind });
    expect(r.statusCode).toBe(200);
    return { b, step: r.json() as { stage: string; step: string } };
  }

  it('config reports app mode when the API is configured, authentik otherwise', async () => {
    const b = browser(env);
    const r = await b.config();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ mode: 'app', recovery: true, enroll: false });
    const c = r.cookies.find((x) => x.name === 'ff_flow_csrf')!;
    expect(c.value.length).toBeGreaterThanOrEqual(32);
    expect([c.httpOnly ?? false, c.sameSite, c.path, c.maxAge]).toEqual([false, 'Strict', '/', 600]);
    // a second call sets a fresh token
    expect((await b.config()).cookies.find((x) => x.name === 'ff_flow_csrf')!.value).not.toBe(c.value);
    // the recovery lookup is cached (one Authentik call for both)
    expect(ak.calls.filter((x) => x.path === '/api/v3/flows/instances/default-recovery-flow/')).toHaveLength(1);

    env.ctx.cfg = { ...env.ctx.cfg, AUTHENTIK_ENROLL_FLOW: 'default-enrollment-flow' };
    expect((await b.config()).json()).toMatchObject({ mode: 'app', enroll: true });
    env.ctx.cfg = { ...env.ctx.cfg, AUTHENTIK_API_TOKEN: undefined };
    expect((await b.config()).json()).toEqual({ mode: 'authentik', recovery: false, enroll: false });
    env.ctx.cfg = { ...env.ctx.cfg, ...AK, LOGIN_UI: 'authentik' };
    expect((await b.config()).json()).toEqual({ mode: 'authentik', recovery: false, enroll: false });
  });

  it('config: an unknown recovery slug or an unreachable Authentik → recovery false', async () => {
    env.ctx.cfg = { ...env.ctx.cfg, AUTHENTIK_RECOVERY_FLOW: 'no-such-flow' };
    expect((await browser(env).config()).json()).toEqual({ mode: 'app', recovery: false, enroll: false });
    env.ctx.cfg = { ...env.ctx.cfg, AUTHENTIK_RECOVERY_FLOW: 'other-flow' };
    ak.override = () => { throw new TypeError('fetch failed'); };
    expect((await browser(env).config()).json()).toEqual({ mode: 'app', recovery: false, enroll: false });
    env.ctx.cfg = { ...env.ctx.cfg, AUTHENTIK_RECOVERY_FLOW: undefined };
  });

  it('start without csrf header → 403', async () => {
    const b = browser(env);
    await b.config();
    expect((await b.post('start', { kind: 'login' }, { csrf: null })).statusCode).toBe(403);
    const wrong = await b.post('start', { kind: 'login' }, { csrf: 'x'.repeat(43) });
    expect([wrong.statusCode, wrong.json()]).toEqual([403, { error: 'csrf' }]);
    // a header without the cookie
    const bare = browser(env);
    expect((await bare.post('start', { kind: 'login' }, { csrf: 'abc' })).statusCode).toBe(403);
    // answer and cancel too
    expect((await b.post('answer', { step: 'x', stage: 'identify', identifier: 'anna' }, { csrf: null })).statusCode).toBe(403);
    expect((await b.post('cancel', {}, { csrf: null })).statusCode).toBe(403);
    expect(ak.calls.filter((c) => c.path.startsWith('/api/v3/flows/executor/'))).toHaveLength(0);
  });

  it('start returns identify with a step id and sets ff_flow', async () => {
    const b = browser(env);
    await b.config();
    const r = await b.post('start', { kind: 'login' });
    expect(r.statusCode).toBe(200);
    const step = r.json();
    expect(step).toMatchObject({ stage: 'identify', passwordInline: false, passkey: null });
    expect(step.step).toMatch(/^[A-Za-z0-9_-]{20,24}$/);
    const c = r.cookies.find((x) => x.name === 'ff_flow')!;
    expect([c.httpOnly, c.sameSite, c.path, c.maxAge]).toEqual([true, 'Strict', '/auth/flow', 600]);
    expect(c.value.length).toBeGreaterThanOrEqual(43);
    // no Authentik URL, cookie or token reaches the browser
    expect(r.body).not.toContain('auth.example.com');
    expect(r.body).not.toContain('authentik_session');
    // the jar is stored encrypted under the hash of the flow id
    const blob = await env.kv.get(`akflow:${sha256(c.value)}`);
    expect(blob).toBeTruthy();
    expect(blob).not.toContain('authentik_session');
  });

  it('start: bad bodies → 400; a recovery jar; a second start forgets the first jar', async () => {
    const b = browser(env);
    await b.config();
    for (const body of [{ kind: 'setup-totp' }, { kind: 'login', then: 'setup-totp' }, { kind: 'login', extra: 1 }, { kind: 'login', invite: 'x'.repeat(129) }, { kind: 'recovery', invite: 'x'.repeat(30) }]) {
      const r = await b.post('start', body);
      expect([r.statusCode, r.json()], JSON.stringify(body)).toEqual([400, { error: 'bad_request' }]);
    }
    const first = await b.post('start', { kind: 'login' });
    const firstFlow = b.cookies.ff_flow!;
    useFake(recoveryStages());
    const second = await b.post('start', { kind: 'recovery' });
    expect(second.json()).toMatchObject({ stage: 'identify' });
    expect(ak.calls.some((c) => c.path === '/api/v3/flows/executor/default-recovery-flow/')).toBe(true);
    expect(b.cookies.ff_flow).not.toBe(firstFlow);
    expect(await env.kv.get(`akflow:${sha256(firstFlow)}`)).toBeNull();
    // the previous attempt's Authentik session was ended first (its cookie went to the invalidation flow)
    const inval = ak.calls.find((c) => c.path === '/api/v3/flows/executor/default-invalidation-flow/');
    expect(inval?.headers.cookie).toMatch(/authentik_session=/);
    expect(first.statusCode).toBe(200);
  });

  it('start with invites: login keeps a valid invite, enroll needs one with an Authentik invitation', async () => {
    const { cookies } = await env.login();
    const adminId = (await env.pool.query<{ id: string }>('select id from users limit 1')).rows[0]!.id;
    const plain = await createInvite(env.ctx, adminId, { role: 'friend', ttlHours: 1 }, { warn: () => {} });
    const withAk = await createInvite(env.ctx, adminId, { role: 'friend', ttlHours: 1 }, { warn: () => {} });
    await env.pool.query('update invites set authentik_invite=$1 where id=$2', [AK_INVITE, withAk.id]);
    expect(cookies.ff_sid).toBeTruthy();
    const b = browser(env);
    await b.config();
    expect((await b.post('start', { kind: 'login', invite: 'n'.repeat(30) })).json()).toEqual({ error: 'invite_invalid' });
    expect((await b.post('start', { kind: 'login', invite: plain.token })).statusCode).toBe(200);
    const enrollNoInvite = await b.post('start', { kind: 'enroll' });
    expect([enrollNoInvite.statusCode, enrollNoInvite.json()]).toEqual([410, { error: 'invite_invalid' }]);
    expect((await b.post('start', { kind: 'enroll', invite: plain.token })).statusCode).toBe(410);
    // no enrolment flow configured
    const nf = await b.post('start', { kind: 'enroll', invite: withAk.token });
    expect([nf.statusCode, nf.json()]).toEqual([409, { error: 'flow_not_configured' }]);
    env.ctx.cfg = { ...env.ctx.cfg, AUTHENTIK_ENROLL_FLOW: 'default-enrollment-flow' };
    useFake([{ challenge: fixture('prompt-enroll') }]);
    const en = await b.post('start', { kind: 'enroll', invite: withAk.token });
    expect(en.json()).toMatchObject({ stage: 'prompt' });
    const call = ak.calls.find((c) => c.path === '/api/v3/flows/executor/default-enrollment-flow/')!;
    expect(call.url.searchParams.get('query')).toBe(`itoken=${AK_INVITE}`);
    // the jar keeps the invite for the end of the flow (P16); the browser never sees the Authentik invitation
    expect(en.body).not.toContain(AK_INVITE);
  });

  it('replaying a step id → 409 step_used and Authentik saw one POST', async () => {
    const { b, step } = await started();
    const body = { step: step.step, stage: 'identify', identifier: 'anna@example.com' };
    const first = await b.post('answer', body);
    expect(first.statusCode).toBe(200);
    const next = first.json();
    expect(next).toMatchObject({ stage: 'password', identity: 'anna@example.com' });
    expect(next.step).not.toBe(step.step);
    const replay = await b.post('answer', body);
    expect([replay.statusCode, replay.json()]).toEqual([409, { error: 'step_used' }]);
    expect(executorPosts(ak)).toHaveLength(1);
  });

  it('a concurrent double submit: one answer reaches Authentik, the other gets 409 step_used', async () => {
    const { b, step } = await started();
    const body = { step: step.step, stage: 'identify', identifier: 'anna@example.com' };
    const rs = await Promise.all([b.post('answer', body), b.post('answer', body)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(executorPosts(ak)).toHaveLength(1);
  });

  it('answer after 601 s → expired, no Authentik call', async () => {
    const { b, step } = await started();
    const before = ak.calls.length;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 601_000);
    const r = await b.post('answer', { step: step.step, stage: 'identify', identifier: 'anna@example.com' });
    expect([r.statusCode, r.json()]).toEqual([200, { stage: 'expired' }]);
    expect(ak.calls.length).toBe(before);
    expect(b.cookies.ff_flow).toBeUndefined(); // cleared
    // no cookie at all: expired as well
    const none = browser(env);
    await none.config();
    expect((await none.post('answer', { step: 'x', stage: 'identify', identifier: 'a' })).json()).toEqual({ stage: 'expired' });
  });

  it('answers are checked against the shown step: stage, offered options, shape (400, nothing used up)', async () => {
    const { b, step } = await started();
    const bad = [
      { step: step.step, stage: 'password', password: 'x' }, // not the shown stage
      { step: step.step, stage: 'identify', identifier: 'anna', password: 'x' }, // no inline password offered
      { step: step.step, stage: 'identify', passkey: { id: 'a', rawId: 'a', type: 'public-key', response: { clientDataJSON: 'a' } } }, // no passkey offered
      { step: step.step, stage: 'identify' }, // nothing
      { step: step.step }, // no stage
      { stage: 'identify', identifier: 'anna' }, // no step
    ];
    for (const body of bad) {
      const r = await b.post('answer', body);
      expect([r.statusCode, r.json()], JSON.stringify(body)).toEqual([400, { error: 'bad_request' }]);
    }
    for (const payload of ['"x"', '[1]']) {
      const r = await env.app.inject({ method: 'POST', url: '/auth/flow/answer', payload, headers: { 'content-type': 'application/json', 'x-ff-flow-csrf': b.cookies.ff_flow_csrf! }, cookies: b.cookies, remoteAddress: b.ip });
      expect(r.statusCode).toBe(400);
    }
    const wrongStep = await b.post('answer', { step: 'not-the-step', stage: 'identify', identifier: 'anna' });
    expect([wrongStep.statusCode, wrongStep.json()]).toEqual([409, { error: 'step_used' }]);
    expect(executorPosts(ak)).toHaveLength(0);
    // the step was not used up by the refused answers
    expect((await b.post('answer', { step: step.step, stage: 'identify', identifier: 'anna' })).statusCode).toBe(200);
  });

  it('a prompt answer may only carry the shown fields; a password mismatch → 400 {errors}, no Authentik call', async () => {
    env.ctx.cfg = { ...env.ctx.cfg, AUTHENTIK_ENROLL_FLOW: 'default-enrollment-flow' };
    await env.login();
    const adminId = (await env.pool.query<{ id: string }>('select id from users limit 1')).rows[0]!.id;
    const inv = await createInvite(env.ctx, adminId, { role: 'friend', ttlHours: 1 }, { warn: () => {} });
    await env.pool.query('update invites set authentik_invite=$1 where id=$2', [AK_INVITE, inv.id]);
    useFake([{ challenge: fixture('prompt-enroll') }]);
    const b = browser(env);
    await b.config();
    const s = (await b.post('start', { kind: 'enroll', invite: inv.token })).json() as { step: string; fields: Array<{ key: string }> };
    const keys = s.fields.map((f) => f.key);
    expect(keys).toContain('password_repeat');
    const extra = await b.post('answer', { step: s.step, stage: 'prompt', is_superuser: 'true' });
    expect(extra.statusCode).toBe(400);
    const mismatch = await b.post('answer', { step: s.step, stage: 'prompt', password: 'a-placeholder', password_repeat: 'b-placeholder' });
    expect([mismatch.statusCode, mismatch.json()]).toEqual([400, { errors: ['password_mismatch'] }]);
    expect(executorPosts(ak)).toHaveLength(0);
  });

  it('ten failed passwords for one identifier → rate_limited without calling Authentik; another identifier still works', async () => {
    const { b, step } = await started();
    let cur = (await b.post('answer', { step: step.step, stage: 'identify', identifier: 'Anna@Example.com' })).json() as { step: string; stage: string };
    expect(cur.stage).toBe('password');
    for (let i = 0; i < 10; i++) {
      const r = await b.post('answer', { step: cur.step, stage: 'password', password: `${PASSWORD}${i}` });
      expect(r.statusCode).toBe(200);
      cur = r.json();
      expect(cur).toMatchObject({ stage: 'password', errors: ['invalid'] });
    }
    expect(await env.kv.get(flowFailKey('anna@example.com'))).toBe('10');
    const posts = executorPosts(ak).length;
    const limited = await b.post('answer', { step: cur.step, stage: 'password', password: RIGHT });
    expect(limited.statusCode).toBe(200);
    const body = limited.json();
    expect(body).toMatchObject({ stage: 'password', errors: ['rate_limited'] });
    expect(body.step).not.toBe(cur.step);
    expect(executorPosts(ak)).toHaveLength(posts);
    // the same account in a new flow, typed differently: refused at identification already
    useFake(loginStages());
    const again = await started();
    const id = await again.b.post('answer', { step: again.step.step, stage: 'identify', identifier: ' ANNA@example.COM' });
    expect(id.json()).toMatchObject({ stage: 'identify', errors: ['rate_limited'] });

    // another identifier is not affected
    useFake(loginStages());
    const other = await started();
    const pw = (await other.b.post('answer', { step: other.step.step, stage: 'identify', identifier: 'bert' })).json() as { step: string };
    const done = await other.b.post('answer', { step: pw.step, stage: 'password', password: RIGHT });
    // the end of the flow: this suite's OIDC fake authorizes on a host that is not Authentik's, so completeFlow answers unavailable
    // without a session (login-finish.test.ts covers the silent authorize); the Authentik session is ended either way
    expect([done.statusCode, done.json()]).toEqual([200, { stage: 'unavailable' }]);
    expect(done.cookies.find((c) => c.name === 'ff_sid')).toBeUndefined();
    expect(ak.calls.some((c) => c.path === '/api/v3/flows/executor/default-invalidation-flow/')).toBe(true);
    expect(other.b.cookies.ff_flow).toBeUndefined();
    expect(Number((await env.kv.get(flowFailKey('bert'))) ?? 0)).toBe(0); // the reserved slot came back
  });

  /** an executor fake with one flow per Authentik session: identification → password (only RIGHT passes) → end; password answers wait a moment */
  function perSessionFake() {
    const calls: AkCall[] = [];
    const where = new Map<string, number>();
    let n = 0;
    const json = (body: unknown, cookie?: string) => {
      const h = new Headers({ 'content-type': 'application/json' });
      if (cookie) h.append('set-cookie', cookie);
      return new Response(JSON.stringify(body), { headers: h });
    };
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      const method = (init.method ?? 'GET').toUpperCase();
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, path: url.pathname, search: url.search, headers, body });
      if (!url.pathname.startsWith('/api/v3/flows/executor/default-authentication-flow/')) return new Response('nf', { status: 404 });
      let sess = /authentik_session=([^;]+)/.exec(headers.cookie ?? '')?.[1];
      const fresh = sess ? undefined : `authentik_session=${(sess = `p${++n}`)}; Path=/`;
      const at = where.get(sess) ?? 0;
      const self = () => new Response(null, { status: 302, headers: { location: `${url.pathname}${url.search}`, ...(fresh ? { 'set-cookie': fresh } : {}) } });
      if (method === 'GET') return json(at === 0 ? fixture('identification') : at === 1 ? fixture('password') : { component: 'xak-flow-redirect', to: '/', final_redirect: true }, fresh);
      if (at === 0) { where.set(sess, 1); return self(); }
      await new Promise((r) => setTimeout(r, 5));
      if (body?.password === RIGHT) { where.set(sess, 2); return self(); }
      return json(fixture('password-invalid'), fresh);
    }) as typeof fetch;
    return { calls, fetchImpl, passwordPosts: () => calls.filter((c) => c.method === 'POST' && c.body?.password !== undefined) };
  }

  it('parallel wrong answers from many flows cannot pass the per-account limit (the slot is reserved before Authentik)', async () => {
    const fake = perSessionFake();
    env.ctx.fetchImpl = fake.fetchImpl;
    // 15 flows prepared up to the password stage (identification answers are free)
    const flows: Array<{ b: ReturnType<typeof browser>; step: string }> = [];
    for (let i = 0; i < 15; i++) {
      const b = browser(env);
      await b.config();
      const s0 = (await b.post('start', { kind: 'login' })).json() as { step: string };
      const pw = (await b.post('answer', { step: s0.step, stage: 'identify', identifier: 'fred' })).json() as { stage: string; step: string };
      expect(pw.stage).toBe('password');
      flows.push({ b, step: pw.step });
    }
    await env.kv.set(flowFailKey('fred'), '9', 900); // one failure left
    const rs = await Promise.all(flows.map((f) => f.b.post('answer', { step: f.step, stage: 'password', password: PASSWORD })));
    expect(fake.passwordPosts()).toHaveLength(1);
    const bodies = rs.map((r) => r.json() as { errors?: string[] });
    expect(bodies.filter((b) => b.errors?.[0] === 'rate_limited')).toHaveLength(14);
    expect(bodies.filter((b) => b.errors?.[0] === 'invalid')).toHaveLength(1);
    expect(await env.kv.get(flowFailKey('fred'))).toBe('10'); // the refused ones gave their slot back
  });

  it('the reserved slot goes back on success and when Authentik is unavailable; a wrong answer keeps it', async () => {
    const fake = perSessionFake();
    env.ctx.fetchImpl = fake.fetchImpl;
    const atPassword = async () => {
      const b = browser(env);
      await b.config();
      const s0 = (await b.post('start', { kind: 'login' })).json() as { step: string };
      return { b, step: ((await b.post('answer', { step: s0.step, stage: 'identify', identifier: 'gina' })).json() as { step: string }).step };
    };
    await env.kv.set(flowFailKey('gina'), '3', 900);
    const wrong = await atPassword();
    expect((await wrong.b.post('answer', { step: wrong.step, stage: 'password', password: PASSWORD })).json()).toMatchObject({ errors: ['invalid'] });
    expect(await env.kv.get(flowFailKey('gina'))).toBe('4');
    const down = await atPassword();
    env.ctx.fetchImpl = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    expect((await down.b.post('answer', { step: down.step, stage: 'password', password: PASSWORD })).json()).toEqual({ stage: 'unavailable' });
    expect(await env.kv.get(flowFailKey('gina'))).toBe('4');
    env.ctx.fetchImpl = fake.fetchImpl;
    const right = await atPassword();
    expect((await right.b.post('answer', { step: right.step, stage: 'password', password: RIGHT })).json()).toEqual({ stage: 'unavailable' }); // the end (no silent authorize in this suite)
    expect(await env.kv.get(flowFailKey('gina'))).toBe('4');
  });

  it('an answer racing a cancel does not bring the dropped jar back', async () => {
    const { b, step } = await started();
    const pw = (await b.post('answer', { step: step.step, stage: 'identify', identifier: 'hugo' })).json() as { step: string };
    const flowId = b.cookies.ff_flow!;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inFlight = new Promise<void>((r) => { entered = r; });
    ak.override = async (c) => {
      if (c.method === 'POST' && c.body?.password !== undefined) { entered(); await gate; }
      return undefined;
    };
    const answering = b.post('answer', { step: pw.step, stage: 'password', password: PASSWORD });
    await inFlight;
    const cancelCookies = { ...b.cookies };
    const c = await env.app.inject({ method: 'POST', url: '/auth/flow/cancel', cookies: cancelCookies, headers: { 'x-ff-flow-csrf': cancelCookies.ff_flow_csrf! }, remoteAddress: b.ip });
    expect(c.statusCode).toBe(200);
    release();
    const r = await answering;
    expect(r.json()).toEqual({ stage: 'expired' });
    expect(await env.kv.get(`akflow:${sha256(flowId)}`)).toBeNull();
  });

  it('an email-sent resend does not count as a failure', async () => {
    useFake(recoveryStages());
    const { b, step } = await started(browser(env), 'recovery');
    let cur = (await b.post('answer', { step: step.step, stage: 'identify', identifier: 'carla@example.com' })).json() as { step: string; stage: string };
    expect(cur).toMatchObject({ stage: 'email-sent', to: 'c•••@example.com' });
    for (let i = 0; i < 11; i++) {
      // past the one-resend-per-minute gap and the recovery e-mail budget (Task 5): this test is about the failure counter only
      for (const k of [...(await env.kv.keys('akflow:resend:')), ...(await env.kv.keys('recoverymail:'))]) await env.kv.del(k);
      const r = await b.post('answer', { step: cur.step, stage: 'email-sent' });
      cur = r.json();
      expect(cur.stage).toBe('email-sent');
      expect(cur).not.toHaveProperty('errors');
    }
    expect(await env.kv.get(flowFailKey('carla@example.com'))).toBeNull();
  });

  it('select-stage is answered automatically; a wrong TOTP code counts; denied ends the flow', async () => {
    const validate = { component: 'ak-stage-authenticator-validate', device_challenges: [], configuration_stages: [{ pk: 'a1b2c3', meta_model_name: 'authentik_stages_authenticator_totp.authenticatortotpstage' }] };
    useFake([
      { challenge: fixture('identification'), answer: (body: { uid_field?: string }) => (body.uid_field ? true : fixture('identification')) },
      { challenge: validate, answer: (body: { selected_stage?: string }) => (body.selected_stage === 'a1b2c3' ? true : validate) },
      { challenge: fixture('totp-setup'), answer: () => fixture('totp-setup-invalid') },
    ]);
    const { b, step } = await started();
    const totp = await b.post('answer', { step: step.step, stage: 'identify', identifier: 'dora' });
    expect(totp.json()).toMatchObject({ stage: 'totp-setup' });
    expect(executorPosts(ak).map((c) => c.body)).toEqual([{ uid_field: 'dora' }, { selected_stage: 'a1b2c3' }]);
    const wrong = await b.post('answer', { step: totp.json().step, stage: 'totp-setup', code: '000000' });
    expect(wrong.json()).toMatchObject({ stage: 'totp-setup', errors: ['code_invalid'] });
    expect(await env.kv.get(flowFailKey('dora'))).toBe('1');

    useFake([{ challenge: fixture('identification'), answer: () => true }, { challenge: fixture('access-denied') }]);
    const d = await started();
    const denied = await d.b.post('answer', { step: d.step.step, stage: 'identify', identifier: 'emil' });
    expect(denied.json()).toEqual({ stage: 'denied' });
    expect(d.b.cookies.ff_flow).toBeUndefined();
  });

  it('a link interstitial outside resume is never answered: classic consent', async () => {
    useFake([{ challenge: fixture('consent-link') }]);
    const { step } = await started();
    expect(step).toEqual({ stage: 'classic', reason: 'consent' });
    expect(executorPosts(ak)).toHaveLength(0);
  });

  it('Authentik unreachable → stage unavailable', async () => {
    const b = browser(env);
    await b.config();
    ak.override = () => { throw new TypeError('fetch failed'); };
    const r = await b.post('start', { kind: 'login' });
    expect([r.statusCode, r.json()]).toEqual([200, { stage: 'unavailable' }]);
    expect(b.cookies.ff_flow).toBeUndefined();
    // mid-flow: a 5xx page from Authentik
    ak.override = undefined;
    const { b: b2, step } = await started();
    ak.override = (c) => (c.method === 'POST' ? new Response('<html>oops</html>', { status: 500, headers: { 'content-type': 'text/html' } }) : undefined);
    const mid = await b2.post('answer', { step: step.step, stage: 'identify', identifier: 'anna' });
    expect([mid.statusCode, mid.json()]).toEqual([200, { stage: 'unavailable' }]);
  });

  it('a password in the body never appears in captured log lines', async () => {
    const { b, step } = await started();
    const pw = (await b.post('answer', { step: step.step, stage: 'identify', identifier: 'anna@example.com' })).json() as { step: string };
    logs.length = 0;
    // the fake throws an error that quotes the request
    ak.override = (c) => { if (c.method === 'POST') throw new Error(`connect failed: ${JSON.stringify(c.body)}`); return undefined; };
    const down = await b.post('answer', { step: pw.step, stage: 'password', password: PASSWORD });
    expect(down.json()).toEqual({ stage: 'unavailable' });
    // an unexpected error inside the handler that quotes the body
    useFake(loginStages());
    const { b: b2, step: s2 } = await started();
    const pw2 = (await b2.post('answer', { step: s2.step, stage: 'identify', identifier: 'anna@example.com' })).json() as { step: string };
    vi.spyOn(env.kv, 'setnx').mockRejectedValueOnce(Object.assign(new Error(`kv failed for ${PASSWORD}`), { code: 'E_TEST' }));
    const boom = await b2.post('answer', { step: pw2.step, stage: 'password', password: PASSWORD });
    expect([boom.statusCode, boom.json()]).toEqual([500, { error: 'internal' }]);
    // a malformed body that contains the password
    await env.app.inject({ method: 'POST', url: '/auth/flow/answer', payload: `{"password":"${PASSWORD}"`, headers: { 'content-type': 'application/json', 'x-ff-flow-csrf': b.cookies.ff_flow_csrf! }, cookies: b.cookies, remoteAddress: b.ip });
    const text = logs.join('\n');
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('kv failed');
    expect(text).not.toContain('connect failed');
    // what is logged: the route pattern and the code
    const warns = logs.map((l) => JSON.parse(l) as { route?: string; code?: string }).filter((l) => l.route);
    expect(warns).toContainEqual(expect.objectContaining({ route: '/auth/flow/answer', code: 'authentik_unavailable' }));
    expect(warns).toContainEqual(expect.objectContaining({ route: '/auth/flow/answer', code: 'internal' }));
  });

  it('no path trick (percent-encoding, case, double slashes) gets the body into the log', async () => {
    const { b } = await started();
    const variants = ['/auth/flow/answer', '/%61uth/flow/answer', '/auth/%66low/answer', '/auth/flow/%61nswer', '/AUTH/flow/answer', '//auth/flow/answer', '/auth//flow/answer'];
    vi.spyOn(env.kv, 'get').mockImplementation(async (k: string) => { if (k.startsWith('akflow:')) throw new Error(`load failed ${PASSWORD}`); return null; });
    let reached = 0;
    for (const url of variants) {
      logs.length = 0;
      const r = await env.app.inject({ method: 'POST', url, payload: { step: 'st1', stage: 'password', password: PASSWORD }, headers: { 'x-ff-flow-csrf': b.cookies.ff_flow_csrf! }, cookies: b.cookies, remoteAddress: b.ip });
      expect([404, 500], url).toContain(r.statusCode);
      if (r.statusCode === 500) reached++;
      expect(logs.join('\n'), url).not.toContain(PASSWORD);
    }
    expect(reached).toBe(4); // the encoded variants reach the real route
  });

  it('cancel ends the Authentik session, deletes the jar and clears the cookies', async () => {
    const { b, step } = await started();
    await b.post('answer', { step: step.step, stage: 'identify', identifier: 'anna' });
    const flowId = b.cookies.ff_flow!;
    const r = await b.post('cancel', {});
    expect([r.statusCode, r.json()]).toEqual([200, { ok: true }]);
    expect(ak.calls.some((c) => c.path === '/api/v3/flows/executor/default-invalidation-flow/')).toBe(true);
    expect(await env.kv.get(`akflow:${sha256(flowId)}`)).toBeNull();
    expect(b.cookies.ff_flow).toBeUndefined();
    expect(b.cookies.ff_flow_csrf).toBeUndefined();
    // without a jar: still fine
    const n = browser(env);
    await n.config();
    expect((await n.post('cancel', {})).statusCode).toBe(200);
  });

  it('a jar of a signed-in person also needs that session and its x-csrf-token', async () => {
    const { cookies, csrf } = await env.login();
    const sess = JSON.parse((await env.kv.get(`sess:${cookies.ff_sid}`))!) as { userId: string };
    const { b, step } = await started(browser(env, cookies));
    // bind the jar to the session (as Task 10's reauth start will)
    const { loadJar, saveJar } = await import('../src/akflow.js');
    const jar = (await loadJar(env.ctx, b.cookies.ff_flow!))!;
    await saveJar(env.ctx, b.cookies.ff_flow!, { ...jar, userId: sess.userId });
    const body = { step: step.step, stage: 'identify', identifier: 'anna' };
    expect((await b.post('answer', body)).statusCode).toBe(403);
    expect((await b.post('answer', body, { headers: { 'x-csrf-token': 'wrong' } })).statusCode).toBe(403);
    expect((await b.post('cancel', {}, { headers: { 'x-csrf-token': 'wrong' } })).statusCode).toBe(403);
    expect(executorPosts(ak)).toHaveLength(0);
    expect((await b.post('answer', body, { headers: { 'x-csrf-token': csrf } })).statusCode).toBe(200);
  });

  it('LOGIN_UI=authentik: start → 409 classic', async () => {
    env.ctx.cfg = { ...env.ctx.cfg, LOGIN_UI: 'authentik' };
    const b = browser(env);
    await b.config();
    const r = await b.post('start', { kind: 'login' });
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'classic' }]);
    expect((await b.post('answer', { step: 'x', stage: 'identify', identifier: 'a' })).json()).toEqual({ error: 'classic' });
    expect(ak.calls.filter((c) => c.path.startsWith('/api/v3/flows/executor/'))).toHaveLength(0);
  });

  it('per-IP limit: the 21st start within a minute → 429', async () => {
    const b = browser(env);
    await b.config();
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await b.post('start', { kind: 'login' })).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes[20]).toBe(429);
  });
});

// Block 23 phase 3, Task 5: password recovery. "Passwort vergessen?" answers the recovery flow's identification itself; the e-mail
// link leads to /reset, whose button resumes Authentik's own recovery flow with the token (never checked by FriendFlix itself).
describe('/auth/flow recovery (Task 5)', () => {
  let env: TestEnv;
  let ak: FakeAuthentik;
  const logs: string[] = [];
  /** obviously fake: shaped like Authentik's 60-character FlowToken key only in its alphabet */
  const TOKEN = 'fakeFlowTokenForTestsOnly0000000000000000000000000000000001';
  const LINK = '00000000-0000-4000-8000-000000000001';
  const NEW_PW = 'New-Passw0rd-placeholder';
  const useFake = (stages: FakeStage[]) => {
    ak = fakeAuthentik(stages, flowsRoute);
    env.ctx.fetchImpl = ak.fetch;
    return ak;
  };
  /** the link interstitial (answered with its token only) → optional MFA → new password ×2 → end */
  const resumeStages = (mfa?: FakeStage): FakeStage[] => [
    { challenge: fixture('consent-link'), answer: (b: { token?: string }) => (b.token === LINK ? true : fixture('consent-link')) },
    ...(mfa ? [mfa] : []),
    { challenge: fixture('prompt-recovery'), answer: (b: { password?: string; password_repeat?: string }) => (b.password === NEW_PW && b.password_repeat === NEW_PW ? true : fixture('prompt-mismatch')), hops: 2 },
  ];
  const totpMfa: FakeStage = { challenge: fixture('validate-all'), answer: (b: { code?: string }) => (b.code === '123456' ? true : fixture('validate-code-invalid')) };
  const executorCalls = () => ak.calls.filter((c) => c.path.startsWith('/api/v3/flows/executor/default-recovery-flow/'));
  const clearKeys = async (...prefixes: string[]) => {
    for (const p of prefixes) for (const k of await env.kv.keys(p)) await env.kv.del(k);
  };

  beforeAll(async () => {
    env = await makeEnv({}, { logger: { stream: { write: (m: string) => { logs.push(m); } }, level: 'trace' } });
  });
  beforeEach(async () => {
    env.ctx.cfg = { ...env.ctx.cfg, ...AK, LOGIN_UI: undefined };
    useFake(recoveryStages());
    await clearKeys('flowfail:', 'recoverymail:', 'akflow:resend:');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  afterAll(() => env.close());

  async function resumed(b = browser(env), token = TOKEN) {
    await b.config();
    const r = await b.post('resume', { token });
    return { b, r, step: r.json() as { stage: string; step: string } };
  }

  it('forgot password with identifier → email-sent with masked address', async () => {
    const b = browser(env);
    await b.config();
    const r = await b.post('start', { kind: 'recovery', identifier: 'Carla@Example.com' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ stage: 'email-sent', step: expect.stringMatching(/^[A-Za-z0-9_-]{20,24}$/), to: 'C•••@example.com' });
    // the backend answered the identification itself; the flow continues in this browser (resend)
    expect(executorPosts(ak).map((c) => c.body)).toEqual([{ uid_field: 'Carla@Example.com' }]);
    expect(b.cookies.ff_flow).toBeTruthy();
    // a username is not shown back
    useFake(recoveryStages());
    expect((await b.post('start', { kind: 'recovery', identifier: 'carla' })).json()).toMatchObject({ stage: 'email-sent', to: null });
    // an identifier only belongs to a recovery start
    for (const body of [{ kind: 'login', identifier: 'carla' }, { kind: 'recovery', identifier: '' }, { kind: 'recovery', identifier: 'x'.repeat(255) }]) {
      expect((await b.post('start', body)).json(), JSON.stringify(body)).toEqual({ error: 'bad_request' });
    }
  });

  it('no enumeration: an unknown identifier gets the same answer, also when Authentik does not pretend', async () => {
    // Authentik's default: the e-mail stage for everyone (fixtures from 2026.8.3)
    const known = await (async () => { const b = browser(env); await b.config(); return (await b.post('start', { kind: 'recovery', identifier: 'anna@example.com' })).json(); })();
    useFake(recoveryStages());
    const unknown = await (async () => { const b = browser(env); await b.config(); return (await b.post('start', { kind: 'recovery', identifier: 'nobody@example.com' })).json(); })();
    expect({ ...known, step: 's' }).toEqual({ stage: 'email-sent', step: 's', to: 'a•••@example.com' });
    expect({ ...unknown, step: 's' }).toEqual({ stage: 'email-sent', step: 's', to: 'n•••@example.com' });
    // an identification stage without "pretend user exists" refuses unknown names: the answer is still "e-mail sent", nothing counts as a
    // failure, and the resend never reaches Authentik (the name stays unconfirmed)
    const refuse = { ...fixture('identification-recovery'), response_errors: { non_field_errors: [{ string: 'Failed to authenticate.', code: 'invalid' }] } };
    useFake([{ challenge: fixture('identification-recovery'), answer: () => refuse }, { challenge: fixture('email-sent'), answer: () => fixture('email-resent') }]);
    const b = browser(env);
    await b.config();
    const r = await b.post('start', { kind: 'recovery', identifier: 'nobody@example.com' });
    expect({ ...r.json(), step: 's' }).toEqual({ stage: 'email-sent', step: 's', to: 'n•••@example.com' });
    expect(await env.kv.get(flowFailKey('nobody@example.com'))).toBeNull();
    await clearKeys('akflow:resend:');
    const posts = executorPosts(ak).length;
    const again = await b.post('answer', { step: r.json().step, stage: 'email-sent' });
    expect({ ...again.json(), step: 's' }).toEqual({ stage: 'email-sent', step: 's', to: 'n•••@example.com' });
    expect(executorPosts(ak)).toHaveLength(posts);
    // the same via the identify screen
    useFake([{ challenge: fixture('identification-recovery'), answer: () => refuse }]);
    const { b: b2, step } = await (async () => { const x = browser(env); await x.config(); return { b: x, step: (await x.post('start', { kind: 'recovery' })).json() }; })();
    const viaScreen = await b2.post('answer', { step: step.step, stage: 'identify', identifier: 'nobody' });
    expect({ ...viaScreen.json(), step: 's' }).toEqual({ stage: 'email-sent', step: 's', to: null });
  });

  it('resend within 60 s → rate_limited, no Authentik call; after 60 s it re-sends', async () => {
    const b = browser(env);
    await b.config();
    const sent = (await b.post('start', { kind: 'recovery', identifier: 'dora@example.com' })).json() as { step: string };
    const posts = executorPosts(ak).length;
    const early = await b.post('answer', { step: sent.step, stage: 'email-sent' });
    expect(early.statusCode).toBe(200);
    expect(early.json()).toEqual({ stage: 'email-sent', step: expect.any(String), to: 'd•••@example.com', errors: ['rate_limited'] });
    expect(executorPosts(ak)).toHaveLength(posts);
    // the refused resend used its step up: the new step id answers
    expect((await b.post('answer', { step: sent.step, stage: 'email-sent' })).statusCode).toBe(409);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    const later = await b.post('answer', { step: early.json().step, stage: 'email-sent' });
    expect(later.json()).toEqual({ stage: 'email-sent', step: expect.any(String), to: 'd•••@example.com' });
    expect(executorPosts(ak).slice(posts).map((c) => c.body)).toEqual([{}]);
    // and the gap starts again
    expect((await b.post('answer', { step: later.json().step, stage: 'email-sent' })).json()).toMatchObject({ errors: ['rate_limited'] });
  });

  it('recovery e-mails are limited per account (any spelling, any IP) and per IP', async () => {
    const send = async (identifier: string, b = browser(env)) => {
      useFake(recoveryStages()); // a fresh flow each time
      await b.config();
      return (await b.post('start', { kind: 'recovery', identifier })).json() as { stage: string; errors?: string[] };
    };
    for (let i = 0; i < 5; i++) expect(await send(i % 2 ? 'Emil@Example.com' : 'emil@example.com')).toMatchObject({ stage: 'email-sent' });
    const sixth = await send(' EMIL@example.com');
    // the identify screen comes back with the error; Authentik is not asked
    expect(sixth).toMatchObject({ stage: 'identify', errors: ['rate_limited'] });
    expect(executorPosts(ak)).toHaveLength(0);
    // through the identify screen: the same budget
    useFake(recoveryStages());
    const b = browser(env);
    await b.config();
    const id = (await b.post('start', { kind: 'recovery' })).json() as { step: string };
    expect((await b.post('answer', { step: id.step, stage: 'identify', identifier: 'emil@example.com' })).json()).toMatchObject({ stage: 'identify', errors: ['rate_limited'] });
    expect(executorPosts(ak)).toHaveLength(0);
    // and as a resend of an attempt started before the budget ran out
    await clearKeys('recoverymail:');
    const early = browser(env);
    const sent = (await send('gina@example.com', early)) as unknown as { step: string };
    for (let i = 0; i < 4; i++) await send('gina@example.com');
    await clearKeys('akflow:resend:');
    expect((await early.post('answer', { step: sent.step, stage: 'email-sent' })).json()).toMatchObject({ stage: 'email-sent', errors: ['rate_limited'] });
    expect(executorPosts(ak)).toHaveLength(1); // the last send() only
    // another account still works
    expect(await send('fritz@example.com')).toMatchObject({ stage: 'email-sent' });
    // per IP: ten e-mails an hour from one address, whatever the names
    await clearKeys('recoverymail:');
    const one = browser(env);
    for (let i = 0; i < 10; i++) expect(await send(`person${i}@example.com`, one)).toMatchObject({ stage: 'email-sent' });
    expect(await send('person10@example.com', one)).toMatchObject({ stage: 'identify', errors: ['rate_limited'] });
    // the budget does not depend on whether the account exists: nothing to learn from it
    expect(await env.kv.get(flowFailKey('person10@example.com'))).toBeNull();
  });

  it('resume with token restores the plan (fake checks query=flow_token%3D…), answers the link interstitial with its token, and returns prompt with two password fields', async () => {
    useFake(resumeStages());
    const { b, r, step } = await resumed();
    expect(r.statusCode).toBe(200);
    expect(step).toEqual({
      stage: 'prompt', step: expect.any(String),
      fields: [
        { key: 'password', type: 'password', label: 'ff:password', required: true },
        { key: 'password_repeat', type: 'password', label: 'ff:password_repeat', required: true },
      ],
    });
    // every executor call continues Authentik's own plan with the token; FriendFlix never judged it itself
    const calls = executorCalls();
    expect(calls[0]).toMatchObject({ method: 'GET', search: `?query=flow_token%3D${TOKEN}` });
    expect(calls.every((c) => c.search === `?query=flow_token%3D${TOKEN}`)).toBe(true);
    // the click on /reset is the confirmation: the interstitial is answered with its own token, once
    expect(executorPosts(ak).map((c) => c.body)).toEqual([{ token: LINK }]);
    // no forwarded app host for recovery (brand and mail links stay Authentik's)
    expect(calls.some((c) => c.headers['x-forwarded-host'])).toBe(false);
    // the token never reaches the browser or the jar's step; the flow continues under the flow cookie
    expect(r.body).not.toContain(TOKEN);
    expect(r.body).not.toContain(LINK);
    expect(r.body).not.toContain('anna');
    expect(b.cookies.ff_flow).toBeTruthy();
  });

  it('resume → link-confirm → mfa(totp) → prompt (the MFA recovery example of wizard installs); a wrong code counts for the account', async () => {
    useFake(resumeStages(totpMfa));
    const { b, step } = await resumed();
    expect(step).toEqual({ stage: 'mfa', step: expect.any(String), totp: true, recovery: true, passkey: null, passkeyClassic: true });
    const wrong = await b.post('answer', { step: step.step, stage: 'mfa', code: '000000' });
    expect(wrong.json()).toMatchObject({ stage: 'mfa', errors: ['code_invalid'] });
    // the per-account counter is the one of the Authentik username the link belongs to
    expect(await env.kv.get(flowFailKey('anna'))).toBe('1');
    const prompt = await b.post('answer', { step: wrong.json().step, stage: 'mfa', code: '123456' });
    expect(prompt.json()).toMatchObject({ stage: 'prompt' });
    const done = await b.post('answer', { step: prompt.json().step, stage: 'prompt', password: NEW_PW, password_repeat: NEW_PW });
    expect(done.json()).toEqual({ stage: 'done', next: '/login?reset=1' });
  });

  it('resume with a WebAuthn-only second factor → classic passkey_origin (no forwarded host in recovery jars)', async () => {
    const webauthnOnly = { ...fixture('validate-webauthn'), device_challenges: (fixture('validate-webauthn').device_challenges as Array<{ device_class: string }>).filter((d) => d.device_class === 'webauthn') };
    useFake(resumeStages({ challenge: webauthnOnly }));
    const { b, step } = await resumed();
    expect(step).toEqual({ stage: 'classic', reason: 'passkey_origin' });
    expect(b.cookies.ff_flow).toBeUndefined();
  });

  it('resume where the first challenge is a consent with permissions → classic consent, the interstitial is not auto-answered', async () => {
    useFake([{ challenge: { ...fixture('consent-link'), permissions: [{ name: 'Read your profile', id: 'profile' }] } }]);
    const { b, step } = await resumed();
    expect(step).toEqual({ stage: 'classic', reason: 'consent' });
    expect(executorPosts(ak)).toHaveLength(0);
    expect(b.cookies.ff_flow).toBeUndefined();
    // a second interstitial after the first one is not answered either
    useFake([{ challenge: fixture('consent-link'), answer: () => true }, { challenge: fixture('consent-link') }]);
    expect((await resumed()).step).toEqual({ stage: 'classic', reason: 'consent' });
    expect(executorPosts(ak)).toHaveLength(1);
  });

  it('older releases without the interstitial: a direct prompt is accepted', async () => {
    useFake([{ challenge: fixture('prompt-recovery'), answer: () => true }]);
    const { step } = await resumed();
    expect(step).toMatchObject({ stage: 'prompt' });
    expect(executorPosts(ak)).toHaveLength(0);
  });

  it('password mismatch → errors password_mismatch, no Authentik call', async () => {
    useFake(resumeStages());
    const { b, step } = await resumed();
    const posts = executorPosts(ak).length;
    const r = await b.post('answer', { step: step.step, stage: 'prompt', password: NEW_PW, password_repeat: `${NEW_PW}x` });
    expect([r.statusCode, r.json()]).toEqual([400, { errors: ['password_mismatch'] }]);
    expect(executorPosts(ak)).toHaveLength(posts);
    // the step is still unused: the corrected answer goes through
    expect((await b.post('answer', { step: step.step, stage: 'prompt', password: NEW_PW, password_repeat: NEW_PW })).json()).toEqual({ stage: 'done', next: '/login?reset=1' });
  });

  it('used token (fake answers identification) → expired', async () => {
    useFake([{ challenge: fixture('recovery-token-reused') }]);
    const { b, r } = await resumed();
    expect([r.statusCode, r.json()]).toEqual([200, { stage: 'expired' }]);
    expect(executorPosts(ak)).toHaveLength(0);
    expect(b.cookies.ff_flow).toBeUndefined();
    // access denied, or an identification right after the interstitial, too
    useFake([{ challenge: fixture('access-denied') }]);
    expect((await resumed()).step).toEqual({ stage: 'expired' });
    useFake([{ challenge: fixture('consent-link'), answer: () => true }, { challenge: fixture('recovery-token-reused') }]);
    expect((await resumed()).step).toEqual({ stage: 'expired' });
    // a plan that ends without a new password was never a reset
    useFake([{ challenge: fixture('consent-link'), answer: () => true }]);
    expect((await resumed()).step).toEqual({ stage: 'expired' });
  });

  it('recovery end → done next=/login?reset=1, no session cookie, invalidation called', async () => {
    useFake(resumeStages());
    const { b, step } = await resumed();
    const flowId = b.cookies.ff_flow!;
    const r = await b.post('answer', { step: step.step, stage: 'prompt', password: NEW_PW, password_repeat: NEW_PW });
    expect([r.statusCode, r.json()]).toEqual([200, { stage: 'done', next: '/login?reset=1' }]);
    // recovery never signs in: no FriendFlix session, and Authentik's session from user_login is ended
    expect(r.cookies.map((c) => c.name)).not.toContain('ff_sid');
    expect(b.cookies.ff_sid).toBeUndefined();
    const inval = ak.calls.find((c) => c.path === '/api/v3/flows/executor/default-invalidation-flow/');
    expect(inval?.headers.cookie).toMatch(/authentik_session=/);
    expect(ak.calls.some((c) => c.path.startsWith('/application/o/authorize'))).toBe(false);
    expect(await env.kv.get(`akflow:${sha256(flowId)}`)).toBeNull();
    expect(b.cookies.ff_flow).toBeUndefined();
    expect(await env.pool.query('select 1 from audit_log where action=$1', ['login']).then((x) => x.rowCount)).toBe(0);
  });

  it('bad token → expired', async () => {
    // malformed: Authentik is not asked
    for (const token of ['short', 'x'.repeat(257), `${TOKEN.slice(0, 20)}/../${TOKEN.slice(0, 20)}`, `${TOKEN}&next=/x`, `${TOKEN} `]) {
      const { r } = await resumed(browser(env), token);
      expect([r.statusCode, r.json()], token).toEqual([200, { stage: 'expired' }]);
    }
    expect(ak.calls).toHaveLength(0);
    // a well-formed token Authentik does not know: it starts a new plan (identification)
    useFake([{ challenge: fixture('recovery-token-reused') }]);
    expect((await resumed(browser(env), 'unknownTokenUnknownToken0000')).step).toEqual({ stage: 'expired' });
    // not a string, extra keys, another kind → 400
    const b = browser(env);
    await b.config();
    for (const body of [{}, { token: 5 }, { token: TOKEN, extra: 1 }, { token: TOKEN, kind: 'login' }, { token: 'x'.repeat(1025) }]) {
      expect((await b.post('resume', body)).json(), JSON.stringify(body)).toEqual({ error: 'bad_request' });
    }
  });

  it('resume: csrf, LOGIN_UI=authentik, Authentik down, the token never in a log line, 10 per minute per IP', async () => {
    const b = browser(env);
    await b.config();
    expect((await b.post('resume', { token: TOKEN }, { csrf: null })).statusCode).toBe(403);
    env.ctx.cfg = { ...env.ctx.cfg, LOGIN_UI: 'authentik' };
    expect((await b.post('resume', { token: TOKEN })).json()).toEqual({ error: 'classic' });
    env.ctx.cfg = { ...env.ctx.cfg, LOGIN_UI: undefined };
    expect(ak.calls).toHaveLength(0);
    logs.length = 0;
    ak.override = (c) => { throw new Error(`connect failed ${c.url.toString()}`); };
    expect((await b.post('resume', { token: TOKEN })).json()).toEqual({ stage: 'unavailable' });
    ak.override = () => new Response(`<html>${TOKEN}</html>`, { status: 500, headers: { 'content-type': 'text/html' } });
    expect((await b.post('resume', { token: TOKEN })).json()).toEqual({ stage: 'unavailable' });
    ak.override = undefined;
    vi.spyOn(env.kv, 'set').mockRejectedValueOnce(new Error(`kv failed ${TOKEN}`));
    useFake(resumeStages());
    expect((await b.post('resume', { token: TOKEN })).statusCode).toBe(500);
    const text = logs.join('\n');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('flow_token');
    expect(logs.map((l) => JSON.parse(l) as { route?: string; code?: string }).filter((l) => l.route)).toContainEqual(expect.objectContaining({ route: '/auth/flow/resume', code: 'authentik_unavailable' }));
    // the jar holds the token only encrypted
    useFake(resumeStages());
    const { b: ok } = await resumed();
    expect(await env.kv.get(`akflow:${sha256(ok.cookies.ff_flow!)}`)).not.toContain(TOKEN);
    // 10 per minute per IP (the requests above came from b and ok: a fresh browser counts its own)
    const c = browser(env);
    await c.config();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await c.post('resume', { token: 'short' })).statusCode);
    expect(codes.slice(0, 10).every((x) => x === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('a new resume ends the previous attempt in this browser', async () => {
    useFake(resumeStages());
    const { b } = await resumed();
    const first = b.cookies.ff_flow!;
    useFake(resumeStages());
    await b.post('resume', { token: TOKEN });
    expect(b.cookies.ff_flow).not.toBe(first);
    expect(await env.kv.get(`akflow:${sha256(first)}`)).toBeNull();
    expect(ak.calls.some((c) => c.path === '/api/v3/flows/executor/default-invalidation-flow/')).toBe(true);
    // a bad token also forgets the previous attempt
    const second = b.cookies.ff_flow!;
    await b.post('resume', { token: 'short' });
    expect(b.cookies.ff_flow).toBeUndefined();
    expect(await env.kv.get(`akflow:${sha256(second)}`)).toBeNull();
  });
});

describe('/auth/login and the LOGIN_UI switch', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv(); });
  beforeEach(() => { env.ctx.cfg = { ...env.ctx.cfg, ...AK, LOGIN_UI: undefined, AUTHENTIK_ENROLL_FLOW: 'default-enrollment-flow' }; });
  afterAll(() => env.close());
  const loc = async (url: string) => {
    const r = await env.app.inject(url);
    return [r.statusCode, r.headers.location] as const;
  };

  it('/auth/login redirects to /login in app mode, stays on the IdP with classic=1 and with resetPin=1', async () => {
    expect(await loc('/auth/login')).toEqual([302, '/login']);
    expect(await loc('/auth/login?classic=1')).toEqual([302, 'https://idp/authorize']);
    expect(await loc('/auth/login?resetPin=1')).toEqual([302, 'https://idp/authorize']);
    expect(await loc('/auth/login?setup=1')).toEqual([302, 'https://idp/authorize']);
    env.ctx.cfg = { ...env.ctx.cfg, LOGIN_UI: 'authentik' };
    expect(await loc('/auth/login')).toEqual([302, 'https://idp/authorize']);
    env.ctx.cfg = { ...env.ctx.cfg, LOGIN_UI: undefined, AUTHENTIK_API_TOKEN: undefined };
    expect(await loc('/auth/login')).toEqual([302, 'https://idp/authorize']);
  });

  it('invites: checked first (410), then carried to /login; /auth/enroll → /login?invite=…&enroll=1', async () => {
    const r = await env.app.inject('/auth/login?invite=nnnnnnnnnnnnnnnnnnnnnnnnnnn');
    expect([r.statusCode, r.json()]).toEqual([410, { error: 'invite_invalid' }]);
    await env.login();
    const adminId = (await env.pool.query<{ id: string }>('select id from users limit 1')).rows[0]!.id;
    const inv = await createInvite(env.ctx, adminId, { role: 'friend', ttlHours: 1 }, { warn: () => {} });
    await env.pool.query('update invites set authentik_invite=$1 where id=$2', [AK_INVITE, inv.id]);
    expect(await loc(`/auth/login?invite=${inv.token}`)).toEqual([302, `/login?invite=${inv.token}`]);
    expect(await loc(`/auth/enroll?invite=${inv.token}`)).toEqual([302, `/login?invite=${inv.token}&enroll=1`]);
    // the classic enrolment stays reachable
    const classic = await loc(`/auth/enroll?invite=${inv.token}&classic=1`);
    expect(classic[1]).toMatch(/^http:\/\/auth\.example\.com:9000\/if\/flow\/default-enrollment-flow\//);
    env.ctx.cfg = { ...env.ctx.cfg, LOGIN_UI: 'authentik' };
    expect((await loc(`/auth/enroll?invite=${inv.token}`))[1]).toMatch(/^http:\/\/auth\.example\.com:9000\/if\/flow\//);
  });
});

describe('the LOGIN_UI switch during setup (preflight D3, D9)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv({}, { setupComplete: false });
    env.ctx.cfg = { ...env.ctx.cfg, ...AK }; // what the automatic Authentik setup saves: loginUi answers app
  });
  afterAll(() => env.close());

  it('/auth/flow/* stays gated (503 setup_required)', async () => {
    for (const [method, url] of [['GET', '/auth/flow/config'], ['POST', '/auth/flow/start'], ['POST', '/auth/flow/answer'], ['POST', '/auth/flow/cancel'], ['POST', '/auth/flow/resume']] as const) {
      const r = await env.app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      expect([r.statusCode, r.json()], url).toEqual([503, { error: 'setup_required' }]);
    }
  });

  it('/auth/login?setup=1 with a setup session still goes to the IdP, and the callback creates the first admin', async () => {
    const code = await issueSetupCode(env.ctx);
    const u = await env.app.inject({ method: 'POST', url: '/api/setup/unlock', payload: { code }, remoteAddress: freshIp() });
    const cookies = { ff_setup: u.cookies.find((c) => c.name === 'ff_setup')!.value };
    // also without ?setup=1: no /login redirect while setup is incomplete
    const plain = await env.app.inject({ url: '/auth/login', cookies });
    expect([plain.statusCode, plain.headers.location]).toEqual([302, 'https://idp/authorize']);
    const l = await env.app.inject({ url: '/auth/login?setup=1', cookies });
    expect([l.statusCode, l.headers.location]).toEqual([302, 'https://idp/authorize']);
    const state = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
    env.claims.current = { sub: 'sub-first', email: 'first@example.com', name: 'First', groups: [] };
    const cb = await env.app.inject({ url: `/auth/callback?state=${state}&code=c`, cookies: { ...cookies, ff_oidc: state } });
    expect([cb.statusCode, cb.headers.location]).toEqual([302, '/setup/extras']);
    expect((await env.pool.query('select role from users where authentik_sub=$1', ['sub-first'])).rows[0]).toEqual({ role: 'admin' });
    expect(await isSetupComplete(env.ctx)).toBe(true);
    // once complete, the same install signs in through /login
    expect((await env.app.inject('/auth/login')).headers.location).toBe('/login');
  });
});

describe('the session CSRF hook decides by route pattern, never the raw url (carry from Task 1)', () => {
  let env: TestEnv;
  let s: { cookies: Record<string, string>; csrf: string };
  beforeAll(async () => {
    env = await makeEnv();
    s = await env.login();
  });
  afterAll(() => env.close());
  const put = (url: string, headers: Record<string, string> = {}) =>
    env.app.inject({ method: 'PUT', url, payload: { onboarded: true }, cookies: s.cookies, headers, remoteAddress: freshIp() });

  it('encoded spellings of a protected route need the token too', async () => {
    for (const url of ['/api/prefs/onboarded', '/%61pi/prefs/onboarded', '/api/%70refs/onboarded', '/api/prefs/%6Fnboarded']) {
      const r = await put(url);
      expect([r.statusCode, r.json()], url).toEqual([403, { error: 'csrf' }]);
      expect((await put(url, { 'x-csrf-token': s.csrf })).statusCode, url).toBe(200);
    }
  });

  it('a request that matches no route gets the strictest branch (403 with a session, no token)', async () => {
    for (const url of ['/API/prefs/onboarded', '//api/prefs/onboarded', '/api//prefs/onboarded', '/api/nope', '/nope', '/api/client-errors-x', '/api/tv/codes', '/api/restore/x', '/api/setup', '/api/invite']) {
      const r = await env.app.inject({ method: 'POST', url, payload: {}, cookies: s.cookies, remoteAddress: freshIp() });
      expect([r.statusCode, r.json()], url).toEqual([403, { error: 'csrf' }]);
    }
    // without a session: the usual 404
    expect((await env.app.inject({ method: 'POST', url: '/api/nope', payload: {} })).statusCode).toBe(404);
  });

  it('the exemptions still work for their real routes (also spelled encoded), and only there', async () => {
    const beacon = (url: string) => env.app.inject({ method: 'POST', url, payload: JSON.stringify({ kind: 'error', message: 'x', path: '/' }), headers: { 'content-type': 'text/plain;charset=UTF-8' }, cookies: s.cookies, remoteAddress: freshIp() });
    for (const url of ['/api/client-errors', '/%61pi/client-errors']) expect((await beacon(url)).statusCode, url).not.toBe(403);
    const tv = await env.app.inject({ method: 'POST', url: '/api/tv/code', cookies: s.cookies, remoteAddress: freshIp() });
    expect(tv.statusCode).not.toBe(403);
    const restore = await env.app.inject({ method: 'POST', url: '/api/restore', payload: {}, cookies: s.cookies, remoteAddress: freshIp() });
    expect([restore.statusCode, restore.json()]).toEqual([401, { error: 'unauthenticated' }]); // no restore cookie, but no csrf 403
    const setup = await env.app.inject({ method: 'PUT', url: '/api/setup/settings', payload: {}, cookies: s.cookies, remoteAddress: freshIp() });
    expect(setup.statusCode).not.toBe(403);
    // GET is never checked
    expect((await env.app.inject({ url: '/%61pi/me', cookies: s.cookies })).statusCode).toBe(200);
  });
});
