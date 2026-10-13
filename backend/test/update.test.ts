import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../src/ctx.js';
import { readFileSync } from 'node:fs';
import { makeEnv, type TestEnv } from './helpers.js';

const VERSION_JSON = JSON.parse(readFileSync(new URL('../../version.json', import.meta.url), 'utf8')) as { version: string; codename: string };

const CUR = 'c'.repeat(40);
const NEW = 'd'.repeat(40);
const HOOK = 'https://portainer.example.com/api/stacks/webhooks/secret-token-uuid';
const KEY = 'ptr_supersecretkey';

interface Seen { method: string; url: string; headers: Record<string, string>; body: any }
let env: TestEnv;
let seen: Seen[];
let stack: any;
/** GitHub releases/latest answer; null = no release published (404) */
let release: any;
const host = (u: string) => new URL(u).host;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const mockFetch = (gh: 'ok' | 'fail' = 'ok') => vi.fn(async (input: any, init: RequestInit = {}) => {
  const url = String(input);
  seen.push({ method: init.method ?? 'GET', url, headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
  if (host(url) === 'api.github.com') {
    if (gh === 'fail') return json({}, 500);
    if (url.endsWith('/releases/latest')) return release ? json(release) : json({ message: 'Not Found' }, 404);
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

beforeEach(() => { seen = []; release = null; stack = { Env: [{ name: 'A', value: '1' }, { name: 'B', value: 'x y' }], GitConfig: null }; });
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
    expect(b.current).toEqual({ sha: CUR, builtAt: '2026-01-01T00:00:00Z', ...VERSION_JSON }); // no APP_VERSION: read from version.json
    expect(b.release).toBeNull();
    expect(b.updateAvailable).toBeNull();
    expect(b.portainer).toEqual({ configured: false, mode: null });
    expect(ghCalls()).toBe(3);
    await get();
    expect(ghCalls()).toBe(3);
    await get('?refresh=1');
    expect(ghCalls()).toBe(6);
    expect(seen[0]!.headers['user-agent']).toBe('friendflix');
  });

  it('GitHub failure gives latest null, not a 500', async () => {
    const { get } = await setup({}, 'fail');
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ release: null, updateAvailable: null, latest: null, behind: null, commits: [], error: 'GitHub 500' });
  });

  it('dev build returns latest without compare', async () => {
    const { get } = await setup({ GIT_SHA: 'dev' });
    const b = (await get()).json();
    expect(b.latest.sha).toBe(NEW);
    expect(b.commits).toEqual([]);
    expect(ghCalls()).toBe(2);
  });

  const rel = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, name: `${tag} Arancini`, html_url: `https://github.com/x/releases/tag/${tag}`, published_at: '2026-10-01T00:00:00Z', body: '### Neu\n- <b>fett</b> & mehr', draft: false, prerelease: false, ...extra });

  it('release newer than the installed version: update available, notes and codename', async () => {
    release = rel('v1.1.0');
    const { get } = await setup({ APP_VERSION: '1.0.0', APP_CODENAME: 'Arancini' });
    const b = (await get()).json();
    expect(b.updateAvailable).toBe(true);
    expect(b.release).toEqual({ version: '1.1.0', codename: 'Arancini', tag: 'v1.1.0', name: 'v1.1.0 Arancini', url: 'https://github.com/x/releases/tag/v1.1.0', publishedAt: '2026-10-01T00:00:00Z', notes: '### Neu\n- <b>fett</b> & mehr' });
    expect(b.current).toMatchObject({ version: '1.0.0', codename: 'Arancini', sha: CUR });
    expect(b.behind).toBe(2); // commits ahead stay as secondary info
    expect(seen.some((s) => s.url === 'https://api.github.com/repos/LetsManu/friendflix/releases/latest')).toBe(true);
  });

  it('a new major release carries the next codename', async () => {
    release = rel('v2.0.0');
    const { get } = await setup({ APP_VERSION: '1.4.2' });
    const b = (await get()).json();
    expect(b.updateAvailable).toBe(true);
    expect(b.release.codename).toBe('Brezel');
    expect(b.current.codename).toBe('Arancini'); // derived from the major when APP_CODENAME is unset
  });

  it('installed version equals the newest release: up to date', async () => {
    release = rel('v1.1.0');
    const { get } = await setup({ APP_VERSION: '1.1.0', APP_CODENAME: 'Arancini' });
    const b = (await get()).json();
    expect(b.updateAvailable).toBe(false);
    expect(b.release.version).toBe('1.1.0');
  });

  it('no release yet: no release answer, commits ahead decide', async () => {
    const { get } = await setup({ APP_VERSION: '1.0.0' });
    const b = (await get()).json();
    expect(b.release).toBeNull();
    expect(b.updateAvailable).toBeNull();
    expect(b.behind).toBe(2);
    expect(b.error).toBeUndefined();
  });

  it('dev/main build newer than the last release: not an update, main build stays secondary info', async () => {
    release = rel('v1.1.0');
    const { get } = await setup({ GIT_SHA: 'dev', APP_VERSION: '1.2.0' });
    const b = (await get()).json();
    expect(b.updateAvailable).toBe(false);
    expect(b.latest.sha).toBe(NEW);
    expect(b.current).toMatchObject({ sha: 'dev', version: '1.2.0' });
  });

  it('drafts, pre-releases and non-version tags are ignored', async () => {
    release = rel('v9.0.0', { prerelease: true });
    const { get } = await setup({ APP_VERSION: '1.0.0' });
    expect((await get()).json()).toMatchObject({ release: null, updateAvailable: null });
    for (const r of [rel('nightly'), rel('v9.0.0', { draft: true })]) {
      release = r;
      expect((await get('?refresh=1')).json()).toMatchObject({ release: null, updateAvailable: null });
    }
  });

  it('exposes the version unauthenticated', async () => {
    await setup({ APP_VERSION: '1.3.0', APP_CODENAME: 'Arancini' });
    expect((await env.app.inject('/api/version')).json()).toEqual({ sha: CUR, version: '1.3.0', codename: 'Arancini' });
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
