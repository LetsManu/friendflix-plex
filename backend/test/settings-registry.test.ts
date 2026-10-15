// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { configSchema, loadConfig } from '../src/config.js';
import { mediaSettings } from '../src/media/index.js';
import { BOOTSTRAP_KEYS, BUILD_KEYS, ENV_ONLY_KEYS, SETTINGS, parseEnvValue, publicUrlSchema, settingDef } from '../src/settings/registry.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

const PHASE3 = ['LOGIN_UI', 'AUTHENTIK_LOGIN_FLOW', 'AUTHENTIK_STATIC_SETUP_FLOW', 'AUTHENTIK_WEBAUTHN_SETUP_FLOW', 'AUTHENTIK_PASSWORD_CHANGE_FLOW',
  'AUTHENTIK_INVALIDATION_FLOW', 'AUTHENTIK_EMAIL_CHANGE_FLOW', 'PASSKEYS_IN_APP', 'LOGIN_COVER_WALL'];
const BOOT = { DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', APP_ENC_KEY: 'k'.repeat(44), INTERNAL_SECRET: 'i'.repeat(20) };
const def = (key: string) => {
  const d = settingDef(key);
  if (!d) throw new Error(`no setting ${key}`);
  return d;
};

describe('key classification', () => {
  it('every key of the config schema is in exactly one of SETTINGS, ENV_ONLY_KEYS, BOOTSTRAP_KEYS, BUILD_KEYS', () => {
    const keys = Object.keys(configSchema.shape);
    expect(keys).toHaveLength(77);
    const classes = [SETTINGS.map((s) => s.key), ENV_ONLY_KEYS, BOOTSTRAP_KEYS, BUILD_KEYS];
    for (const k of keys) expect(classes.filter((c) => c.includes(k)), k).toHaveLength(1);
    expect(classes.flat().sort()).toEqual([...keys].sort()); // nothing outside the schema, no duplicates
    expect([BOOTSTRAP_KEYS.length, ENV_ONLY_KEYS.length, BUILD_KEYS.length, SETTINGS.length]).toEqual([4, 12, 4, 57]);
    expect(SETTINGS.filter((s) => s.visible !== false)).toHaveLength(48);
    expect(SETTINGS.filter((s) => s.visible === false).map((s) => s.key).sort()).toEqual([...PHASE3].sort());
  });
  it('each setting parses with the config schema field of the same key', () => {
    for (const s of SETTINGS) expect(s.schema, s.key).toBe(configSchema.shape[s.key as keyof typeof configSchema.shape]);
  });
  it('the media module contributes the Jellyfin keys', () => {
    const m = mediaSettings();
    expect(m.map((s) => [s.key, s.kind, s.group, s.probe])).toEqual([['JELLYFIN_URL', 'url', 'media', 'media'], ['JELLYFIN_ADMIN_API_KEY', 'secret', 'media', 'media']]);
    const run = m[0]!.runRequired as (c: typeof cfg) => boolean;
    expect(run(cfg)).toBe(true);
    expect(run({ ...cfg, MEDIA_SERVER: 'plex' as never })).toBe(false);
    expect(settingDef('JELLYFIN_URL')).toBe(SETTINGS.find((s) => s.key === 'JELLYFIN_URL'));
  });
  it('secrets and last4 hints', () => {
    expect(SETTINGS.filter((s) => s.secret).map((s) => s.key).sort()).toEqual(['OIDC_CLIENT_SECRET', 'JELLYFIN_ADMIN_API_KEY', 'REQUESTS_API_KEY', 'DISCORD_WEBHOOK_URL',
      'VAPID_PRIVATE_KEY', 'TMDB_API_KEY', 'OMDB_API_KEY', 'AUTHENTIK_API_TOKEN', 'GITHUB_TOKEN', 'PORTAINER_WEBHOOK_URL', 'PORTAINER_API_KEY', 'WEBHOOK_SECRET'].sort());
    expect(SETTINGS.filter((s) => s.hint === 'last4').map((s) => s.key).sort()).toEqual(['OMDB_API_KEY', 'TMDB_API_KEY']);
    for (const s of SETTINGS) expect(s.secret === true, s.key).toBe(s.kind === 'secret');
  });
  it("apply === 'restart' exactly for DOWNLOAD_CREATE_PER_HOUR (API_COMPRESSION is read per response: live)", () => {
    expect(SETTINGS.filter((s) => s.apply === 'restart').map((s) => s.key).sort()).toEqual(['DOWNLOAD_CREATE_PER_HOUR']);
  });
  it('legacy env names', () => {
    expect(def('REQUESTS_URL').legacyEnv).toEqual(['SEERR_URL']);
    expect(def('REQUESTS_API_KEY').legacyEnv).toEqual(['SEERR_API_KEY']);
    expect(SETTINGS.filter((s) => s.legacyEnv).map((s) => s.key).sort()).toEqual(['REQUESTS_API_KEY', 'REQUESTS_URL']);
  });
  it('phase-3 keys are hidden settings with the spec defaults', () => {
    for (const k of PHASE3) expect(def(k).visible, k).toBe(false);
    expect(Object.fromEntries(PHASE3.map((k) => [k, def(k).default]))).toEqual({
      LOGIN_UI: undefined, AUTHENTIK_LOGIN_FLOW: 'default-authentication-flow', AUTHENTIK_STATIC_SETUP_FLOW: 'default-authenticator-static-setup',
      AUTHENTIK_WEBAUTHN_SETUP_FLOW: 'default-authenticator-webauthn-setup', AUTHENTIK_PASSWORD_CHANGE_FLOW: 'default-password-change',
      AUTHENTIK_INVALIDATION_FLOW: 'default-invalidation-flow', AUTHENTIK_EMAIL_CHANGE_FLOW: 'friendflix-email-change', PASSKEYS_IN_APP: 'auto', LOGIN_COVER_WALL: 'true',
    });
    expect(def('LOGIN_UI').options).toEqual(['app', 'authentik']);
    expect(def('PASSKEYS_IN_APP').options).toEqual(['auto', 'off']);
    expect(def('LOGIN_COVER_WALL').kind).toBe('bool');
  });
  it('per-key data: groups, generators, run-required, bounds', () => {
    expect(def('PUBLIC_URL')).toMatchObject({ kind: 'url', group: 'general', probe: 'publicUrl', runRequired: true, apply: 'live' });
    expect(['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'].map((k) => [def(k).group, def(k).runRequired, def(k).probe])).toEqual(Array(3).fill(['signin', true, 'oidc']));
    expect(SETTINGS.filter((s) => s.runRequired !== undefined).map((s) => s.key).sort())
      .toEqual(['JELLYFIN_ADMIN_API_KEY', 'JELLYFIN_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_ISSUER', 'PUBLIC_URL']);
    expect(def('WEBHOOK_SECRET').generate).toBe('webhookSecret');
    expect([def('VAPID_PUBLIC_KEY').generate, def('VAPID_PRIVATE_KEY').generate]).toEqual(['vapidPair', 'vapidPair']);
    expect(def('HOME_NETWORKS')).toMatchObject({ kind: 'cidrList', group: 'playback' });
    expect(def('PLAYBACK_CHECK_HOUR')).toMatchObject({ kind: 'int', group: 'health', min: -1, max: 23, default: 4 });
    expect(def('SESSION_TTL_SECONDS')).toMatchObject({ group: 'sessions', default: 28800, min: 1 });
    expect(def('SESSION_TTL_SECONDS').max).toBeUndefined();
    expect(def('DOWNLOAD_PREP_CONCURRENCY')).toMatchObject({ min: 1, max: 4 });
    expect(def('CAST_ENABLED')).toMatchObject({ kind: 'bool', group: 'playback', default: 'true' });
    expect(def('AUTHENTIK_RECOVERY_FLOW').default).toBe('default-recovery-flow');
    expect(def('AUTHENTIK_TOTP_SETUP_FLOW').default).toBe('default-authenticator-totp-setup');
    expect(def('TMDB_API_KEY')).toMatchObject({ group: 'sources', probe: 'tmdb' });
    expect(settingDef('MEDIA_SERVER')).toBeUndefined();
  });
});

describe('value parsing', () => {
  it('publicUrlSchema keeps the origin only', () => {
    expect(publicUrlSchema.parse('https://tv.example.com/')).toBe('https://tv.example.com');
    expect(publicUrlSchema.parse('http://localhost:3000')).toBe('http://localhost:3000');
    const code = (v: string) => parseEnvValue(def('PUBLIC_URL'), v);
    expect(code('https://tv.example.com/ff')).toEqual({ ok: false, code: 'origin_only' });
    expect(code('https://tv.example.com/?a=1')).toEqual({ ok: false, code: 'origin_only' });
    expect(code('ftp://x')).toEqual({ ok: false, code: 'invalid_url' });
    expect(code('no url')).toEqual({ ok: false, code: 'invalid_url' });
  });
  it('parseEnvValue types env strings', () => {
    expect(parseEnvValue(def('HOME_NETWORKS'), '10.0.0.0/8, bad')).toEqual({ ok: false, code: 'invalid_cidr' });
    expect(parseEnvValue(def('HOME_NETWORKS'), '10.0.0.0/8, fd00::/8')).toEqual({ ok: true, value: ['10.0.0.0/8', 'fd00::/8'] });
    expect(parseEnvValue(def('CAST_ENABLED'), 'false')).toEqual({ ok: true, value: 'false' });
    expect(parseEnvValue(def('CAST_ENABLED'), 'yes')).toMatchObject({ ok: false });
    expect(parseEnvValue(def('SESSION_TTL_SECONDS'), '600')).toEqual({ ok: true, value: 600 });
    expect(parseEnvValue(def('SESSION_TTL_SECONDS'), '-5')).toMatchObject({ ok: false });
    expect(parseEnvValue(def('WEBHOOK_SECRET'), 'short')).toMatchObject({ ok: false });
  });
});

describe('loadConfig with bootstrap env only', () => {
  it('succeeds; run-required keys are empty strings', () => {
    const c = loadConfig(BOOT);
    expect(c.OIDC_ISSUER).toBe('');
    expect([c.OIDC_CLIENT_ID, c.OIDC_CLIENT_SECRET, c.PUBLIC_URL, c.REQUESTS_URL, c.REQUESTS_API_KEY, c.WEBHOOK_SECRET]).toEqual(['', '', '', '', '', '']);
    expect(c.SESSION_TTL_SECONDS).toBe(28800);
    expect(c.JELLYFIN_URL).toBeUndefined();
    expect(c.AUTHENTIK_LOGIN_FLOW).toBe('default-authentication-flow');
    expect(c.LOGIN_UI).toBeUndefined();
  });
  it('validates a set value and normalises PUBLIC_URL', () => {
    expect(loadConfig({ ...BOOT, PUBLIC_URL: 'https://tv.example.com/' }).PUBLIC_URL).toBe('https://tv.example.com');
    expect(() => loadConfig({ ...BOOT, PUBLIC_URL: 'ftp://tv.example.com' })).toThrow();
    expect(() => loadConfig({ ...BOOT, OIDC_ISSUER: 'not a url' })).toThrow();
    expect(() => loadConfig({ ...BOOT, WEBHOOK_SECRET: 'short' })).toThrow();
  });
});

describe('PUBLIC_URL with a path in env', () => {
  it('starts with the origin and warns once without the raw value; a save still rejects the path', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(loadConfig({ ...BOOT, PUBLIC_URL: 'https://user:pw@tv.example.com/ff?x=1' }).PUBLIC_URL).toBe('https://tv.example.com');
      expect(loadConfig({ ...BOOT, PUBLIC_URL: 'https://tv.example.com/ff' }).PUBLIC_URL).toBe('https://tv.example.com');
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0]![0]);
      expect(msg).toContain('https://tv.example.com');
      expect(msg).not.toMatch(/\/ff|pw|x=1/);
      expect(loadConfig({ ...BOOT, PUBLIC_URL: 'https://tv.example.com' }).PUBLIC_URL).toBe('https://tv.example.com');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
    expect(parseEnvValue(def('PUBLIC_URL'), 'https://tv.example.com/ff')).toEqual({ ok: false, code: 'origin_only' });
    expect(configSchema.shape.PUBLIC_URL.safeParse('https://tv.example.com/ff').success).toBe(false);
  });
});

describe('webhooks without WEBHOOK_SECRET', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
    env.ctx.cfg = { ...cfg, WEBHOOK_SECRET: '' };
  });
  afterAll(() => env.close());
  it('answer 403 without a header and with an empty one', async () => {
    for (const url of ['/internal/webhook/jellyfin', '/internal/webhook/requests', '/internal/webhook/seerr']) {
      expect((await env.app.inject({ method: 'POST', url, payload: { type: 'PlaybackStart' } })).statusCode, url).toBe(403);
      expect((await env.app.inject({ method: 'POST', url, headers: { 'x-webhook-secret': '' }, payload: { type: 'PlaybackStart' } })).statusCode, url).toBe(403);
    }
    expect((await env.app.inject({ method: 'POST', url: '/internal/webhook/requests', headers: { authorization: '' }, payload: {} })).statusCode).toBe(403);
  });
});
