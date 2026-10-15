// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mediaUrlKey } from '../src/media/index.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let sid = '';
const SECRET = { 'x-internal-secret': 'internal-secret-123456' };

beforeAll(async () => {
  env = await makeEnv();
  sid = (await env.login()).cookies.ff_sid!;
});
afterAll(() => env.close());

const gatewayConfig = (headers: Record<string, string> = SECRET) => env.app.inject({ method: 'GET', url: '/internal/gateway-config', headers });

describe('GET /internal/gateway-config', () => {
  it('mediaUrlKey names the media server URL setting', () => {
    expect(mediaUrlKey(cfg)).toBe('JELLYFIN_URL');
  });

  it('gateway-config returns the live JELLYFIN_URL and the rev; after saving a new URL it returns the new one', async () => {
    const r = await gatewayConfig();
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json()).toEqual({ rev: env.ctx.settings.rev(), upstreamUrl: 'http://jellyfin:8096' });
    try {
      const rev = await env.ctx.settings.save({ JELLYFIN_URL: 'http://media.internal:8096' }, null);
      const r2 = await gatewayConfig();
      expect(r2.json()).toEqual({ rev, upstreamUrl: 'http://media.internal:8096' });
      expect(rev).toBeGreaterThan(r.json().rev);
    } finally {
      await env.ctx.settings.save({ JELLYFIN_URL: cfg.JELLYFIN_URL }, null);
    }
  });

  it('503 setup_required with an empty URL', async () => {
    try {
      await env.ctx.settings.save({ JELLYFIN_URL: null }, null);
      const r = await gatewayConfig();
      expect([r.statusCode, r.json()]).toEqual([503, { error: 'setup_required' }]);
    } finally {
      await env.ctx.settings.save({ JELLYFIN_URL: cfg.JELLYFIN_URL }, null);
    }
    expect((await gatewayConfig()).statusCode).toBe(200);
  });

  it('403 without the secret', async () => {
    for (const h of [{} as Record<string, string>, { 'x-internal-secret': '' }, { 'x-internal-secret': 'wrong-secret-123456' }]) {
      const r = await gatewayConfig(h);
      expect([r.statusCode, r.json()]).toEqual([403, { error: 'forbidden' }]);
      expect(r.body).not.toContain('jellyfin');
    }
  });

  it('authz answers carry x-ff-config-rev', async () => {
    const rev = String(env.ctx.settings.rev());
    const a = await env.app.inject({ method: 'POST', url: '/internal/authz', headers: SECRET, payload: { sid, ip: '192.168.1.10' } });
    expect(a.statusCode).toBe(200);
    expect(a.headers['x-ff-config-rev']).toBe(rev);
    const u = await env.app.inject({ method: 'POST', url: '/internal/authz', headers: SECRET, payload: { sid: 'x'.repeat(30) } });
    expect([u.statusCode, u.headers['x-ff-config-rev']]).toEqual([401, rev]);
    const i = await env.app.inject({ method: 'POST', url: '/internal/authz/item', headers: SECRET, payload: { sid: 'x'.repeat(30), itemId: 'a'.repeat(32) } });
    expect([i.statusCode, i.headers['x-ff-config-rev']]).toEqual([401, rev]);
    const n = await env.app.inject({ method: 'GET', url: '/internal/authz-nginx', headers: SECRET });
    expect([n.statusCode, n.headers['x-ff-config-rev']]).toEqual([401, rev]);
    // a wrong secret learns nothing, not even the rev
    const f = await env.app.inject({ method: 'POST', url: '/internal/authz', payload: { sid } });
    expect([f.statusCode, f.headers['x-ff-config-rev']]).toEqual([403, undefined]);
    // a save bumps the rev the gateway sees
    try {
      const next = await env.ctx.settings.save({ JELLYFIN_URL: 'http://media.internal:8096' }, null);
      const b = await env.app.inject({ method: 'POST', url: '/internal/authz', headers: SECRET, payload: { sid, ip: '192.168.1.10' } });
      expect(b.headers['x-ff-config-rev']).toBe(String(next));
    } finally {
      await env.ctx.settings.save({ JELLYFIN_URL: cfg.JELLYFIN_URL }, null);
    }
  });
});
