// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { LOGIN_ART_RATINGS, currentArtSet } from '../src/loginArt.js';
import { makeEnv, type Handler, type TestEnv } from './helpers.js';

// Block 23 phase 3, Task 6: the public cover wall (Ruling 6, preflight D2 and D9).
const ID = (n: number) => n.toString(16).padStart(32, '0');
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const items = [
  { Id: ID(1), OfficialRating: 'FSK 12' }, { Id: ID(2), OfficialRating: 'G' }, { Id: ID(3), OfficialRating: 'PG-13' },
  { Id: ID(4) }, { Id: ID(5), OfficialRating: 'NR' }, { Id: ID(6), OfficialRating: 'fsk 12' },
];
const jf = (): Record<string, Handler> => ({
  'GET /Items': () => ({ json: { Items: items } }),
  'GET /Items/[0-9a-f]{32}/Images/Primary': () => ({ raw: JPEG, type: 'image/jpeg' }),
});

let env: TestEnv;
afterEach(async () => { const e = env; env = undefined as unknown as TestEnv; await e?.close(); });

async function start(extra: Parameters<typeof makeEnv>[1] = {}) {
  env = await makeEnv(jf(), extra);
  return env;
}
const art = (e: TestEnv) => e.jfCalls.filter((c) => c.path === '/Items');

describe('login art', () => {
  it('lists paths only: no item ids, no media-server host, no tags', async () => {
    await start();
    const r = await env.app.inject('/api/public/login-art');
    expect(r.statusCode).toBe(200);
    const body = r.body;
    expect(r.json().images.length).toBeGreaterThan(0);
    for (const p of r.json().images as string[]) expect(p).toMatch(/^\/api\/public\/login-art\/[A-Za-z0-9_-]{12}\/\d{1,2}$/);
    for (const bad of [...items.map((i) => i.Id), 'jellyfin', '8096', 'Tags', 'adminkey']) expect(body).not.toContain(bad);
    expect(r.headers['cache-control']).toBe('public, max-age=3600');
    expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('second call within the hour reuses the set (one Jellyfin listing call)', async () => {
    await start();
    const a = (await env.app.inject('/api/public/login-art')).json();
    const b = (await env.app.inject('/api/public/login-art')).json();
    expect(b).toEqual(a);
    expect(art(env)).toHaveLength(1);
  });

  it('concurrent first requests run one Jellyfin listing', async () => {
    await start();
    const rs = await Promise.all([1, 2, 3, 4].map(() => env.app.inject('/api/public/login-art')));
    for (const r of rs) expect(r.json().images.length).toBeGreaterThan(0);
    expect(art(env)).toHaveLength(1);
  });

  it('query has no ParentId and no userId (all libraries) and carries the pipe-joined, URL-encoded rating allow-list incl. "FSK 12"', async () => {
    await start();
    await env.app.inject('/api/public/login-art');
    const c = art(env)[0]!;
    const q = new URLSearchParams(c.search);
    expect([...q.keys()].map((k) => k.toLowerCase())).not.toContain('parentid');
    expect([...q.keys()].map((k) => k.toLowerCase())).not.toContain('userid');
    expect([...q.keys()].map((k) => k.toLowerCase())).not.toContain('maxofficialrating');
    expect(q.get('OfficialRatings')).toBe(LOGIN_ART_RATINGS.join('|'));
    expect(q.get('OfficialRatings')!.split('|')).toContain('FSK 12');
    expect(c.search).toContain('FSK%2012');
    expect(c.search).not.toContain('%2C0');
    expect(q.get('Limit')).toBe('36');
    expect(c.auth).toContain('adminkey'); // the admin key goes out, never into a reply (checked above)
  });

  it('an item returned with a rating outside the allow-list (or none) is dropped', async () => {
    await start();
    const r = (await env.app.inject('/api/public/login-art')).json();
    expect(r.images).toHaveLength(2); // FSK 12 and G only
    const fetched = env.jfCalls.filter((c) => c.path.includes('/Images/Primary')).map((c) => c.path);
    expect(fetched.sort()).toEqual([`/Items/${ID(1)}/Images/Primary`, `/Items/${ID(2)}/Images/Primary`]);
  });

  it('LOGIN_ART_RATINGS contains no PG-13, TV-14, NR or empty value', () => {
    for (const bad of ['PG-13', 'TV-14', 'NR', '', 'Unrated', 'Approved']) expect(LOGIN_ART_RATINGS).not.toContain(bad);
    expect(LOGIN_ART_RATINGS).toContain('FSK 12');
    expect(new Set(LOGIN_ART_RATINGS).size).toBe(LOGIN_ART_RATINGS.length);
  });

  it('coverWall off → images []', async () => {
    await start();
    env.ctx.cfg = { ...env.ctx.cfg, LOGIN_COVER_WALL: 'false' };
    const r = await env.app.inject('/api/public/login-art');
    expect(r.json()).toEqual({ images: [] });
    expect(art(env)).toHaveLength(0);
  });

  it('media server without loginArtIds → images []', async () => {
    await start({ ctxPatch: (c) => { delete (c.jf.admin as { loginArtIds?: unknown }).loginArtIds; } });
    expect((await env.app.inject('/api/public/login-art')).json()).toEqual({ images: [] });
    expect(await currentArtSet(env.ctx)).toBeNull();
  });

  it('image route serves bytes with immutable cache; bad set → 404', async () => {
    await start();
    const [first] = (await env.app.inject('/api/public/login-art')).json().images as string[];
    const r = await env.app.inject(first!);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.headers['cache-control']).toBe('public, max-age=3600, immutable');
    expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect([...r.rawPayload]).toEqual([...JPEG]);
    const set = first!.split('/')[4]!;
    for (const url of ['/api/public/login-art/short/0', `/api/public/login-art/${set}/abc`, `/api/public/login-art/${set}/100`, `/api/public/login-art/${set}/35`, '/api/public/login-art/aaaaaaaaaaaa/0']) {
      const x = await env.app.inject(url);
      expect(x.statusCode, url).toBe(404);
    }
  });

  it('the wall is switched off through the settings store (the registry key LOGIN_COVER_WALL)', async () => {
    // PUT /api/admin/settings refuses the key ("unknown") until Task 9 makes it visible; the store write is what that route performs
    await start();
    expect((await env.app.inject('/api/public/login-art')).json().images.length).toBeGreaterThan(0);
    await env.ctx.settings.save({ LOGIN_COVER_WALL: false }, null);
    expect(env.ctx.cfg.LOGIN_COVER_WALL).toBe('false');
    expect((await env.app.inject('/api/public/login-art')).json()).toEqual({ images: [] });
  });

  it('stays behind the setup gate: 503 setup_required during setup', async () => {
    await start({ setupComplete: false });
    for (const url of ['/api/public/login-art', `/api/public/login-art/aaaaaaaaaaaa/0`]) {
      const r = await env.app.inject(url);
      expect([r.statusCode, r.json()], url).toEqual([503, { error: 'setup_required' }]);
    }
    expect(art(env)).toHaveLength(0);
  });

  it('a failed image is skipped; the set is compact (half-built set stays consistent)', async () => {
    env = await makeEnv({ [`GET /Items/${ID(1)}/Images/Primary`]: () => ({ status: 500 }), ...jf() });
    const r = (await env.app.inject('/api/public/login-art')).json().images as string[];
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/\/0$/);
    expect((await env.app.inject(r[0]!)).statusCode).toBe(200);
  });

  it('no image at all: empty answer is no-store', async () => {
    env = await makeEnv({ 'GET /Items/[0-9a-f]{32}/Images/Primary': () => ({ status: 404 }), 'GET /Items': () => ({ json: { Items: items } }) });
    const r = await env.app.inject('/api/public/login-art');
    expect(r.json()).toEqual({ images: [] });
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('a failed or empty build is remembered: no second listing within the window', async () => {
    env = await makeEnv({ 'GET /Items': () => ({ status: 500 }) });
    for (let i = 0; i < 3; i++) {
      const r = await env.app.inject('/api/public/login-art');
      expect(r.json()).toEqual({ images: [] });
      expect(r.headers['cache-control']).toBe('no-store');
    }
    expect(art(env)).toHaveLength(1);
    expect(JSON.stringify(env.jfCalls)).toContain('/Items'); // only the one listing; no error text reaches the reply
  });

  it('a waiter that gives up while another request holds the lock gets an uncached empty list', async () => {
    await start();
    await env.kv.setnx('loginart:building', 'other', 60);
    const r = await env.app.inject('/api/public/login-art');
    expect(r.json()).toEqual({ images: [] });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(art(env)).toHaveLength(0);
  }, 20_000);

  it('images outlive the list', async () => {
    await start();
    await env.app.inject('/api/public/login-art');
    const { LOGIN_ART_IMAGE_TTL, LOGIN_ART_TTL } = await import('../src/loginArt.js');
    expect(LOGIN_ART_IMAGE_TTL).toBeGreaterThan(2 * LOGIN_ART_TTL);
  });

  it('image route answers 404 when the wall is off, and rejects a leading zero', async () => {
    await start();
    const [first] = (await env.app.inject('/api/public/login-art')).json().images as string[];
    expect((await env.app.inject(first!.replace(/\/0$/, '/00'))).statusCode).toBe(404);
    expect((await env.app.inject(first!)).statusCode).toBe(200);
    env.ctx.cfg = { ...env.ctx.cfg, LOGIN_COVER_WALL: 'false' };
    const r = await env.app.inject(first!);
    expect(r.statusCode).toBe(404);
    expect(r.headers['cache-control']).toBe('no-store');
  });
});
