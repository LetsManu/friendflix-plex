// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { audit } from './audit.js';
import type { Ctx } from './ctx.js';

/**
 * Client of the opt-in updater container (updater/, compose profile `updater`; docs/security.md "Updater"). The backend never
 * gets the Docker socket: it can only ask the updater for five fixed actions, each request HMAC-signed with a key derived from
 * INTERNAL_SECRET (timestamp + nonce; the updater refuses replays and anything outside 60 s). Signing must match
 * updater/src/protocol.ts byte for byte (test-vectors/updater-hmac.json).
 */
const KEY_LABEL = 'friendflix-updater/v1';
export type UpdaterAction = 'update' | 'rollback' | 'self-update';
export const UPDATER_ACTIONS: readonly UpdaterAction[] = ['update', 'rollback', 'self-update'];
const STEP_NAMES = ['pull', 'verify', 'restart', 'health', 'rollback'] as const;
const STEP_STATES = ['pending', 'running', 'ok', 'failed', 'skipped'] as const;
const JOB_STATES = ['running', 'succeeded', 'failed', 'rolled_back'] as const;
const TAG_RE = /^(latest|nightly|[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}|sha-[0-9a-f]{7})$/;

export function updaterKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(KEY_LABEL).digest();
}

export function signUpdater(key: Buffer, method: string, path: string, body = '', ts = String(Date.now()), nonce = randomBytes(16).toString('hex')): Record<string, string> {
  const canonical = [method.toUpperCase(), path, ts, nonce, createHash('sha256').update(body).digest('hex')].join('\n');
  return { 'x-ff-updater-ts': ts, 'x-ff-updater-nonce': nonce, 'x-ff-updater-signature': `v1=${createHmac('sha256', key).update(canonical).digest('hex')}` };
}

export interface UpdaterJob {
  id: string; action: UpdaterAction; state: (typeof JOB_STATES)[number]; step: (typeof STEP_NAMES)[number] | null;
  steps: Record<(typeof STEP_NAMES)[number], (typeof STEP_STATES)[number]>; from: string | null; to: string;
  startedAt: string; finishedAt: string | null; error: string | null;
}
export interface UpdaterStatus {
  updater: { version: string | null; sha: string | null };
  channel: 'stable' | 'nightly' | 'pinned'; version: string | null; targetTag: string | null;
  current: string | null; previous: string | null; busy: boolean; job: UpdaterJob | null; log: string[];
  services: Array<{ service: string; state: string; health: string; sha: string | null; version: string | null }>;
}
export type UpdaterView = { present: false } | { present: true; error: 'unauthorized' | 'invalid_answer' } | { present: true; status: UpdaterStatus };

const pick = <T extends string>(v: unknown, list: readonly T[]): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null);
const tagOrNull = (v: unknown): string | null => (typeof v === 'string' && TAG_RE.test(v) ? v : null);
const short = (v: unknown, re: RegExp): string | null => (typeof v === 'string' && re.test(v) ? v : null);
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

function parseJob(raw: unknown): UpdaterJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const j = raw as Record<string, unknown>;
  const action = pick(j.action, UPDATER_ACTIONS), state = pick(j.state, JOB_STATES), to = tagOrNull(j.to);
  if (typeof j.id !== 'string' || !/^[0-9a-f]{16}$/.test(j.id) || !action || !state || !to) return null;
  const steps = Object.fromEntries(STEP_NAMES.map((s) => [s, pick((j.steps as Record<string, unknown> | undefined)?.[s], STEP_STATES) ?? 'pending'])) as UpdaterJob['steps'];
  return {
    id: j.id, action, state, step: pick(j.step, STEP_NAMES), steps, from: tagOrNull(j.from), to,
    startedAt: short(j.startedAt, ISO) ?? '', finishedAt: short(j.finishedAt, ISO), error: short(j.error, /^[a-z_]{1,40}$/),
  };
}

/** Only known fields with checked values reach the browser (the updater is a separate container: its answer is input too). */
export function parseStatus(raw: unknown): UpdaterStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const channel = pick(o.channel, ['stable', 'nightly', 'pinned'] as const);
  if (!channel) return null;
  const u = (o.updater ?? {}) as Record<string, unknown>;
  return {
    updater: { version: short(u.version, /^\d+\.\d+\.\d+$/), sha: short(u.sha, /^[0-9a-f]{40}$/) },
    channel, version: short(o.version, /^\d+\.\d+\.\d+$/), targetTag: tagOrNull(o.targetTag),
    current: tagOrNull(o.current), previous: tagOrNull(o.previous), busy: o.busy === true, job: parseJob(o.job),
    log: Array.isArray(o.log) ? o.log.filter((l): l is string => typeof l === 'string').slice(-30).map((l) => l.slice(0, 300)) : [],
    services: Array.isArray(o.services) ? o.services.slice(0, 10).flatMap((s) => {
      const x = (s ?? {}) as Record<string, unknown>;
      const service = short(x.service, /^[a-z-]{1,20}$/);
      return service ? [{ service, state: short(x.state, /^[a-z]{1,20}$/) ?? 'unknown', health: short(x.health, /^[a-z]{0,20}$/) ?? '', sha: tagOrNull(x.sha), version: short(x.version, /^\d+\.\d+\.\d+$/) }] : [];
    }) : [],
  };
}

type Answer = { status: number; json: unknown } | null;

/** one signed request; null = the updater is not there (profile off, DNS, refused, timeout) */
async function call(ctx: Ctx, method: 'GET' | 'POST', path: string, body = ''): Promise<Answer> {
  const base = ctx.cfg.UPDATER_URL;
  if (!base) return null;
  const headers: Record<string, string> = signUpdater(updaterKey(ctx.cfg.INTERNAL_SECRET), method, path, body);
  if (body) headers['content-type'] = 'application/json';
  try {
    const r = await ctx.fetchImpl(`${base}${path}`, { method, headers, body: method === 'POST' ? body : undefined, signal: AbortSignal.timeout(5_000), redirect: 'error' });
    return { status: r.status, json: await r.json().catch(() => null) };
  } catch {
    return null;
  }
}

/** an absent updater is remembered briefly (each Admin -> Update load would otherwise wait for a DNS failure) */
const absentUntil = new WeakMap<object, number>();
const ABSENT_MS = 30_000;

export async function updaterView(ctx: Ctx): Promise<UpdaterView> {
  if (!ctx.cfg.UPDATER_URL) return { present: false };
  if ((absentUntil.get(ctx) ?? 0) > Date.now()) return { present: false };
  const r = await call(ctx, 'GET', '/v1/status');
  if (!r) { absentUntil.set(ctx, Date.now() + ABSENT_MS); return { present: false }; }
  absentUntil.delete(ctx);
  if (r.status === 401) return { present: true, error: 'unauthorized' };
  const status = r.status === 200 ? parseStatus(r.json) : null;
  if (!status) return { present: true, error: 'invalid_answer' };
  await reconcileAudit(ctx, status).catch(() => undefined);
  return { present: true, status };
}

/** sends the channel setting to the updater (pinned without a version is not sent: the updater would have nothing to install) */
export async function syncChannel(ctx: Ctx): Promise<boolean> {
  const channel = ctx.cfg.UPDATE_CHANNEL;
  if (channel === 'pinned' && !ctx.cfg.UPDATE_VERSION) return false;
  const body = JSON.stringify(channel === 'pinned' ? { channel, version: ctx.cfg.UPDATE_VERSION } : { channel });
  const r = await call(ctx, 'POST', '/v1/channel', body);
  return r?.status === 200;
}

export type StartResult = { ok: true; job: UpdaterJob } | { ok: false; status: number; error: string };
const PENDING = 'updater:pending:';

/**
 * Starts a job and audits it (who, from -> to); the result is audited once the job is finished (reconcileAudit, from the next
 * status read: the job usually restarts this very backend). `actor` null = the automatic update.
 */
export async function startJob(ctx: Ctx, action: UpdaterAction, actor: string | null): Promise<StartResult> {
  if (action !== 'rollback' && !(await syncChannel(ctx))) {
    // an updater that is there but refuses the channel would install the wrong tag: stop here
    const v = await updaterView(ctx);
    if (!v.present) return { ok: false, status: 409, error: 'not_available' };
    if ('status' in v && v.status.busy) return { ok: false, status: 409, error: 'busy' };
    if (ctx.cfg.UPDATE_CHANNEL === 'pinned' && !ctx.cfg.UPDATE_VERSION) return { ok: false, status: 409, error: 'no_target' };
    return { ok: false, status: 502, error: 'channel_sync_failed' };
  }
  const r = await call(ctx, 'POST', `/v1/${action}`);
  if (!r) return { ok: false, status: 409, error: 'not_available' };
  const job = r.status === 202 ? parseJob((r.json as { job?: unknown } | null)?.job) : null;
  if (!job) {
    const err = short((r.json as { error?: unknown } | null)?.error, /^[a-z_]{1,40}$/) ?? 'updater_error';
    return { ok: false, status: r.status === 409 || r.status === 400 ? 409 : 502, error: err };
  }
  const meta = { action, from: job.from, to: job.to, ...(actor ? {} : { auto: true }) };
  await ctx.kv.set(`${PENDING}${job.id}`, JSON.stringify({ actor, ...meta }), 7 * 86_400).catch(() => undefined);
  await audit(ctx, actor, 'system.updater_start', undefined, meta);
  return { ok: true, job };
}

/** the result audit of a finished job, exactly once (the pending entry is taken atomically) */
export async function reconcileAudit(ctx: Ctx, s: UpdaterStatus): Promise<void> {
  const j = s.job;
  if (!j || j.state === 'running') return;
  const raw = await ctx.kv.take(`${PENDING}${j.id}`);
  if (!raw) return;
  const p = JSON.parse(raw) as { actor: string | null; action: UpdaterAction; auto?: true };
  await audit(ctx, p.actor, 'system.updater_result', undefined, { action: j.action, from: j.from, to: j.to, result: j.state, error: j.error, ...(p.auto ? { auto: true } : {}) });
}

/** HH:MM of `now` in the server's time zone (TZ) */
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const WINDOW_MIN = 30;

/**
 * AUTO_UPDATE=nightly-window: once a day in the 30 minutes from AUTO_UPDATE_TIME, the same update job as the button (actor
 * null). One start per day across all backend instances (kv lock). Also finishes the result audit of earlier jobs.
 */
export async function autoUpdateTick(ctx: Ctx, now = new Date()): Promise<'off' | 'outside' | 'done' | 'absent' | 'busy' | 'started' | 'failed'> {
  if ((await ctx.kv.keys(PENDING).catch(() => [])).length) await updaterView(ctx).catch(() => undefined);
  if (ctx.cfg.AUTO_UPDATE !== 'nightly-window' || !ctx.cfg.UPDATER_URL) return 'off';
  const diff = (minutes(hhmm(now)) - minutes(ctx.cfg.AUTO_UPDATE_TIME) + 1440) % 1440;
  if (diff >= WINDOW_MIN) return 'outside';
  const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  if (await ctx.kv.get(`updater:auto:${day}`)) return 'done';
  const v = await updaterView(ctx);
  if (!v.present || !('status' in v)) return 'absent';
  if (v.status.busy) return 'busy';
  if (!(await ctx.kv.setnx(`updater:auto:${day}`, '1', 2 * 86_400))) return 'done';
  const r = await startJob(ctx, 'update', null);
  return r.ok ? 'started' : 'failed';
}
