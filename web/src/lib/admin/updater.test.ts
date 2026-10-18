// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { hasKey, setLocale, tr } from '#lib/i18n';
import { ApiError } from '#lib/api';
import { TIME_RE, canRollback, failReason, isRunning, nextPoll, startError, statusOf, visibleSteps, type UpdaterJob, type UpdaterStatus } from './updater';

const job = (over: Partial<UpdaterJob> = {}): UpdaterJob => ({
  id: '0123456789abcdef', action: 'update', state: 'running', step: 'pull', from: 'sha-aaaaaaa', to: 'latest', startedAt: '2026-10-18T04:00:00.000Z', finishedAt: null, error: null,
  steps: { pull: 'running', verify: 'pending', restart: 'pending', health: 'pending', rollback: 'skipped' }, ...over,
});
const status = (over: Partial<UpdaterStatus> = {}): UpdaterStatus => ({
  updater: { version: '1.1.0', sha: null }, channel: 'stable', version: null, targetTag: 'latest', current: 'latest', previous: 'sha-aaaaaaa', busy: false, job: null, log: [], services: [], ...over,
});

afterEach(async () => { await setLocale('de'); });

describe('updater panel logic', () => {
  it('steps: the four, rollback once it ran, no health step for a self-update', () => {
    expect(visibleSteps(job())).toEqual(['pull', 'verify', 'restart', 'health']);
    expect(visibleSteps(job({ steps: { pull: 'ok', verify: 'ok', restart: 'ok', health: 'failed', rollback: 'running' } }))).toEqual(['pull', 'verify', 'restart', 'health', 'rollback']);
    expect(visibleSteps(job({ action: 'self-update' }))).toEqual(['pull', 'verify', 'restart']);
  });

  it('status, running and rollback availability', () => {
    expect(statusOf(null)).toBeNull();
    expect(statusOf({ present: false })).toBeNull();
    expect(statusOf({ present: true, error: 'unauthorized' })).toBeNull();
    expect(statusOf({ present: true, status: status() })?.current).toBe('latest');
    expect(isRunning(job())).toBe(true);
    expect(isRunning(job({ state: 'failed' }))).toBe(false);
    expect(isRunning(null)).toBe(false);
    expect(canRollback(status())).toBe(true);
    expect(canRollback(status({ previous: null }))).toBe(false);
    expect(canRollback(status({ busy: true }))).toBe(false);
    expect(canRollback(status({ job: job() }))).toBe(false);
    expect(canRollback(null)).toBe(false);
    expect(nextPoll(false)).toBe(2000);
    expect(nextPoll(true)).toBe(3000);
    for (const ok of ['00:00', '04:00', '23:59']) expect(TIME_RE.test(ok)).toBe(true);
    for (const bad of ['4:00', '24:00', '12:60', '']) expect(TIME_RE.test(bad)).toBe(false);
  });

  it('error texts: known codes, rate limit, unknown codes never shown raw', async () => {
    await setLocale('en');
    expect(failReason('verify_failed')).toBe(tr('admin.update.updater.failReason.verify_failed'));
    expect(failReason('<b>x</b>')).toBe(tr('admin.update.updater.failReason.unknown'));
    expect(failReason(null)).toBe(tr('admin.update.updater.failReason.unknown'));
    expect(startError(new ApiError(429, {}))).toBe(tr('admin.update.updater.error.tooSoon'));
    expect(startError(new ApiError(409, { error: 'busy' }))).toBe(tr('admin.update.updater.error.busy'));
    expect(startError(new ApiError(409, { error: 'whatever' }))).toBe(tr('admin.update.updater.error.generic'));
    expect(startError(null)).toBe(tr('admin.update.updater.error.generic'));
  });

  it('every updater string exists in all seven languages', async () => {
    const keys = ['title', 'intro', 'installed', 'previous', 'target', 'none', 'updateNow', 'rollback', 'selfUpdate', 'selfHint', 'advanced', 'confirm.update', 'confirm.rollback',
      'confirm.self-update', 'confirmGo', 'cancel', 'step.pull', 'step.verify', 'step.restart', 'step.health', 'step.rollback', 'state.pending', 'state.running', 'state.ok',
      'state.failed', 'state.skipped', 'running', 'reconnecting', 'watchTimeout', 'lastJob', 'result.succeeded', 'result.rolled_back', 'result.failed', 'error.busy', 'error.no_previous',
      'error.no_target', 'error.not_available', 'error.channel_sync_failed', 'error.tooSoon', 'error.generic', 'failReason.verify_failed', 'failReason.pull_failed',
      'failReason.unhealthy', 'failReason.restart_failed', 'failReason.rollback_failed', 'failReason.interrupted', 'failReason.self_update_timeout', 'failReason.unexpected_image',
      'failReason.compose_config', 'failReason.unknown', 'unauthorized', 'invalid', 'log', 'reauthBack', 'auto.title', 'auto.label', 'auto.off', 'auto.window', 'auto.time',
      'auto.save', 'auto.saved', 'auto.locked', 'auto.hint', 'auto.timeInvalid'];
    for (const l of ['de', 'en', 'es', 'fr', 'it', 'pl', 'tr']) {
      await setLocale(l);
      for (const k of keys) expect(hasKey(`admin.update.updater.${k}`), `${l} ${k}`).toBe(true);
    }
  });
});
