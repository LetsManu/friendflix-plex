// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { selfUpdate } from '../src/selfUpdate.js';
import { DEFAULT_STATE, fileStore, sanitize } from '../src/state.js';

const SECRET = 'config-test-secret-0123456789';

describe('updater config', () => {
  it('defaults', () => {
    const c = loadConfig({ INTERNAL_SECRET: SECRET });
    expect(c).toMatchObject({ port: 7070, projectDir: '/project', composeFiles: ['compose.prod.yaml', 'compose.plex.yaml'], repo: 'LetsManu/friendflix-plex', dockerHost: 'tcp://docker-proxy:2375',
      stateDir: '/state', backendHealthUrl: 'http://backend:3000/health', version: null, gitSha: null });
    expect(c.secret).toBe(SECRET);
  });

  it('reads the secret from the bootstrap-gateway volume copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-upd-'));
    writeFileSync(join(dir, 'internal_secret'), `${SECRET}\n`);
    expect(loadConfig({ FF_BOOTSTRAP_DIR: dir }).secret).toBe(SECRET);
    writeFileSync(join(dir, 'f'), `${SECRET}\n`);
    expect(loadConfig({ INTERNAL_SECRET_FILE: join(dir, 'f') }).secret).toBe(SECRET);
    expect(() => loadConfig({ FF_BOOTSTRAP_DIR: join(dir, 'missing') })).toThrow('missing INTERNAL_SECRET');
  });

  it('refuses values that could smuggle arguments or paths', () => {
    const bad: Array<Record<string, string>> = [
      { UPDATER_COMPOSE_FILES: '../etc/passwd.yaml' }, { UPDATER_COMPOSE_FILES: '-f.yaml' }, { UPDATER_COMPOSE_FILES: 'a.yaml,--x' }, { UPDATER_COMPOSE_FILES: 'compose.json' },
      { UPDATER_PROJECT_DIR: 'relative' }, { UPDATER_PROJECT_DIR: '/a/../b' }, { UPDATER_PROJECT_DIR: '/a;b' },
      { COMPOSE_PROJECT_NAME: 'Bad Name' }, { UPDATE_REPO: 'x' }, { DOCKER_HOST: 'unix:///var/run/docker.sock' }, { DOCKER_HOST: 'tcp://-x:2375' },
      { PORT: '80' }, { UPDATER_BACKEND_HEALTH_URL: 'https://evil.example.com/x?y' },
    ];
    for (const b of bad) expect(() => loadConfig({ INTERNAL_SECRET: SECRET, ...b }), JSON.stringify(b)).toThrow();
    expect(loadConfig({ INTERNAL_SECRET: SECRET, UPDATER_COMPOSE_FILES: 'compose.prod.yaml, compose.secrets.yaml', UPDATER_PROJECT_DIR: '/srv/friend flix', COMPOSE_PROJECT_NAME: 'ff', GIT_SHA: 'a'.repeat(40), APP_VERSION: '1.1.0' }))
      .toMatchObject({ composeFiles: ['compose.prod.yaml', 'compose.secrets.yaml'], projectDir: '/srv/friend flix', projectName: 'ff', gitSha: 'a'.repeat(40), version: '1.1.0' });
  });
});

describe('updater state file', () => {
  it('round-trips atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-upd-'));
    const s = fileStore(dir);
    expect(s.load()).toEqual(DEFAULT_STATE);
    s.save({ ...DEFAULT_STATE, channel: 'pinned', version: '1.2.3', current: '1.2.3', previous: 'sha-abcdef1' });
    expect(s.load()).toMatchObject({ channel: 'pinned', version: '1.2.3', current: '1.2.3', previous: 'sha-abcdef1' });
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).channel).toBe('pinned');
  });

  it('a tampered file cannot inject a tag, a channel or a job', () => {
    expect(sanitize({ channel: 'evil', version: '1.2.3; id', current: 'latest && id', previous: 'latest', lastJob: { id: 'x' } })).toEqual(DEFAULT_STATE);
    expect(sanitize({ channel: 'pinned' }).channel).toBe('stable'); // pinned without a version
    expect(sanitize(null)).toEqual(DEFAULT_STATE);
    const job = sanitize({ lastJob: { id: '0123456789abcdef', action: 'update', state: 'failed', to: 'latest', from: '$(id)', steps: { pull: 'ok', verify: 'weird' }, step: 'verify', error: 'Bad Error', startedAt: 'nope' } }).lastJob!;
    expect(job).toMatchObject({ from: null, error: null, step: 'verify', steps: { pull: 'ok', verify: 'pending' }, startedAt: new Date(0).toISOString() });
  });
});

describe('self-update helper', () => {
  it('recreates only the updater service with a valid tag', async () => {
    const calls: Array<[string, readonly string[]]> = [];
    const d = { up: async (t: string, s: readonly string[]) => { calls.push([t, s]); } };
    expect(await selfUpdate({ FF_TAG: 'nightly' }, d)).toBe(0);
    expect(calls).toEqual([['nightly', ['updater']]]);
    expect(await selfUpdate({ FF_TAG: 'nightly;id' }, d)).toBe(2);
    expect(await selfUpdate({}, d)).toBe(2);
    expect(await selfUpdate({ FF_TAG: 'latest' }, { up: async () => { throw new Error('x'); } })).toBe(1);
  });
});
