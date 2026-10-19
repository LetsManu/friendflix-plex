// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { isRepo } from './policy.js';

export interface UpdaterConfig {
  port: number;
  secret: string;
  projectDir: string;
  composeFiles: string[];
  projectName?: string;
  repo: string;
  dockerHost: string;
  stateDir: string;
  backendHealthUrl: string;
  version: string | null;
  gitSha: string | null;
}

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.ya?ml$/;
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const DOCKER_HOST_RE = /^tcp:\/\/[a-z0-9][a-z0-9.-]{0,62}:[0-9]{2,5}$/;

/**
 * INTERNAL_SECRET: env, INTERNAL_SECRET_FILE, or the gateway's copy in the bootstrap-gateway volume (that volume holds nothing
 * else: never the database password or the encryption key). Same rule as gateway/src/env.ts.
 */
function secret(env: NodeJS.ProcessEnv): string {
  const f = env.INTERNAL_SECRET_FILE;
  const direct = (f ? readFileSync(f, 'utf8').trim() : env.INTERNAL_SECRET) || '';
  if (direct) return direct;
  const file = join(env.FF_BOOTSTRAP_DIR || '/run/friendflix-gateway', 'internal_secret');
  let v = '';
  try { v = readFileSync(file, 'utf8').replace(/(\r?\n)+$/, ''); } catch { /* reported below */ }
  if (v.length < 16) throw new Error(`missing INTERNAL_SECRET (env or ${file})`);
  return v;
}

/** Every value is checked here: anything that reaches a command line is a constant or matched one of these patterns. */
export function loadConfig(env: NodeJS.ProcessEnv): UpdaterConfig {
  const rawDir = env.UPDATER_PROJECT_DIR || '/project';
  const projectDir = normalize(rawDir).replace(/(.)\/$/, '$1');
  if (!isAbsolute(rawDir) || !/^\/[A-Za-z0-9._/ -]{0,250}$/.test(rawDir) || rawDir.split('/').includes('..')) throw new Error('UPDATER_PROJECT_DIR must be an absolute path');
  const composeFiles = (env.UPDATER_COMPOSE_FILES || 'compose.prod.yaml,compose.plex.yaml').split(',').map((s) => s.trim()).filter(Boolean);
  if (!composeFiles.length || composeFiles.length > 8 || !composeFiles.every((f) => FILE_RE.test(f))) throw new Error('UPDATER_COMPOSE_FILES: comma-separated file names in the project directory');
  const projectName = env.COMPOSE_PROJECT_NAME || undefined;
  if (projectName && !PROJECT_RE.test(projectName)) throw new Error('COMPOSE_PROJECT_NAME is not a valid project name');
  const repo = env.UPDATE_REPO || 'LetsManu/friendflix-plex'; // fork: friendflix-plex-* images, this repo's publish.yml signs them
  if (!isRepo(repo)) throw new Error('UPDATE_REPO must be owner/repo');
  const dockerHost = env.DOCKER_HOST || 'tcp://docker-proxy:2375';
  if (!DOCKER_HOST_RE.test(dockerHost)) throw new Error('DOCKER_HOST must be tcp://<host>:<port> (the socket proxy)');
  const port = Number(env.PORT || 7070);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be 1024-65535');
  const backendHealthUrl = env.UPDATER_BACKEND_HEALTH_URL || 'http://backend:3000/health';
  if (!/^http:\/\/[a-z0-9][a-z0-9.-]{0,62}(:[0-9]{2,5})?\/[a-z]{0,20}$/.test(backendHealthUrl)) throw new Error('UPDATER_BACKEND_HEALTH_URL must be an internal http URL');
  const sha = env.GIT_SHA && /^[0-9a-f]{40}$/.test(env.GIT_SHA) ? env.GIT_SHA : null;
  return {
    port, secret: secret(env), projectDir, composeFiles, projectName, repo, dockerHost,
    stateDir: env.UPDATER_STATE_DIR || '/state', backendHealthUrl,
    version: env.APP_VERSION && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(env.APP_VERSION) ? env.APP_VERSION : null, gitSha: sha,
  };
}
