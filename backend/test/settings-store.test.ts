// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { decrypt, encrypt, keyFromBase64 } from '../src/crypto.js';
import { MemorySettingsBus, RedisSettingsBus, SETTINGS_CHANNEL, type SettingsBus } from '../src/settings/bus.js';
import type { StoredRow } from '../src/settings/repo.js';
import { readRev, updateMeta } from '../src/settings/repo.js';
import { resolveConfig } from '../src/settings/resolve.js';
import { createSettingsStore, SettingsError, type SettingsStore } from '../src/settings/store.js';
import { HttpError } from '../src/users.js';
import { ENC_KEY, resetDb, TEST_DB } from './helpers.js';

const encKey = keyFromBase64(ENC_KEY);
const otherKey = Buffer.alloc(32, 9);
const BASE: NodeJS.ProcessEnv = { DATABASE_URL: TEST_DB, REDIS_URL: 'redis://x', APP_ENC_KEY: ENC_KEY, INTERNAL_SECRET: 'internal-secret-123456' };
const row = (key: string, value: unknown): StoredRow => ({ key, value, enc: null, last4: null, updatedAt: new Date().toISOString(), updatedBy: null });
const secretRow = (key: string, plain: string, k = encKey): StoredRow => ({ ...row(key, null), enc: encrypt(k, plain) });

describe('resolveConfig', () => {
  it('env wins over the database, an empty env value counts as unset, no row falls back to the default or unset', () => {
    const rows = [row('JELLYFIN_URL', 'http://db:8096')];
    const a = resolveConfig({ env: { ...BASE, JELLYFIN_URL: 'http://env:8096' }, rows, encKey });
    expect(a.cfg.JELLYFIN_URL).toBe('http://env:8096');
    expect(a.sources.JELLYFIN_URL).toBe('env');
    const b = resolveConfig({ env: { ...BASE, JELLYFIN_URL: '' }, rows, encKey });
    expect(b.cfg.JELLYFIN_URL).toBe('http://db:8096');
    expect(b.sources.JELLYFIN_URL).toBe('db');
    const c = resolveConfig({ env: BASE, rows: [], encKey });
    expect(c.cfg.JELLYFIN_URL).toBeUndefined();
    expect(c.sources.JELLYFIN_URL).toBe('unset');
    expect(c.cfg.SESSION_TTL_SECONDS).toBe(28800);
    expect(c.sources.SESSION_TTL_SECONDS).toBe('default');
    expect(c.cfg.OIDC_ISSUER).toBe(''); // run-required keys are '' while unset
    expect(c.sources.OIDC_ISSUER).toBe('unset');
    expect(c.sources.DATABASE_URL).toBe('env');
    expect(c.invalid).toEqual([]);
  });

  it('reads VAR_FILE (Docker secrets) as the env layer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-settings-'));
    try {
      writeFileSync(join(dir, 'jf'), 'file-key-0123456789\n');
      const r = resolveConfig({ env: { ...BASE, JELLYFIN_ADMIN_API_KEY_FILE: join(dir, 'jf') }, rows: [secretRow('JELLYFIN_ADMIN_API_KEY', 'db-key')], encKey });
      expect(r.cfg.JELLYFIN_ADMIN_API_KEY).toBe('file-key-0123456789');
      expect(r.sources.JELLYFIN_ADMIN_API_KEY).toBe('env');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('VAR_FILE wins over VAR, as in loadConfig', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-settings-'));
    try {
      writeFileSync(join(dir, 'k'), 'from-file\n');
      writeFileSync(join(dir, 'empty'), '\n');
      const file = join(dir, 'k');
      const r = resolveConfig({ env: { ...BASE, JELLYFIN_ADMIN_API_KEY: 'from-var', JELLYFIN_ADMIN_API_KEY_FILE: file }, rows: [], encKey });
      expect(r.cfg.JELLYFIN_ADMIN_API_KEY).toBe('from-file');
      expect(loadConfig({ ...BASE, JELLYFIN_ADMIN_API_KEY: 'from-var', JELLYFIN_ADMIN_API_KEY_FILE: file }).JELLYFIN_ADMIN_API_KEY).toBe('from-file');
      // an empty file with a set VAR is unset, as in loadConfig (one rule for both)
      const emptyFile = { ...BASE, JELLYFIN_ADMIN_API_KEY: 'from-var', JELLYFIN_ADMIN_API_KEY_FILE: join(dir, 'empty') };
      expect(resolveConfig({ env: emptyFile, rows: [], encKey }).cfg.JELLYFIN_ADMIN_API_KEY).toBeUndefined();
      expect(loadConfig(emptyFile).JELLYFIN_ADMIN_API_KEY).toBeUndefined();
      // ... and it hides the legacy names, as the new name in either form does
      const emptyNew = { ...BASE, REQUESTS_API_KEY_FILE: join(dir, 'empty'), SEERR_API_KEY: 'old-var' };
      expect(resolveConfig({ env: emptyNew, rows: [], encKey }).cfg.REQUESTS_API_KEY).toBe(loadConfig(emptyNew).REQUESTS_API_KEY);
      expect(loadConfig(emptyNew).REQUESTS_API_KEY).toBe('');
      // legacy pair: old_FILE wins over old; the new name in either form wins over both
      const legacy = { ...BASE, SEERR_API_KEY: 'old-var', SEERR_API_KEY_FILE: file };
      expect(resolveConfig({ env: legacy, rows: [], encKey }).cfg.REQUESTS_API_KEY).toBe('from-file');
      expect(loadConfig(legacy).REQUESTS_API_KEY).toBe('from-file');
      expect(resolveConfig({ env: { ...legacy, REQUESTS_API_KEY: 'new-var' }, rows: [], encKey }).cfg.REQUESTS_API_KEY).toBe('new-var');
      expect(loadConfig({ ...legacy, REQUESTS_API_KEY: 'new-var' }).REQUESTS_API_KEY).toBe('new-var');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('legacy names count as env', () => {
    const r = resolveConfig({ env: { ...BASE, SEERR_URL: 'http://seerr:5055' }, rows: [row('REQUESTS_URL', 'http://db:5055')], encKey });
    expect(r.cfg.REQUESTS_URL).toBe('http://seerr:5055');
    expect(r.sources.REQUESTS_URL).toBe('env');
  });

  it('an env PUBLIC_URL with a path resolves to its origin', () => {
    const r = resolveConfig({ env: { ...BASE, PUBLIC_URL: 'https://tv.example.com/ff' }, rows: [], encKey });
    expect(r.cfg.PUBLIC_URL).toBe('https://tv.example.com');
    expect(r.sources.PUBLIC_URL).toBe('env');
  });

  it('decrypts secret rows; a row encrypted with another key is ignored and listed as invalid', () => {
    const r = resolveConfig({ env: BASE, rows: [secretRow('JELLYFIN_ADMIN_API_KEY', 'good-key'), secretRow('TMDB_API_KEY', 'other-key-1234', otherKey)], encKey });
    expect(r.cfg.JELLYFIN_ADMIN_API_KEY).toBe('good-key');
    expect(r.sources.JELLYFIN_ADMIN_API_KEY).toBe('db');
    expect(r.cfg.TMDB_API_KEY).toBeUndefined();
    expect(r.sources.TMDB_API_KEY).toBe('unset');
    expect(r.invalid).toEqual(['TMDB_API_KEY']);
  });

  it('a row failing its schema is ignored: the default is used and the key is invalid', () => {
    const r = resolveConfig({ env: BASE, rows: [row('SESSION_TTL_SECONDS', -5), row('CAST_ENABLED', false), row('HOME_NETWORKS', ['10.0.0.0/8'])], encKey });
    expect(r.cfg.SESSION_TTL_SECONDS).toBe(28800);
    expect(r.sources.SESSION_TTL_SECONDS).toBe('default');
    expect(r.invalid).toEqual(['SESSION_TTL_SECONDS']);
    expect(r.cfg.CAST_ENABLED).toBe('false'); // stored typed, Config keeps its string enum
    expect(r.cfg.HOME_NETWORKS).toEqual(['10.0.0.0/8']);
  });

  it('keeps the disk warn/crit rule for database values, with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = [row('HEALTH_DISK_WARN_PCT', 95), row('HEALTH_DISK_CRIT_PCT', 90)];
    resolveConfig({ env: BASE, rows, encKey });
    const r = resolveConfig({ env: BASE, rows, encKey });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('using 85 / 95');
    warn.mockRestore();
    expect(r.cfg.HEALTH_DISK_WARN_PCT).toBe(85);
    expect(r.cfg.HEALTH_DISK_CRIT_PCT).toBe(95);
  });

  it('bootstrap keys: env, then the bootstrap file, never the database', () => {
    const { INTERNAL_SECRET: _drop, ...env } = BASE;
    const r = resolveConfig({ env, rows: [], encKey, bootstrap: { INTERNAL_SECRET: 'from-bootstrap-volume-1' } });
    expect(r.cfg.INTERNAL_SECRET).toBe('from-bootstrap-volume-1');
    expect(r.sources.INTERNAL_SECRET).toBe('bootstrap');
    expect(r.sources.APP_ENC_KEY).toBe('env');
    expect(() => resolveConfig({ env, rows: [], encKey })).toThrow(/INTERNAL_SECRET/);
  });

  it('an invalid env value fails by key name and code, never the value', () => {
    let msg = '';
    try {
      resolveConfig({ env: { ...BASE, SESSION_TTL_SECONDS: 'not-a-number-xyz' }, rows: [], encKey });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('SESSION_TTL_SECONDS');
    expect(msg).not.toContain('not-a-number-xyz');
  });
});

/** A bus that never delivers anything (a missed Redis message). */
const deafBus = (): SettingsBus => ({ publish: async () => {}, subscribe: async () => () => {} });
const logger = () => ({ warn: vi.fn() });

describe('settings store', () => {
  let pool: pg.Pool;
  const open: SettingsStore[] = [];
  const make = async (opts: { env?: NodeJS.ProcessEnv; bus?: SettingsBus; log?: ReturnType<typeof logger>; pollMs?: number; listenerTimeoutMs?: number } = {}) => {
    const s = await createSettingsStore({ db: pool, encKey, env: opts.env ?? BASE, bus: opts.bus ?? new MemorySettingsBus(), log: opts.log ?? logger(), pollMs: opts.pollMs, listenerTimeoutMs: opts.listenerTimeoutMs });
    open.push(s);
    return s;
  };
  beforeAll(async () => { pool = await resetDb(); });
  beforeEach(async () => { await pool.query('delete from settings; update settings_meta set rev = 0'); });
  afterEach(async () => { await Promise.all(open.splice(0).map((s) => s.close())); });
  afterAll(async () => { await pool.end(); });

  it('a save on store A reloads store B over the shared bus', async () => {
    const bus = new MemorySettingsBus();
    const a = await make({ bus });
    const b = await make({ bus });
    expect(b.current().CAST_ENABLED).toBe('true');
    expect(await a.save({ CAST_ENABLED: false }, null)).toBe(1);
    expect(a.current().CAST_ENABLED).toBe('false'); // the saving store is current when save resolves
    expect(a.rev()).toBe(1);
    await vi.waitFor(() => expect(b.rev()).toBe(1));
    expect(b.current().CAST_ENABLED).toBe('false');
    expect(b.sources().CAST_ENABLED).toBe('db');
  });

  it('poll picks up a rev written by another store without a bus message', async () => {
    const a = await make({ bus: deafBus() });
    const b = await make({ bus: deafBus(), pollMs: 20 });
    await a.save({ SESSION_IDLE_SECONDS: 900 }, null);
    await vi.waitFor(() => expect(b.rev()).toBe(1));
    expect(b.current().SESSION_IDLE_SECONDS).toBe(900);
  });

  it('a setup_completed_at change reaches other stores (its rev bump is picked up by the poll)', async () => {
    const b = await make({ bus: deafBus(), pollMs: 20 });
    await updateMeta(pool, { setupCompletedAt: new Date() });
    await vi.waitFor(() => expect(b.rev()).toBe(1));
  });

  it('a Redis outage does not break reads or saves', async () => {
    const log = logger();
    const broken: SettingsBus = { publish: () => Promise.reject(new Error('redis down')), subscribe: () => Promise.reject(new Error('redis down')) };
    const s = await make({ bus: broken, log });
    expect(await s.save({ CAST_ENABLED: false }, null)).toBe(1);
    expect(s.current().CAST_ENABLED).toBe('false');
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledTimes(2)); // subscribe + publish, both by message only
  });

  it('onChange fires only for the watched keys, with the changed ones', async () => {
    const s = await make();
    const fn = vi.fn();
    const off = s.onChange(['JELLYFIN_URL'], fn);
    await s.save({ JELLYFIN_URL: 'http://jf2:8096' }, null);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]![0].JELLYFIN_URL).toBe('http://jf2:8096');
    expect(fn.mock.calls[0]![1]).toEqual(['JELLYFIN_URL']);
    await s.save({ CAST_ENABLED: false }, null);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    await s.save({ JELLYFIN_URL: 'http://jf3:8096' }, null);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a failing listener does not stop the reload or the other listeners', async () => {
    const log = logger();
    const s = await make({ log });
    const ok = vi.fn();
    s.onChange(['CAST_ENABLED'], () => { throw new Error('boom'); });
    s.onChange(['CAST_ENABLED'], ok);
    await s.save({ CAST_ENABLED: false }, null);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(s.current().CAST_ENABLED).toBe('false');
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ keys: ['CAST_ENABLED'] }), expect.any(String));
  });

  it('a listener may call save, and a hanging listener does not block later reloads or saves', async () => {
    const log = logger();
    const s = await make({ log, listenerTimeoutMs: 50 });
    s.onChange(['CAST_ENABLED'], async () => { await s.save({ PREVIEW_WARM: false }, null); });
    await s.save({ CAST_ENABLED: false }, null); // the listener's own save completes inside this one
    expect(s.current().PREVIEW_WARM).toBe('false');
    expect(s.rev()).toBe(2);

    s.onChange(['SESSION_IDLE_SECONDS'], () => new Promise(() => {}));
    await s.save({ SESSION_IDLE_SECONDS: 900 }, null); // returns after the timeout
    expect(log.warn).toHaveBeenCalledWith({ keys: ['SESSION_IDLE_SECONDS'] }, expect.any(String));
    await s.save({ SESSION_TTL_SECONDS: 1800 }, null);
    await s.reload();
    expect(s.current().SESSION_TTL_SECONDS).toBe(1800);
  });

  it('snapshots are frozen, including array values', async () => {
    const s = await make();
    const c = s.current();
    expect(Object.isFrozen(c)).toBe(true);
    expect(() => { (c as { CAST_ENABLED: string }).CAST_ENABLED = 'false'; }).toThrow();
    expect(() => (c.HOME_NETWORKS as string[]).push('1.2.3.0/24')).toThrow();
  });

  it('concurrent saves on two stores end with both values on both', async () => {
    const bus = new MemorySettingsBus();
    const a = await make({ bus });
    const b = await make({ bus });
    await Promise.all([a.save({ CAST_ENABLED: false }, null), b.save({ PREVIEW_WARM: false }, null), b.reload()]);
    for (const s of [a, b]) {
      await vi.waitFor(() => expect(s.rev()).toBe(2));
      expect(s.current().CAST_ENABLED).toBe('false');
      expect(s.current().PREVIEW_WARM).toBe('false');
    }
  });

  it('a stored write whose local reload fails still returns its rev and publishes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-settings-'));
    const file = join(dir, 'token');
    writeFileSync(file, 'ghp_from_file');
    const bus = new MemorySettingsBus();
    const seen: number[] = [];
    await bus.subscribe((rev) => seen.push(rev));
    const log = logger();
    const s = await make({ env: { ...BASE, GITHUB_TOKEN_FILE: file }, bus, log });
    rmSync(dir, { recursive: true, force: true }); // the next reload cannot read the env layer
    expect(await s.save({ CAST_ENABLED: false }, null)).toBe(1);
    await vi.waitFor(() => expect(seen).toEqual([1]));
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'settings reload after save failed');
  });

  it('retries a failed bus subscription', async () => {
    const shared = new MemorySettingsBus();
    let fails = 1;
    const flaky: SettingsBus = { publish: (r) => shared.publish(r), subscribe: (fn) => (fails-- > 0 ? Promise.reject(new Error('down')) : shared.subscribe(fn)) };
    const a = await make({ bus: shared });
    const b = await make({ bus: flaky, pollMs: 60_000 }); // first retry after min(pollMs, 1 s)
    await new Promise((r) => setTimeout(r, 1200));
    await a.save({ CAST_ENABLED: false }, null);
    await vi.waitFor(() => expect(b.rev()).toBe(1));
  });

  it('pendingRestart lists restart keys that differ from the boot value', async () => {
    const s = await make();
    expect(s.pendingRestart()).toEqual([]);
    await s.save({ DOWNLOAD_CREATE_PER_HOUR: 7 }, null);
    expect(s.pendingRestart()).toEqual(['DOWNLOAD_CREATE_PER_HOUR']);
    await s.save({ API_COMPRESSION: false }, null); // live: never pending
    expect(s.pendingRestart()).toEqual(['DOWNLOAD_CREATE_PER_HOUR']);
    await s.save({ DOWNLOAD_CREATE_PER_HOUR: null }, null);
    expect(s.pendingRestart()).toEqual([]);
  });

  it('importEnv copies env values into the database; env stays the source', async () => {
    const key = 'abcd1234efgh5678';
    const s = await make({ env: { ...BASE, TMDB_API_KEY: key } });
    expect(await s.importEnv(['TMDB_API_KEY'], null)).toEqual(['TMDB_API_KEY']);
    const r = (await pool.query("select * from settings where key = 'TMDB_API_KEY'")).rows[0];
    expect(r.value).toBeNull();
    expect(decrypt(encKey, r.enc)).toBe(key);
    expect(r.last4).toBe('5678');
    expect(s.sources().TMDB_API_KEY).toBe('env');
    expect(s.current().TMDB_API_KEY).toBe(key);
    expect(s.rev()).toBe(1);
    expect(await s.importEnv('all', null)).toEqual(['TMDB_API_KEY']); // keys not set in env are skipped
    expect(await s.importEnv(['OMDB_API_KEY'], null)).toEqual([]);
    expect(s.rev()).toBe(2); // nothing to move: no write
  });

  it('save refuses env-locked, non-setting and unknown keys with SettingsError (400) and writes nothing', async () => {
    const s = await make({ env: { ...BASE, JELLYFIN_URL: 'http://env:8096' } });
    const err = await s.save({ JELLYFIN_URL: 'http://db:8096', CAST_ENABLED: false }, null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettingsError);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(400);
    expect((err as SettingsError).errors).toEqual({ JELLYFIN_URL: 'locked' });
    const err2 = await s.save({ DATABASE_URL: 'postgres://x', PORT: 1, NOPE: 1, toString: 1 }, null).catch((e: unknown) => e) as SettingsError;
    expect(err2.errors).toEqual({ DATABASE_URL: 'locked', PORT: 'locked', NOPE: 'unknown', toString: 'unknown' });
    expect(await readRev(pool)).toBe(0);
    expect((await pool.query('select count(*)::int as n from settings')).rows[0].n).toBe(0);
  });

  it('save validates every value against the registry before writing', async () => {
    const s = await make();
    const err = await s.save({ CAST_ENABLED: 'maybe', SESSION_TTL_SECONDS: -5, PUBLIC_URL: 'https://tv.example.com/ff', HOME_NETWORKS: '10.0.0.0/8,bad', JELLYFIN_URL: 'http://ok:8096' }, null)
      .catch((e: unknown) => e) as SettingsError;
    expect(err.errors).toEqual({ CAST_ENABLED: 'invalid_option', SESSION_TTL_SECONDS: 'too_small', PUBLIC_URL: 'origin_only', HOME_NETWORKS: 'invalid_cidr' });
    expect(await readRev(pool)).toBe(0);
    // accepted forms are stored canonical: booleans, numbers, CIDR arrays, an origin without slash
    await s.save({ CAST_ENABLED: 'false', SESSION_TTL_SECONDS: '3600', PUBLIC_URL: 'https://tv.example.com/', HOME_NETWORKS: '10.0.0.0/8, 192.168.0.0/16' }, null);
    const stored = Object.fromEntries((await pool.query('select key, value from settings')).rows.map((r) => [r.key, r.value]));
    expect(stored).toEqual({ CAST_ENABLED: false, SESSION_TTL_SECONDS: 3600, PUBLIC_URL: 'https://tv.example.com', HOME_NETWORKS: ['10.0.0.0/8', '192.168.0.0/16'] });
    expect(s.current().HOME_NETWORKS).toEqual(['10.0.0.0/8', '192.168.0.0/16']);
  });

  it('an empty value deletes the stored row (an empty secret clears it)', async () => {
    const s = await make();
    await s.save({ JELLYFIN_ADMIN_API_KEY: 'k'.repeat(32), NTFY_URL: 'https://ntfy.example.com/ff' }, null);
    expect(s.sources().JELLYFIN_ADMIN_API_KEY).toBe('db');
    await s.save({ JELLYFIN_ADMIN_API_KEY: '', NTFY_URL: null }, null);
    expect(s.sources().JELLYFIN_ADMIN_API_KEY).toBe('unset');
    expect(s.current().NTFY_URL).toBeUndefined();
    expect((await pool.query('select count(*)::int as n from settings')).rows[0].n).toBe(0);
  });

  it('logs an unreadable row by key name only, once', async () => {
    await pool.query("insert into settings(key, enc) values ('GITHUB_TOKEN', $1)", [encrypt(otherKey, 'ghp_secret_value_42')]);
    const log = logger();
    const s = await make({ log });
    expect(s.invalid()).toEqual(['GITHUB_TOKEN']);
    expect(log.warn).toHaveBeenCalledWith({ key: 'GITHUB_TOKEN' }, expect.any(String));
    await s.save({ CAST_ENABLED: false }, null);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('ghp_secret_value_42');
    // entering it again clears the flag
    await s.save({ GITHUB_TOKEN: 'ghp_new' }, null);
    expect(s.invalid()).toEqual([]);
  });

  it('save({}) bumps and publishes the rev (a publish point for meta changes)', async () => {
    const bus = new MemorySettingsBus();
    const seen: number[] = [];
    await bus.subscribe((rev) => seen.push(rev));
    const s = await make({ bus });
    expect(await s.save({}, null)).toBe(1);
    await vi.waitFor(() => expect(seen).toEqual([1]));
  });
});

/** Just enough of ioredis for pub/sub: connections created by duplicate() share one hub. */
function fakeRedis() {
  const hub = new EventEmitter();
  const published: Array<[string, string]> = [];
  const conns: Array<{ quit: ReturnType<typeof vi.fn> }> = [];
  const make = () => {
    const self = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const subs = new Set<string>();
    const deliver = (ch: string, msg: string) => { if (subs.has(ch)) self.emit('message', ch, msg); };
    Object.assign(self, {
      duplicate: () => make(),
      publish: async (ch: string, msg: string) => { published.push([ch, msg]); hub.emit('m', ch, msg); return 1; },
      subscribe: async (ch: string) => { subs.add(ch); hub.on('m', deliver); return 1; },
      unsubscribe: async (ch: string) => { subs.delete(ch); return 0; },
      quit: vi.fn(async () => { hub.off('m', deliver); return 'OK'; }),
    });
    conns.push(self as unknown as { quit: ReturnType<typeof vi.fn> });
    return self;
  };
  return { redis: make() as unknown as Redis, published, conns };
}

describe('RedisSettingsBus', () => {
  it('publishes only the rev as a string and delivers it to subscribers on a duplicated connection', async () => {
    const { redis, published, conns } = fakeRedis();
    const bus = new RedisSettingsBus(redis);
    const got: number[] = [];
    const off = await bus.subscribe((rev) => got.push(rev));
    expect(conns).toHaveLength(2); // the subscriber is a duplicate, the main connection stays usable
    await bus.publish(7);
    expect(published).toEqual([[SETTINGS_CHANNEL, '7']]);
    expect(SETTINGS_CHANNEL).toBe('ff:settings:rev');
    await vi.waitFor(() => expect(got).toEqual([7]));
    (conns[1] as unknown as EventEmitter).emit('message', SETTINGS_CHANNEL, 'garbage');
    (conns[1] as unknown as EventEmitter).emit('message', 'other', '9');
    expect(got).toEqual([7]);
    await off();
    expect(conns[1]!.quit).toHaveBeenCalled();
  });
});
