// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Docker, StepError, type Program, type RunResult, type Runner } from '../src/docker.js';

type Call = { program: Program; args: string[]; env: Record<string, string> };
const D = 'sha256:' + 'c'.repeat(64);
const ID = 'sha256:' + 'e'.repeat(64);

function fake(answer: (c: Call) => Partial<RunResult> = () => ({})) {
  const calls: Call[] = [];
  const run: Runner = async (program, args, opts) => {
    const c = { program, args: [...args], env: opts.env };
    calls.push(c);
    return { code: 0, stdout: '', stderr: '', ...answer(c) };
  };
  const docker = new Docker({ projectDir: '/srv/friendflix', files: ['compose.prod.yaml', 'compose.secrets.yaml'], repo: 'LetsManu/friendflix', dockerHost: 'tcp://docker-proxy:2375' }, run);
  return { calls, docker };
}
const config = (tag: string, over: Record<string, string> = {}) => JSON.stringify({ services: Object.fromEntries(['bootstrap', 'backend', 'gateway', 'web', 'updater', 'postgres'].map((s) => [s, {
  image: over[s] ?? (s === 'postgres' ? 'postgres:17-alpine' : `ghcr.io/letsmanu/friendflix-${s === 'bootstrap' ? 'backend' : s}:${tag}`),
}])) });

describe('docker command lines', () => {
  it('compose runs with fixed arguments, the tag only via FF_TAG, and an environment without secrets', async () => {
    process.env.INTERNAL_SECRET = 'must-never-reach-a-child-process';
    const { calls, docker } = fake();
    await docker.pull('nightly', ['backend', 'web']);
    await docker.up('nightly', ['backend', 'web']);
    expect(calls[0]!.args).toEqual(['compose', '--project-directory', '/srv/friendflix', '-f', '/srv/friendflix/compose.prod.yaml', '-f', '/srv/friendflix/compose.secrets.yaml',
      '--profile', 'updater', '--ansi', 'never', 'pull', '--quiet', 'backend', 'web']);
    expect(calls[1]!.args.slice(11)).toEqual(['up', '-d', '--no-deps', '--pull', 'never', 'backend', 'web']);
    for (const c of calls) {
      expect(c.env).toEqual({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', PWD: '/srv/friendflix', DOCKER_HOST: 'tcp://docker-proxy:2375', DOCKER_CONFIG: '/tmp/.docker', FF_TAG: 'nightly' });
      expect(JSON.stringify(c)).not.toContain('must-never-reach');
    }
    delete process.env.INTERNAL_SECRET;
    expect(() => docker.env('latest;id')).toThrow('invalid tag');
    await expect(docker.pull('$(id)', ['backend'])).rejects.toThrow('invalid tag');
  });

  it('a failing command is a step error with a fixed code', async () => {
    const { docker } = fake(() => ({ code: 1, stderr: 'Error: token ghp_secret123 denied' }));
    await expect(docker.pull('latest', ['backend'])).rejects.toEqual(new StepError('pull_failed'));
    await expect(docker.up('latest', ['backend'])).rejects.toEqual(new StepError('restart_failed'));
    await expect(docker.spawnSelfUpdate('latest')).rejects.toEqual(new StepError('restart_failed'));
    await expect(docker.images('latest', ['backend'])).rejects.toEqual(new StepError('compose_config'));
  });

  it('images: every service must resolve to exactly this repository\'s image with the requested tag', async () => {
    expect(await fake(() => ({ stdout: config('1.2.3') })).docker.images('1.2.3', ['bootstrap', 'backend', 'gateway', 'web'])).toEqual({
      bootstrap: 'ghcr.io/letsmanu/friendflix-backend:1.2.3', backend: 'ghcr.io/letsmanu/friendflix-backend:1.2.3',
      gateway: 'ghcr.io/letsmanu/friendflix-gateway:1.2.3', web: 'ghcr.io/letsmanu/friendflix-web:1.2.3',
    });
    for (const evil of ['ghcr.io/evil/friendflix-web:1.2.3', 'ghcr.io/letsmanu/friendflix-web:latest', 'docker.io/library/nginx', 'ghcr.io/letsmanu/friendflix-web@' + D]) {
      await expect(fake(() => ({ stdout: config('1.2.3', { web: evil }) })).docker.images('1.2.3', ['web']), evil).rejects.toEqual(new StepError('unexpected_image'));
    }
    await expect(fake(() => ({ stdout: 'not json' })).docker.images('1.2.3', ['web'])).rejects.toEqual(new StepError('compose_config'));
    await expect(fake(() => ({ stdout: '{}' })).docker.images('1.2.3', ['web'])).rejects.toEqual(new StepError('unexpected_image'));
  });

  it('verify: cosign gets the digest-pinned reference and the publish workflow identity, never a tag', async () => {
    const { calls, docker } = fake((c) => (c.program === 'docker' ? { stdout: `["ghcr.io/letsmanu/friendflix-web@${D}"]\t["GIT_SHA=${'a'.repeat(40)}","APP_VERSION=1.2.3"]\n` } : {}));
    expect(await docker.verify('ghcr.io/letsmanu/friendflix-web:latest')).toBe(true);
    const cos = calls.find((c) => c.program === 'cosign')!;
    expect(cos.args).toEqual(['verify', '--certificate-identity-regexp',
      '^https://github\\.com/LetsManu/friendflix/\\.github/workflows/publish\\.yml@refs/(heads/main|tags/v[0-9]+\\.[0-9]+\\.[0-9]+)$',
      '--certificate-oidc-issuer', 'https://token.actions.githubusercontent.com', `ghcr.io/letsmanu/friendflix-web@${D}`]);
    expect(cos.env).toEqual({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' });
  });

  it('verify fails without a matching digest or when cosign fails', async () => {
    expect(await fake(() => ({ stdout: `["ghcr.io/evil/friendflix-web@${D}"]\t[]` })).docker.verify('ghcr.io/letsmanu/friendflix-web:latest')).toBe(false);
    expect(await fake((c) => (c.program === 'docker' ? { stdout: `["ghcr.io/letsmanu/friendflix-web@${D}"]\t[]` } : { code: 1 })).docker.verify('ghcr.io/letsmanu/friendflix-web:latest')).toBe(false);
    expect(await fake(() => ({ code: 1 })).docker.verify('ghcr.io/letsmanu/friendflix-web:latest')).toBe(false);
  });

  it('ps, running image and image info', async () => {
    const { docker } = fake((c) => {
      if (c.args.includes('ps')) return { stdout: [{ Service: 'backend', Name: 'friendflix-backend-1', State: 'running', Health: 'healthy' }, { Service: 'web', Name: 'friendflix-web-1', State: 'exited', Health: '' }].map((x) => JSON.stringify(x)).join('\n') };
      if (c.args[0] === 'container') return { stdout: `${ID}\n` };
      return { stdout: `["ghcr.io/letsmanu/friendflix-backend@${D}"]\t["PATH=/x","GIT_SHA=${'a'.repeat(40)}","APP_VERSION=1.2.3"]` };
    });
    expect(await docker.ps()).toEqual([{ service: 'backend', name: 'friendflix-backend-1', state: 'running', health: 'healthy' }, { service: 'web', name: 'friendflix-web-1', state: 'exited', health: '' }]);
    expect(await docker.running('backend')).toEqual({ repoDigests: [`ghcr.io/letsmanu/friendflix-backend@${D}`], gitSha: 'a'.repeat(40), version: '1.2.3' });
    expect(await docker.running('web')).toBeNull(); // not running
    expect(await docker.imageInfo('bad ref; id')).toBeNull();
    expect(await docker.containerImage('../x')).toBeNull();
  });

  it('ps tolerates an array answer and failures', async () => {
    expect(await fake(() => ({ stdout: JSON.stringify([{ Service: 'web', Name: 'w', State: 'running' }]) })).docker.ps()).toEqual([{ service: 'web', name: 'w', state: 'running', health: '' }]);
    expect(await fake(() => ({ code: 1 })).docker.ps()).toEqual([]);
    expect(await fake(() => ({ stdout: 'garbage' })).docker.ps()).toEqual([]);
    expect(await fake(() => ({ code: 1 })).docker.imageInfo('x')).toBeNull();
    expect(await fake(() => ({ stdout: 'x\ty' })).docker.imageInfo('x')).toBeNull();
    expect(await fake(() => ({ stdout: 'not-a-digest' })).docker.containerImage('c')).toBeNull();
  });

  it('self-update spawns the helper from the updater service definition', async () => {
    const { calls, docker } = fake();
    await docker.spawnSelfUpdate('1.2.3');
    expect(calls[0]!.args.slice(11)).toEqual(['run', '-d', '--rm', '--no-deps', '--pull', 'never', '-e', 'FF_TAG=1.2.3', 'updater', 'node', 'updater/dist/selfUpdate.js']);
  });
});
