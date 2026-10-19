// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { StepError, type ImageInfo } from './docker.js';
import { FF_SERVICES, SELF_SERVICE, SHA_TAG_RE, channelTag, shaTag, type Channel } from './policy.js';
import type { Job, JobAction, State, StateStore, StepName } from './state.js';

/** What a job needs from Docker (docker.ts in production, a fake in the tests). */
export interface Ops {
  images(tag: string, services: readonly string[]): Promise<Record<string, string>>;
  pull(tag: string, services: readonly string[]): Promise<void>;
  verify(image: string): Promise<boolean>;
  up(tag: string, services: readonly string[]): Promise<void>;
  imageInfo(ref: string): Promise<ImageInfo | null>;
  running(service: string): Promise<ImageInfo | null>;
  spawnSelfUpdate(tag: string): Promise<void>;
  /** one health round: every FriendFlix service up (and healthy where it has a check), the backend answering with `sha7` */
  healthy(sha7: string | null): Promise<boolean>;
}

/** In-memory job log: our own fixed messages, tags and error codes only (never command output, never a secret). */
export class JobLog {
  private lines: string[] = [];
  constructor(private readonly max = 200, private readonly now: () => number = Date.now) {}
  add(msg: string): void {
    this.lines.push(`${new Date(this.now()).toISOString()} ${msg}`);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }
  tail(n = 50): string[] { return this.lines.slice(-n); }
}

export interface UpdaterOpts {
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  selfUpdateTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: JobLog;
}

export type StartResult = { ok: true; job: Job } | { ok: false; error: 'busy' | 'no_target' | 'no_previous' };

const newJob = (action: JobAction, from: string | null, to: string, now: number): Job => ({
  id: randomBytes(8).toString('hex'), action, state: 'running', step: null, from, to,
  steps: { pull: 'pending', verify: 'pending', restart: 'pending', health: 'pending', rollback: 'skipped' },
  startedAt: new Date(now).toISOString(), finishedAt: null, error: null,
});

/**
 * One job at a time: update (pull -> cosign verify -> recreate -> health, automatic rollback to the previous build when the
 * new one does not get healthy), rollback (to the recorded previous sha tag), self-update (explicit only). A verify failure
 * aborts before anything is restarted.
 */
export class Updater {
  readonly log: JobLog;
  private state: State;
  private current: Promise<void> | null = null;
  private readonly o: Required<Omit<UpdaterOpts, 'log'>>;

  constructor(private readonly ops: Ops, private readonly store: StateStore, opts: UpdaterOpts = {}) {
    this.o = {
      healthTimeoutMs: opts.healthTimeoutMs ?? 180_000, healthIntervalMs: opts.healthIntervalMs ?? 5_000,
      selfUpdateTimeoutMs: opts.selfUpdateTimeoutMs ?? 180_000,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), now: opts.now ?? Date.now,
    };
    this.log = opts.log ?? new JobLog(200, this.o.now);
    this.state = store.load();
    this.recover();
  }

  /** a job still marked running after a restart: a self-update that got to its restart step succeeded (we are the new process) */
  private recover(): void {
    const j = this.state.lastJob;
    if (!j || j.state !== 'running') return;
    if (j.action === 'self-update' && j.step === 'restart') {
      j.steps.restart = 'ok'; j.steps.health = 'ok'; j.step = null; j.state = 'succeeded';
      this.log.add(`self-update to ${j.to} finished`);
    } else {
      if (j.step) j.steps[j.step] = 'failed';
      j.state = 'failed'; j.error = 'interrupted';
      this.log.add(`job ${j.action} was interrupted by a restart`);
    }
    j.finishedAt = new Date(this.o.now()).toISOString();
    this.persist();
  }

  get busy(): boolean { return this.current !== null; }
  snapshot(): State { return structuredClone(this.state); }
  /** resolves when the running job (if any) is done */
  async idle(): Promise<void> { await this.current; }

  setChannel(channel: Channel, version: string | null): State {
    this.state.channel = channel;
    this.state.version = channel === 'pinned' ? version : null;
    this.persist();
    this.log.add(`channel set to ${channel}${channel === 'pinned' ? ` ${version}` : ''}`);
    return this.snapshot();
  }

  start(action: JobAction): StartResult {
    if (this.current) return { ok: false, error: 'busy' };
    const target = action === 'rollback' ? this.state.previous : channelTag(this.state.channel, this.state.version);
    if (!target) return { ok: false, error: action === 'rollback' ? 'no_previous' : 'no_target' };
    if (action === 'rollback' && !SHA_TAG_RE.test(target)) return { ok: false, error: 'no_previous' };
    const job = newJob(action, this.state.current, target, this.o.now());
    this.state.lastJob = job;
    this.persist();
    this.log.add(`${action} to ${target} started`);
    const run = action === 'self-update' ? this.selfUpdate(job) : this.deployJob(job, action === 'update');
    this.current = run.catch(() => undefined).finally(() => { this.current = null; });
    return { ok: true, job: structuredClone(job) };
  }

  private persist(): void {
    try { this.store.save(this.state); } catch { this.log.add('state file could not be written'); }
  }

  private async step<T>(job: Job, name: StepName, fn: () => Promise<T>): Promise<T> {
    job.step = name; job.steps[name] = 'running'; this.persist();
    this.log.add(`step ${name}`);
    try {
      const v = await fn();
      job.steps[name] = 'ok'; this.persist();
      return v;
    } catch (e) {
      job.steps[name] = 'failed'; this.persist();
      throw e instanceof StepError ? e : new StepError(`${name}_failed`);
    }
  }

  private finish(job: Job, state: Job['state'], error: string | null): void {
    job.state = state; job.error = error; job.finishedAt = new Date(this.o.now()).toISOString();
    for (const k of Object.keys(job.steps) as StepName[]) if (job.steps[k] === 'pending') job.steps[k] = 'skipped';
    if (state === 'succeeded') job.step = null;
    this.persist();
    this.log.add(`${job.action} ${state}${error ? ` (${error})` : ''}`);
  }

  /** pull + verify (+ the commit the new backend image carries); nothing is restarted here */
  private async prepare(job: Job | null, tag: string, services: readonly string[], step = <T>(n: StepName, f: () => Promise<T>) => (job ? this.step(job, n, f) : f())) {
    const images = await step('pull', async () => {
      const imgs = await this.ops.images(tag, services);
      await this.ops.pull(tag, services);
      return imgs;
    });
    await step('verify', async () => {
      for (const img of [...new Set(Object.values(images))]) {
        if (!(await this.ops.verify(img))) { this.log.add(`signature check failed for ${img}`); throw new StepError('verify_failed'); }
        this.log.add(`signature ok: ${img}`);
      }
    });
    return images;
  }

  private async waitHealthy(sha7: string | null): Promise<boolean> {
    const end = this.o.now() + this.o.healthTimeoutMs;
    for (;;) {
      if (await this.ops.healthy(sha7).catch(() => false)) return true;
      if (this.o.now() >= end) return false;
      await this.o.sleep(this.o.healthIntervalMs);
    }
  }

  /** restart + health of an already verified tag; throws StepError */
  private async bringUp(job: Job, tag: string, images: Record<string, string>, steps: boolean): Promise<string | null> {
    const newSha = (await this.ops.imageInfo(images.backend!))?.gitSha ?? null;
    const restart = () => this.ops.up(tag, FF_SERVICES);
    if (steps) await this.step(job, 'restart', restart); else await restart();
    const health = async () => { if (!(await this.waitHealthy(newSha ? newSha.slice(0, 7) : null))) throw new StepError('unhealthy'); };
    if (steps) await this.step(job, 'health', health); else await health();
    return newSha;
  }

  private async deployJob(job: Job, autoRollback: boolean): Promise<void> {
    const before = await this.ops.running('backend').catch(() => null);
    const prevTag = shaTag(before?.gitSha);
    if (prevTag) job.from = prevTag;
    let images: Record<string, string>;
    try {
      images = await this.prepare(job, job.to, FF_SERVICES);
    } catch (e) {
      // nothing was restarted
      return this.finish(job, 'failed', (e as StepError).code);
    }
    try {
      const newSha = await this.bringUp(job, job.to, images, true);
      this.state.current = job.to;
      const newTag = shaTag(newSha);
      if (prevTag && prevTag !== newTag) this.state.previous = prevTag;
      return this.finish(job, 'succeeded', null);
    } catch (e) {
      const code = (e as StepError).code;
      if (!autoRollback || !prevTag) return this.finish(job, 'failed', code);
      this.log.add(`rolling back to ${prevTag}`);
      job.steps.rollback = 'pending';
      try {
        await this.step(job, 'rollback', async () => {
          const imgs = await this.prepare(null, prevTag, FF_SERVICES);
          await this.bringUp(job, prevTag, imgs, false);
        });
        this.state.current = prevTag;
        return this.finish(job, 'rolled_back', code);
      } catch {
        return this.finish(job, 'failed', 'rollback_failed');
      }
    }
  }

  private async selfUpdate(job: Job): Promise<void> {
    job.steps.health = 'skipped';
    try {
      await this.prepare(job, job.to, [SELF_SERVICE]);
      await this.step(job, 'restart', () => this.ops.spawnSelfUpdate(job.to));
      job.step = 'restart'; job.steps.restart = 'running'; this.persist();
      // the helper recreates this container: a new process finishes the job (recover()); still here after the timeout = it failed
      await this.o.sleep(this.o.selfUpdateTimeoutMs);
      job.steps.restart = 'failed';
      return this.finish(job, 'failed', 'self_update_timeout');
    } catch (e) {
      return this.finish(job, 'failed', (e as StepError).code);
    }
  }
}
