// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createInvite } from '../src/invites.js';
import { pushPersonal } from '../src/notify.js';
import { pollTick } from '../src/polls.js';
import { issueSetupCode } from '../src/setup/code.js';
import { isOperational, isSetupComplete } from '../src/setup/state.js';
import { runProbe } from '../src/settings/probes.js';
import { updateMeta } from '../src/settings/repo.js';
import { ADMIN, cfg, makeEnv, type TestEnv } from './helpers.js';

// Block 25 Task 11 (spec Parts E1 and F): the setup gate, the setup-session endpoints and the publicUrl probe.
type SetupSess = { cookies: Record<string, string>; csrf: string };
let ipN = 0;
const freshIp = () => `10.12.${Math.floor(++ipN / 250)}.${ipN % 250}`;

async function unlock(env: TestEnv): Promise<SetupSess> {
  const code = await issueSetupCode(env.ctx);
  const r = await env.app.inject({ method: 'POST', url: '/api/setup/unlock', payload: { code }, remoteAddress: freshIp() });
  expect(r.statusCode).toBe(200);
  const token = r.cookies.find((c) => c.name === 'ff_setup')!.value;
  const csrf = r.cookies.find((c) => c.name === 'ff_setup_csrf')!.value;
  return { cookies: { ff_setup: token, ff_setup_csrf: csrf }, csrf };
}

/** ctx.fetchImpl that sends the probe's request into the app itself (the public URL reaches this backend) */
function selfFetch(env: { app?: TestEnv['app'] }, override?: () => Response | undefined): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    const o = override?.();
    if (o) return o;
    const r = await env.app!.inject({ url: u.pathname + u.search });
    return new Response(r.body, { status: r.statusCode, headers: { 'content-type': String(r.headers['content-type'] ?? '') } });
  }) as typeof fetch;
}

describe('the setup gate while setup is incomplete', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv({}, { setupComplete: false }); });
  afterAll(() => env.close());

  it('answers 503 setup_required everywhere but the allow-list', async () => {
    for (const url of ['/api/me', '/health/ready', '/metrics', '/api/admin/settings', '/api/nope', '/API/me', '/api/setup/../me', '/ws/remote']) {
      const r = await env.app.inject({ url });
      expect(r.statusCode, url).toBe(503);
      expect(r.json(), url).toEqual({ error: 'setup_required' });
    }
    const post = await env.app.inject({ method: 'POST', url: '/api/client-errors', payload: { message: 'x' } });
    expect(post.statusCode).toBe(503);
  });

  it('lets /health, GET /api/version, /api/setup/* and /internal/gateway-config through', async () => {
    expect((await env.app.inject('/health')).statusCode).toBe(200);
    expect((await env.app.inject('/api/version')).statusCode).toBe(200);
    expect((await env.app.inject('/api/setup/state')).statusCode).toBe(200);
    const gw = await env.app.inject({ url: '/internal/gateway-config', headers: { 'x-internal-secret': cfg.INTERNAL_SECRET } });
    expect(gw.statusCode).toBe(200);
    expect(gw.json().upstreamUrl).toBe(cfg.JELLYFIN_URL);
  });

  it('/auth/login and /auth/callback need a valid setup session (without one: back to the wizard, no JSON page)', async () => {
    const login = await env.app.inject('/auth/login');
    expect([login.statusCode, login.headers.location]).toEqual([302, '/setup']);
    // the setup session ran out between login and callback, or its cookie was lost on the way back from the IdP: the code step says so
    const cb = await env.app.inject('/auth/callback?state=x&code=c');
    expect([cb.statusCode, cb.headers.location]).toEqual([302, '/setup?expired=1']);
    expect((await env.app.inject({ url: '/auth/login', cookies: { ff_setup: 'forged' } })).headers.location).toBe('/setup');
    // not a navigation: the usual answer
    expect((await env.app.inject({ method: 'POST', url: '/auth/logout' })).statusCode).toBe(503);
    const s = await unlock(env);
    expect((await env.app.inject({ url: '/auth/login', cookies: s.cookies })).statusCode).toBe(302);
    // other auth routes stay closed even with a setup session
    expect((await env.app.inject({ url: '/auth/enroll', cookies: s.cookies })).statusCode).toBe(503);
    expect((await env.app.inject({ url: '/api/me', cookies: s.cookies })).statusCode).toBe(503);
  });

  it('GET /api/setup/state: complete, unlocked, media kind, steps, the saved public URL as prefill and the sign-in path', async () => {
    const r = await env.app.inject({ url: '/api/setup/state', headers: { 'x-forwarded-proto': 'https', host: 'tv.example.com' } });
    expect(env.ctx.cfg.PUBLIC_URL).toBeTruthy();
    expect(env.ctx.cfg.PUBLIC_URL).not.toBe('https://tv.example.com');
    expect(r.json()).toEqual({
      complete: false, unlocked: false, mediaKind: 'jellyfin', media: { keys: ['JELLYFIN_URL', 'JELLYFIN_ADMIN_API_KEY'], auto: ['url', 'username', 'password'] },
      steps: { publicUrl: 'done', media: 'done', signin: 'done', admin: 'todo' },
      // the saved address wins over the browser's origin: the redirect URI of step 4 must be the one OIDC uses
      prefill: { publicUrl: env.ctx.cfg.PUBLIC_URL },
      signinVia: null,
    });
    const s = await unlock(env);
    expect((await env.app.inject({ url: '/api/setup/state', cookies: s.cookies })).json().unlocked).toBe(true);
    const before = env.ctx.cfg;
    try {
      // no public URL saved yet: the origin of the forwarded request; a garbage host is no prefill
      env.ctx.cfg = { ...before, PUBLIC_URL: '' };
      const fwd = await env.app.inject({ url: '/api/setup/state', headers: { 'x-forwarded-proto': 'https', host: 'tv.example.com' } });
      expect(fwd.json().prefill).toEqual({ publicUrl: 'https://tv.example.com' });
      const bad = await env.app.inject({ url: '/api/setup/state', headers: { host: 'tv.example.com/evil' } });
      expect(bad.json().prefill).toEqual({ publicUrl: null });
    } finally {
      env.ctx.cfg = before;
    }
  });

  it('steps report env-locked and missing keys', async () => {
    const before = env.ctx.cfg;
    try {
      env.ctx.cfg = { ...before, PUBLIC_URL: 'https://env.example.com', OIDC_CLIENT_SECRET: '' };
      const steps = (await env.app.inject('/api/setup/state')).json().steps;
      expect(steps.publicUrl).toBe('env');
      expect(steps.signin).toBe('todo');
    } finally {
      env.ctx.cfg = before;
    }
  });

  it('jobs: pollTick with setup incomplete touches nothing (no media call, the due poll stays open)', async () => {
    const uid = (await env.pool.query("insert into users(id, authentik_sub, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-p','P','admin','jfp','P','x') returning id")).rows[0].id;
    const poll = (await env.pool.query("insert into polls(id, title, created_by, closes_at, starts_at) values (gen_random_uuid(), 'T', $1, now() - interval '1 minute', now() + interval '1 hour') returning id", [uid])).rows[0].id;
    await env.pool.query("insert into poll_options(poll_id, jf_item_id, title) values ($1, $2, 'A')", [poll, 'a'.repeat(32)]);
    expect(isOperational(env.ctx)).toBe(false);
    const calls = env.jfCalls.length;
    await pollTick(env.ctx);
    expect(env.jfCalls.length).toBe(calls);
    expect((await env.pool.query('select status from polls where id=$1', [poll])).rows[0].status).toBe('open');
    await env.pool.query('delete from users where id=$1', [uid]);
  });

  it('a real websocket upgrade is refused with 503 while setup is incomplete', async () => {
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (env.app.server.address() as { port: number }).port;
    for (const path of ['/ws/remote', '/ws/party/abc']) {
      const status = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { origin: 'https://portal.example.com' } });
        ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
        ws.on('open', () => { resolve(101); ws.close(); });
        ws.on('error', () => undefined);
      });
      expect(status, path).toBe(503);
    }
    // the refused upgrade sockets are closed by the gate (an open one would hold up app.close() in afterAll)
  });

  it('a refused upgrade is closed even when the gate check throws; a plain request with an Upgrade header keeps its connection', async () => {
    if (!env.app.server.listening) await env.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (env.app.server.address() as { port: number }).port;
    // a plain request (Upgrade header, no Connection: upgrade) is no upgrade: 503 and the keep-alive connection stays open
    const agent = new http.Agent({ keepAlive: true });
    try {
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/api/me', agent, headers: { upgrade: 'websocket', connection: 'keep-alive' } }, resolve).on('error', reject);
      });
      const sock = res.socket;
      expect(res.statusCode).toBe(503);
      await new Promise((r) => { res.on('end', r); res.resume(); });
      await new Promise((r) => setTimeout(r, 100));
      expect(sock.destroyed).toBe(false);
    } finally {
      agent.destroy();
    }
    // a cold cache with the database down: the gate throws (500), and the upgrade socket is still closed by the server
    const { settings, db } = env.ctx;
    env.ctx.settings = { ...settings, rev: () => -2 } as typeof settings;
    env.ctx.db = { query: async () => { throw new Error('db down'); } } as unknown as typeof db;
    try {
      const closed = await new Promise<number>((resolve) => {
        const timer = setTimeout(() => resolve(-1), 3000);
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/remote`, { headers: { origin: 'https://portal.example.com' } });
        ws.on('unexpected-response', (_req, res) => {
          res.socket.once('close', () => { clearTimeout(timer); resolve(res.statusCode ?? 0); });
          res.resume();
        });
        ws.on('error', () => undefined);
      });
      expect(closed).toBe(500);
    } finally {
      env.ctx.settings = settings;
      env.ctx.db = db;
    }
  });

  it('isSetupComplete keeps the last known state while the database is down (a cold cache fails)', async () => {
    const known = await isSetupComplete(env.ctx);
    await env.ctx.settings.save({ ADMIN_GROUP: 'friendflix-admins' }, null); // moves the rev: the next call re-reads
    const down = { query: async () => { throw new Error('db down'); } } as unknown as TestEnv['ctx']['db'];
    expect(await isSetupComplete({ settings: env.ctx.settings, db: down })).toBe(known);
    const cold = { ...env.ctx.settings, rev: () => -1 } as typeof env.ctx.settings; // another store: no cache entry
    await expect(isSetupComplete({ settings: cold, db: down })).rejects.toThrow('db down');
    expect(await isSetupComplete(env.ctx)).toBe(known); // recovers with the database
  });

  it('isSetupComplete is cached until the settings rev moves; isOperational needs the run-required keys too', async () => {
    expect(await isSetupComplete(env.ctx)).toBe(false);
    const uid = (await env.pool.query("insert into users(id, authentik_sub, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-q','Q','admin','jfq','Q','x') returning id")).rows[0].id;
    await env.pool.query("insert into polls(id, title, created_by, closes_at, starts_at) values (gen_random_uuid(), 'T2', $1, now() - interval '1 minute', now() + interval '1 hour')", [uid]);
    await updateMeta(env.pool, { setupCompletedAt: new Date() });
    expect(await isSetupComplete(env.ctx)).toBe(false); // cached: this instance has not seen the new rev yet
    await env.ctx.settings.reload();
    expect(await isSetupComplete(env.ctx)).toBe(true);
    expect(isOperational(env.ctx)).toBe(true);
    const before = env.ctx.cfg;
    try {
      env.ctx.cfg = { ...before, OIDC_ISSUER: '' };
      expect(isOperational(env.ctx)).toBe(false);
    } finally {
      env.ctx.cfg = before;
    }
    expect((await env.app.inject('/api/me')).statusCode).toBe(401); // the gate is inert now
    // and the jobs run again: the due poll from the test above is closed now (no votes -> cancelled)
    await pollTick(env.ctx);
    expect((await env.pool.query("select status from polls where title='T2'")).rows[0].status).toBe('cancelled');
    await updateMeta(env.pool, { setupCompletedAt: null });
    await env.ctx.settings.reload();
    expect((await env.app.inject('/api/me')).statusCode).toBe(503);
  });
});

describe('setup-session endpoints', () => {
  const holder: { app?: TestEnv['app'] } = {};
  let override: (() => Response | undefined) | undefined;
  let env: TestEnv;
  let s: SetupSess;
  beforeAll(async () => {
    env = await makeEnv({}, { setupComplete: false, ctxPatch: (c) => { c.fetchImpl = selfFetch(holder, () => override?.()); } });
    holder.app = env.app;
    s = await unlock(env);
  });
  afterAll(() => env.close());
  const put = (values: Record<string, unknown>, sess: Partial<SetupSess> = s, headers: Record<string, string> = { 'x-ff-setup-csrf': s.csrf }) =>
    env.app.inject({ method: 'PUT', url: '/api/setup/settings', cookies: sess.cookies ?? {}, headers, payload: { values } });

  it('ff_setup is SameSite=Lax, ff_setup_csrf Strict; the Lax cookie alone never authorises a write', async () => {
    const code = await issueSetupCode(env.ctx);
    const r = await env.app.inject({ method: 'POST', url: '/api/setup/unlock', payload: { code }, remoteAddress: freshIp() });
    const sess = r.cookies.find((c) => c.name === 'ff_setup')!;
    expect(sess).toMatchObject({ sameSite: 'Lax', httpOnly: true });
    expect(r.cookies.find((c) => c.name === 'ff_setup_csrf')).toMatchObject({ sameSite: 'Strict' });
    // what a cross-site top-level request could carry: the Lax cookie, never the Strict one, never the header
    for (const method of ['PUT', 'POST'] as const) {
      const url = method === 'PUT' ? '/api/setup/settings' : '/api/setup/test';
      const payload = method === 'PUT' ? { values: { PUBLIC_URL: 'https://evil.example.com' } } : { group: 'general' };
      const w = await env.app.inject({ method, url, cookies: { ff_setup: sess.value }, payload });
      expect(w.statusCode, url).toBe(403);
      expect(w.json()).toEqual({ error: 'csrf' });
    }
    expect(env.ctx.cfg.PUBLIC_URL).not.toBe('https://evil.example.com');
  });

  it('PUT /api/setup/settings needs the setup session and its csrf header', async () => {
    expect((await put({ PUBLIC_URL: 'https://tv.example.com' }, {}, {})).statusCode).toBe(401);
    const noCsrf = await put({ PUBLIC_URL: 'https://tv.example.com' }, s, {});
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toEqual({ error: 'csrf' });
    expect((await put({ PUBLIC_URL: 'https://tv.example.com' }, s, { 'x-ff-setup-csrf': 'x'.repeat(s.csrf.length) })).statusCode).toBe(403);
    // the header must match the session's own cookie, not just any cookie value
    expect((await put({ PUBLIC_URL: 'https://tv.example.com' }, { cookies: { ...s.cookies, ff_setup_csrf: 'abc' } }, { 'x-ff-setup-csrf': 'abc' })).statusCode).toBe(403);
  });

  it('saves PUBLIC_URL as an origin (trailing slash dropped), audited with actor null and key names only', async () => {
    const r = await put({ PUBLIC_URL: 'https://tv.example.com/' });
    expect(r.statusCode).toBe(200);
    expect(env.ctx.cfg.PUBLIC_URL).toBe('https://tv.example.com');
    const a = (await env.pool.query("select actor, meta from audit_log where action='settings.update' order by id desc limit 1")).rows[0];
    expect(a.actor).toBeNull();
    expect(a.meta).toEqual({ keys: ['PUBLIC_URL'] });
  });

  it('refuses a path (origin_only), keys outside the wizard (not_allowed) and clearing a run-required key', async () => {
    const path = await put({ PUBLIC_URL: 'https://tv.example.com/ff' });
    expect(path.statusCode).toBe(400);
    expect(path.json()).toEqual({ error: 'invalid_settings', errors: { PUBLIC_URL: 'origin_only' } });
    const cast = await put({ CAST_ENABLED: false });
    expect(cast.statusCode).toBe(400);
    expect(cast.json().errors).toEqual({ CAST_ENABLED: 'not_allowed' });
    expect((await put({ OIDC_CLIENT_ID: '' })).json().errors).toEqual({ OIDC_CLIENT_ID: 'required' });
    // media and sign-in keys are the wizard's
    expect((await put({ ADMIN_GROUP: 'ff-admins' })).statusCode).toBe(200);
  });

  it('publicUrl probe: the echo through the public URL answers -> ok; another body -> warning, the save still succeeds', async () => {
    const test = (values: Record<string, unknown>) => env.app.inject({ method: 'POST', url: '/api/setup/test', cookies: s.cookies, headers: { 'x-ff-setup-csrf': s.csrf }, payload: { group: 'general', values } });
    const ok = await test({ PUBLIC_URL: 'https://tv.example.com' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, code: 'ok', probe: 'publicUrl' });
    override = () => new Response(JSON.stringify({ answer: 'something else' }), { status: 200, headers: { 'content-type': 'application/json' } });
    try {
      const warn = await test({ PUBLIC_URL: 'https://other.example.com' });
      expect(warn.json()).toMatchObject({ ok: true, code: 'warning', detail: 'echo_mismatch' });
      expect((await put({ PUBLIC_URL: 'https://other.example.com' })).statusCode).toBe(200);
      expect(env.ctx.cfg.PUBLIC_URL).toBe('https://other.example.com');
      override = () => { throw new TypeError('fetch failed'); };
      expect((await test({ PUBLIC_URL: 'https://down.example.com' })).json()).toMatchObject({ ok: true, code: 'warning', detail: 'unreachable' });
    } finally {
      override = undefined;
    }
    // http works but is a warning (cookies not secure, cast and passkeys off)
    expect((await test({ PUBLIC_URL: 'http://tv.example.com' })).json()).toMatchObject({ ok: true, code: 'warning', detail: 'insecure' });
    // keys outside the wizard are refused here as well
    const other = await env.app.inject({ method: 'POST', url: '/api/setup/test', cookies: s.cookies, headers: { 'x-ff-setup-csrf': s.csrf }, payload: { group: 'requests' } });
    expect(other.statusCode).toBe(400);
  });

  it('runProbe publicUrl directly: the nonce is used once and removed', async () => {
    const before = (await env.kv.keys('setup:echo:')).length;
    const r = await runProbe(env.ctx, 'publicUrl', { ...env.ctx.cfg, PUBLIC_URL: 'https://tv.example.com' });
    expect(r).toEqual({ ok: true, code: 'ok' });
    expect((await env.kv.keys('setup:echo:')).length).toBe(before);
    expect(await runProbe(env.ctx, 'publicUrl', { ...env.ctx.cfg, PUBLIC_URL: '' })).toEqual({ ok: false, code: 'invalid', detail: 'not_set' });
  });

  it('the echo endpoint is no reflector: strict nonce format, unknown nonces 404, a fixed answer shape', async () => {
    for (const n of ['abc', '<script>', 'a'.repeat(44), `${'a'.repeat(42)}%2F`]) {
      const r = await env.app.inject({ url: `/api/setup/echo/${n}` });
      expect(r.statusCode, n).toBe(404);
      expect(r.body).not.toContain('script');
    }
    const unknown = await env.app.inject({ url: `/api/setup/echo/${'a'.repeat(43)}` });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'not_found' });
    await env.kv.set(`setup:echo:${'b'.repeat(43)}`, 'answer-123', 60);
    const known = await env.app.inject({ url: `/api/setup/echo/${'b'.repeat(43)}` });
    expect(known.statusCode).toBe(200);
    expect(known.json()).toEqual({ answer: 'answer-123' });
    expect(known.headers['content-type']).toMatch(/^application\/json/);
  });

  it('after setup completes: an admin ff_sid plus an old ff_setup cookie get 409 setup_complete or 401, never 403 csrf', async () => {
    expect(await isSetupComplete(env.ctx)).toBe(false); // cached for the current rev
    await updateMeta(env.pool, { setupCompletedAt: new Date() });
    // this instance has not seen the completion yet (a lost bus message: up to the 30 s poll), its cached gate still says incomplete;
    // a setup session's write reads the database itself and is refused
    expect(await isSetupComplete(env.ctx)).toBe(false);
    for (const [method, url, payload] of [['PUT', '/api/setup/settings', { values: { PUBLIC_URL: 'https://stale.example.com' } }], ['POST', '/api/setup/media/auto', { url: 'https://jf.example.com', username: 'a', password: 'b' }],
      ['POST', '/api/setup/authentik/apply', { url: 'https://auth.example.com', token: 't', addMeToAdmins: false }]] as const) {
      const w = await env.app.inject({ method, url, cookies: s.cookies, headers: { 'x-ff-setup-csrf': s.csrf }, payload });
      expect(w.statusCode, url).toBe(409);
      expect(w.json()).toEqual({ error: 'setup_complete' });
    }
    expect(env.ctx.cfg.PUBLIC_URL).not.toBe('https://stale.example.com');
    await env.ctx.settings.reload();
    // a cached "complete" is final: 409 without reading the database
    expect(await isSetupComplete(env.ctx)).toBe(true);
    const realDb = env.ctx.db;
    env.ctx.db = { query: async () => { throw new Error('db down'); } } as unknown as typeof realDb;
    try {
      const w = await env.app.inject({ method: 'PUT', url: '/api/setup/settings', cookies: s.cookies, headers: { 'x-ff-setup-csrf': s.csrf }, payload: { values: { PUBLIC_URL: 'https://tv.example.com' } } });
      expect([w.statusCode, w.json()]).toEqual([409, { error: 'setup_complete' }]);
    } finally {
      env.ctx.db = realDb;
    }
    const admin = await env.login({ ...ADMIN, groups: [env.ctx.cfg.ADMIN_GROUP] }); // ADMIN_GROUP was changed by the wizard above
    const both = { ...s.cookies, ...admin.cookies };
    const r = await env.app.inject({ method: 'PUT', url: '/api/setup/settings', cookies: both, payload: { values: { PUBLIC_URL: 'https://tv.example.com' } } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'setup_complete' });
    const t = await env.app.inject({ method: 'POST', url: '/api/setup/test', cookies: both, headers: { 'x-csrf-token': admin.csrf }, payload: { group: 'general' } });
    expect(t.statusCode).toBe(409);
    const u = await env.app.inject({ method: 'POST', url: '/api/setup/unlock', cookies: both, payload: { code: 'AAAA-BBBB-CCCC' }, remoteAddress: freshIp() });
    expect(u.statusCode).toBe(409);
    // once complete, the public state says that and nothing else (no keys, sources or addresses)
    const st = await env.app.inject({ url: '/api/setup/state', cookies: both });
    expect(st.json()).toEqual({ complete: true });
  });
});

describe('links without a public URL (setup mode) do not throw', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv({}, { setupComplete: false }); });
  afterAll(() => env.close());

  it('the gate keeps notifications and invites unreachable; called directly, they keep the link as given', async () => {
    expect((await env.app.inject({ method: 'POST', url: '/api/admin/invites', payload: {} })).statusCode).toBe(503);
    const sent: Array<Record<string, string>> = [];
    const uid = (await env.pool.query("insert into users(id, authentik_sub, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-n','N','admin','jfn','N','x') returning id")).rows[0].id;
    await env.pool.query(`insert into user_prefs(user_id, data) values ($1, '{"ntfyTopic":"topic1"}')`, [uid]);
    const ctx = { db: env.pool, cfg: { ...env.ctx.cfg, PUBLIC_URL: '', NTFY_URL: 'https://ntfy.example.com/x' }, fetchImpl: (async (_u: unknown, init: RequestInit) => { sent.push(init.headers as Record<string, string>); return new Response(null); }) as typeof fetch };
    expect(await pushPersonal(ctx, uid, { title: 'T', link: '/party/abc' })).toBe(true);
    expect(sent[0]!.Click).toBe('/party/abc');
    env.ctx.cfg = { ...env.ctx.cfg, PUBLIC_URL: '' };
    const inv = await createInvite(env.ctx, uid, { role: 'friend', ttlHours: 1 });
    expect(inv.link).toBe(`/invite/${inv.token}`);
  });
});
