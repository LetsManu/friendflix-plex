// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// The `bootstrap` init container (compose): generates every secret needed before the database can be read into the `bootstrap`
// volume, and the gateway's copy of INTERNAL_SECRET into `bootstrap-gateway`. Runs as root without any capability but CHOWN, on a
// read-only root fs without network, then exits; every other service waits for it (service_completed_successfully).
// Dependency-free on purpose (node: modules and the import-free volumeValue.ts only): it must not load the app, its config or its
// database code.
import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripNewlines } from './volumeValue.js';

/** volume file -> the legacy env variable that wins over it (existing installs keep their .env values) */
const SECRETS = [
  { file: 'postgres_password', env: 'POSTGRES_PASSWORD', make: () => randomBytes(32).toString('hex') },
  { file: 'redis_password', env: 'REDIS_PASSWORD', make: () => randomBytes(32).toString('hex') },
  { file: 'app_enc_key', env: 'APP_ENC_KEY', make: () => randomBytes(32).toString('base64') },
  { file: 'internal_secret', env: 'INTERNAL_SECRET', make: () => randomBytes(32).toString('hex') },
] as const;
/** Regenerating these would orphan existing data (pgdata's password, encrypted rows), so an empty copy is an error, never replaced. */
const PRECIOUS: ReadonlySet<string> = new Set(['postgres_password', 'app_enc_key']);

export interface BootstrapOptions {
  dir: string;
  gatewayDir: string;
  env: NodeJS.ProcessEnv;
  /** the group that may read the files (FF_SECRETS_GID, 10001): services that need them get it via group_add */
  gid: number;
  chown: (path: string, uid: number, gid: number) => void;
  /** file names and actions only, never values */
  log: (line: string) => void;
}

/** A redis.conf argument: plain when redis reads it back verbatim, else double-quoted with escapes (a legacy password may be anything). */
function redisArg(v: string): string {
  if (/^[\x21-\x7e]+$/.test(v) && !/["'\\]/.test(v)) return v;
  const esc = [...Buffer.from(v, 'utf8')].map((b) => {
    if (b === 0x22) return '\\"';
    if (b === 0x5c) return '\\\\';
    return b >= 0x20 && b <= 0x7e && b !== 0x27 ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`;
  });
  return `"${esc.join('')}"`;
}

const readOr = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);

/** fsync a file or directory, so a renamed file survives a power loss with its content */
function sync(path: string, flags: string): void {
  const fd = openSync(path, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Creates the volume layout (idempotent): per secret, a non-empty env value is written (env wins on every run), else an existing
 * non-empty file is kept, else a new value is generated. redis.conf and the gateway copy follow their source. Directories end up
 * 0750, files 0440, all owned by root and `gid`. Writes are atomic and durable (temp file + fsync + rename + directory fsync).
 * An existing but empty file on a volume that holds other files is a damaged volume: postgres_password and app_enc_key are then
 * refused (the run fails before writing anything, naming the file), the others are regenerated with a log line.
 */
export function runBootstrap(opts: BootstrapOptions): void {
  const { dir, gatewayDir, env, gid, chown, log } = opts;
  for (const d of [dir, gatewayDir]) {
    mkdirSync(d, { recursive: true });
    chown(d, 0, gid);
    chmodSync(d, 0o750);
  }

  /** writes `content` when it differs from what is there; always (re)applies owner and mode */
  const put = (path: string, content: string): 'kept' | 'written' => {
    if (readOr(path) === content) {
      chown(path, 0, gid);
      chmodSync(path, 0o440);
      return 'kept';
    }
    const tmp = `${path}.tmp`;
    rmSync(tmp, { force: true }); // a leftover 0440 temp file could not be reopened for writing without CAP_DAC_OVERRIDE
    const fd = openSync(tmp, 'w', 0o600);
    try {
      const buf = Buffer.from(content, 'utf8');
      for (let off = 0; off < buf.length;) off += writeSync(fd, buf, off, buf.length - off); // a short write continues
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chown(tmp, 0, gid);
    chmodSync(tmp, 0o440);
    renameSync(tmp, path);
    sync(join(path, '..'), 'r');
    return 'written';
  };

  // decide everything before the first write, so a refused run leaves the volume as it was
  const existing = Object.fromEntries(SECRETS.map((s) => {
    const raw = readOr(join(dir, s.file));
    return [s.file, raw === undefined ? undefined : stripNewlines(raw)];
  }));
  // fresh = no run ever completed: no value, no redis.conf, and no gateway copy (it lives on its own volume)
  const gwOld = readOr(join(gatewayDir, 'internal_secret'));
  const fresh = !Object.values(existing).some(Boolean) && !existsSync(join(dir, 'redis.conf')) && !stripNewlines(gwOld ?? '');
  const plan = SECRETS.map((s) => {
    const fromEnv = stripNewlines(env[s.env] ?? '');
    const old = existing[s.file];
    if (fromEnv) return { s, value: fromEnv, action: 'from environment' };
    if (old) return { s, value: old, action: 'kept' };
    if (old === '' && !fresh) {
      if (PRECIOUS.has(s.file)) {
        throw new Error(`${join(dir, s.file)} exists but is empty (damaged volume): restore it from the backup of the bootstrap volume or `
          + `set ${s.env}; a new value would not match the existing data`);
      }
      return { s, value: s.make(), action: 'regenerated (was empty)' };
    }
    return { s, value: s.make(), action: 'generated' };
  });

  const values: Record<string, string> = {};
  for (const { s, value, action } of plan) {
    values[s.file] = value;
    put(join(dir, s.file), value);
    log(`${s.file}: ${action}`);
  }

  const conf = join(dir, 'redis.conf');
  const confExisted = existsSync(conf);
  const confAction = put(conf, `requirepass ${redisArg(values.redis_password!)}\n`);
  log(`redis.conf: ${confAction === 'kept' ? 'kept' : confExisted ? 'updated' : 'generated'}`);

  // the gateway only ever sees INTERNAL_SECRET: never the database password or the encryption key
  const gw = join(gatewayDir, 'internal_secret');
  const gwExisted = existsSync(gw);
  const gwAction = put(gw, values.internal_secret!);
  log(`gateway internal_secret: ${gwAction === 'kept' ? 'kept' : gwExisted ? 'updated' : 'generated'}`);
}

// entry point of the init container: node backend/dist/bootstrap.js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runBootstrap({ dir: '/run/friendflix', gatewayDir: '/run/friendflix-gateway', env: process.env, gid: 10001, chown: chownSync, log: (l) => console.log(`bootstrap: ${l}`) });
  } catch (err) {
    // fs errors name the path and the code, never file contents
    console.error(`bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
