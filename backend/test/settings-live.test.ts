// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { createLiveCtx } from '../src/ctx.js';
import type { MediaRuntime, MediaServer } from '../src/media/types.js';
import { createLazyOidc, type OidcProvider } from '../src/oidc.js';
import { previews, previewWarmTick } from '../src/previews.js';
import { SeerrClient } from '../src/seerr/client.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

describe('live settings in the context', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv(); });
  afterAll(() => env.close());

  it('saving JELLYFIN_URL swaps ctx.jf: the next admin ping goes to the new URL', async () => {
    const before = env.ctx.jf;
    expect(await env.ctx.jf.admin.ping()).toBe(true);
    expect(env.jfCalls.at(-1)).toMatchObject({ host: 'jellyfin:8096', path: '/System/Ping' });
    await env.ctx.settings.save({ JELLYFIN_URL: 'http://media.internal:8096' }, null);
    expect(env.ctx.jf).not.toBe(before);
    expect(await env.ctx.jf.admin.ping()).toBe(true);
    expect(env.jfCalls.at(-1)).toMatchObject({ host: 'media.internal:8096', path: '/System/Ping' });
    // an unrelated change keeps the instance
    const now = env.ctx.jf;
    await env.ctx.settings.save({ CAST_ENABLED: false }, null);
    expect(env.ctx.jf).toBe(now);
    await env.ctx.settings.save({ JELLYFIN_URL: cfg.JELLYFIN_URL }, null);
  });

  it('saving the request service keys swaps ctx.seerr', async () => {
    const before = env.ctx.seerr;
    await env.ctx.settings.save({ REQUESTS_URL: 'http://requests2:5055' }, null);
    expect(env.ctx.seerr).not.toBe(before);
    expect(env.ctx.seerr).toBeInstanceOf(SeerrClient);
  });

  it('ctx.cfg reflects a saved SESSION_IDLE_SECONDS on the next request without restart', async () => {
    const set = vi.spyOn(env.kv, 'set');
    try {
      await env.ctx.settings.save({ SESSION_IDLE_SECONDS: 120 }, null);
      expect(env.ctx.cfg.SESSION_IDLE_SECONDS).toBe(120);
      await env.login();
      const sess = set.mock.calls.filter(([k]) => k.startsWith('sess:'));
      expect(sess.length).toBeGreaterThan(0);
      for (const [, , ttl] of sess) expect(ttl).toBe(120);
    } finally {
      set.mockRestore();
      await env.ctx.settings.save({ SESSION_IDLE_SECONDS: cfg.SESSION_IDLE_SECONDS }, null);
    }
  });

  it('PREVIEW_WARM=false -> warm tick does nothing; after saving true -> the next tick warms', async () => {
    const warm = vi.spyOn(previews(env.ctx), 'warmTick').mockResolvedValue(undefined);
    try {
      expect(env.ctx.cfg.PREVIEW_WARM).toBe('false');
      await previewWarmTick(env.ctx);
      expect(warm).not.toHaveBeenCalled();
      await env.ctx.settings.save({ PREVIEW_WARM: true }, null);
      await previewWarmTick(env.ctx);
      expect(warm).toHaveBeenCalledTimes(1);
    } finally {
      warm.mockRestore();
      await env.ctx.settings.save({ PREVIEW_WARM: false }, null);
    }
  });

  it('ctx.cfg assignments in tests are overrides that report env; a frozen snapshot cannot be mutated', async () => {
    const orig = env.ctx.cfg;
    expect(Object.isFrozen(orig)).toBe(true);
    expect(() => { (env.ctx.cfg as { CAST_ENABLED: string }).CAST_ENABLED = 'false'; }).toThrow(TypeError);
    env.ctx.cfg = { ...orig, OMDB_API_KEY: 'omdb-override-1' };
    expect(env.ctx.cfg.OMDB_API_KEY).toBe('omdb-override-1');
    expect(env.ctx.settings.sources().OMDB_API_KEY).toBe('env');
    env.ctx.cfg = orig;
    expect(env.ctx.cfg.OMDB_API_KEY).toBeUndefined();
    expect(env.ctx.settings.sources().OMDB_API_KEY).toBe('unset');
  });

  it('a TMDB key saved in the database reports from: db, and the admin route publishes a revision', async () => {
    const admin = await env.login();
    const sk = `sess:${admin.cookies.ff_sid}`; // replacing a source key needs a recent re-authentication
    await env.kv.set(sk, JSON.stringify({ ...JSON.parse((await env.kv.get(sk))!), reauthAt: Date.now() }), 600);
    await env.ctx.settings.save({ TMDB_API_KEY: 'saved-in-db-1234' }, null);
    const st = await env.app.inject({ url: '/api/admin/sources/tmdb', cookies: admin.cookies });
    expect(st.json()).toMatchObject({ set: true, from: 'db', last4: '1234' });
    const rev = env.ctx.settings.rev();
    const put = await env.app.inject({ method: 'PUT', url: '/api/admin/sources/tmdb', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { key: 'route-saved-5678' } });
    expect(put.json()).toMatchObject({ from: 'db', last4: '5678' });
    expect(env.ctx.settings.rev()).toBeGreaterThan(rev);
    expect(env.ctx.cfg.TMDB_API_KEY).toBe('route-saved-5678');
    await env.app.inject({ method: 'DELETE', url: '/api/admin/sources/tmdb', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf } });
    expect(env.ctx.cfg.TMDB_API_KEY).toBeUndefined();
  });

  it('media holder: concurrent changes stop every replaced instance and leave exactly the current one started', async () => {
    const made: Array<{ url: string | undefined; started: number; stopped: number }> = [];
    const media = (c: Config) => {
      const rec = { url: c.JELLYFIN_URL, started: 0, stopped: 0 };
      made.push(rec);
      return {
        rec,
        start: async () => { await new Promise((r) => setTimeout(r, 5)); rec.started++; },
        stop: async () => { await new Promise((r) => setTimeout(r, 5)); rec.stopped++; },
      } as unknown as MediaServer;
    };
    const live = createLiveCtx({
      settings: env.ctx.settings, kv: env.kv, db: env.pool, encKey: env.ctx.encKey, fetchImpl: fetch, roles: env.ctx.roles, oidc: env.ctx.oidc,
      media, requests: (c) => new SeerrClient(c.REQUESTS_URL, c.REQUESTS_API_KEY), log: { warn: () => {} },
    });
    try {
      const rt: MediaRuntime = { dispatch: async () => {}, log: { warn: () => {}, info: () => {} } };
      await live.startMedia(rt);
      await Promise.all([
        env.ctx.settings.save({ JELLYFIN_URL: 'http://a.internal:8096' }, null),
        env.ctx.settings.save({ JELLYFIN_URL: 'http://b.internal:8096' }, null),
        env.ctx.settings.save({ JELLYFIN_ADMIN_API_KEY: 'other-admin-key' }, null),
      ]);
      await live.ready();
      const current = (live.ctx.jf as unknown as { rec: (typeof made)[number] }).rec;
      expect(current.url).toBe(env.ctx.cfg.JELLYFIN_URL);
      expect(current).toMatchObject({ started: 1, stopped: 0 });
      for (const r of made) if (r !== current) expect(r.started).toBe(r.stopped);
      expect(() => { live.ctx.cfg = env.ctx.cfg; }).toThrow(/read-only/);
    } finally {
      await live.close();
      await env.ctx.settings.save({ JELLYFIN_URL: cfg.JELLYFIN_URL, JELLYFIN_ADMIN_API_KEY: cfg.JELLYFIN_ADMIN_API_KEY }, null);
    }
    expect(made.every((r) => r.started === r.stopped)).toBe(true);
  });
  it('media holder: start() waits until the app is operational (setup mode, spec Part E1); syncMedia starts it once', async () => {
    let operational = false;
    const made: Array<{ url: string | undefined; started: number; stopped: number }> = [];
    const media = (c: Config) => {
      const rec = { url: c.JELLYFIN_URL, started: 0, stopped: 0 };
      made.push(rec);
      return { rec, start: async () => { rec.started++; }, stop: async () => { rec.stopped++; } } as unknown as MediaServer;
    };
    const live = createLiveCtx({
      settings: env.ctx.settings, kv: env.kv, db: env.pool, encKey: env.ctx.encKey, fetchImpl: fetch, roles: env.ctx.roles, oidc: env.ctx.oidc,
      media, requests: (c) => new SeerrClient(c.REQUESTS_URL, c.REQUESTS_API_KEY), log: { warn: () => {} }, operational: () => operational,
    });
    try {
      await live.startMedia({ dispatch: async () => {}, log: { warn: () => {}, info: () => {} } });
      await live.syncMedia();
      expect(made[0]).toMatchObject({ started: 0, stopped: 0 });
      // the wizard saves the media settings: a new instance, still not started
      await env.ctx.settings.save({ JELLYFIN_URL: 'http://wizard.internal:8096' }, null);
      await live.ready();
      expect(made.map((r) => [r.started, r.stopped])).toEqual([[0, 0], [0, 0]]);
      operational = true;
      await live.syncMedia();
      await live.syncMedia();
      expect(made.map((r) => [r.started, r.stopped])).toEqual([[0, 0], [1, 0]]);
    } finally {
      await live.close();
      await env.ctx.settings.save({ JELLYFIN_URL: cfg.JELLYFIN_URL }, null);
    }
    expect(made.map((r) => [r.started, r.stopped])).toEqual([[0, 0], [1, 1]]);
  });
  it('media holder: a factory that throws keeps the previous instance; failing stop()/start() are logged, not thrown', async () => {
    const warned: string[] = [];
    let fail: 'build' | 'lifecycle' = 'build';
    const media = (c: Config) => {
      if (c.JELLYFIN_URL === 'http://broken.internal:8096' && fail === 'build') throw new Error('bad');
      return { url: c.JELLYFIN_URL, start: async () => { if (fail === 'lifecycle') throw new Error('start'); }, stop: async () => { throw new Error('stop'); } } as unknown as MediaServer;
    };
    const live = createLiveCtx({
      settings: env.ctx.settings, kv: env.kv, db: env.pool, encKey: env.ctx.encKey, fetchImpl: fetch, roles: env.ctx.roles, oidc: env.ctx.oidc,
      media, requests: (c) => new SeerrClient(c.REQUESTS_URL, c.REQUESTS_API_KEY), log: { warn: (_o, m) => { warned.push(m); } },
    });
    try {
      const first = live.ctx.jf;
      await live.startMedia({ dispatch: async () => {}, log: { warn: () => {}, info: () => {} } });
      await env.ctx.settings.save({ JELLYFIN_URL: 'http://broken.internal:8096' }, null);
      expect(live.ctx.jf).toBe(first);
      fail = 'lifecycle';
      await env.ctx.settings.save({ JELLYFIN_ADMIN_API_KEY: 'another-key' }, null);
      expect((live.ctx.jf as unknown as { url: string }).url).toBe('http://broken.internal:8096');
      expect(warned).toEqual([
        'media server rebuild failed; keeping the previous one', 'stopping the replaced media server failed', 'starting the media server failed',
      ]);
    } finally {
      await live.close().catch(() => undefined);
      await env.ctx.settings.save({ JELLYFIN_URL: cfg.JELLYFIN_URL, JELLYFIN_ADMIN_API_KEY: cfg.JELLYFIN_ADMIN_API_KEY }, null);
    }
  });
});

describe('lazy OIDC', () => {
  let env: TestEnv;
  const discovered: string[] = [];
  const fake: OidcProvider = {
    start: async () => ({ url: 'https://idp.example.com/authorize?x=1', state: `s${Math.random().toString(36).slice(2)}`, nonce: 'n', codeVerifier: 'v' }),
    finish: async () => { throw new Error('unused'); },
  };
  const discover = async (c: Config): Promise<OidcProvider> => {
    discovered.push(c.OIDC_ISSUER);
    if (c.OIDC_ISSUER !== 'https://idp.example.com/') throw new Error('discovery failed');
    return fake;
  };
  beforeAll(async () => {
    env = await makeEnv({}, { ctxPatch: (c) => { c.oidc = createLazyOidc(() => c.cfg, { discover }); } });
  });
  afterAll(() => env.close());
  afterEach(() => { vi.useRealTimers(); });

  it('oidc discovery failure -> /auth/login answers 503 oidc_unavailable and the backend stays up; after saving a reachable issuer the next login starts', async () => {
    const first = await env.app.inject('/auth/login');
    expect(first.statusCode).toBe(503);
    expect(first.json()).toEqual({ error: 'oidc_unavailable' });
    expect((await env.app.inject('/health')).statusCode).toBe(200);
    // backoff: no new discovery within 30 s
    expect((await env.app.inject('/auth/login')).statusCode).toBe(503);
    expect(discovered).toEqual(['https://auth.example.com/']);
    await env.ctx.settings.save({ OIDC_ISSUER: 'https://idp.example.com/' }, null);
    const ok = await env.app.inject('/auth/login');
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toBe('https://idp.example.com/authorize?x=1');
    expect(discovered).toEqual(['https://auth.example.com/', 'https://idp.example.com/']);
    // cached: no further discovery
    await env.app.inject('/auth/login');
    expect(discovered).toHaveLength(2);
  });

  it('retries a failed discovery after 30 s; one discovery serves concurrent callers', async () => {
    let now = 1_000_000;
    let calls = 0;
    let up = false;
    const oidc = createLazyOidc(() => cfg, {
      now: () => now,
      discover: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); if (!up) throw new Error('down'); return fake; },
    });
    await expect(oidc.start()).rejects.toMatchObject({ statusCode: 503, message: 'oidc_unavailable' });
    up = true;
    now += 29_000;
    await expect(oidc.start()).rejects.toMatchObject({ statusCode: 503 });
    expect(calls).toBe(1);
    now += 2_000;
    await Promise.all([oidc.start(), oidc.start(), oidc.finish(new URL('https://x/'), { state: 's', nonce: 'n', codeVerifier: 'v' }).catch(() => null)]);
    expect(calls).toBe(2);
    // a reset during a discovery: the stale result is not cached
    oidc.reset();
    const p = oidc.start();
    oidc.reset();
    await p;
    await oidc.start();
    expect(calls).toBe(4);
  });

  it('saving PUBLIC_URL drops the cached provider (its redirect_uri): the next login discovers again', async () => {
    expect((await env.app.inject('/auth/login')).statusCode).toBe(302); // cached from the test above
    const before = discovered.length;
    await env.app.inject('/auth/login');
    expect(discovered).toHaveLength(before);
    await env.ctx.settings.save({ PUBLIC_URL: 'https://friend2.example.com' }, null);
    expect((await env.app.inject('/auth/login')).statusCode).toBe(302);
    expect(discovered).toHaveLength(before + 1);
  });

  it('a callback whose provider became unavailable answers 503 oidc_unavailable, not 401 login_failed', async () => {
    const l = await env.app.inject('/auth/login');
    const state = l.cookies.find((c) => c.name === 'ff_oidc')!.value;
    await env.ctx.settings.save({ OIDC_ISSUER: 'https://down.example.com/' }, null);
    const cb = await env.app.inject({ url: `/auth/callback?state=${state}&code=c`, cookies: { ff_oidc: state } });
    expect(cb.statusCode).toBe(503);
    expect(cb.json()).toEqual({ error: 'oidc_unavailable' });
  });

  it('an empty OIDC_ISSUER is unavailable, not a crash', async () => {
    const oidc = createLazyOidc(() => ({ ...cfg, OIDC_ISSUER: '' }));
    await expect(oidc.start()).rejects.toMatchObject({ statusCode: 503, message: 'oidc_unavailable' });
  });
});

describe('an empty PUBLIC_URL', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv({}, { ctxPatch: (c) => { c.cfg = { ...c.cfg, PUBLIC_URL: '' }; } }); });
  afterAll(() => env.close());

  it('buildApp succeeds; origin checks match nothing and cookies are not marked secure', async () => {
    expect((await env.app.inject('/health')).statusCode).toBe(200);
    const beacon = (headers: Record<string, string>) => env.app.inject({
      method: 'POST', url: '/api/client-errors', headers: { 'content-type': 'application/json', ...headers },
      payload: JSON.stringify({ message: 'x', url: '/', userAgent: 'UA', kind: 'error' }),
    });
    expect((await beacon({ origin: 'https://portal.example.com' })).statusCode).toBe(403);
    expect((await beacon({})).statusCode).toBe(204);
    const code = await env.app.inject({ method: 'POST', url: '/api/tv/code' });
    expect(code.statusCode).toBe(200);
  });

  it('a callback without a PUBLIC_URL answers 503 oidc_unavailable (no TypeError, no 401)', async () => {
    const l = await env.app.inject('/auth/login');
    const state = l.cookies.find((c) => c.name === 'ff_oidc')!.value;
    const cb = await env.app.inject({ url: `/auth/callback?state=${state}&code=c`, cookies: { ff_oidc: state } });
    expect(cb.statusCode).toBe(503);
    expect(cb.json()).toEqual({ error: 'oidc_unavailable' });
  });

  it('cookies follow a PUBLIC_URL saved later (secure once it is https)', async () => {
    const plain = await env.app.inject('/auth/login');
    expect(plain.cookies.find((c) => c.name === 'ff_oidc')?.secure).toBeFalsy();
    await env.ctx.settings.save({ PUBLIC_URL: 'https://portal.example.com' }, null); // the real save path, not a test override
    const secure = await env.app.inject('/auth/login');
    expect(secure.cookies.find((c) => c.name === 'ff_oidc')?.secure).toBe(true);
  });

  it('a re-authentication callback without a PUBLIC_URL answers 503, not the reauth-failed redirect', async () => {
    const { cookies } = await env.login(); // PUBLIC_URL is set by the test above
    env.ctx.cfg = { ...env.ctx.cfg, PUBLIC_URL: '' };
    const r = await env.app.inject({ url: '/auth/reauth', cookies });
    expect(r.statusCode).toBe(302);
    const state = r.cookies.find((c) => c.name === 'ff_oidc')!.value;
    const cb = await env.app.inject({ url: `/auth/callback?state=${state}&code=c`, cookies: { ...cookies, ff_oidc: state } });
    expect(cb.statusCode).toBe(503);
    expect(cb.json()).toEqual({ error: 'oidc_unavailable' });
  });
});
