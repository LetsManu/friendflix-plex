// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ImageInfo } from '../src/docker.js';
import { Updater, type Ops } from '../src/job.js';
import { ReplayCache, deriveKey, sign, type Verifier } from '../src/protocol.js';
import { handler, healthProbe, servicesView } from '../src/server.js';
import { DEFAULT_STATE, memoryStore } from '../src/state.js';

const key = deriveKey('server-test-secret-0123456789');
let server: Server, base: string, updater: Updater, verifier: Verifier, warnings: string[], started: string[];
let release: () => void = () => {};

function ops(): Ops {
  const info: ImageInfo = { repoDigests: [], gitSha: 'a'.repeat(40), version: '1.0.0' };
  return {
    images: async (tag, s) => Object.fromEntries(s.map((x) => [x, `ghcr.io/letsmanu/friendflix-${x}:${tag}`])),
    pull: async (tag) => { started.push(tag); await new Promise<void>((r) => { release = r; }); },
    verify: async () => true, up: async () => {}, imageInfo: async () => info, running: async () => info, spawnSelfUpdate: async () => {}, healthy: async () => true,
  };
}

beforeAll(async () => {
  server = createServer((req, res) => { void handler({
    get updater() { return updater; }, get verifier() { return verifier; },
    services: async () => [{ service: 'backend', state: 'running', health: 'healthy', sha: 'sha-aaaaaaa', version: '1.0.0' }],
    self: { version: '1.0.0', sha: null }, warn: (m: string) => warnings.push(m),
  } as never)(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  release();
  warnings = []; started = [];
  updater = new Updater(ops(), memoryStore(DEFAULT_STATE), { sleep: async () => {} });
  verifier = { key, cache: new ReplayCache(), notBefore: Date.now() - 1000 };
});

const call = (method: string, path: string, body = '', o: { headers?: Record<string, string>; unsigned?: boolean } = {}) =>
  fetch(base + path, { method, body: method === 'GET' ? undefined : body, headers: { ...(o.unsigned ? {} : sign(key, method, path, body)), ...(body.startsWith('{') ? { 'content-type': 'application/json' } : {}), ...o.headers } });

describe('updater HTTP API', () => {
  it('healthz is open, everything else needs a signature', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const r = await call('GET', '/v1/status', '', { unsigned: true });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'missing' });
    expect(warnings).toEqual(['refused status: missing']);
  });

  it('status (signed)', async () => {
    const r = await call('GET', '/v1/status');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toMatchObject({ channel: 'stable', targetTag: 'latest', current: null, previous: null, busy: false, job: null, services: [{ service: 'backend' }], updater: { version: '1.0.0' } });
  });

  it('a replayed request is refused', async () => {
    const h = sign(key, 'POST', '/v1/update', '');
    expect((await fetch(`${base}/v1/update`, { method: 'POST', headers: h })).status).toBe(202);
    release();
    await updater.idle();
    const again = await fetch(`${base}/v1/update`, { method: 'POST', headers: h });
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: 'replay' });
  });

  it('unknown paths and wrong methods; no other action exists', async () => {
    for (const p of ['/v1/exec', '/v1/run', '/v1/update/../exec', '/v1/services/postgres', '/']) expect((await call('POST', p)).status, p).toBe(404);
    expect((await call('GET', '/v1/update')).status).toBe(405);
    expect((await call('POST', '/v1/status')).status).toBe(405);
  });

  it('update: 202 with the job, then 409 while it runs', async () => {
    const r = await call('POST', '/v1/update');
    expect(r.status).toBe(202);
    expect((await r.json()).job).toMatchObject({ action: 'update', to: 'latest', state: 'running' });
    expect((await call('POST', '/v1/update')).status).toBe(409);
    expect((await call('POST', '/v1/channel', '{"channel":"nightly"}')).status).toBe(409);
    release();
    await updater.idle();
    expect(started).toEqual(['latest']);
  });

  it('job actions take no parameters (no image, service or tag can be passed)', async () => {
    for (const b of ['{"tag":"evil"}', '{"services":["postgres"]}', 'x']) expect((await call('POST', '/v1/update', b)).status, b).toBe(400);
    expect((await call('POST', '/v1/rollback', '{}')).status).toBe(400); // no previous build recorded
    expect(await (await call('POST', '/v1/rollback')).json()).toEqual({ error: 'no_previous' });
  });

  it('channel: strict body, JSON only', async () => {
    const ok = await call('POST', '/v1/channel', '{"channel":"pinned","version":"1.2.3"}');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ channel: 'pinned', version: '1.2.3', targetTag: '1.2.3' });
    expect(updater.snapshot()).toMatchObject({ channel: 'pinned', version: '1.2.3' });
    for (const b of ['{"channel":"pinned","version":"latest"}', '{"channel":"stable","tag":"x"}', '{"channel":"edge"}', '{broken', '[]']) {
      expect((await call('POST', '/v1/channel', b, { headers: { 'content-type': 'application/json' } })).status, b).toBe(400);
    }
    expect((await call('POST', '/v1/channel', 'channel=stable', { headers: { 'content-type': 'text/plain' } })).status).toBe(415);
  });

  it('a body over 1 KB is refused before the signature check', async () => {
    const big = `{"channel":"stable","x":"${'a'.repeat(2000)}"}`;
    const r = await fetch(`${base}/v1/channel`, { method: 'POST', body: big, headers: { 'content-type': 'application/json' } }).catch(() => null);
    expect(r === null || r.status === 413).toBe(true);
  });

  it('self-update starts only on its explicit action', async () => {
    const r = await call('POST', '/v1/self-update');
    expect(r.status).toBe(202);
    expect((await r.json()).job.action).toBe('self-update');
    release();
    await updater.idle();
  });
});

describe('health probe and service view', () => {
  const ps = (rows: Array<{ service: string; state: string; health: string }>) => ({ ps: async () => rows.map((r) => ({ ...r, name: `ff-${r.service}-1` })) });
  const up = [{ service: 'backend', state: 'running', health: 'healthy' }, { service: 'gateway', state: 'running', health: 'healthy' }, { service: 'web', state: 'running', health: '' }];
  const answer = (b: unknown, status = 200) => (async () => new Response(JSON.stringify(b), { status })) as unknown as typeof fetch;

  it('healthy only when every service runs (healthy where checked) and the backend reports the new build', async () => {
    expect(await healthProbe(ps(up), 'http://backend:3000/health', answer({ status: 'ok', version: 'bbbbbbb' }))('bbbbbbb')).toBe(true);
    expect(await healthProbe(ps(up), 'http://backend:3000/health', answer({ status: 'ok', version: 'aaaaaaa' }))('bbbbbbb')).toBe(false);
    expect(await healthProbe(ps(up), 'http://backend:3000/health', answer({ status: 'ok', version: 'aaaaaaa' }))(null)).toBe(true);
    expect(await healthProbe(ps(up), 'http://backend:3000/health', answer({}, 503))(null)).toBe(false);
    expect(await healthProbe(ps(up.map((u) => (u.service === 'gateway' ? { ...u, health: 'starting' } : u))), 'http://b/health', answer({}))(null)).toBe(false);
    expect(await healthProbe(ps(up.slice(0, 2)), 'http://b/health', answer({}))(null)).toBe(false);
  });

  it('service view is cached', async () => {
    let n = 0, t = 0;
    const d = { ps: async () => { n++; return [{ service: 'backend', name: 'ff-backend-1', state: 'running', health: 'healthy' }]; },
      containerImage: async () => 'sha256:' + 'e'.repeat(64), imageInfo: async () => ({ repoDigests: [], gitSha: 'c'.repeat(40), version: '1.1.0' }) };
    const view = servicesView(d, 10_000, () => t);
    const v = await view();
    expect(v.find((s) => s.service === 'backend')).toEqual({ service: 'backend', state: 'running', health: 'healthy', sha: 'sha-ccccccc', version: '1.1.0' });
    expect(v.find((s) => s.service === 'web')).toEqual({ service: 'web', state: 'missing', health: '', sha: null, version: null });
    await view();
    expect(n).toBe(1);
    t = 20_000;
    await view();
    expect(n).toBe(2);
  });
});
