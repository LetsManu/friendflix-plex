// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripNewlines } from '../volumeValue.js';

/** What the `bootstrap` init container wrote into the bootstrap volume (src/bootstrap.ts); undefined = file missing or empty. */
export interface BootstrapFiles {
  postgresPassword?: string;
  redisPassword?: string;
  appEncKey?: string;
  internalSecret?: string;
}

export type BootstrapEnv = { DATABASE_URL: string; REDIS_URL: string; APP_ENC_KEY: string; INTERNAL_SECRET: string };

const DIR = '/run/friendflix';
const FILES: Record<keyof BootstrapFiles, string> = {
  postgresPassword: 'postgres_password', redisPassword: 'redis_password', appEncKey: 'app_enc_key', internalSecret: 'internal_secret',
};

const KEYS = Object.keys(FILES) as Array<keyof BootstrapFiles>;

/**
 * One volume file, without its trailing newlines (the writer's contract, src/volumeValue.ts). Missing or empty = undefined; unreadable
 * (EACCES: the container lacks the secrets group, group_add: ["10001"]) throws, naming the path, never a value.
 */
function readFile(dir: string, key: keyof BootstrapFiles): string | undefined {
  const path = join(dir, FILES[key]);
  try {
    return stripNewlines(readFileSync(path, 'utf8')) || undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw new Error(`bootstrap file ${path} is not readable (${code})`, { cause: err });
  }
}

/** Reads the whole bootstrap volume at once. A missing directory or file is not an error here; an unreadable one is. */
export function readBootstrap(dir = DIR): BootstrapFiles {
  const out: BootstrapFiles = {};
  for (const key of KEYS) {
    const v = readFile(dir, key);
    if (v) out[key] = v;
  }
  return out;
}

/**
 * The bootstrap volume, read per value on first access: bootstrapEnv only touches the files whose key env does not provide, so an
 * unreadable volume does not stop a backend that gets all four values from env.
 */
export function lazyBootstrap(dir = DIR): BootstrapFiles {
  const out: BootstrapFiles = {};
  for (const key of KEYS) {
    let cached: { v: string | undefined } | undefined;
    Object.defineProperty(out, key, { enumerable: true, get: () => (cached ??= { v: readFile(dir, key) }).v });
  }
  return out;
}

/** VAR, or the file named by VAR_FILE (which then decides alone; empty = unset), as the settings resolver's env layer reads it. */
function fromEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim() || undefined;
  return env[name] || undefined;
}

const missing = (name: string) =>
  new Error(`bootstrap file ${DIR}/${name} missing: start the stack with docker compose up (the bootstrap service creates it)`);

/**
 * The four bootstrap keys: env (incl. VAR_FILE) wins, else derived from the bootstrap volume (spec Part A defaults). A file is only
 * required when env does not provide its key; a missing one is a startup error naming the file and the fix.
 */
export function bootstrapEnv(env: NodeJS.ProcessEnv, files: BootstrapFiles): BootstrapEnv {
  const need = (key: keyof BootstrapFiles) => {
    const v = files[key];
    if (!v) throw missing(FILES[key]);
    return v;
  };
  return {
    DATABASE_URL: fromEnv(env, 'DATABASE_URL') ?? `postgres://friendflix:${encodeURIComponent(need('postgresPassword'))}@postgres:5432/friendflix`,
    REDIS_URL: fromEnv(env, 'REDIS_URL') ?? `redis://:${encodeURIComponent(need('redisPassword'))}@redis:6379`,
    APP_ENC_KEY: fromEnv(env, 'APP_ENC_KEY') ?? need('appEncKey'),
    INTERNAL_SECRET: fromEnv(env, 'INTERNAL_SECRET') ?? need('internalSecret'),
  };
}

/** The env without empty values: compose passes every optional key as `${KEY:-}`, and empty counts as unset everywhere. */
export function nonEmptyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
}

/**
 * The env loadConfig sees at start: empty values dropped (otherwise `${KEY:-}` = '' fails a number schema), the four resolved
 * bootstrap values laid over it and their VAR_FILE names removed (bootstrapEnv already decided them; an empty file counts as unset
 * there, while loadConfig would read it as '').
 */
export function bootConfigEnv(env: NodeJS.ProcessEnv, bootstrap: BootstrapEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...nonEmptyEnv(env), ...bootstrap };
  for (const k of Object.keys(bootstrap)) delete out[`${k}_FILE`];
  return out;
}
