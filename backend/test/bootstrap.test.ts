// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBootstrap } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { bootConfigEnv, bootstrapEnv, lazyBootstrap, nonEmptyEnv, readBootstrap } from '../src/settings/bootstrapFiles.js';

const FILES = ['app_enc_key', 'internal_secret', 'postgres_password', 'redis.conf', 'redis_password'];
const HEX = /^[0-9a-f]{64}$/;
const K = Buffer.alloc(32, 7).toString('base64');
const S = 's'.repeat(64);

let root: string;
let dir: string;
let gatewayDir: string;
let chowns: Array<[string, number, number]>;
let lines: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ff-bootstrap-'));
  dir = join(root, 'friendflix');
  gatewayDir = join(root, 'friendflix-gateway');
  chowns = [];
  lines = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (env: NodeJS.ProcessEnv = {}) =>
  runBootstrap({ dir, gatewayDir, env, gid: 10001, chown: (p, u, g) => chowns.push([p, u, g]), log: (l) => lines.push(l) });
const read = (name: string, d = dir) => readFileSync(join(d, name), 'utf8');
const mode = (p: string) => statSync(p).mode & 0o777;
/** Overwrite a file the bootstrap may have left read-only (0440): without root (CI runners) the write needs the owner bit back first. */
const overwrite = (p: string, content: string) => {
  try { chmodSync(p, 0o600); } catch { /* not there yet */ }
  writeFileSync(p, content);
};

describe('runBootstrap', () => {
  it('generates the five files, owned by root and the secrets group, mode 0440, and the gateway copy', () => {
    run();
    expect(readdirSync(dir).sort()).toEqual(FILES);
    expect(Buffer.from(read('app_enc_key'), 'base64')).toHaveLength(32);
    expect(read('app_enc_key')).toHaveLength(44);
    for (const f of ['postgres_password', 'redis_password', 'internal_secret']) expect(read(f)).toMatch(HEX);
    expect(new Set(['postgres_password', 'redis_password', 'internal_secret'].map((f) => read(f))).size).toBe(3);
    expect(read('redis.conf')).toBe(`requirepass ${read('redis_password')}\n`);
    const owned = chowns.map(([p, u, g]) => [p.replace(/\.tmp$/, ''), u, g]); // written as a temp file, then renamed into place
    for (const f of FILES) {
      expect(mode(join(dir, f)), f).toBe(0o440);
      expect(owned, f).toContainEqual([join(dir, f), 0, 10001]);
    }
    expect(mode(dir)).toBe(0o750);
    expect(chowns).toContainEqual([dir, 0, 10001]);
    expect(readdirSync(gatewayDir)).toEqual(['internal_secret']);
    expect(read('internal_secret', gatewayDir)).toBe(read('internal_secret'));
    expect(mode(join(gatewayDir, 'internal_secret'))).toBe(0o440);
    expect(mode(gatewayDir)).toBe(0o750);
    expect(owned).toContainEqual([join(gatewayDir, 'internal_secret'), 0, 10001]);
    expect(chowns.every(([, u, g]) => u === 0 && g === 10001)).toBe(true);
    for (const f of ['postgres_password', 'redis_password', 'app_enc_key', 'internal_secret']) expect(lines).toContain(`${f}: generated`);
  });

  it('a second run keeps every file unchanged', () => {
    run();
    const before = Object.fromEntries(FILES.map((f) => [f, read(f)]));
    const gw = read('internal_secret', gatewayDir);
    lines = [];
    run();
    expect(Object.fromEntries(FILES.map((f) => [f, read(f)]))).toEqual(before);
    expect(read('internal_secret', gatewayDir)).toBe(gw);
    for (const f of FILES) expect(lines).toContain(`${f}: kept`);
    expect(lines).toContain('gateway internal_secret: kept');
    expect(readdirSync(dir).sort()).toEqual(FILES); // no temp files left behind
  });

  it('an env value wins and stays in the volume once the env is gone', () => {
    run({ POSTGRES_PASSWORD: 'legacy-pw' });
    expect(read('postgres_password')).toBe('legacy-pw');
    expect(lines).toContain('postgres_password: from environment');
    lines = [];
    run({});
    expect(read('postgres_password')).toBe('legacy-pw');
    expect(lines).toContain('postgres_password: kept');
  });

  it('an env value replaces a file generated earlier (env wins on every run) and rewrites redis.conf and the gateway copy', () => {
    run();
    lines = [];
    run({ REDIS_PASSWORD: 'r'.repeat(20), INTERNAL_SECRET: 'i'.repeat(32), APP_ENC_KEY: K });
    expect(read('redis_password')).toBe('r'.repeat(20));
    expect(read('redis.conf')).toBe(`requirepass ${'r'.repeat(20)}\n`);
    expect(read('internal_secret', gatewayDir)).toBe('i'.repeat(32));
    expect(read('app_enc_key')).toBe(K);
    expect(lines).toEqual(expect.arrayContaining(['redis.conf: updated', 'gateway internal_secret: updated', 'app_enc_key: from environment']));
  });

  it('quotes a legacy Redis password that redis.conf would otherwise split or misread', () => {
    run({ REDIS_PASSWORD: 'a b"c\\d\'e\n#' });
    expect(read('redis.conf')).toBe('requirepass "a b\\"c\\\\d\\x27e\\x0a#"\n');
  });

  it('regenerates an empty redis_password or internal_secret (logged) and repairs the modes of kept files', () => {
    run();
    overwrite(join(dir, 'redis_password'), '');
    overwrite(join(dir, 'internal_secret'), '\n');
    chmodSync(join(dir, 'app_enc_key'), 0o644);
    lines = [];
    run();
    expect(read('redis_password')).toMatch(HEX);
    expect(read('internal_secret')).toMatch(HEX);
    expect(read('internal_secret', gatewayDir)).toBe(read('internal_secret'));
    expect(lines).toContain('redis_password: regenerated (was empty)');
    expect(lines).toContain('internal_secret: regenerated (was empty)');
    expect(lines).toContain('redis.conf: updated');
    expect(mode(join(dir, 'app_enc_key'))).toBe(0o440);
  });

  it('refuses an empty postgres_password or app_enc_key on a used volume and changes nothing', () => {
    for (const f of ['postgres_password', 'app_enc_key']) {
      run();
      overwrite(join(dir, f), '');
      const before = Object.fromEntries(FILES.map((n) => [n, read(n)]));
      lines = [];
      expect(() => run(), f).toThrow(`${join(dir, f)} exists but is empty (damaged volume): restore it from the backup of the bootstrap volume`);
      expect(Object.fromEntries(FILES.map((n) => [n, read(n)]))).toEqual(before);
      expect(lines).toEqual([]);
      // an env value repairs it
      run(f === 'app_enc_key' ? { APP_ENC_KEY: K } : { POSTGRES_PASSWORD: 'restored-pw' });
      expect(read(f)).toBe(f === 'app_enc_key' ? K : 'restored-pw');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an empty file on a fresh volume (nothing else there yet) is generated', () => {
    mkdirSync(dir, { recursive: true });
    overwrite(join(dir, 'app_enc_key'), '');
    run();
    expect(Buffer.from(read('app_enc_key'), 'base64')).toHaveLength(32);
    expect(lines).toContain('app_enc_key: generated');
  });

  it('strips a trailing newline from files and env values, the same way the readers do', () => {
    run();
    overwrite(join(dir, 'redis_password'), 'pw with space\n'); // echo-style
    run({ POSTGRES_PASSWORD: 'pg-pw\r\n' });
    expect(read('redis_password')).toBe('pw with space');
    expect(read('postgres_password')).toBe('pg-pw');
    expect(read('redis.conf')).toBe('requirepass "pw with space"\n');
    const files = readBootstrap(dir);
    expect(files.redisPassword).toBe('pw with space');
    expect(files.postgresPassword).toBe('pg-pw');
    // a value keeps any other whitespace: the readers must not trim it away
    overwrite(join(dir, 'redis_password'), ' spaced \n');
    expect(readBootstrap(dir).redisPassword).toBe(' spaced ');
  });

  it('strips every trailing newline (a fixed point): a value read back equals the one in redis.conf', () => {
    run();
    overwrite(join(dir, 'redis_password'), 'dummy\n\n');
    run({ POSTGRES_PASSWORD: 'pg-pw\r\n\r\n' });
    expect(read('redis_password')).toBe('dummy');
    expect(read('redis.conf')).toBe('requirepass dummy\n');
    expect(read('postgres_password')).toBe('pg-pw');
    expect(readBootstrap(dir)).toMatchObject({ redisPassword: 'dummy', postgresPassword: 'pg-pw' });
    overwrite(join(dir, 'app_enc_key'), `${K}\n\n\n`);
    expect(readBootstrap(dir).appEncKey).toBe(K);
    expect(lazyBootstrap(dir).appEncKey).toBe(K);
  });

  it('a volume whose only remaining trace is the gateway copy is not fresh: an empty postgres_password is refused', () => {
    run();
    for (const f of FILES) rmSync(join(dir, f), { force: true });
    overwrite(join(dir, 'postgres_password'), '');
    const before = read('internal_secret', gatewayDir);
    expect(() => run()).toThrow(/postgres_password exists but is empty/);
    expect(read('postgres_password')).toBe('');
    expect(read('internal_secret', gatewayDir)).toBe(before);
    // an empty gateway copy does not count: nothing ever completed
    overwrite(join(gatewayDir, 'internal_secret'), '\n');
    run();
    expect(read('postgres_password')).toMatch(HEX);
    expect(lines).toContain('postgres_password: generated');
  });

  it('never logs a value', () => {
    const env = { POSTGRES_PASSWORD: 'legacy-pw', APP_ENC_KEY: K };
    run(env);
    run({});
    const log = lines.join('\n');
    const values = [...['postgres_password', 'redis_password', 'app_enc_key', 'internal_secret'].map((f) => read(f)), ...Object.values(env)];
    for (const v of values) expect(log).not.toContain(v);
  });
});

describe('readBootstrap', () => {
  it('reads the four values (trimmed) and leaves missing or empty files undefined', () => {
    run();
    const files = readBootstrap(dir);
    expect(files).toEqual({
      postgresPassword: read('postgres_password'), redisPassword: read('redis_password'),
      appEncKey: read('app_enc_key'), internalSecret: read('internal_secret'),
    });
    rmSync(join(dir, 'app_enc_key'), { force: true });
    overwrite(join(dir, 'internal_secret'), '\n');
    expect(readBootstrap(dir)).toEqual({ postgresPassword: files.postgresPassword, redisPassword: files.redisPassword });
    expect(readBootstrap(join(root, 'nope'))).toEqual({});
  });

  it('names the file when it exists but cannot be read', () => {
    run();
    rmSync(join(dir, 'app_enc_key'));
    mkdirSync(join(dir, 'app_enc_key')); // EISDIR stands in for EACCES (the tests may run as root)
    expect(() => readBootstrap(dir)).toThrow(`bootstrap file ${join(dir, 'app_enc_key')} is not readable (EISDIR)`);
  });
});

describe('lazyBootstrap', () => {
  it('reads only the files that are asked for: an unreadable volume does not matter when env provides every key', () => {
    mkdirSync(dir, { recursive: true });
    for (const f of ['postgres_password', 'redis_password', 'app_enc_key', 'internal_secret']) mkdirSync(join(dir, f)); // EISDIR ~ EACCES
    const env = { DATABASE_URL: 'postgres://u:x@db/x', REDIS_URL: 'redis://other', APP_ENC_KEY: K, INTERNAL_SECRET_FILE: '', INTERNAL_SECRET: S };
    expect(bootstrapEnv(env, lazyBootstrap(dir))).toEqual({ DATABASE_URL: 'postgres://u:x@db/x', REDIS_URL: 'redis://other', APP_ENC_KEY: K, INTERNAL_SECRET: S });
    expect(() => bootstrapEnv({ ...env, APP_ENC_KEY: '' }, lazyBootstrap(dir))).toThrow(`bootstrap file ${join(dir, 'app_enc_key')} is not readable (EISDIR)`);
    expect(() => readBootstrap(dir)).toThrow('is not readable (EISDIR)');
  });

  it('reads each file once and gives the same values as readBootstrap', () => {
    run();
    const lazy = lazyBootstrap(dir);
    expect({ ...lazy }).toEqual(readBootstrap(dir));
    const key = lazy.appEncKey;
    rmSync(join(dir, 'app_enc_key'));
    expect(lazy.appEncKey).toBe(key); // read once, then cached
    expect(lazyBootstrap(dir).appEncKey).toBeUndefined();
  });
});

describe('bootConfigEnv', () => {
  const b = { DATABASE_URL: 'postgres://friendflix:p@postgres:5432/friendflix', REDIS_URL: 'redis://:r@redis:6379', APP_ENC_KEY: K, INTERNAL_SECRET: S };

  it('drops empty values (compose ${KEY:-}), so loadConfig parses an empty number key as its default', () => {
    expect(() => loadConfig({ ...b, HEALTH_DISK_CRIT_PCT: '' })).toThrow();
    const c = loadConfig(bootConfigEnv({ HEALTH_DISK_CRIT_PCT: '', SESSION_TTL_SECONDS: '', ADMIN_GROUP: '', TZ: 'UTC' }, b));
    expect(c.HEALTH_DISK_CRIT_PCT).toBe(95);
    expect(c.SESSION_TTL_SECONDS).toBe(8 * 3600);
    expect(c.ADMIN_GROUP).toBe('friendflix-admins');
    expect(c.DATABASE_URL).toBe(b.DATABASE_URL);
  });

  it('removes the bootstrap keys\' VAR_FILE names: an empty DATABASE_URL_FILE does not override the resolved value', () => {
    const f = join(root, 'empty');
    writeFileSync(f, '\n');
    const env = { DATABASE_URL_FILE: f, APP_ENC_KEY_FILE: f, WEBHOOK_SECRET_FILE: f };
    const out = bootConfigEnv(env, bootstrapEnv(env, { postgresPassword: 'p', redisPassword: 'r', appEncKey: K, internalSecret: S }));
    expect(out.DATABASE_URL_FILE).toBeUndefined();
    expect(out.APP_ENC_KEY_FILE).toBeUndefined();
    expect(out.WEBHOOK_SECRET_FILE).toBe(f); // other keys keep their VAR_FILE
    const c = loadConfig(out);
    expect(c.DATABASE_URL).toBe(b.DATABASE_URL);
    expect(c.APP_ENC_KEY).toBe(K);
  });

  it('nonEmptyEnv keeps everything but empty values', () => {
    expect(nonEmptyEnv({ A: 'x', B: '', C: undefined, D: ' ' })).toEqual({ A: 'x', D: ' ' });
  });
});

describe('bootstrapEnv', () => {
  const files = { postgresPassword: 'p', redisPassword: 'r', appEncKey: K, internalSecret: S };

  it('derives the four bootstrap keys from the volume files', () => {
    expect(bootstrapEnv({}, files)).toEqual({
      DATABASE_URL: 'postgres://friendflix:p@postgres:5432/friendflix', REDIS_URL: 'redis://:r@redis:6379', APP_ENC_KEY: K, INTERNAL_SECRET: S,
    });
  });

  it('env wins, also as VAR_FILE', () => {
    const f = join(root, 'secret');
    writeFileSync(f, `${'f'.repeat(32)}\n`);
    expect(bootstrapEnv({ DATABASE_URL: 'postgres://u:x@db/x', REDIS_URL: 'redis://other', INTERNAL_SECRET_FILE: f }, files)).toEqual({
      DATABASE_URL: 'postgres://u:x@db/x', REDIS_URL: 'redis://other', APP_ENC_KEY: K, INTERNAL_SECRET: 'f'.repeat(32),
    });
  });

  it('an empty env value or VAR_FILE counts as unset', () => {
    const f = join(root, 'empty');
    writeFileSync(f, '\n');
    expect(bootstrapEnv({ DATABASE_URL: '', INTERNAL_SECRET: 'x'.repeat(32), INTERNAL_SECRET_FILE: f }, files).INTERNAL_SECRET).toBe(S);
    expect(bootstrapEnv({ DATABASE_URL: '' }, files).DATABASE_URL).toBe('postgres://friendflix:p@postgres:5432/friendflix');
  });

  it('URL-encodes a legacy password in the derived URLs', () => {
    const r = bootstrapEnv({}, { ...files, postgresPassword: 'a@b/c', redisPassword: 'd:e#' });
    expect(r.DATABASE_URL).toBe('postgres://friendflix:a%40b%2Fc@postgres:5432/friendflix');
    expect(r.REDIS_URL).toBe('redis://:d%3Ae%23@redis:6379');
  });

  it('a missing file is a startup error naming the file and the fix', () => {
    expect(() => bootstrapEnv({}, { ...files, appEncKey: undefined })).toThrow(
      'bootstrap file /run/friendflix/app_enc_key missing: start the stack with docker compose up (the bootstrap service creates it)');
    expect(() => bootstrapEnv({}, { ...files, postgresPassword: undefined })).toThrow('bootstrap file /run/friendflix/postgres_password missing');
    expect(() => bootstrapEnv({}, { ...files, redisPassword: undefined })).toThrow('bootstrap file /run/friendflix/redis_password missing');
    expect(() => bootstrapEnv({}, { ...files, internalSecret: undefined })).toThrow('bootstrap file /run/friendflix/internal_secret missing');
    // not needed when env provides the key
    expect(bootstrapEnv({ APP_ENC_KEY: K, DATABASE_URL: 'postgres://x' }, { redisPassword: 'r', internalSecret: S }).APP_ENC_KEY).toBe(K);
  });
});
