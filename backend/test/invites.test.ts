import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

const AK = { AUTHENTIK_URL: 'https://auth.example.com', AUTHENTIK_API_TOKEN: 't', AUTHENTIK_ENROLL_FLOW: 'enroll' };
const FLOW_PK = '0f3c9a4e-0000-4000-8000-000000000001';

/** Fake Authentik API; `ak.mode` switches the failure path under test. */
const ak = {
  mode: 'ok' as 'ok' | 'flow404' | 'forbidden' | 'down',
  calls: [] as Array<{ method: string; url: string; auth: string | null; body: any }>,
};
const akFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input);
  const method = init.method ?? 'GET';
  ak.calls.push({ method, url, auth: new Headers(init.headers).get('authorization'), body: init.body ? JSON.parse(String(init.body)) : undefined });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (ak.mode === 'down') throw new TypeError('fetch failed');
  if (method === 'GET' && url === 'https://auth.example.com/api/v3/flows/instances/enroll/') {
    return ak.mode === 'flow404' ? json({ detail: 'No Flow matches the given query.' }, 404) : json({ pk: FLOW_PK, slug: 'enroll' });
  }
  if (method === 'POST' && url === 'https://auth.example.com/api/v3/stages/invitation/invitations/') {
    return ak.mode === 'forbidden' ? json({ detail: 'You do not have permission to perform this action.' }, 403) : json({ pk: 'ak-inv-1', name: 'x' }, 201);
  }
  if (method === 'DELETE' && url.startsWith('https://auth.example.com/api/v3/stages/invitation/invitations/')) return new Response(null, { status: 204 });
  return json({ detail: 'not found' }, 404);
}) as unknown as typeof fetch;

let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
beforeAll(async () => {
  env = await makeEnv({}, {
    ctxPatch: (c) => {
      c.fetchImpl = akFetch;
      c.cfg = { ...cfg, ...AK };
      // realistic authorize request on the Authentik host (path + query becomes the enrollment `next`)
      c.oidc.start = async () => {
        const state = 's' + Math.random().toString(36).slice(2);
        return { url: `https://auth.example.com/application/o/authorize/?client_id=ff&response_type=code&state=${state}`, state, nonce: 'n', codeVerifier: 'v' };
      };
    },
  });
  admin = await env.login();
});
beforeEach(() => { ak.mode = 'ok'; ak.calls.length = 0; });
afterAll(() => env.close());

const adm = (method: string, url: string, body?: unknown) => env.app.inject({ method: method as 'GET', url, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: body as object });

async function inviteLogin(token: string | undefined, sub: string, headers: Record<string, string> = {}, cookies: Record<string, string> = {}) {
  env.claims.current = { sub, email: `${sub}@x.de`, name: `Freund ${sub}`, groups: [] };
  const l = await env.app.inject(`/auth/login${token ? `?invite=${token}` : ''}`);
  if (l.statusCode !== 302) return l;
  const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
  return env.app.inject({ url: `/auth/callback?state=${st}&code=c`, headers, cookies: { ...cookies, ff_oidc: st } });
}

describe('invites', () => {
  it('only admins can create invites; token is stored hashed', async () => {
    const r = await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 24, note: 'Max' });
    expect(r.statusCode).toBe(200);
    const inv = r.json();
    expect(inv.link).toMatch(/^https:\/\/portal\.example\.com\/invite\/[\w-]{30,}$/);
    const token = inv.link.split('/').pop();
    expect(inv.authentik).toBe('ok');
    expect(inv.enrollUrl).toBe(`https://portal.example.com/auth/enroll?invite=${token}`);
    const row = (await env.pool.query('select token_hash from invites')).rows[0];
    expect(row.token_hash).not.toContain(token);
    await expect(env.app.inject({ method: 'POST', url: '/api/admin/invites', payload: { role: 'friend' } })).resolves.toMatchObject({ statusCode: 401 });
  });

  it('invite info is public but reveals nothing for invalid tokens', async () => {
    const token = (await adm('POST', '/api/admin/invites', { role: 'guest', ttlHours: 1 })).json().link.split('/').pop();
    const ok = await env.app.inject(`/api/invite/${token}`);
    expect(ok.json()).toMatchObject({ role: 'guest', roleLabel: 'Gast' });
    expect((await env.app.inject('/api/invite/' + 'x'.repeat(30))).statusCode).toBe(404);
  });

  it('redeeming creates user + jellyfin account with role policy and is single use', async () => {
    const token = (await adm('POST', '/api/admin/invites', { role: 'guest', ttlHours: 1 })).json().link.split('/').pop();
    env.jfCalls.length = 0;
    const cb = await inviteLogin(token, 'guest1');
    expect(cb.statusCode).toBe(302);
    const u = (await env.pool.query("select * from users where authentik_sub='guest1'")).rows[0];
    expect(u.role).toBe('guest');
    const pol = env.jfCalls.filter((c) => c.path.endsWith('/Policy')).at(-1)!.body;
    expect(pol).toMatchObject({ MaxParentalRating: 12, EnableVideoPlaybackTranscoding: true, MaxActiveSessions: 1, RemoteClientBitrateLimit: 8_000_000, EnableContentDownloading: false });
    // second use fails
    expect((await inviteLogin(token, 'guest2')).statusCode).toBe(410);
    expect((await env.pool.query("select 1 from users where authentik_sub='guest2'")).rowCount).toBe(0);
    const inv = (await adm('GET', '/api/admin/invites')).json().invites.find((i: any) => i.used_by_name);
    expect(inv.used_by_name).toBe('Freund guest1');
  });

  it('expired invites are rejected and unknown users need an invite', async () => {
    const token = (await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 1 })).json().link.split('/').pop();
    await env.pool.query("update invites set expires_at = now() - interval '1 minute' where used_at is null");
    expect((await inviteLogin(token, 'late')).statusCode).toBe(410);
    expect((await inviteLogin(undefined, 'noinvite')).statusCode).toBe(403);
  });

  it('a failed provisioning releases the invite', async () => {
    const token = (await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 1 })).json().link.split('/').pop();
    const orig = env.ctx.jf.admin.createIdentity;
    env.ctx.jf.admin.createIdentity = async () => { throw new Error('jellyfin down'); };
    expect((await inviteLogin(token, 'f1')).statusCode).toBe(401);
    env.ctx.jf.admin.createIdentity = orig;
    expect((await inviteLogin(token, 'f1')).statusCode).toBe(302);
  });

  it('creates a single-use Authentik invitation bound to the enrollment flow', async () => {
    const r = await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 24 });
    expect(r.json().authentik).toBe('ok');
    expect(ak.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://auth.example.com/api/v3/flows/instances/enroll/',
      'POST https://auth.example.com/api/v3/stages/invitation/invitations/',
    ]);
    const post = ak.calls[1]!;
    expect(post.auth).toBe('Bearer t');
    expect(post.body).toMatchObject({ single_use: false, flow: FLOW_PK, fixed_data: {} });
    expect(post.body.name).toMatch(/^ff-[a-z0-9]+$/); // Authentik validates the name as a slug
    expect(Math.abs(new Date(post.body.expires).getTime() - new Date(r.json().expiresAt).getTime())).toBeLessThan(1000);
  });

  it('enrollment link: portal login -> Authentik enrollment -> authorize -> callback, one pass', async () => {
    const token = (await adm('POST', '/api/admin/invites', { role: 'family', ttlHours: 24 })).json().link.split('/').pop();
    expect((await env.app.inject(`/api/invite/${token}`)).json().enrollUrl).toBe(`/auth/enroll?invite=${token}`);

    // 1. invite page button -> portal starts the OIDC login and hands over to the enrollment flow
    const e = await env.app.inject(`/auth/enroll?invite=${token}`);
    expect(e.statusCode).toBe(302);
    const loc = new URL(e.headers.location as string);
    expect(`${loc.origin}${loc.pathname}`).toBe('https://auth.example.com/if/flow/enroll/');
    expect(loc.searchParams.get('itoken')).toBe('ak-inv-1');
    const cookie = e.cookies.find((c) => c.name === 'ff_oidc')!;
    expect(cookie.maxAge).toBe(1800); // enough time for sign-up + MFA setup
    // 2. Authentik only follows a relative `next`: the authorize request the portal just started
    const next = loc.searchParams.get('next')!;
    expect(next.startsWith('/application/o/authorize/?')).toBe(true);
    expect(new URLSearchParams(next.split('?')[1]).get('state')).toBe(cookie.value);

    // 3. after enrollment Authentik continues `next` and redirects to /auth/callback (same browser)
    env.claims.current = { sub: 'enrolled1', email: 'e1@x.de', name: 'Neu Eins', groups: [] };
    const cb = await env.app.inject({ url: `/auth/callback?state=${cookie.value}&code=c`, cookies: { ff_oidc: cookie.value } });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/');
    expect(cb.cookies.find((c) => c.name === 'ff_sid')).toBeTruthy();
    const u = (await env.pool.query("select role from users where authentik_sub='enrolled1'")).rows[0];
    expect(u.role).toBe('family');
    expect((await env.app.inject(`/auth/enroll?invite=${token}`)).statusCode).toBe(410); // used up
  });

  it('invite for an existing Authentik user skips enrollment', async () => {
    const r = (await adm('POST', '/api/admin/invites', { role: 'guest', ttlHours: 1, enroll: false })).json();
    expect(r.authentik).toBe('skipped');
    expect(r.enrollUrl).toBeUndefined();
    expect(ak.calls).toHaveLength(0);
    const token = r.link.split('/').pop();
    expect((await env.app.inject(`/api/invite/${token}`)).json().enrollUrl).toBeUndefined();
    const e = await env.app.inject(`/auth/enroll?invite=${token}`);
    expect(e.statusCode).toBe(302);
    expect(e.headers.location).toBe(`/auth/login?invite=${token}`);
    expect((await env.app.inject('/auth/enroll?invite=' + 'x'.repeat(30))).statusCode).toBe(410);
  });

  it('Authentik failures are logged and fall back to a portal-only invite', async () => {
    const { createInvite } = await import('../src/invites.js');
    const user = (await env.pool.query("select id from users where role='admin' limit 1")).rows[0].id;
    const run = async (mode: typeof ak.mode, c = env.ctx) => {
      ak.mode = mode; ak.calls.length = 0;
      const warnings: string[] = [];
      const inv = await createInvite(c, user, { role: 'friend', ttlHours: 1 }, { warn: (_o, msg) => warnings.push(msg) });
      return { inv, warnings };
    };

    const forbidden = await run('forbidden');
    expect(forbidden.inv).toMatchObject({ authentik: 'failed', enrollUrl: undefined });
    expect(forbidden.warnings.join()).toMatch(/invitation creation failed.*Can add Invitation/);

    const flow404 = await run('flow404');
    expect(flow404.inv.authentik).toBe('failed');
    expect(flow404.warnings.join()).toMatch(/enrollment flow "enroll" not found/);
    expect(ak.calls.filter((x) => x.method === 'POST')).toHaveLength(0);

    const down = await run('down');
    expect(down.inv.authentik).toBe('failed');
    expect(down.warnings.join()).toMatch(/Authentik unreachable/);

    const partial = await run('ok', { ...env.ctx, cfg: { ...env.ctx.cfg, AUTHENTIK_API_TOKEN: undefined } });
    expect(partial.inv.authentik).toBe('off');
    expect(partial.warnings.join()).toMatch(/AUTHENTIK_API_TOKEN not set/);
    expect(ak.calls).toHaveLength(0);

    // the portal invite still works for someone with an existing Authentik account
    expect((await env.app.inject(`/api/invite/${forbidden.inv.token}`)).json().enrollUrl).toBeUndefined();
    expect((await inviteLogin(forbidden.inv.token, 'fallback1')).statusCode).toBe(302);
  });

  it('concurrent redemption only succeeds once', async () => {
    const token = (await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 1 })).json().link.split('/').pop();
    const { claimInvite } = await import('../src/invites.js');
    const res = await Promise.all([claimInvite(env.ctx, token), claimInvite(env.ctx, token), claimInvite(env.ctx, token)]);
    expect(res.filter(Boolean)).toHaveLength(1);
  });
});

describe('devices', () => {
  it('first device is trusted, second needs approval, approval unlocks the pending session', async () => {
    const u1 = await inviteLogin((await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 1 })).json().link.split('/').pop(), 'dev-user');
    const c1 = Object.fromEntries(u1.cookies.map((c) => [c.name, c.value]));
    expect((await env.app.inject({ url: '/api/library/views', cookies: c1 })).statusCode).not.toBe(403);

    // login again from another browser (no ff_dev cookie)
    const u2 = await inviteLogin(undefined, 'dev-user');
    const c2 = Object.fromEntries(u2.cookies.map((c) => [c.name, c.value]));
    expect(c2.ff_dev).not.toBe(c1.ff_dev);
    const me2 = await env.app.inject({ url: '/api/me', cookies: c2 });
    expect(me2.json().deviceApproved).toBe(false);
    expect((await env.app.inject({ url: '/api/library/views', cookies: c2 })).json()).toEqual({ error: 'device_pending' });
    // gateway authz also refuses the pending session
    const authz = await env.app.inject({ method: 'POST', url: '/internal/authz', headers: { 'x-internal-secret': cfg.INTERNAL_SECRET }, payload: { sid: c2.ff_sid } });
    expect(authz.statusCode).toBe(401);

    // the user is told about the waiting device (bell notification linking to the approval list)
    const note = (await env.pool.query("select link, title from notifications where kind='device_pending' order by id desc limit 1")).rows[0];
    expect(note).toMatchObject({ link: '/devices' });

    // approve from the first device
    const me1 = (await env.app.inject({ url: '/api/me', cookies: c1 })).json();
    const list = (await env.app.inject({ url: '/api/devices', cookies: c1 })).json().devices;
    const pending = list.find((d: any) => !d.approved);
    const ap = await env.app.inject({ method: 'POST', url: `/api/devices/${pending.id}/approve`, cookies: c1, headers: { 'x-csrf-token': me1.csrfToken } });
    expect(ap.statusCode).toBe(200);
    expect((await env.app.inject({ url: '/api/library/views', cookies: c2 })).statusCode).not.toBe(403);
    expect((await env.app.inject({ url: '/api/me', cookies: c2 })).json().deviceApproved).toBe(true);
  });
});

describe('admin user management', () => {
  it('role change re-applies the jellyfin policy; disabling blocks and revokes sessions', async () => {
    const sub = 'managed';
    const u = await inviteLogin((await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 1 })).json().link.split('/').pop(), sub);
    const c = Object.fromEntries(u.cookies.map((x) => [x.name, x.value]));
    const row = (await env.pool.query('select id from users where authentik_sub=$1', [sub])).rows[0];
    env.jfCalls.length = 0;
    expect((await adm('PATCH', `/api/admin/users/${row.id}`, { role: 'family' })).statusCode).toBe(200);
    expect(env.jfCalls.filter((x) => x.path.endsWith('/Policy')).at(-1)!.body).toMatchObject({ EnableContentDownloading: true, MaxActiveSessions: 4 });
    expect((await adm('PATCH', `/api/admin/users/${row.id}`, { disabled: true })).statusCode).toBe(200);
    expect(env.jfCalls.filter((x) => x.path.endsWith('/Policy')).at(-1)!.body).toMatchObject({ IsDisabled: true });
    expect((await env.app.inject({ url: '/api/me', cookies: c })).statusCode).toBe(401);
    const audit = (await adm('GET', '/api/admin/audit')).json().entries.map((e: any) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['user.role', 'user.disable', 'invite.create', 'user.provisioned']));
  });
  it('non-admins are forbidden; admins cannot lock themselves out', async () => {
    const me = (await adm('GET', '/api/admin/users')).json().users.find((x: any) => x.role === 'admin');
    expect((await adm('PATCH', `/api/admin/users/${me.id}`, { disabled: true })).statusCode).toBe(400);
    const token = (await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 1 })).json().link.split('/').pop();
    const u = await inviteLogin(token, 'plain');
    const c = Object.fromEntries(u.cookies.map((x) => [x.name, x.value]));
    expect((await env.app.inject({ url: '/api/admin/users', cookies: c })).statusCode).toBe(403);
  });

  it('the Authentik invitation is reusable until the portal invite is redeemed, then deleted', async () => {
    const inv = (await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 24 })).json();
    expect(ak.calls.find((c) => c.method === 'POST')!.body).toMatchObject({ single_use: false });
    ak.calls.length = 0;
    const token = inv.link.split('/').pop();
    expect((await inviteLogin(token, 'reuse-1')).statusCode).toBe(302);
    await vi.waitFor(() => expect(ak.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)); // deletion is fire-and-forget
    expect(ak.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['https://auth.example.com/api/v3/stages/invitation/invitations/ak-inv-1/']);
  });
  it('revoking an invite deletes its Authentik invitation', async () => {
    const inv = (await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 24 })).json();
    ak.calls.length = 0;
    expect((await adm('DELETE', `/api/admin/invites/${inv.id}`)).statusCode).toBe(200);
    expect(ak.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });
});
