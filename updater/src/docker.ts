// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile } from 'node:child_process';
import { FF_SERVICES, SELF_SERVICE, cosignIdentity, expectedImage, isTag, pinnedRef } from './policy.js';

/** The only two programs the updater starts, never through a shell. */
export type Program = 'docker' | 'cosign';
export interface RunResult { code: number; stdout: string; stderr: string }
export type Runner = (program: Program, args: readonly string[], opts: { env: Record<string, string>; timeoutMs: number }) => Promise<RunResult>;

/** execFile without a shell; the child gets only the environment passed in (never the updater's own, which holds the secret). */
export const execRunner: Runner = (program, args, opts) => new Promise((resolve) => {
  execFile(program, [...args], { env: opts.env, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});

export interface ComposeSettings {
  /** the stack's directory, mounted read-only at the same path as on the host (relative bind paths must resolve the same) */
  projectDir: string;
  /** compose files inside projectDir (plain file names, checked in config.ts) */
  files: readonly string[];
  /** optional explicit project name (else the file's `name:`) */
  projectName?: string;
  /** owner/repo whose CI signs the images */
  repo: string;
  dockerHost: string;
}

export type ServiceState = { service: string; name: string; state: string; health: string };
export type ImageInfo = { repoDigests: string[]; gitSha: string | null; version: string | null };

const MIN = 60_000;

/** The fixed command lines. Every argument is a constant, a validated tag or a value read back from Docker itself. */
export class Docker {
  constructor(private readonly s: ComposeSettings, private readonly run: Runner) {}

  /**
   * The child environment: Docker endpoint, a writable config dir, the tag compose interpolates, PWD = the stack directory
   * (compose.prod.yaml mounts it at ${PWD}, so the updater's own definition renders the same as on the host), nothing else.
   */
  env(tag?: string): Record<string, string> {
    if (tag !== undefined && !isTag(tag)) throw new Error('invalid tag');
    return {
      PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', PWD: this.s.projectDir, DOCKER_HOST: this.s.dockerHost, DOCKER_CONFIG: '/tmp/.docker',
      ...(tag ? { FF_TAG: tag } : {}),
    };
  }

  private compose(tag: string | undefined, args: readonly string[], timeoutMs: number): Promise<RunResult> {
    const base = ['compose', '--project-directory', this.s.projectDir, ...this.s.files.flatMap((f) => ['-f', `${this.s.projectDir}/${f}`]),
      ...(this.s.projectName ? ['-p', this.s.projectName] : []), '--profile', 'updater', '--ansi', 'never'];
    return this.run('docker', [...base, ...args], { env: this.env(tag), timeoutMs });
  }

  /** the image each service would run with `tag`; throws unless every one is exactly ghcr.io/<owner>/<repo>-<image>:<tag> */
  async images(tag: string, services: readonly string[]): Promise<Record<string, string>> {
    const r = await this.compose(tag, ['config', '--format', 'json'], MIN);
    if (r.code !== 0) throw new StepError('compose_config');
    let cfg: { services?: Record<string, { image?: unknown }> };
    try { cfg = JSON.parse(r.stdout); } catch { throw new StepError('compose_config'); }
    const out: Record<string, string> = {};
    for (const svc of services) {
      const image = cfg.services?.[svc]?.image;
      if (typeof image !== 'string' || image !== expectedImage(this.s.repo, svc, tag)) throw new StepError('unexpected_image');
      out[svc] = image;
    }
    return out;
  }

  async pull(tag: string, services: readonly string[]): Promise<void> {
    const r = await this.compose(tag, ['pull', '--quiet', ...services], 10 * MIN);
    if (r.code !== 0) throw new StepError('pull_failed');
  }

  /** recreates exactly these services from the images already pulled and verified (`--pull never`: no second, unverified pull) */
  async up(tag: string, services: readonly string[]): Promise<void> {
    const r = await this.compose(tag, ['up', '-d', '--no-deps', '--pull', 'never', ...services], 10 * MIN);
    if (r.code !== 0) throw new StepError('restart_failed');
  }

  /**
   * Self-update: a one-shot sibling container of the updater service (same definition, the new image) recreates the updater;
   * the running updater cannot do it itself because compose stops it halfway through.
   */
  async spawnSelfUpdate(tag: string): Promise<void> {
    const r = await this.compose(tag, ['run', '-d', '--rm', '--no-deps', '--pull', 'never', '-e', `FF_TAG=${tag}`, SELF_SERVICE, 'node', 'updater/dist/selfUpdate.js'], 2 * MIN);
    if (r.code !== 0) throw new StepError('restart_failed');
  }

  async ps(): Promise<ServiceState[]> {
    const r = await this.compose(undefined, ['ps', '--all', '--format', 'json', ...FF_SERVICES, SELF_SERVICE], MIN);
    if (r.code !== 0) return [];
    // compose prints one JSON object per line (older versions: one array)
    const rows: Array<Record<string, unknown>> = [];
    for (const line of r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      try { const v = JSON.parse(line); rows.push(...(Array.isArray(v) ? v : [v])); } catch { /* ignore */ }
    }
    return rows.map((x) => ({ service: String(x.Service ?? ''), name: String(x.Name ?? ''), state: String(x.State ?? ''), health: String(x.Health ?? '') }));
  }

  /** what an image (a tag or the id a container runs) is: its registry digests and the commit baked in (GIT_SHA, APP_VERSION) */
  async imageInfo(ref: string): Promise<ImageInfo | null> {
    if (!/^[a-z0-9][a-z0-9./:@_-]{0,250}$/.test(ref)) return null;
    const r = await this.run('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}\t{{json .Config.Env}}', ref], { env: this.env(), timeoutMs: MIN });
    if (r.code !== 0) return null;
    const [digests, env] = r.stdout.trim().split('\t');
    try {
      const d = JSON.parse(digests ?? '[]') as unknown, e = JSON.parse(env ?? '[]') as unknown;
      const vars = Array.isArray(e) ? e.filter((x): x is string => typeof x === 'string') : [];
      const get = (k: string) => vars.find((v) => v.startsWith(`${k}=`))?.slice(k.length + 1) || null;
      return { repoDigests: Array.isArray(d) ? d.filter((x): x is string => typeof x === 'string') : [], gitSha: get('GIT_SHA'), version: get('APP_VERSION') };
    } catch { return null; }
  }

  /** the image id a container runs */
  async containerImage(container: string): Promise<string | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) return null;
    const r = await this.run('docker', ['container', 'inspect', '--format', '{{.Image}}', container], { env: this.env(), timeoutMs: MIN });
    const id = r.stdout.trim();
    return r.code === 0 && /^sha256:[0-9a-f]{64}$/.test(id) ? id : null;
  }

  /** what a service runs now (image digests + GIT_SHA of its container's image) */
  async running(service: string): Promise<ImageInfo | null> {
    const st = (await this.ps()).find((p) => p.service === service && p.state === 'running');
    const id = st ? await this.containerImage(st.name) : null;
    return id ? this.imageInfo(id) : null;
  }

  /** cosign keyless verification of image@digest against this repository's publish workflow; false on any failure */
  async verify(image: string): Promise<boolean> {
    const info = await this.imageInfo(image);
    const ref = info ? pinnedRef(image, info.repoDigests) : null;
    if (!ref) return false;
    const id = cosignIdentity(this.s.repo);
    const r = await this.run('cosign', ['verify', '--certificate-identity-regexp', id.identityRegexp, '--certificate-oidc-issuer', id.issuer, ref],
      { env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' }, timeoutMs: 2 * MIN });
    return r.code === 0;
  }
}

/** a step failure with a fixed code (the only thing that reaches the log, the state file and the backend) */
export class StepError extends Error {
  constructor(readonly code: string) { super(code); }
}
