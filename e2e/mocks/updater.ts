// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SettingsMock } from './settings.js';

/**
 * A fake opt-in updater behind GET/POST /api/admin/updater (backend/src/routes/updater.ts). Not installed by default
 * (`present: false`, Admin → Update keeps the manual steps). A started job advances one step per poll: pull → verify → restart,
 * then `downPolls` polls answered 502 (the backend restarting), then health → done, or (outcome rolled_back) health failed →
 * rollback → rolled back.
 */
export interface UpdaterMock {
  present: boolean | 'unauthorized';
  current: string | null;
  previous: string | null;
  job: any;
  log: string[];
  /** POSTed actions */
  posts: string[];
  /** POST answers 401 reauth_required */
  reauthRequired: boolean;
  outcome: 'succeeded' | 'rolled_back';
  downPolls: number;
  tick: number;
}
type Reply = (b: unknown, status?: number) => Promise<void>;

export function updaterState(present: UpdaterMock['present'] = false): UpdaterMock {
  return { present, current: 'latest', previous: 'sha-a1b2c3d', job: null, log: ['2026-10-17T04:00:00.000Z update succeeded'], posts: [], reauthRequired: false, outcome: 'succeeded', downPolls: 2, tick: 0 };
}

const value = (s: SettingsMock, key: string) => s.groups.flatMap((g) => g.items).find((i) => i.key === key);

function advance(u: UpdaterMock): boolean {
  const j = u.job;
  if (!j || j.state !== 'running') return true;
  const n = u.tick++;
  const set = (step: string, steps: Record<string, string>) => { j.step = step; Object.assign(j.steps, steps); };
  if (n === 0) set('verify', { pull: 'ok', verify: 'running' });
  else if (n === 1) set('restart', { verify: 'ok', restart: 'running' });
  else if (n < 2 + u.downPolls) return false; // the backend is restarting
  else if (n === 2 + u.downPolls) set('health', { restart: 'ok', health: 'running' });
  else if (u.outcome === 'rolled_back' && j.steps.rollback !== 'running') set('rollback', { health: 'failed', rollback: 'running' });
  else {
    const rolled = u.outcome === 'rolled_back';
    Object.assign(j.steps, rolled ? { rollback: 'ok' } : { health: 'ok' });
    j.state = rolled ? 'rolled_back' : 'succeeded';
    j.error = rolled ? 'unhealthy' : null;
    j.step = rolled ? 'rollback' : null;
    j.finishedAt = new Date().toISOString();
    if (!rolled) { u.previous = j.from; u.current = j.to; }
    u.log.push(`${j.finishedAt} ${j.action} ${j.state}`);
  }
  return true;
}

export function updaterRoute(u: UpdaterMock | null, settings: SettingsMock, m: string, p: string, J: Reply): Promise<void> | null {
  const auto = { mode: value(settings, 'AUTO_UPDATE')?.value ?? 'off', time: value(settings, 'AUTO_UPDATE_TIME')?.value ?? '04:00', locked: [] as string[] };
  const ch = value(settings, 'UPDATE_CHANNEL')?.value ?? 'stable';
  const ver = value(settings, 'UPDATE_VERSION')?.value ?? null;
  const target = ch === 'nightly' ? 'nightly' : ch === 'pinned' ? ver : 'latest';
  if (p === '/api/admin/updater' && m === 'GET') {
    if (!u || !u.present) return J({ present: false, autoUpdate: auto });
    if (u.present === 'unauthorized') return J({ present: true, error: 'unauthorized', autoUpdate: auto });
    if (!advance(u)) return J({ error: 'bad_gateway' }, 502);
    const busy = u.job?.state === 'running';
    return J({ present: true, autoUpdate: auto, status: {
      updater: { version: '1.1.0', sha: null }, channel: ch, version: ch === 'pinned' ? ver : null, targetTag: target, current: u.current, previous: u.previous, busy,
      job: u.job, log: u.log.slice(-30), services: [{ service: 'backend', state: 'running', health: 'healthy', sha: 'sha-c0be6c5', version: '1.0.0' }],
    } });
  }
  const mm = p.match(/^\/api\/admin\/updater\/(update|rollback|self-update)$/);
  if (mm && m === 'POST') {
    if (!u || !u.present) return J({ error: 'not_available' }, 409);
    if (u.reauthRequired) return J({ error: 'reauth_required' }, 401);
    u.posts.push(mm[1]!);
    if (u.job?.state === 'running') return J({ error: 'busy' }, 409);
    if (mm[1] === 'rollback' && !u.previous) return J({ error: 'no_previous' }, 409);
    const to = mm[1] === 'rollback' ? u.previous : target;
    u.tick = 0;
    u.job = { id: '0123456789abcdef', action: mm[1], state: 'running', step: 'pull', from: 'sha-c0be6c5', to, startedAt: new Date().toISOString(), finishedAt: null, error: null,
      steps: { pull: 'running', verify: 'pending', restart: 'pending', health: mm[1] === 'self-update' ? 'skipped' : 'pending', rollback: 'skipped' } };
    return J({ job: u.job }, 202);
  }
  return null;
}
