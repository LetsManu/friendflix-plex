// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Update with the opt-in updater container (backend/src/updater.ts, GET/POST /api/admin/updater): the job steps
 * (pull → verify → restart → health, rollback when it ran), the result of the last job, and the polling while a job runs
 * (the backend restarts in the middle: failed polls mean "reconnecting", not an error).
 */
import { hasKey, trDynamic } from '#lib/i18n';

export type StepName = 'pull' | 'verify' | 'restart' | 'health' | 'rollback';
export type StepState = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
export type UpdaterAction = 'update' | 'rollback' | 'self-update';
export interface UpdaterJob {
  id: string; action: UpdaterAction; state: 'running' | 'succeeded' | 'failed' | 'rolled_back'; step: StepName | null;
  steps: Record<StepName, StepState>; from: string | null; to: string; startedAt: string; finishedAt: string | null; error: string | null;
}
export interface UpdaterStatus {
  updater: { version: string | null; sha: string | null };
  channel: 'stable' | 'nightly' | 'pinned'; version: string | null; targetTag: string | null;
  current: string | null; previous: string | null; busy: boolean; job: UpdaterJob | null; log: string[];
  services: Array<{ service: string; state: string; health: string; sha: string | null; version: string | null }>;
}
export interface AutoUpdate { mode: 'off' | 'nightly-window'; time: string; locked: string[] }
export type UpdaterView = { autoUpdate?: AutoUpdate } & ({ present: false } | { present: true; error: 'unauthorized' | 'invalid_answer' } | { present: true; status: UpdaterStatus });

/** HH:MM like the backend (config.ts AUTO_UPDATE_TIME) */
export const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const MAIN_STEPS: readonly StepName[] = ['pull', 'verify', 'restart', 'health'];

export const statusOf = (v: UpdaterView | null): UpdaterStatus | null => (v && v.present && 'status' in v ? v.status : null);
export const isRunning = (j: UpdaterJob | null | undefined): boolean => j?.state === 'running';

/** the four steps, plus the rollback once it ran (self-update: no health step) */
export function visibleSteps(j: UpdaterJob): StepName[] {
  const base = MAIN_STEPS.filter((s) => !(j.action === 'self-update' && s === 'health'));
  return j.steps.rollback !== 'skipped' && j.steps.rollback !== 'pending' ? [...base, 'rollback'] : base;
}

/** a readable reason for a job's error code (unknown codes: "unknown error"; the code itself is never shown raw) */
export function failReason(code: string | null): string {
  const k = code && /^[a-z_]+$/.test(code) && hasKey(`admin.update.updater.failReason.${code}`) ? code : 'unknown';
  return trDynamic(`admin.update.updater.failReason.${k}`);
}

/** the error toast of a refused start (backend codes from routes/updater.ts) */
export function startError(e: unknown): string {
  const status = (e as { status?: number } | null)?.status;
  const code = (e as { body?: { error?: unknown } } | null)?.body?.error;
  if (status === 429) return trDynamic('admin.update.updater.error.tooSoon');
  if (typeof code === 'string' && /^[a-z_]+$/.test(code) && hasKey(`admin.update.updater.error.${code}`)) return trDynamic(`admin.update.updater.error.${code}`);
  return trDynamic('admin.update.updater.error.generic');
}

/** poll every 2 s while a job runs, every 3 s while the backend is away; give up after 15 minutes */
export const POLL_MS = 2_000;
export const RECONNECT_MS = 3_000;
export const WATCH_MAX_MS = 15 * 60_000;
export const nextPoll = (reconnecting: boolean): number => (reconnecting ? RECONNECT_MS : POLL_MS);

/** rollback is offered once the updater recorded a previous build and no job runs */
export const canRollback = (s: UpdaterStatus | null): boolean => Boolean(s?.previous && !s.busy && !isRunning(s.job));
