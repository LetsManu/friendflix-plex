// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { decrypt, encrypt, keyFromBase64 } from '../../src/crypto.js';
import { MemoryKV } from '../../src/kv.js';
import { createMediaServer, mediaConfigProblems, mediaSetupKeys, mediaUrlKey } from '../../src/media/index.js';
import { MemorySettingsBus } from '../../src/settings/bus.js';
import { resolveConfig } from '../../src/settings/resolve.js';
import { createSettingsStore, SettingsError } from '../../src/settings/store.js';
import { missingRunRequired } from '../../src/setup/state.js';
import { PlexMediaServer } from '../../src/plex/service.js';
import { cfg, ENC_KEY, resetDb, TEST_DB } from '../helpers.js';
import { PlexFake, PLEX_TOKEN, PLEX_URL } from '../plexfake.js';

const BASE = {
  PUBLIC_URL: 'https://p.example.com', DATABASE_URL: 'postgres://x@localhost/none', REDIS_URL: 'x', APP_ENC_KEY: 'k'.repeat(44), INTERNAL_SECRET: 'i'.repeat(20),
  OIDC_ISSUER: 'https://a.example.com', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', REQUESTS_URL: 'http://s', REQUESTS_API_KEY: 'k', WEBHOOK_SECRET: 'w'.repeat(20),
};

const BASE_DB: NodeJS.ProcessEnv = { DATABASE_URL: TEST_DB, REDIS_URL: 'redis://x', APP_ENC_KEY: ENC_KEY, INTERNAL_SECRET: 'i'.repeat(20) };

describe('MEDIA_SERVER=plex config', () => {
  it('without PLEX_URL / PLEX_TOKEN the instance starts in setup mode (no startup refusal); both are run-required for plex', () => {
    for (const env of [{}, { PLEX_URL: '', PLEX_TOKEN: '' }, { PLEX_URL: 'http://plex:32400' }]) {
      const c = loadConfig({ ...BASE, MEDIA_SERVER: 'plex', ...env });
      expect(c.MEDIA_SERVER).toBe('plex');
      expect(c.PLEX_TOKEN).toBeUndefined();
      expect(missingRunRequired(c)).toContain('PLEX_TOKEN');
      expect(missingRunRequired(c)).not.toContain('JELLYFIN_URL');
      expect(missingRunRequired(c)).not.toContain('JELLYFIN_ADMIN_API_KEY');
    }
    const none = loadConfig({ ...BASE, MEDIA_SERVER: 'plex' });
    expect(missingRunRequired(none)).toEqual(expect.arrayContaining(['PLEX_URL', 'PLEX_TOKEN']));
    expect(missingRunRequired(none).filter((k) => /^(PLEX|JELLYFIN)_/.test(k))).toEqual(['PLEX_URL', 'PLEX_TOKEN']);
    // a set value is still validated
    expect(() => loadConfig({ ...BASE, MEDIA_SERVER: 'plex', PLEX_URL: 'not a url', PLEX_TOKEN: 't' })).toThrow();
    const c = loadConfig({ ...BASE, MEDIA_SERVER: 'plex', PLEX_URL: 'http://plex:32400', PLEX_TOKEN: 'tok' });
    expect([c.MEDIA_SERVER, c.PLEX_URL, c.PLEX_TOKEN, c.JELLYFIN_URL]).toEqual(['plex', 'http://plex:32400', 'tok', undefined]);
    expect(missingRunRequired(c).filter((k) => /^(PLEX|JELLYFIN)_/.test(k))).toEqual([]);
    expect(mediaConfigProblems(c)).toEqual([]);
  });
  it('the wizard and the gateway see the Plex keys: mediaSetupKeys, mediaUrlKey, missingRunRequired (a fresh Plex install cannot complete setup without Plex)', () => {
    const plex = { ...cfg, MEDIA_SERVER: 'plex' as const, JELLYFIN_URL: undefined, JELLYFIN_ADMIN_API_KEY: undefined, PLEX_URL: undefined, PLEX_TOKEN: undefined };
    expect(mediaSetupKeys(plex)).toEqual(['PLEX_URL', 'PLEX_TOKEN']);
    expect(mediaUrlKey(plex)).toBe('PLEX_URL');
    expect(missingRunRequired(plex)).toEqual(['PLEX_URL', 'PLEX_TOKEN']);
    expect(missingRunRequired({ ...plex, PLEX_URL, PLEX_TOKEN })).toEqual([]);
    // the Jellyfin default is unchanged
    expect(mediaSetupKeys(cfg)).toEqual(['JELLYFIN_URL', 'JELLYFIN_ADMIN_API_KEY']);
    expect(mediaUrlKey(cfg)).toBe('JELLYFIN_URL');
    expect(missingRunRequired({ ...cfg, JELLYFIN_URL: undefined })).toEqual(['JELLYFIN_URL']);
  });
  it('PLEX_TOKEN_FILE (Docker secret) and env PLEX_URL still win over saved values (existing installs keep working, shown locked)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffplex-'));
    try {
      writeFileSync(join(dir, 'tok'), 'from-file\n');
      expect(loadConfig({ ...BASE, MEDIA_SERVER: 'plex', PLEX_URL: 'http://plex:32400', PLEX_TOKEN_FILE: join(dir, 'tok') }).PLEX_TOKEN).toBe('from-file');
      const env = { DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', APP_ENC_KEY: ENC_KEY, INTERNAL_SECRET: 'i'.repeat(20), MEDIA_SERVER: 'plex',
        PLEX_URL: 'http://plex-env:32400', PLEX_TOKEN_FILE: join(dir, 'tok') };
      const rows = [
        { key: 'PLEX_URL', value: 'http://plex-db:32400', enc: null, last4: null, updatedAt: new Date().toISOString(), updatedBy: null },
        { key: 'PLEX_TOKEN', value: null, enc: encrypt(keyFromBase64(ENC_KEY), 'db-token'), last4: null, updatedAt: new Date().toISOString(), updatedBy: null },
      ];
      const r = resolveConfig({ env, rows, encKey: keyFromBase64(ENC_KEY) });
      expect([r.cfg.PLEX_URL, r.cfg.PLEX_TOKEN]).toEqual(['http://plex-env:32400', 'from-file']);
      expect([r.sources.PLEX_URL, r.sources.PLEX_TOKEN]).toEqual(['env', 'env']);
      // without env the saved (decrypted) values apply
      const db = resolveConfig({ env: { ...env, PLEX_URL: undefined, PLEX_TOKEN_FILE: undefined }, rows, encKey: keyFromBase64(ENC_KEY) });
      expect([db.cfg.PLEX_URL, db.cfg.PLEX_TOKEN, db.sources.PLEX_URL, db.sources.PLEX_TOKEN]).toEqual(['http://plex-db:32400', 'db-token', 'db', 'db']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('a saved PLEX_TOKEN is encrypted at rest (no plaintext value, no last4 hint); an env one locks the key', async () => {
    const pool = await resetDb();
    try {
      const store = await createSettingsStore({ db: pool, encKey: keyFromBase64(ENC_KEY), env: { ...BASE_DB, MEDIA_SERVER: 'plex' }, bus: new MemorySettingsBus(), log: { warn: () => {} }, pollMs: 3_600_000 });
      try {
        await store.save({ PLEX_URL: 'http://plex:32400', PLEX_TOKEN }, null);
        const row = (await pool.query("select value, enc, last4 from settings where key = 'PLEX_TOKEN'")).rows[0];
        expect([row.value, row.last4]).toEqual([null, null]);
        expect(decrypt(keyFromBase64(ENC_KEY), row.enc)).toBe(PLEX_TOKEN);
        expect(JSON.stringify((await pool.query('select * from settings')).rows)).not.toContain(PLEX_TOKEN);
        expect([store.current().PLEX_URL, store.current().PLEX_TOKEN]).toEqual(['http://plex:32400', PLEX_TOKEN]);
      } finally {
        await store.close();
      }
      const locked = await createSettingsStore({ db: pool, encKey: keyFromBase64(ENC_KEY), env: { ...BASE_DB, MEDIA_SERVER: 'plex', PLEX_TOKEN: 'env-token' }, bus: new MemorySettingsBus(), log: { warn: () => {} }, pollMs: 3_600_000 });
      try {
        expect(locked.sources().PLEX_TOKEN).toBe('env');
        const err = await locked.save({ PLEX_TOKEN: 'other' }, null).catch((e: unknown) => e) as SettingsError;
        expect(err).toBeInstanceOf(SettingsError);
        expect(err.errors).toEqual({ PLEX_TOKEN: 'locked' });
      } finally {
        await locked.close();
      }
    } finally {
      await pool.end();
    }
  });
  it('fork: an env PLEX_URL with a query (a pasted ?X-Plex-Token=…), fragment or userinfo stops the start; the error never echoes it', () => {
    const canary = 'url-token-canary-placeholder'; // a test placeholder, never a real token
    const bad = [`http://plex.example.com:32400/?X-Plex-Token=${canary}`, `http://plex.example.com:32400/#${canary}`, `http://u:${canary}@plex.example.com:32400`];
    for (const url of bad) {
      // the boot config (server.ts loadConfig) and the settings store (resolveConfig) both refuse it, by key and code only
      let boot = '';
      try { loadConfig({ ...BASE, MEDIA_SERVER: 'plex', PLEX_URL: url, PLEX_TOKEN: 't' }); } catch (e) { boot = (e as Error).message; }
      expect(boot, url).toContain('PLEX_URL must be the server address only');
      expect(boot).not.toContain(canary);
      expect(() => resolveConfig({ env: { ...BASE_DB, MEDIA_SERVER: 'plex', PLEX_URL: url }, rows: [], encKey: keyFromBase64(ENC_KEY) })).toThrow(/^PLEX_URL is invalid \(invalid_url\)$/);
    }
    // a stored row with a query (written before this check) is ignored and listed invalid, never used or passed on
    const rows = [{ key: 'PLEX_URL', value: bad[0], enc: null, last4: null, updatedAt: new Date().toISOString(), updatedBy: null }];
    const r = resolveConfig({ env: { ...BASE_DB, MEDIA_SERVER: 'plex' }, rows, encKey: keyFromBase64(ENC_KEY) });
    expect([r.cfg.PLEX_URL, r.invalid]).toEqual([undefined, ['PLEX_URL']]);
    // a reverse-proxy path is an address too
    expect(loadConfig({ ...BASE, MEDIA_SERVER: 'plex', PLEX_URL: 'http://plex.example.com:32400/plex' }).PLEX_URL).toBe('http://plex.example.com:32400/plex');
  });
  it('the Jellyfin default is unaffected by empty PLEX_* lines in .env', () => {
    const c = loadConfig({ ...BASE, JELLYFIN_URL: 'http://j', JELLYFIN_ADMIN_API_KEY: 'k', PLEX_URL: '', PLEX_TOKEN: '' });
    expect([c.MEDIA_SERVER, c.PLEX_URL, c.PLEX_TOKEN]).toEqual(['jellyfin', undefined, undefined]);
    expect(missingRunRequired(c).filter((k) => /^(PLEX|JELLYFIN)_/.test(k))).toEqual([]);
    expect(missingRunRequired(loadConfig(BASE)).filter((k) => /^(PLEX|JELLYFIN)_/.test(k))).toEqual(['JELLYFIN_URL', 'JELLYFIN_ADMIN_API_KEY']);
  });
  it('the factory builds the Plex implementation on the shared pool (MediaDeps.db; token only in its request headers)', async () => {
    const fake = new PlexFake();
    const db = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 1 });
    const ms = createMediaServer({ cfg: { ...cfg, MEDIA_SERVER: 'plex', PLEX_URL, PLEX_TOKEN }, kv: new MemoryKV(), db, encKey: keyFromBase64(ENC_KEY), fetchImpl: fake.fetch });
    expect(ms).toBeInstanceOf(PlexMediaServer);
    expect(ms.kind).toBe('plex');
    expect(await ms.admin.ping()).toBe(true);
    expect(fake.calls.at(-1)).toMatchObject({ path: '/identity', search: '', token: PLEX_TOKEN });
    expect((ms as PlexMediaServer).db).toBe(db);
    await db.end();
  });
});
