import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../src/ctx.js';
import { makeEnv, type TestEnv } from './helpers.js';

const CUR = 'c'.repeat(40);
const NEW = 'd'.repeat(40);
const HOOK = 'https://portainer.example.com/api/stacks/webhooks/secret-token-uuid';
const KEY = 'ptr_supersecretkey';

interface Seen { method: string; url: string; headers: Record<string, string>; body: any }
let env: TestEnv;
let seen: Seen[];
let stack: any;
const host = (u: string) => new URL(u).host;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const mockFetch = (gh: 'ok' | 'fail' = 'ok') => vi.fn(async (input: any, init: RequestInit = {}) => {
  const url = String(input);
  seen.push({ method: init.method ?? 'GET', url, headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
  if (host(url) === 'api.github.com') {
    if (gh === 'fail') return json({}, 500);
    if (url.includes('/actions/workflows/ci.yml/runs')) return json({ workflow_runs: [{ head_sha: NEW, updated_at: '2026-01-02T00:00:00Z', html_url: 'https://github.com/x/runs/1' }] });
    if (url.includes(`/compare/${CUR}...${NEW}`)) return json({ ahead_by: 2, commits: [1, 2].map((n) => ({ sha: `s${n}`, html_url: `https://github.com/c/${n}`, commit: { message: `msg ${n}\n\nbody`, author: { name: 'Ann', date: '2026-01-01T00:00:00Z' } } })) });
  }
  if (url.endsWith('/api/stacks/7/file')) return json({ StackFileContent: 'services: {}' });
  if (url.includes('/api/stacks/7') && (init.method ?? 'GET') === 'GET') return json(stack);
  if (host(url) === 'portainer.example.com') return new Response(null, { status: 204 });
  return json({}, 404);
});

async function setup(cfg: Record<string, unknown> = {}, gh: 'ok' | 'fail' = 'ok') {
  env = await makeEnv({}, { ctxPatch: (c: Ctx) => { c.cfg = { ...c.cfg, GIT_SHA: CUR, BUILD_TIME: '2026-01-01T00:00:00Z', ...cfg }; } });
  env.ctx.fetchImpl = mockFetch(gh) as any;
  const admin = await env.login();
  const post = (cookies = admin.cookies, csrf = admin.csrf) => env.app.inject({ method: 'POST', url: '/api/admin/update', cookies, headers: { 'x-csrf-token': csrf } });
  const get = (q = '') => env.app.inject({ url: `/api/admin/update${q}`, cookies: admin.cookies });
  return { admin, post, get };
}
const ghCalls = () => seen.filter((s) => host(s.url) === 'api.github.com').length;

beforeEach(() => { seen = []; stack = { Env: [{ name: 'A', value: '1' }, { name: 'B', value: 'x y' }], GitConfig: null }; });
afterEach(() => env?.close());

describe('admin update', () => {
  it('combines run and compare, caches, refresh bypasses', async () => {
    const { get } = await setup();
    const r = await get();
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.latest).toEqual({ sha: NEW, date: '2026-01-02T00:00:00Z', runUrl: 'https://github.com/x/runs/1' });
    expect(b.behind).toBe(2);
    expect(b.commits.map((c: any) => c.message)).toEqual(['msg 2', 'msg 1']);
    expect(b.current).toEqual({ sha: CUR, builtAt: '2026-01-01T00:00:00Z' });
    expect(b.portainer).toEqual({ configured: false, mode: null });
    expect(ghCalls()).toBe(2);
    await get();
    expect(ghCalls()).toBe(2);
    await get('?refresh=1');
    expect(ghCalls()).toBe(4);
    expect(seen[0]!.headers['user-agent']).toBe('friendflix');
  });

  it('GitHub failure gives latest null, not a 500', async () => {
    const { get } = await setup({}, 'fail');
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ latest: null, behind: null, commits: [], error: 'GitHub 500' });
  });

  it('dev build returns latest without compare', async () => {
    const { get } = await setup({ GIT_SHA: 'dev' });
    const b = (await get()).json();
    expect(b.latest.sha).toBe(NEW);
    expect(b.commits).toEqual([]);
    expect(ghCalls()).toBe(1);
  });

  it('exposes the version unauthenticated', async () => {
    await setup();
    expect((await env.app.inject('/api/version')).json()).toEqual({ sha: CUR });
    expect((await env.app.inject('/health')).json().version).toBe(CUR.slice(0, 7));
  });

  it('not configured -> 409', async () => {
    const { post } = await setup();
    expect((await post()).statusCode).toBe(409);
  });

  it('non-admins get 403', async () => {
    const { post } = await setup({ PORTAINER_WEBHOOK_URL: HOOK });
    await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'u1','u@example.com','U','friend','jfu','u','x')");
    const u = await env.login({ sub: 'u1', email: 'u@example.com', name: 'U', groups: [] });
    expect((await post(u.cookies, u.csrf)).statusCode).toBe(403);
    expect((await env.app.inject({ url: '/api/admin/update', cookies: u.cookies })).statusCode).toBe(403);
  });

  it('webhook mode posts to the URL, audits, and leaks no secret', async () => {
    const { post, get } = await setup({ PORTAINER_WEBHOOK_URL: HOOK });
    const g = await get();
    expect(g.json().portainer).toEqual({ configured: true, mode: 'webhook' });
    const r = await post();
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ ok: true, mode: 'webhook' });
    const hook = seen.find((s) => s.url === HOOK)!;
    expect(hook.method).toBe('POST');
    expect(hook.body).toBeUndefined();
    const a = await env.pool.query("select actor, meta from audit_log where action='system.update'");
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0].meta).toMatchObject({ from: CUR, to: NEW });
    for (const t of [g.body, r.body, JSON.stringify(a.rows)]) expect(t).not.toContain('secret-token');
  });

  it('portainer error -> 502 with status only', async () => {
    const { post } = await setup({ PORTAINER_WEBHOOK_URL: HOOK });
    (env.ctx.fetchImpl as any) = vi.fn(async () => new Response(null, { status: 404 }));
    const r = await post();
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: 'portainer', status: 404, step: 'webhook' });
    expect(r.body).not.toContain('secret-token');
  });

  it('unreachable portainer -> 502 with the errno code only, never the URL', async () => {
    const { post } = await setup({ PORTAINER_WEBHOOK_URL: HOOK });
    (env.ctx.fetchImpl as any) = vi.fn(async (url: string) => { throw Object.assign(new TypeError(`fetch failed ${url}`), { cause: { code: 'ENOTFOUND', hostname: url } }); });
    const r = await post();
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: 'portainer_unreachable', status: null, step: 'webhook', code: 'ENOTFOUND' });
    expect(r.body).not.toContain('secret-token');
  });

  it('unreachable portainer -> 502 with the errno code only, never the URL', async () => {
    const { post } = await setup({ PORTAINER_WEBHOOK_URL: HOOK });
    (env.ctx.fetchImpl as any) = vi.fn(async (url: string) => { throw Object.assign(new TypeError(`fetch failed ${url}`), { cause: { code: 'ENOTFOUND', hostname: url } }); });
    const r = await post();
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: 'portainer_unreachable', status: null, step: 'webhook', code: 'ENOTFOUND' });
    expect(r.body).not.toContain('secret-token');
  });

  const api = { PORTAINER_URL: 'https://portainer.example.com/', PORTAINER_API_KEY: KEY, PORTAINER_STACK_ID: '7', PORTAINER_ENDPOINT_ID: 3 };

  it('api mode, git stack: git/redeploy with pullImage and preserved env', async () => {
    stack.GitConfig = { ReferenceName: 'refs/heads/main' };
    const { post, get } = await setup(api);
    const g = await get();
    const r = await post();
    expect(r.statusCode).toBe(202);
    const put = seen.find((s) => s.method === 'PUT')!;
    expect(put.url).toBe('https://portainer.example.com/api/stacks/7/git/redeploy?endpointId=3');
    expect(put.headers['x-api-key']).toBe(KEY);
    expect(put.body).toMatchObject({ pullImage: true, prune: false, env: stack.Env, repositoryReferenceName: 'refs/heads/main' });
    expect(g.body + r.body).not.toContain(KEY);
  });

  it('api mode, file stack: stackFileContent and env', async () => {
    const { post } = await setup(api);
    expect((await post()).statusCode).toBe(202);
    const put = seen.find((s) => s.method === 'PUT')!;
    expect(put.url).toBe('https://portainer.example.com/api/stacks/7?endpointId=3');
    expect(put.body).toMatchObject({ stackFileContent: 'services: {}', env: stack.Env, pullImage: true, prune: false });
  });

  it('rate limit: second POST within 2 minutes -> 429', async () => {
    const { post } = await setup({ PORTAINER_WEBHOOK_URL: HOOK });
    expect((await post()).statusCode).toBe(202);
    expect((await post()).statusCode).toBe(429);
  });
});
