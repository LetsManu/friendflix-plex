// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHANNELS, SHA_TAG_RE, VERSION_RE, isTag, type Channel } from './policy.js';

export type StepName = 'pull' | 'verify' | 'restart' | 'health' | 'rollback';
export type StepState = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
export type JobAction = 'update' | 'rollback' | 'self-update';
export type JobState = 'running' | 'succeeded' | 'failed' | 'rolled_back';

export interface Job {
  id: string;
  action: JobAction;
  state: JobState;
  /** where the job is (or stopped) */
  step: StepName | null;
  steps: Record<StepName, StepState>;
  /** tags: what ran before (sha-<7> when known) and the target */
  from: string | null;
  to: string;
  startedAt: string;
  finishedAt: string | null;
  /** a fixed error code (never command output) */
  error: string | null;
}

/** What survives a restart (state volume): the channel, what is installed and the previous build to roll back to. */
export interface State {
  channel: Channel;
  version: string | null;
  /** the tag the FriendFlix services were last brought up with by the updater */
  current: string | null;
  /** sha-<7> of the build that ran before the last successful update (the rollback target) */
  previous: string | null;
  lastJob: Job | null;
}

export const DEFAULT_STATE: State = { channel: 'stable', version: null, current: null, previous: null, lastJob: null };

/** A malformed or tampered file falls back field by field to the defaults: nothing from it reaches compose unchecked. */
export function sanitize(raw: unknown): State {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const channel = typeof o.channel === 'string' && (CHANNELS as readonly string[]).includes(o.channel) ? (o.channel as Channel) : 'stable';
  const version = typeof o.version === 'string' && VERSION_RE.test(o.version) ? o.version : null;
  return {
    channel: channel === 'pinned' && !version ? 'stable' : channel,
    version,
    current: isTag(o.current) ? o.current : null,
    previous: typeof o.previous === 'string' && SHA_TAG_RE.test(o.previous) ? o.previous : null,
    lastJob: sanitizeJob(o.lastJob),
  };
}

function sanitizeJob(raw: unknown): Job | null {
  if (!raw || typeof raw !== 'object') return null;
  const j = raw as Record<string, unknown>;
  if (typeof j.id !== 'string' || !/^[0-9a-f]{16}$/.test(j.id) || !isTag(j.to)) return null;
  if (!['update', 'rollback', 'self-update'].includes(String(j.action)) || !['running', 'succeeded', 'failed', 'rolled_back'].includes(String(j.state))) return null;
  const steps = {} as Record<StepName, StepState>;
  for (const s of ['pull', 'verify', 'restart', 'health', 'rollback'] as const) {
    const v = (j.steps as Record<string, unknown> | undefined)?.[s];
    steps[s] = (['pending', 'running', 'ok', 'failed', 'skipped'] as const).find((x) => x === v) ?? 'pending';
  }
  const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  return {
    id: j.id, action: j.action as JobAction, state: j.state as JobState,
    step: (['pull', 'verify', 'restart', 'health', 'rollback'] as const).find((x) => x === j.step) ?? null, steps,
    from: isTag(j.from) ? j.from : null, to: j.to, startedAt: iso(j.startedAt) ?? new Date(0).toISOString(), finishedAt: iso(j.finishedAt),
    error: typeof j.error === 'string' && /^[a-z_]{1,40}$/.test(j.error) ? j.error : null,
  };
}

export interface StateStore { load(): State; save(s: State): void }

/** JSON file in the state volume, replaced atomically (write + rename). */
export function fileStore(dir: string): StateStore {
  const file = join(dir, 'state.json');
  return {
    load() {
      try { return sanitize(JSON.parse(readFileSync(file, 'utf8'))); } catch { return { ...DEFAULT_STATE }; }
    },
    save(s) {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
    },
  };
}

export function memoryStore(init: State = DEFAULT_STATE): StateStore & { state: State } {
  const m = { state: structuredClone(init), load: () => structuredClone(m.state), save: (s: State) => { m.state = structuredClone(s); } };
  return m;
}
