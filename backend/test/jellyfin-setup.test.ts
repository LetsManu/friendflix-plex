// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { jellyfinSetup } from '../src/jellyfin/setup.js';
import { MediaSetupError } from '../src/media/types.js';
import { issueSetupCode } from '../src/setup/code.js';
import { fakeHttp, makeEnv, type Call, type Handler, type TestEnv } from './helpers.js';

// Block 25 Task 12 (spec Part G "Jellyfin automation", Part H): the API key from an admin username and password.
const PASSWORD = 'pw-placeholder-Zq81'; // a test placeholder, never a real credential
const URL_ = 'http://jf.example.com:8096';
const auto = jellyfinSetup.auto!;

interface FakeOpts { listFailsAfterCreate?: number; wizardDone?: boolean; admin?: boolean; auth?: Handler; createStatus?: number; noNewKey?: boolean; twoNew?: boolean; probeStatus?: number }
function fakeJellyfin(o: FakeOpts = {}) {
  const calls: Call[] = [];
  const inits: RequestInit[] = [];
  const keys = [
    { AccessToken: 'old-ff-key', AppName: 'FriendFlix', DateCreated: '2026-01-01T00:00:00.0000000Z' },
    { AccessToken: 'other-key', AppName: 'Other', DateCreated: '2026-02-01T00:00:00.0000000Z' },
  ];
  let created = false;
  let listFails = o.listFailsAfterCreate ?? 0;
  const routes: Record<string, Handler> = {
    'GET /System/Info/Public': () => ({ json: { StartupWizardCompleted: o.wizardDone ?? true, Version: '10.11.0' } }),
    'POST /Users/AuthenticateByName': o.auth ?? (() => ({ json: { AccessToken: 'sess-token', User: { Id: 'u1', Name: 'admin', Policy: { IsAdministrator: o.admin ?? true } } } })),
    'POST /Auth/Keys': () => {
      if (o.createStatus) return { status: o.createStatus };
      created = true;
      if (!o.noNewKey) {
        if (o.twoNew) keys.push({ AccessToken: 'new-ff-key-a', AppName: 'FriendFlix', DateCreated: '2026-10-15T10:00:00.0000000Z' });
        keys.push({ AccessToken: 'new-ff-key', AppName: 'FriendFlix', DateCreated: '2026-10-15T10:00:01.0000000Z' });
        if (o.twoNew) keys.push({ AccessToken: 'new-ff-key-b', AppName: 'FriendFlix', DateCreated: '2026-10-15T09:59:59.0000000Z' });
        keys.push({ AccessToken: 'newer-other', AppName: 'Other', DateCreated: '2026-10-15T11:00:00.0000000Z' });
      }
      return { status: 204 };
    },
    'GET /Auth/Keys': (_u, init) => {
      if (created && listFails > 0) { listFails--; return { status: 500 }; }
      // the media probe after the save: GET /Auth/Keys with the new key itself
      if (o.probeStatus && (init.headers as Record<string, string>).Authorization?.includes('Token="new-ff-key"')) return { status: o.probeStatus };
      return { json: { Items: keys, TotalRecordCount: keys.length } };
    },
    'DELETE /Auth/Keys/[^/]+': (u) => {
      const i = keys.findIndex((k) => k.AccessToken === decodeURIComponent(u.pathname.split('/').at(-1)!));
      if (i >= 0) keys.splice(i, 1);
      return { status: 204 };
    },
    'POST /Sessions/Logout': () => ({ status: 204 }),
  };
  const base = fakeHttp(routes, calls);
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => { inits.push(init); return base(input, init); }) as typeof fetch;
  return { calls, inits, keys, fetchImpl };
}
const input = { url: URL_, username: 'admin', password: PASSWORD };
const deps = (f: typeof fetch) => ({ fetchImpl: f, appVersion: 'dev' });
const codeOf = async (p: Promise<unknown>) => {
  const e = await p.then(() => undefined, (err: unknown) => err);
  expect(e).toBeInstanceOf(MediaSetupError);
  expect(String((e as Error).message)).not.toContain(PASSWORD);
  return { code: (e as MediaSetupError).code, detail: (e as MediaSetupError).detail };
};

describe('jellyfinSetup provider', () => {
  it('has the keys, URL key and auto fields of spec Part H', () => {
    expect(jellyfinSetup.kind).toBe('jellyfin');
    expect(jellyfinSetup.keys).toEqual(['JELLYFIN_URL', 'JELLYFIN_ADMIN_API_KEY']);
    expect(jellyfinSetup.urlKey).toBe('JELLYFIN_URL');
    expect(auto.fields).toEqual(['url', 'username', 'password']);
  });

  it('StartupWizardCompleted false → wizard_pending, no login attempt', async () => {
    const jf = fakeJellyfin({ wizardDone: false });
    expect(await codeOf(auto.run(input, deps(jf.fetchImpl)))).toMatchObject({ code: 'wizard_pending' });
    expect(jf.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /System/Info/Public']);
  });

  it('IsAdministrator false → not_admin, logout called, no key created', async () => {
    const jf = fakeJellyfin({ admin: false });
    expect(await codeOf(auto.run(input, deps(jf.fetchImpl)))).toMatchObject({ code: 'not_admin' });
    expect(jf.calls.some((c) => c.method === 'POST' && c.path === '/Auth/Keys')).toBe(false);
    const logout = jf.calls.find((c) => c.path === '/Sessions/Logout');
    expect(logout?.auth).toContain('Token="sess-token"');
  });

  it('happy path: POST /Auth/Keys?app=FriendFlix, then the newest FriendFlix key by DateCreated (an older FriendFlix key and a newer \'Other\' key exist) is saved; logout called with the session token', async () => {
    const jf = fakeJellyfin();
    const values = await auto.run(input, deps(jf.fetchImpl));
    expect(values).toEqual({ JELLYFIN_URL: URL_, JELLYFIN_ADMIN_API_KEY: 'new-ff-key' });
    const seq = jf.calls.map((c) => `${c.method} ${c.path}${c.search}`);
    expect(seq).toEqual(['GET /System/Info/Public', 'POST /Users/AuthenticateByName', 'GET /Auth/Keys', 'POST /Auth/Keys?app=FriendFlix', 'GET /Auth/Keys', 'POST /Sessions/Logout']);
    const login = jf.calls[1]!;
    expect(login.body).toEqual({ Username: 'admin', Pw: PASSWORD });
    expect(login.auth).toMatch(/^MediaBrowser Client="FriendFlix", Device="Setup", DeviceId="ff-setup-[0-9a-f]{16}", Version="dev"$/);
    for (const c of jf.calls.slice(2)) expect(c.auth).toContain('Token="sess-token"');
    // a credential is never sent along a redirect, and every call has a deadline
    for (const init of jf.inits) {
      expect(init.redirect).toBe('manual');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('two new FriendFlix keys: the one with the newest DateCreated', async () => {
    const jf = fakeJellyfin({ twoNew: true });
    expect((await auto.run(input, deps(jf.fetchImpl))).JELLYFIN_ADMIN_API_KEY).toBe('new-ff-key');
  });

  it('the listing after the key was created fails once: it is tried again and the key is found; twice: unexpected', async () => {
    const once = fakeJellyfin({ listFailsAfterCreate: 1 });
    expect((await auto.run(input, deps(once.fetchImpl))).JELLYFIN_ADMIN_API_KEY).toBe('new-ff-key');
    expect(await codeOf(auto.run(input, deps(fakeJellyfin({ listFailsAfterCreate: 2 }).fetchImpl)))).toMatchObject({ code: 'unexpected' });
  });

  it('wrong password (401) → unauthorized; other answers and network errors → unreachable; no new key → unexpected', async () => {
    expect(await codeOf(auto.run(input, deps(fakeJellyfin({ auth: () => ({ status: 401 }) }).fetchImpl)))).toMatchObject({ code: 'unauthorized' });
    expect(await codeOf(auto.run(input, deps(fakeJellyfin({ auth: () => ({ status: 500 }) }).fetchImpl)))).toMatchObject({ code: 'unreachable', detail: 'upstream_error' });
    expect(await codeOf(auto.run(input, deps(fakeJellyfin({ auth: () => ({ status: 302 }) }).fetchImpl)))).toMatchObject({ code: 'unreachable', detail: 'redirect' });
    expect(await codeOf(auto.run(input, deps(fakeJellyfin({ auth: () => ({ json: { User: {} } }) }).fetchImpl)))).toMatchObject({ code: 'unexpected' });
    expect(await codeOf(auto.run(input, deps(fakeJellyfin({ auth: () => ({ raw: 'not json' }) }).fetchImpl)))).toMatchObject({ code: 'unexpected' });
    const noKey = fakeJellyfin({ noNewKey: true });
    expect(await codeOf(auto.run(input, deps(noKey.fetchImpl)))).toMatchObject({ code: 'unexpected' });
    expect(noKey.calls.at(-1)?.path).toBe('/Sessions/Logout');
    const denied = fakeJellyfin({ createStatus: 403 });
    expect(await codeOf(auto.run(input, deps(denied.fetchImpl)))).toMatchObject({ code: 'not_admin' });
    expect(denied.calls.at(-1)?.path).toBe('/Sessions/Logout');
    expect(await codeOf(auto.run(input, deps(fakeJellyfin({ createStatus: 500 }).fetchImpl)))).toMatchObject({ code: 'unexpected' });
    // a public info answer that is not Jellyfin's
    const notJf = fakeHttp({ 'GET /System/Info/Public': () => ({ status: 404 }) });
    expect(await codeOf(auto.run(input, deps(notJf)))).toMatchObject({ code: 'unreachable' });
    const garbage = fakeHttp({ 'GET /System/Info/Public': () => ({ raw: 'x'.repeat(100) }) });
    expect(await codeOf(auto.run(input, deps(garbage)))).toMatchObject({ code: 'unreachable' });
  });

  it('a network error or a timeout is unreachable; an error text quoting the password never surfaces', async () => {
    const boom = (err: Error) => (async (u: RequestInfo | URL) => {
      if (String(u).includes('/System/Info/Public')) return new Response(JSON.stringify({ StartupWizardCompleted: true }), { status: 200 });
      throw err;
    }) as typeof fetch;
    expect(await codeOf(auto.run(input, deps(boom(new Error(`connect failed ${PASSWORD}`)))))).toEqual({ code: 'unreachable', detail: undefined });
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    expect(await codeOf(auto.run(input, deps(boom(timeout))))).toEqual({ code: 'unreachable', detail: 'timeout' });
  });

  it('a body that stalls or breaks after the headers is unreachable (timeout / bad_response), not a 500', async () => {
    const broken = (err: Error) => (async () => new Response(new ReadableStream({ pull(c) { c.error(err); } }), { status: 200 })) as unknown as typeof fetch;
    expect(await codeOf(auto.run(input, deps(broken(Object.assign(new Error('t'), { name: 'TimeoutError' })))))).toEqual({ code: 'unreachable', detail: 'timeout' });
    expect(await codeOf(auto.run(input, deps(broken(new TypeError('terminated')))))).toEqual({ code: 'unreachable', detail: 'bad_response' });
  });

  it('revoke: DELETE /Auth/Keys/<key> with that key, no redirect, a deadline; nothing without URL or key; never throws', async () => {
    const jf = fakeJellyfin();
    const values = await auto.run(input, deps(jf.fetchImpl));
    const n = jf.inits.length;
    await auto.revoke!(values, { fetchImpl: jf.fetchImpl });
    const del = jf.calls.at(-1)!;
    expect([del.method, del.path]).toEqual(['DELETE', '/Auth/Keys/new-ff-key']);
    expect(del.auth).toMatch(/Device="Setup", DeviceId="ff-setup-[0-9a-f]{16}".*Token="new-ff-key"/);
    expect(jf.inits[n]).toMatchObject({ method: 'DELETE', redirect: 'manual' });
    expect(jf.inits[n]!.signal).toBeInstanceOf(AbortSignal);
    expect(jf.keys.some((k) => k.AccessToken === 'new-ff-key')).toBe(false);
    await auto.revoke!({ JELLYFIN_URL: URL_ }, { fetchImpl: jf.fetchImpl });
    await auto.revoke!({ JELLYFIN_ADMIN_API_KEY: 'k' }, { fetchImpl: jf.fetchImpl });
    expect(jf.inits.length).toBe(n + 1);
    await expect(auto.revoke!(values, { fetchImpl: (async () => { throw new Error('down'); }) as typeof fetch })).resolves.toBeUndefined();
  });

  it('a logout failure does not change the result (best effort)', async () => {
    const jf = fakeJellyfin();
    const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
      if (String(u).includes('/Sessions/Logout')) throw new Error('gone');
      return jf.fetchImpl(u, init);
    }) as typeof fetch;
    expect((await auto.run(input, deps(f))).JELLYFIN_ADMIN_API_KEY).toBe('new-ff-key');
  });

  it('refuses a URL with credentials or another scheme before any request', async () => {
    const jf = fakeJellyfin();
    for (const url of ['http://user:pass@jf.example.com', 'ftp://jf.example.com', 'not a url']) {
      expect(await codeOf(auto.run({ ...input, url }, deps(jf.fetchImpl)))).toMatchObject({ code: 'invalid', detail: 'invalid_url' });
    }
    expect(jf.calls).toEqual([]);
  });

  it('keeps a reverse-proxy path prefix', async () => {
    const calls: Call[] = [];
    const f = fakeHttp({ 'GET /jf/System/Info/Public': () => ({ json: { StartupWizardCompleted: false } }) }, calls);
    expect(await codeOf(auto.run({ ...input, url: 'https://media.example.com/jf/' }, deps(f)))).toMatchObject({ code: 'wizard_pending' });
    expect(calls[0]?.path).toBe('/jf/System/Info/Public');
  });

  it('probe: GET /Auth/Keys with the key; incomplete / invalid URL without a request', async () => {
    const calls: Call[] = [];
    const f = fakeHttp({ 'GET /Auth/Keys': (_u, init) => ((init.headers as Record<string, string>).Authorization?.includes('Token="good"') ? { json: { Items: [] } } : { status: 401 }) }, calls);
    expect(await jellyfinSetup.probe({ JELLYFIN_URL: URL_, JELLYFIN_ADMIN_API_KEY: 'good' }, { fetchImpl: f })).toEqual({ ok: true, code: 'ok' });
    expect(await jellyfinSetup.probe({ JELLYFIN_URL: URL_, JELLYFIN_ADMIN_API_KEY: 'bad' }, { fetchImpl: f })).toEqual({ ok: false, code: 'not_admin' });
    expect(await jellyfinSetup.probe({ JELLYFIN_URL: URL_ }, { fetchImpl: f })).toEqual({ ok: false, code: 'invalid', detail: 'incomplete' });
    expect(await jellyfinSetup.probe({ JELLYFIN_URL: 'ftp://x', JELLYFIN_ADMIN_API_KEY: 'k' }, { fetchImpl: f })).toEqual({ ok: false, code: 'invalid', detail: 'invalid_url' });
    expect(calls.length).toBe(2);
  });
});

describe('POST /api/setup/media/auto', () => {
  const logs: string[] = [];
  let env: TestEnv;
  let jf: ReturnType<typeof fakeJellyfin>;
  let sess: { cookies: Record<string, string>; csrf: string };
  let ip = 0;
  beforeAll(async () => {
    env = await makeEnv({}, {
      setupComplete: false,
      ctxPatch: (c) => { c.fetchImpl = ((u: RequestInfo | URL, i?: RequestInit) => jf.fetchImpl(u, i)) as typeof fetch; },
      logger: { stream: { write: (l: string) => { logs.push(l); } }, level: 'trace' },
    });
    const code = await issueSetupCode(env.ctx);
    const r = await env.app.inject({ method: 'POST', url: '/api/setup/unlock', payload: { code }, remoteAddress: '10.99.0.1' });
    const csrf = r.cookies.find((c) => c.name === 'ff_setup_csrf')!.value;
    sess = { cookies: { ff_setup: r.cookies.find((c) => c.name === 'ff_setup')!.value, ff_setup_csrf: csrf }, csrf };
  });
  afterAll(() => env.close());
  const post = (payload: Record<string, unknown>, s: Partial<typeof sess> = sess, headers: Record<string, string> = { 'x-ff-setup-csrf': sess.csrf }) =>
    env.app.inject({ method: 'POST', url: '/api/setup/media/auto', cookies: s.cookies ?? {}, headers, payload, remoteAddress: `10.98.0.${++ip}` });

  it('needs the setup session and its csrf header', async () => {
    jf = fakeJellyfin();
    expect((await post(input, {}, {})).statusCode).toBe(401);
    expect((await post(input, sess, {})).statusCode).toBe(403);
    expect(jf.calls).toEqual([]);
  });

  it('validates the URL before any request (http/https, no userinfo)', async () => {
    jf = fakeJellyfin();
    for (const url of ['http://admin:x@jf.example.com', 'file:///etc/passwd', 'javascript:alert(1)']) {
      const r = await post({ ...input, url });
      expect(r.statusCode, url).toBe(400);
      expect(r.json()).toEqual({ ok: false, code: 'invalid', detail: 'invalid_url' });
    }
    expect((await post({ url: URL_ })).statusCode).toBe(400);
    expect(jf.calls).toEqual([]);
  });

  it('saves JELLYFIN_URL and an encrypted JELLYFIN_ADMIN_API_KEY and returns { ok: true }', async () => {
    jf = fakeJellyfin();
    const url = 'http://media.example.com:8096';
    const r = await post({ ...input, url });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    await env.ctx.settings.reload();
    expect(env.ctx.cfg.JELLYFIN_URL).toBe(url);
    expect(env.ctx.cfg.JELLYFIN_ADMIN_API_KEY).toBe('new-ff-key');
    const rows = (await env.pool.query<{ key: string; value: unknown; enc: string | null }>("select key, value, enc from settings where key in ('JELLYFIN_URL', 'JELLYFIN_ADMIN_API_KEY') order by key")).rows;
    expect(rows.map((x) => [x.key, x.value === null, x.enc === null])).toEqual([['JELLYFIN_ADMIN_API_KEY', true, false], ['JELLYFIN_URL', false, true]]);
    expect(JSON.stringify(rows)).not.toContain('new-ff-key');
    // the media probe confirmed the new key before the save
    expect(jf.calls.filter((c) => c.method === 'GET' && c.path === '/Auth/Keys').at(-1)?.auth).toContain('Token="new-ff-key"');
    const audit = await env.pool.query("select meta from audit_log where action = 'settings.update' order by id desc limit 1");
    expect(audit.rows[0].meta).toEqual({ keys: ['JELLYFIN_URL', 'JELLYFIN_ADMIN_API_KEY'] });
  });

  it('a Jellyfin failure answers the ProbeResult code; nothing is saved', async () => {
    jf = fakeJellyfin({ admin: false });
    const before = env.ctx.cfg.JELLYFIN_ADMIN_API_KEY;
    const r = await post({ ...input, url: 'http://other.example.com:8096' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: false, code: 'not_admin' });
    expect(env.ctx.cfg.JELLYFIN_ADMIN_API_KEY).toBe(before);
    jf = fakeJellyfin({ wizardDone: false });
    expect((await post(input)).json()).toEqual({ ok: false, code: 'wizard_pending' });
  });

  it('the probe after creating the key fails (500): 400 probe_failed, the key is revoked with itself, nothing saved, logout still called', async () => {
    jf = fakeJellyfin({ probeStatus: 500 });
    const before = { url: env.ctx.cfg.JELLYFIN_URL, key: env.ctx.cfg.JELLYFIN_ADMIN_API_KEY };
    const rev = env.ctx.settings.rev();
    const r = await post({ ...input, url: 'http://revoke.example.com:8096' });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'probe_failed', group: 'media' });
    expect(r.body).not.toContain(PASSWORD);
    const seq = jf.calls.map((c) => `${c.method} ${c.path}`);
    expect(seq.indexOf('POST /Sessions/Logout')).toBeGreaterThan(-1);
    const del = jf.calls.find((c) => c.method === 'DELETE');
    expect(del).toMatchObject({ path: '/Auth/Keys/new-ff-key', auth: expect.stringContaining('Token="new-ff-key"') });
    expect(seq.indexOf('DELETE /Auth/Keys/new-ff-key')).toBeGreaterThan(seq.indexOf('POST /Sessions/Logout'));
    expect(jf.keys.some((k) => k.AccessToken === 'new-ff-key')).toBe(false);
    await env.ctx.settings.reload();
    expect(env.ctx.settings.rev()).toBe(rev);
    expect({ url: env.ctx.cfg.JELLYFIN_URL, key: env.ctx.cfg.JELLYFIN_ADMIN_API_KEY }).toEqual(before);
    expect(logs.join('\n')).not.toContain(PASSWORD);
  });

  it('one run at a time: 409 busy while another holds the lock (no request)', async () => {
    jf = fakeJellyfin();
    await env.ctx.kv.set('setup:media:auto', '1', 60);
    try {
      const r = await post(input);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: 'busy' });
      expect(jf.calls).toEqual([]);
    } finally {
      await env.ctx.kv.del('setup:media:auto');
    }
    expect((await post(input)).json()).toEqual({ ok: true }); // the lock is released after each run
    expect(await env.ctx.kv.get('setup:media:auto')).toBeNull();
  });

  it('JELLYFIN_URL from the environment: another URL is refused (env_locked); the same URL saves only the key', async () => {
    const real = env.ctx.settings.sources.bind(env.ctx.settings);
    const spy = vi.spyOn(env.ctx.settings, 'sources').mockImplementation(() => ({ ...real(), JELLYFIN_URL: 'env' }));
    try {
      jf = fakeJellyfin();
      const other = await post({ ...input, url: 'http://elsewhere.example.com:8096' });
      expect(other.statusCode).toBe(400);
      expect(other.json()).toEqual({ ok: false, code: 'invalid', detail: 'env_locked' });
      expect(jf.calls).toEqual([]);
      const r = await post({ ...input, url: env.ctx.cfg.JELLYFIN_URL! });
      expect(r.json()).toEqual({ ok: true });
      const audit = await env.pool.query("select meta from audit_log where action = 'settings.update' order by id desc limit 1");
      expect(audit.rows[0].meta).toEqual({ keys: ['JELLYFIN_ADMIN_API_KEY'] });
    } finally {
      spy.mockRestore();
    }
  });

  it('JELLYFIN_ADMIN_API_KEY from the environment: refused (env_key_locked) before any request, so no key is left behind', async () => {
    const real = env.ctx.settings.sources.bind(env.ctx.settings);
    const spy = vi.spyOn(env.ctx.settings, 'sources').mockImplementation(() => ({ ...real(), JELLYFIN_ADMIN_API_KEY: 'env' }));
    try {
      jf = fakeJellyfin();
      const r = await post(input);
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ ok: false, code: 'invalid', detail: 'env_key_locked' });
      expect(jf.calls).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("a provider's revoke that throws synchronously does not escape: still 400 probe_failed", async () => {
    jf = fakeJellyfin({ probeStatus: 500 });
    const revoke = vi.spyOn(auto, 'revoke').mockImplementation(() => { throw new Error('sync throw'); });
    try {
      const r = await post({ ...input, url: 'http://sync.example.com:8096' });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ error: 'probe_failed' });
      expect(revoke).toHaveBeenCalled();
    } finally {
      revoke.mockRestore();
    }
  });

  it('the password never appears in any log call or error message (spy on the logger)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
    try {
      for (const o of [{}, { admin: false }, { auth: () => ({ status: 401 }) }, { auth: () => { throw new Error(`socket closed ${PASSWORD}`); } }] as FakeOpts[]) {
        jf = fakeJellyfin(o);
        const r = await post(input);
        expect(r.body).not.toContain(PASSWORD);
      }
      // a body that fails validation is not echoed either
      expect((await post({ ...input, username: 7 })).body).not.toContain(PASSWORD);
      for (const s of spies) for (const call of s.mock.calls) expect(JSON.stringify(call)).not.toContain(PASSWORD);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(PASSWORD);
  });
});
