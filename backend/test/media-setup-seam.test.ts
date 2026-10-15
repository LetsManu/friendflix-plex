// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { mediaSettings, mediaSetupKeys, mediaUrlKey } from '../src/media/index.js';
import { MEDIA_SETUP, type MediaSetupProvider } from '../src/media/setup.js';
import { runProbe } from '../src/settings/probes.js';
import { cfg, fakeHttp, makeEnv, type TestEnv } from './helpers.js';

// Block 25 Task 12 (spec Part H): the media setup seam. A fork (Plex) adds MEDIA_SETUP.<kind>; a kind without an entry, or without
// `auto`, still gets a working wizard step from mediaSettings().
describe('media setup seam', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv({}, { setupComplete: false }); });
  afterAll(() => env.close());

  /** runs fn with MEDIA_SETUP[kind] replaced (undefined = removed) */
  async function withEntry<T>(entry: MediaSetupProvider | undefined, fn: () => Promise<T>): Promise<T> {
    const prev = MEDIA_SETUP.jellyfin;
    if (entry) MEDIA_SETUP.jellyfin = entry;
    else delete MEDIA_SETUP.jellyfin;
    try {
      return await fn();
    } finally {
      MEDIA_SETUP.jellyfin = prev;
    }
  }

  it('GET /api/setup/state reports the provider\'s keys and auto fields', async () => {
    expect((await env.app.inject('/api/setup/state')).json().media).toEqual({ keys: ['JELLYFIN_URL', 'JELLYFIN_ADMIN_API_KEY'], auto: ['url', 'username', 'password'] });
  });

  it('a kind without MEDIA_SETUP entry → state.media has keys from mediaSettings() and auto null', async () => {
    await withEntry(undefined, async () => {
      const keys = mediaSettings().map((d) => d.key);
      expect((await env.app.inject('/api/setup/state')).json().media).toEqual({ keys, auto: null });
      expect(mediaSetupKeys(cfg)).toEqual(keys);
      // the gateway upstream falls back to the first url setting
      expect(mediaUrlKey(cfg)).toBe('JELLYFIN_URL');
      // no probe to run: a warning, never a blocker
      expect(await runProbe(env.ctx, 'media', cfg)).toEqual({ ok: true, code: 'warning', detail: 'not_tested' });
      // and no automation
      const r = await env.app.inject({ method: 'POST', url: '/api/setup/media/auto', payload: { url: 'http://x.example.com', username: 'a', password: 'b' } });
      expect(r.statusCode).toBe(401); // the session check comes first; with one: 400 not_supported (below)
    });
  });

  it('a kind with a provider but no `auto` (the Plex fork\'s manual step): auto null, its own keys, its probe', async () => {
    const calls: string[] = [];
    const manual: MediaSetupProvider = {
      kind: 'jellyfin', keys: ['JELLYFIN_URL'], urlKey: 'JELLYFIN_URL',
      probe: async (values) => { calls.push(String(values.JELLYFIN_URL)); return { ok: false, code: 'unauthorized' }; },
    };
    await withEntry(manual, async () => {
      expect((await env.app.inject('/api/setup/state')).json().media).toEqual({ keys: ['JELLYFIN_URL'], auto: null });
      expect(await runProbe(env.ctx, 'media', cfg)).toEqual({ ok: false, code: 'unauthorized' });
      expect(calls).toEqual([cfg.JELLYFIN_URL]);
      expect(mediaSetupKeys(cfg)).toEqual(['JELLYFIN_URL']);
    });
  });

  it('type: an object literal with only kind, keys, urlKey and probe satisfies MediaSetupProvider', () => {
    const p = { kind: 'jellyfin', keys: ['JELLYFIN_URL'], urlKey: 'JELLYFIN_URL', probe: async () => ({ ok: true, code: 'ok' }) } satisfies MediaSetupProvider;
    expectTypeOf(p).toMatchTypeOf<MediaSetupProvider>();
    expectTypeOf<MediaSetupProvider['auto']>().toEqualTypeOf<MediaSetupProvider['auto'] | undefined>();
  });

  it('mediaUrlKey reads the provider\'s urlKey', async () => {
    await withEntry({ kind: 'jellyfin', keys: [], urlKey: 'JELLYFIN_ADMIN_API_KEY', probe: async () => ({ ok: true, code: 'ok' }) }, async () => {
      expect(mediaUrlKey(cfg)).toBe('JELLYFIN_ADMIN_API_KEY');
    });
    expect(mediaUrlKey(cfg)).toBe('JELLYFIN_URL');
  });

  it('the media probe runs through the provider with a guarded fetch (no redirect, deadline)', async () => {
    const inits: RequestInit[] = [];
    const base = fakeHttp({ 'GET /Auth/Keys': () => ({ json: { Items: [] } }) });
    const f = ((u: RequestInfo | URL, i: RequestInit = {}) => { inits.push(i); return base(u, i); }) as typeof fetch;
    expect(await runProbe(env.ctx, 'media', cfg, { fetchImpl: f })).toEqual({ ok: true, code: 'ok' });
    expect(inits[0]).toMatchObject({ redirect: 'manual' });
    expect(inits[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('no import cycle: media/setup.ts and jellyfin/setup.ts import media/index.ts for types only', () => {
    const src = new URL('../src/', import.meta.url).pathname;
    for (const f of ['media/setup.ts', 'jellyfin/setup.ts']) {
      const text = readFileSync(src + f, 'utf8');
      const runtime = [...text.matchAll(/^import (?!type )[^;]*from '([^']+)'/gm)].map((m) => m[1]);
      expect(runtime.filter((p) => /media\/index\.js$|^\.\/index\.js$/.test(p!)), f).toEqual([]);
    }
  });
});

describe('POST /api/setup/media/auto for a kind without automation', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv({}, { setupComplete: false }); });
  afterAll(() => env.close());
  it('400 not_supported', async () => {
    const { issueSetupCode } = await import('../src/setup/code.js');
    const code = await issueSetupCode(env.ctx);
    const u = await env.app.inject({ method: 'POST', url: '/api/setup/unlock', payload: { code }, remoteAddress: '10.97.0.1' });
    const csrf = u.cookies.find((c) => c.name === 'ff_setup_csrf')!.value;
    const cookies = { ff_setup: u.cookies.find((c) => c.name === 'ff_setup')!.value, ff_setup_csrf: csrf };
    const prev = MEDIA_SETUP.jellyfin!;
    MEDIA_SETUP.jellyfin = { ...prev, auto: undefined };
    try {
      const r = await env.app.inject({ method: 'POST', url: '/api/setup/media/auto', cookies, headers: { 'x-ff-setup-csrf': csrf }, payload: { url: 'http://x.example.com', username: 'a', password: 'b' } });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: 'not_supported' });
    } finally {
      MEDIA_SETUP.jellyfin = prev;
    }
  });
});
