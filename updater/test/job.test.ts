// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { StepError, type ImageInfo } from '../src/docker.js';
import { JobLog, Updater, type Ops } from '../src/job.js';
import { DEFAULT_STATE, memoryStore, type State } from '../src/state.js';

const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40);

/** a fake Docker world: which tag each service runs, which images verify, whether the new build gets healthy */
function world(o: { verifyFails?: string; healthyTags?: string[]; pullFails?: boolean; upFails?: string; running?: string | null; spawnFails?: boolean } = {}) {
  const calls: string[] = [];
  let runningTag = 'old';
  const shaOf = (tag: string) => (tag === 'old' || tag === 'sha-aaaaaaa' ? OLD : NEW);
  const info = (sha: string): ImageInfo => ({ repoDigests: [], gitSha: sha, version: '1.0.0' });
  const ops: Ops = {
    images: async (tag, services) => { calls.push(`images ${tag} ${services.join(',')}`); return Object.fromEntries(services.map((s) => [s, `ghcr.io/letsmanu/friendflix-${s === 'bootstrap' ? 'backend' : s}:${tag}`])); },
    pull: async (tag) => { calls.push(`pull ${tag}`); if (o.pullFails) throw new StepError('pull_failed'); },
    verify: async (img) => { calls.push(`verify ${img}`); return img !== o.verifyFails; },
    up: async (tag, services) => { calls.push(`up ${tag} ${services.join(',')}`); if (o.upFails === tag) throw new StepError('restart_failed'); runningTag = tag; },
    imageInfo: async (ref) => info(shaOf(ref.split(':').pop()!)),
    running: async () => (o.running === null ? null : info(o.running ?? shaOf(runningTag))),
    spawnSelfUpdate: async (tag) => { calls.push(`spawn ${tag}`); if (o.spawnFails) throw new StepError('restart_failed'); },
    healthy: async (sha7) => { calls.push(`health ${sha7}`); return (o.healthyTags ?? ['latest', 'nightly', '1.2.3', 'sha-aaaaaaa', 'sha-bbbbbbb']).includes(runningTag) && sha7 === shaOf(runningTag).slice(0, 7); },
  };
  return { ops, calls };
}
function make(w: ReturnType<typeof world>, init: Partial<State> = {}) {
  let t = 1_760_800_000_000;
  const store = memoryStore({ ...DEFAULT_STATE, ...init });
  const u = new Updater(w.ops, store, { healthTimeoutMs: 20_000, healthIntervalMs: 5_000, selfUpdateTimeoutMs: 1000, now: () => t, sleep: async (ms) => { t += ms; } });
  return { u, store };
}

describe('update job', () => {
  it('pull -> verify every image -> recreate the FriendFlix services -> health; records the previous sha tag', async () => {
    const w = world();
    const { u, store } = make(w);
    const r = u.start('update');
    expect(r.ok).toBe(true);
    expect(u.busy).toBe(true);
    await u.idle();
    expect(w.calls).toEqual([
      'images latest bootstrap,backend,gateway,web', 'pull latest',
      'verify ghcr.io/letsmanu/friendflix-backend:latest', 'verify ghcr.io/letsmanu/friendflix-gateway:latest', 'verify ghcr.io/letsmanu/friendflix-web:latest',
      'up latest bootstrap,backend,gateway,web', 'health bbbbbbb',
    ]);
    const s = store.state;
    expect(s.lastJob).toMatchObject({ action: 'update', state: 'succeeded', from: 'sha-aaaaaaa', to: 'latest', error: null, step: null,
      steps: { pull: 'ok', verify: 'ok', restart: 'ok', health: 'ok', rollback: 'skipped' } });
    expect(s.current).toBe('latest');
    expect(s.previous).toBe('sha-aaaaaaa');
    expect(u.busy).toBe(false);
    expect(u.log.tail().some((l) => l.endsWith('update succeeded'))).toBe(true);
  });

  it('a cosign failure aborts before anything is restarted', async () => {
    const w = world({ verifyFails: 'ghcr.io/letsmanu/friendflix-gateway:latest' });
    const { u, store } = make(w);
    u.start('update');
    await u.idle();
    expect(w.calls.some((c) => c.startsWith('up '))).toBe(false);
    expect(store.state.lastJob).toMatchObject({ state: 'failed', error: 'verify_failed', step: 'verify', steps: { pull: 'ok', verify: 'failed', restart: 'skipped', health: 'skipped' } });
    expect(store.state.previous).toBeNull();
  });

  it('a pull failure aborts too', async () => {
    const w = world({ pullFails: true });
    const { u, store } = make(w);
    u.start('update');
    await u.idle();
    expect(w.calls.some((c) => c.startsWith('up ') || c.startsWith('verify'))).toBe(false);
    expect(store.state.lastJob).toMatchObject({ state: 'failed', error: 'pull_failed', steps: { pull: 'failed', verify: 'skipped' } });
  });

  it('the new build never gets healthy: automatic rollback to the previous sha tag (verified too), job marked rolled_back', async () => {
    const w = world({ healthyTags: ['sha-aaaaaaa'] });
    const { u, store } = make(w);
    u.start('update');
    await u.idle();
    const after = w.calls.slice(w.calls.indexOf('up latest bootstrap,backend,gateway,web') + 1);
    expect(after.filter((c) => c === 'health bbbbbbb').length).toBe(5); // 20 s / 5 s + the first round
    expect(after.slice(5)).toEqual([
      'images sha-aaaaaaa bootstrap,backend,gateway,web', 'pull sha-aaaaaaa',
      'verify ghcr.io/letsmanu/friendflix-backend:sha-aaaaaaa', 'verify ghcr.io/letsmanu/friendflix-gateway:sha-aaaaaaa', 'verify ghcr.io/letsmanu/friendflix-web:sha-aaaaaaa',
      'up sha-aaaaaaa bootstrap,backend,gateway,web', 'health aaaaaaa',
    ]);
    expect(store.state.lastJob).toMatchObject({ state: 'rolled_back', error: 'unhealthy', steps: { restart: 'ok', health: 'failed', rollback: 'ok' } });
    expect(store.state.current).toBe('sha-aaaaaaa');
  });

  it('a failed restart rolls back as well; a failed rollback is reported as such', async () => {
    const w1 = world({ upFails: 'latest' });
    const a = make(w1);
    a.u.start('update');
    await a.u.idle();
    expect(a.store.state.lastJob).toMatchObject({ state: 'rolled_back', error: 'restart_failed', steps: { restart: 'failed', health: 'skipped', rollback: 'ok' } });

    const w2 = world({ healthyTags: [] });
    const b = make(w2);
    b.u.start('update');
    await b.u.idle();
    expect(b.store.state.lastJob).toMatchObject({ state: 'failed', error: 'rollback_failed', steps: { rollback: 'failed' } });
  });

  it('without a known previous build (dev image, nothing running) an unhealthy update just fails', async () => {
    const w = world({ healthyTags: [], running: null });
    const { u, store } = make(w);
    u.start('update');
    await u.idle();
    expect(store.state.lastJob).toMatchObject({ state: 'failed', error: 'unhealthy', from: null });
    expect(w.calls.some((c) => c.includes('sha-'))).toBe(false);
  });

  it('one job at a time', async () => {
    const { u } = make(world());
    expect(u.start('update').ok).toBe(true);
    expect(u.start('update')).toEqual({ ok: false, error: 'busy' });
    expect(u.start('rollback')).toEqual({ ok: false, error: 'busy' });
    await u.idle();
    expect(u.start('update').ok).toBe(true);
    await u.idle();
  });

  it('the channel decides the tag; pinned needs a version', async () => {
    const w = world();
    const { u, store } = make(w);
    u.setChannel('nightly', null);
    u.start('update');
    await u.idle();
    expect(w.calls[0]).toBe('images nightly bootstrap,backend,gateway,web');
    u.setChannel('pinned', '1.2.3');
    expect(store.state).toMatchObject({ channel: 'pinned', version: '1.2.3' });
    u.start('update');
    await u.idle();
    expect(w.calls).toContain('pull 1.2.3');
    u.setChannel('stable', '9.9.9');
    expect(store.state.version).toBeNull();
    expect(make(world(), { channel: 'pinned', version: null }).u.start('update')).toEqual({ ok: false, error: 'no_target' });
  });

  it('rollback goes to the recorded previous sha tag only, and records the build it left', async () => {
    expect(make(world()).u.start('rollback')).toEqual({ ok: false, error: 'no_previous' });
    expect(make(world(), { previous: 'latest' as never }).u.start('rollback')).toEqual({ ok: false, error: 'no_previous' });
    const w = world({ running: NEW });
    const { u, store } = make(w, { previous: 'sha-aaaaaaa', current: 'latest' });
    u.start('rollback');
    await u.idle();
    expect(w.calls).toContain('up sha-aaaaaaa bootstrap,backend,gateway,web');
    expect(store.state.lastJob).toMatchObject({ action: 'rollback', state: 'succeeded', from: 'sha-bbbbbbb', to: 'sha-aaaaaaa' });
    expect(store.state.current).toBe('sha-aaaaaaa');
    expect(store.state.previous).toBe('sha-bbbbbbb');
  });

  it('an unhealthy rollback does not roll back again', async () => {
    const w = world({ running: NEW, healthyTags: [] });
    const { u, store } = make(w, { previous: 'sha-aaaaaaa' });
    u.start('rollback');
    await u.idle();
    expect(store.state.lastJob).toMatchObject({ state: 'failed', error: 'unhealthy', steps: { rollback: 'skipped' } });
    expect(w.calls.filter((c) => c.startsWith('up ')).length).toBe(1);
  });

  it('self-update: pull + verify the updater image, spawn the helper; the new process finishes the job', async () => {
    const w = world();
    const { u, store } = make(w);
    u.start('self-update');
    await u.idle();
    expect(w.calls.slice(0, 4)).toEqual(['images latest updater', 'pull latest', 'verify ghcr.io/letsmanu/friendflix-updater:latest', 'spawn latest']);
    // still alive after the timeout: the helper did not replace us
    expect(store.state.lastJob).toMatchObject({ action: 'self-update', state: 'failed', error: 'self_update_timeout' });

    // the helper recreated the container: the new process finds the job at its restart step
    const s2 = memoryStore({ ...DEFAULT_STATE, lastJob: { ...store.state.lastJob!, state: 'running', step: 'restart', error: null, finishedAt: null } });
    const u2 = new Updater(w.ops, s2, { log: new JobLog() });
    expect(u2.snapshot().lastJob).toMatchObject({ state: 'succeeded', steps: { restart: 'ok' } });
  });

  it('self-update with a failing verify or helper never spawns / reports the failure', async () => {
    const w = world({ verifyFails: 'ghcr.io/letsmanu/friendflix-updater:latest' });
    const a = make(w);
    a.u.start('self-update');
    await a.u.idle();
    expect(w.calls.some((c) => c.startsWith('spawn'))).toBe(false);
    expect(a.store.state.lastJob).toMatchObject({ state: 'failed', error: 'verify_failed' });
    const b = make(world({ spawnFails: true }));
    b.u.start('self-update');
    await b.u.idle();
    expect(b.store.state.lastJob).toMatchObject({ state: 'failed', error: 'restart_failed' });
  });

  it('a job interrupted by a restart is marked failed', () => {
    const job = { id: '0123456789abcdef', action: 'update' as const, state: 'running' as const, step: 'health' as const, from: null, to: 'latest', startedAt: new Date().toISOString(), finishedAt: null, error: null,
      steps: { pull: 'ok' as const, verify: 'ok' as const, restart: 'ok' as const, health: 'running' as const, rollback: 'skipped' as const } };
    const s = memoryStore({ ...DEFAULT_STATE, lastJob: job });
    new Updater(world().ops, s);
    expect(s.state.lastJob).toMatchObject({ state: 'failed', error: 'interrupted', steps: { health: 'failed' } });
  });

  it('a state file that cannot be written does not stop the job', async () => {
    const w = world();
    const u = new Updater(w.ops, { load: () => ({ ...DEFAULT_STATE }), save: () => { throw new Error('read-only'); } }, { sleep: async () => {} });
    u.start('update');
    await u.idle();
    expect(u.snapshot().lastJob?.state).toBe('succeeded');
    expect(u.log.tail().some((l) => l.includes('state file could not be written'))).toBe(true);
  });

  it('the log keeps the last lines only', () => {
    const l = new JobLog(3, () => 0);
    for (const m of ['a', 'b', 'c', 'd']) l.add(m);
    expect(l.tail()).toEqual(['1970-01-01T00:00:00.000Z b', '1970-01-01T00:00:00.000Z c', '1970-01-01T00:00:00.000Z d']);
  });
});
