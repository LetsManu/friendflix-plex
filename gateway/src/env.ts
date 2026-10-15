// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** VAR, or the file referenced by VAR_FILE (Docker secrets); undefined when unset or empty. */
function read(env: NodeJS.ProcessEnv, k: string): string | undefined {
  const f = env[`${k}_FILE`];
  return (f ? readFileSync(f, 'utf8').trim() : env[k]) || undefined;
}

/** Reads VAR or VAR_FILE; undefined when unset or empty. */
export const optional = (env: NodeJS.ProcessEnv, k: string): string | undefined => read(env, k);

/** Reads VAR or VAR_FILE; refuses to start without it. */
export function need(env: NodeJS.ProcessEnv, k: string): string {
  const v = read(env, k);
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}

/**
 * INTERNAL_SECRET: env or INTERNAL_SECRET_FILE (unchanged), else the copy the `bootstrap` init container writes into the
 * `bootstrap-gateway` volume (the gateway never sees the other bootstrap secrets). FF_GATEWAY_BOOTSTRAP_DIR only moves it (tests).
 */
export function internalSecret(env: NodeJS.ProcessEnv): string {
  const v = read(env, 'INTERNAL_SECRET');
  if (v) return v;
  const file = join(env.FF_GATEWAY_BOOTSTRAP_DIR || '/run/friendflix-gateway', 'internal_secret');
  let fromFile = '';
  try {
    fromFile = readFileSync(file, 'utf8').replace(/(\r?\n)+$/, ''); // the volume's contract (backend/src/volumeValue.ts): trailing newlines only
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`bootstrap file ${file} is not readable (${(err as NodeJS.ErrnoException).code})`, { cause: err });
  }
  if (!fromFile) throw new Error(`missing env INTERNAL_SECRET and bootstrap file ${file}: start the stack with docker compose up (the bootstrap service creates it)`);
  return fromFile;
}
