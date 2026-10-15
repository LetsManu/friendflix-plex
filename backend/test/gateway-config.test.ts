// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mediaGatewayKeys, mediaUrlKey } from '../src/media/index.js';
import { MEDIA_SETUP } from '../src/media/setup.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';
import { PLEX_TOKEN, PLEX_URL } from './plexfake.js';

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

  it('fork: the Jellyfin answer is unchanged (no upstreamAuth: the gateway uses each user\'s own token)', async () => {
    const r = await gatewayConfig();
    expect(Object.keys(r.json()).sort()).toEqual(['rev', 'upstreamUrl']);
    expect(r.body).not.toContain('adminkey');
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

// fork: FriendFlix for Plex. The gateway has one server-wide Plex token; with settings in the database it reaches the gateway only here.
describe('GET /internal/gateway-config on Plex (gatewayKeys)', () => {
  let plex: TestEnv;
  const lines: string[] = [];
  beforeAll(async () => {
    plex = await makeEnv({}, { server: 'plex', logger: { stream: { write: (l: string) => void lines.push(l) }, level: 'info' } });
  });
  afterAll(() => plex.close());
  const get = (headers: Record<string, string> = SECRET) => plex.app.inject({ method: 'GET', url: '/internal/gateway-config', headers });

  it('MEDIA_SETUP.plex names PLEX_TOKEN as its only gateway key; Jellyfin has none', () => {
    expect(mediaGatewayKeys({ ...cfg, MEDIA_SERVER: 'plex' })).toEqual(['PLEX_TOKEN']);
    expect(mediaGatewayKeys(cfg)).toEqual([]);
    expect(MEDIA_SETUP.jellyfin?.gatewayKeys).toBeUndefined();
  });

  it('with the secret: the URL, the rev and the token as upstreamAuth, no-store', async () => {
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json()).toEqual({ rev: plex.ctx.settings.rev(), upstreamUrl: PLEX_URL, upstreamAuth: { PLEX_TOKEN } });
  });

  it('403 without the right secret: neither the token nor the URL', async () => {
    const prefix = SECRET['x-internal-secret'].slice(0, -1); // a prefix of the right secret (length differs) is refused too
    for (const h of [{} as Record<string, string>, { 'x-internal-secret': '' }, { 'x-internal-secret': 'w'.repeat(22) }, { 'x-internal-secret': prefix }]) {
      const r = await get(h);
      expect([r.statusCode, r.json()]).toEqual([403, { error: 'forbidden' }]);
      expect(JSON.stringify(r.headers) + r.body).not.toContain(PLEX_TOKEN);
      expect(r.body).not.toContain('plex.test');
    }
  });

  it('an empty INTERNAL_SECRET refuses every caller, also one sending an empty header', async () => {
    const saved = plex.ctx.cfg;
    try {
      plex.ctx.cfg = { ...saved, INTERNAL_SECRET: '' };
      for (const h of [{} as Record<string, string>, { 'x-internal-secret': '' }]) {
        const r = await get(h);
        expect(r.statusCode).toBe(403);
        expect(r.body).not.toContain(PLEX_TOKEN);
      }
    } finally {
      plex.ctx.cfg = saved;
    }
    expect((await get()).statusCode).toBe(200);
  });

  it('503 setup_required while the token or the URL is empty (before setup)', async () => {
    for (const unset of [{ PLEX_TOKEN: null }, { PLEX_URL: null }, { PLEX_URL: null, PLEX_TOKEN: null }]) {
      try {
        await plex.ctx.settings.save(unset, null);
        const r = await get();
        expect([r.statusCode, r.json(), r.headers['cache-control']]).toEqual([503, { error: 'setup_required' }, 'no-store']);
        expect(r.body).not.toContain(PLEX_TOKEN);
      } finally {
        await plex.ctx.settings.save({ PLEX_URL, PLEX_TOKEN }, null);
      }
    }
    expect((await get()).statusCode).toBe(200);
  });

  it('a saved token rotation is answered with the new rev at once', async () => {
    const before = (await get()).json();
    try {
      const rev = await plex.ctx.settings.save({ PLEX_TOKEN: 'rotated-plex-token-5678' }, null);
      expect((await get()).json()).toEqual({ rev, upstreamUrl: PLEX_URL, upstreamAuth: { PLEX_TOKEN: 'rotated-plex-token-5678' } });
      expect(rev).toBeGreaterThan(before.rev);
    } finally {
      await plex.ctx.settings.save({ PLEX_TOKEN }, null);
    }
  });

  it('the token is never in the request log', () => {
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n');
    expect(all).toContain('/internal/gateway-config');
    expect(all).not.toContain(PLEX_TOKEN);
    expect(all).not.toContain('rotated-plex-token-5678');
  });
});

describe('GET /internal/gateway-config on Plex with an env-pinned token', () => {
  it('the env value (PLEX_TOKEN pinned for the backend) is the one sent', async () => {
    const pinned = await makeEnv({}, { server: 'plex', settingsEnv: { PLEX_TOKEN } });
    try {
      const r = await pinned.app.inject({ method: 'GET', url: '/internal/gateway-config', headers: SECRET });
      expect(r.json()).toEqual({ rev: pinned.ctx.settings.rev(), upstreamUrl: PLEX_URL, upstreamAuth: { PLEX_TOKEN } });
    } finally {
      await pinned.close();
    }
  });
});
