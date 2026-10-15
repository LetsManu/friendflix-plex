// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { stat as fsStat, statfs as fsStatfs } from 'node:fs/promises';
import type { Ctx } from './ctx.js';
import { recentCount } from './errorlog.js';
import { pruneTimings } from './playtiming.js';
import { OMDB_DAILY_BUDGET, PAUSE_KEY, SOURCES, sourceStatus, type SourceName } from './sources/keys.js';

/**
 * Block 22: health snapshot for the admin (traffic lights per dependency, disk usage, error levels) and the issues the warning
 * banner shows (Block 23: also open approval requests). Built by healthTick every 60 s (BACKGROUND_JOBS) and served from kv
 * `health:snap`; a request never waits for a slow probe except the explicit ?refresh=1 (every probe is bounded at 3 s).
 * Nothing in a snapshot carries a URL, path, key, token or exception text: reasons are codes the web translates.
 */
export type Level = 'ok' | 'warn' | 'err' | 'off';
export type ServiceId = 'media' | 'postgres' | 'redis' | 'gateway' | 'oidc' | 'requests' | 'tmdb' | 'omdb' | 'playbackCheck';
export type Reason = 'slow' | 'down' | 'issuer_mismatch' | 'invalid_key' | 'paused' | 'budget' | 'not_set' | 'failed_titles' | 'unavailable' | 'full' | 'low_free' | 'cap' | 'large' | 'server_errors' | 'client_errors' | 'failed_playbacks' | 'empty_media' | 'pending_approvals';
export interface ServiceHealth { id: ServiceId; level: Level; reason?: Reason; ms?: number; detail?: { n?: number; pct?: number } }
export interface DiskHealth {
  id: 'downloads' | 'previews' | 'database'; level: Level; reason?: Reason; totalBytes?: number; freeBytes?: number; usedPct?: number; ownBytes: number; capBytes?: number;
  /** the other FriendFlix volume lives on the same filesystem: shown as one entry, with that volume's own bytes in sharedBytes */
  sharedWith?: 'downloads' | 'previews'; sharedBytes?: number;
}
export interface ErrorHealth { level: Level; reason?: Reason; server15: number; client15: number; playback60: number }
export interface HealthIssue { id: string; level: 'warn' | 'err'; reason: Reason; fp: string; detail?: { n?: number; pct?: number } }
export interface HealthSnapshot { at: string; services: ServiceHealth[]; disks: DiskHealth[]; errors: ErrorHealth; issues: HealthIssue[]; worst: Level }

export interface DiskDeps {
  statfs: (path: string) => Promise<{ bsize: number; blocks: number; bavail: number }>;
  stat: (path: string) => Promise<{ dev: number }>;
}
export interface HealthDeps extends Partial<DiskDeps> { fetchImpl?: typeof fetch; timeoutMs?: number }

const PROBE_TIMEOUT_MS = 3000;
const SLOW_MS: Partial<Record<ServiceId, number>> = { media: 2000, postgres: 500, redis: 200, gateway: 2000, oidc: 2000 };
const SNAP_KEY = 'health:snap';
const SNAP_TTL = 300;
const STALE_MS = 90_000;
const OIDC_KEY = 'health:oidc';
const OIDC_TTL = 300;
const GiB = 1024 ** 3;
/** a playback check where every one of at least this many titles failed is red (the media server, not a file, is broken) */
const ALL_FAILED_MIN = 3;
const RANK: Record<Level, number> = { err: 3, warn: 2, ok: 1, off: 0 };

/** Stable per (issue, level, reason): numbers never change it, so 85 % → 86 % does not re-show a dismissed warning. */
export function issueFp(id: string, level: string, reason: string): string {
  return createHash('sha1').update(`${id}|${level}|${reason}`).digest('hex').slice(0, 12);
}

type Outcome<T> = { ok: true; v: T; ms: number } | { ok: false; ms: number };

/** Runs a probe with a hard time limit; a throw or a timeout is a failed probe (its message is dropped). */
async function bounded<T>(fn: () => Promise<T>, timeoutMs: number): Promise<Outcome<T>> {
  const t0 = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((res) => { timer = setTimeout(() => res('timeout'), timeoutMs); });
  try {
    const r = await Promise.race([fn(), timeout]);
    const ms = Math.round(performance.now() - t0);
    return r === 'timeout' ? { ok: false, ms } : { ok: true, v: r as T, ms };
  } catch {
    return { ok: false, ms: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

function timedService(id: ServiceId, o: Outcome<boolean>): ServiceHealth {
  if (!o.ok || !o.v) return { id, level: 'err', reason: 'down', ms: o.ms };
  const slow = SLOW_MS[id];
  return slow !== undefined && o.ms > slow ? { id, level: 'warn', reason: 'slow', ms: o.ms } : { id, level: 'ok', ms: o.ms };
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

async function oidcProbe(ctx: Ctx, fetchImpl: typeof fetch, timeoutMs: number): Promise<ServiceHealth> {
  const hit = await ctx.kv.get(OIDC_KEY).catch(() => null);
  if (hit) {
    try { return JSON.parse(hit) as ServiceHealth; } catch { /* probe again */ }
  }
  const issuer = trimSlash(ctx.cfg.OIDC_ISSUER);
  const o = await bounded(async () => {
    const res = await fetchImpl(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return 'down' as const;
    const doc = (await res.json()) as { issuer?: unknown };
    return typeof doc?.issuer === 'string' && trimSlash(doc.issuer) === issuer ? ('ok' as const) : ('issuer_mismatch' as const);
  }, timeoutMs);
  let h: ServiceHealth;
  if (!o.ok || o.v === 'down') h = { id: 'oidc', level: 'err', reason: 'down', ms: o.ms };
  else if (o.v === 'issuer_mismatch') h = { id: 'oidc', level: 'err', reason: 'issuer_mismatch', ms: o.ms };
  else h = timedService('oidc', { ok: true, v: true, ms: o.ms });
  await ctx.kv.set(OIDC_KEY, JSON.stringify(h), OIDC_TTL).catch(() => undefined);
  return h;
}

async function sourceProbe(ctx: Ctx, name: SourceName): Promise<ServiceHealth> {
  const id: ServiceId = name;
  try {
    const s = await sourceStatus(ctx, name);
    if (!s.set) return { id, level: 'off', reason: 'not_set' };
    if (s.invalid) return { id, level: 'warn', reason: 'invalid_key' };
    if ((await ctx.kv.get(PAUSE_KEY(name))) !== null) return { id, level: 'warn', reason: 'paused' };
    const budget = s.budget ?? OMDB_DAILY_BUDGET;
    if (name === 'omdb' && (s.usedToday ?? 0) >= 0.9 * budget) return { id, level: 'warn', reason: 'budget', detail: { n: s.usedToday ?? 0, pct: Math.round(((s.usedToday ?? 0) / budget) * 100) } };
    return { id, level: 'ok' };
  } catch {
    return { id, level: 'off', reason: 'unavailable' };
  }
}

async function playbackCheckProbe(ctx: Ctx): Promise<ServiceHealth> {
  try {
    const r = await ctx.db.query<{ results: Array<{ ok: boolean; itemId?: string }> }>('select results from playback_checks order by id desc limit 1');
    const row = r.rows[0];
    if (!row) return { id: 'playbackCheck', level: 'off' };
    // the "aborted" row (no itemId) is not a checked title
    const titles = (Array.isArray(row.results) ? row.results : []).filter((x) => x?.itemId !== '');
    const failed = titles.filter((x) => !x?.ok).length;
    // every title failed: not a broken file but a broken media server (e.g. a hung hardware encoder returning empty segments)
    if (titles.length >= ALL_FAILED_MIN && failed === titles.length) return { id: 'playbackCheck', level: 'err', reason: 'empty_media', detail: { n: failed } };
    return failed ? { id: 'playbackCheck', level: 'warn', reason: 'failed_titles', detail: { n: failed } } : { id: 'playbackCheck', level: 'ok' };
  } catch {
    return { id: 'playbackCheck', level: 'off', reason: 'unavailable' };
  }
}

async function services(ctx: Ctx, fetchImpl: typeof fetch, timeoutMs: number): Promise<ServiceHealth[]> {
  const gatewayUrl = `${trimSlash(ctx.cfg.GATEWAY_URL)}/health`;
  const seerr = ctx.seerr;
  const [media, postgres, redis, gateway, oidc, requests, tmdb, omdb, check] = await Promise.all([
    bounded(() => ctx.jf.admin.ping(), timeoutMs).then((o) => timedService('media', o)),
    bounded(async () => { await ctx.db.query('select 1'); return true; }, timeoutMs).then((o) => timedService('postgres', o)),
    bounded(() => ctx.kv.ping(), timeoutMs).then((o) => timedService('redis', o)),
    bounded(async () => (await fetchImpl(gatewayUrl, { signal: AbortSignal.timeout(timeoutMs) })).status === 200, timeoutMs).then((o) => timedService('gateway', o)),
    oidcProbe(ctx, fetchImpl, timeoutMs),
    // the request service only affects wishes: down is a warning, never red; not set up (it is optional) is off
    seerr
      ? bounded(() => seerr.requestCount(), timeoutMs).then((o): ServiceHealth => (o.ok ? { id: 'requests', level: 'ok', ms: o.ms } : { id: 'requests', level: 'warn', reason: 'down', ms: o.ms }))
      : Promise.resolve<ServiceHealth>({ id: 'requests', level: 'off', reason: 'not_set' }),
    bounded(() => sourceProbe(ctx, SOURCES[0]!), timeoutMs).then((o): ServiceHealth => (o.ok ? o.v : { id: 'tmdb', level: 'off', reason: 'unavailable' })),
    bounded(() => sourceProbe(ctx, SOURCES[1]!), timeoutMs).then((o): ServiceHealth => (o.ok ? o.v : { id: 'omdb', level: 'off', reason: 'unavailable' })),
    bounded(() => playbackCheckProbe(ctx), timeoutMs).then((o): ServiceHealth => (o.ok ? o.v : { id: 'playbackCheck', level: 'off', reason: 'unavailable' })),
  ]);
  return [media, postgres, redis, gateway, oidc, requests, tmdb, omdb, check];
}

interface Vol { total: number; free: number; dev: number | null }

/**
 * statfs/stat calls still running, per implementation and path. A call on a hung network mount never returns and holds a
 * libuv thread; bounded() only stops waiting. While one is pending no new call starts for that path (the disk reads as
 * unavailable), so a stalled mount costs one thread, not one per tick.
 */
const pendingVolumes = new WeakMap<DiskDeps['statfs'], Map<string, Promise<unknown>>>();

async function volume(path: string, d: DiskDeps, timeoutMs: number): Promise<Vol | null> {
  let pending = pendingVolumes.get(d.statfs);
  if (!pending) pendingVolumes.set(d.statfs, (pending = new Map()));
  if (pending.has(path)) return null;
  const call = (async () => {
    const s = await d.statfs(path);
    const dev = await d.stat(path).then((x) => Number(x.dev), () => null);
    return { total: Number(s.blocks) * Number(s.bsize), free: Number(s.bavail) * Number(s.bsize), dev };
  })();
  const done = call.then(() => undefined, () => undefined).finally(() => pending.delete(path));
  pending.set(path, done);
  const o = await bounded(() => call, timeoutMs);
  return o.ok && o.v.total > 0 ? o.v : null;
}

function diskEntry(ctx: Ctx, id: 'downloads' | 'previews', v: Vol | null, ownBytes: number, capBytes?: number): DiskHealth {
  if (!v) return { id, level: 'off', reason: 'unavailable', ownBytes, ...(capBytes !== undefined ? { capBytes } : {}) };
  const { HEALTH_DISK_WARN_PCT: warnPct, HEALTH_DISK_CRIT_PCT: critPct, DOWNLOAD_MIN_FREE_GB } = ctx.cfg;
  const used = ((v.total - v.free) / v.total) * 100;
  const minFree = id === 'downloads' ? DOWNLOAD_MIN_FREE_GB * GiB : 0;
  let level: Level = 'ok';
  let reason: Reason | undefined;
  if (used >= critPct) { level = 'err'; reason = 'full'; }
  else if (minFree > 0 && v.free < minFree) { level = 'err'; reason = 'low_free'; }
  else if (used >= warnPct) { level = 'warn'; reason = 'full'; }
  else if (minFree > 0 && v.free < 2 * minFree) { level = 'warn'; reason = 'low_free'; }
  else if (capBytes !== undefined && ownBytes >= 0.9 * capBytes) { level = 'warn'; reason = 'cap'; }
  return {
    id, level, ...(reason ? { reason } : {}), totalBytes: v.total, freeBytes: v.free, usedPct: Math.round(used), ownBytes, ...(capBytes !== undefined ? { capBytes } : {}),
  };
}

async function disks(ctx: Ctx, d: DiskDeps, timeoutMs: number): Promise<DiskHealth[]> {
  const downloadsOn = ctx.cfg.DOWNLOADS_ENABLED === 'true';
  const num = async (sql: string) => Number((await ctx.db.query<{ n: string }>(sql).catch(() => ({ rows: [] as Array<{ n: string }> }))).rows[0]?.n ?? 0);
  const [dlVol, pvVol, dlBytes, pvBytes, dbBytes] = await Promise.all([
    downloadsOn ? volume(ctx.cfg.DOWNLOAD_DIR, d, timeoutMs) : Promise.resolve(null),
    volume(ctx.cfg.PREVIEW_DIR, d, timeoutMs),
    downloadsOn ? num("select coalesce(sum(bytes),0)::text n from download_jobs where status='ready'") : Promise.resolve(0),
    num("select coalesce(sum(bytes),0)::text n from preview_clips where status='ok'"),
    bounded(() => num('select pg_database_size(current_database())::text n'), timeoutMs).then((o) => (o.ok ? o.v : null)),
  ]);
  const out: DiskHealth[] = [];
  const cap = Math.round(ctx.cfg.DOWNLOAD_CACHE_MAX_GB * GiB);
  if (downloadsOn) {
    const dl = diskEntry(ctx, 'downloads', dlVol, dlBytes, cap);
    if (dlVol && pvVol && dlVol.dev !== null && dlVol.dev === pvVol.dev) out.push({ ...dl, sharedWith: 'previews', sharedBytes: pvBytes });
    else out.push(dl, diskEntry(ctx, 'previews', pvVol, pvBytes));
  } else {
    out.push(diskEntry(ctx, 'previews', pvVol, pvBytes));
  }
  if (dbBytes === null) out.push({ id: 'database', level: 'off', reason: 'unavailable', ownBytes: 0 });
  else if (dbBytes > ctx.cfg.HEALTH_DB_WARN_GB * GiB) out.push({ id: 'database', level: 'warn', reason: 'large', ownBytes: dbBytes });
  else out.push({ id: 'database', level: 'ok', ownBytes: dbBytes });
  return out;
}

async function errorHealth(ctx: Ctx): Promise<ErrorHealth> {
  const [server15, client15, playback60] = await Promise.all([recentCount(ctx, 'server', 15), recentCount(ctx, 'client', 15), recentCount(ctx, 'playback', 60)]);
  const reason: Reason | undefined = server15 >= 10 ? 'server_errors' : client15 >= 20 ? 'client_errors' : playback60 >= 3 ? 'failed_playbacks' : undefined;
  // errors alone never mean the instance is down: at most yellow
  return { level: reason ? 'warn' : 'ok', ...(reason ? { reason } : {}), server15, client15, playback60 };
}

/** Block 23: open sign-in requests (not rejected) in the approval queue; null when the count cannot be read. */
async function pendingApprovals(ctx: Ctx, timeoutMs: number): Promise<number | null> {
  const o = await bounded(async () => (await ctx.db.query<{ n: number }>('select count(*)::int as n from approval_requests where rejected_at is null')).rows[0]?.n ?? 0, timeoutMs);
  return o.ok ? o.v : null;
}

function issuesOf(svcs: ServiceHealth[], dsks: DiskHealth[], errs: ErrorHealth, pending: number | null): HealthIssue[] {
  const out: HealthIssue[] = [];
  const add = (id: string, level: Level, reason: Reason | undefined, detail?: HealthIssue['detail']) => {
    if ((level === 'warn' || level === 'err') && reason) out.push({ id, level, reason, fp: issueFp(id, level, reason), ...(detail ? { detail } : {}) });
  };
  for (const s of svcs) add(`svc:${s.id}`, s.level, s.reason, s.detail);
  for (const d of dsks) {
    const pct = d.reason === 'cap' && d.capBytes ? Math.round((d.ownBytes / d.capBytes) * 100) : d.usedPct;
    add(`disk:${d.id}`, d.level, d.reason, pct !== undefined ? { pct } : undefined);
  }
  if (errs.server15 >= 10) add('errors:server', 'warn', 'server_errors', { n: errs.server15 });
  if (errs.client15 >= 20) add('errors:client', 'warn', 'client_errors', { n: errs.client15 });
  if (errs.playback60 >= 3) add('errors:playback', 'warn', 'failed_playbacks', { n: errs.playback60 });
  // a to-do for the admin, not a health problem: shown in the banner, but it does not colour `worst`
  if (pending) add('approvals:pending', 'warn', 'pending_approvals', { n: pending });
  return out;
}

export function worstOf(levels: Level[]): Level {
  const w = levels.reduce<Level>((a, l) => (RANK[l] > RANK[a] ? l : a), 'off');
  return w === 'off' ? 'ok' : w;
}

// module-level so the in-flight guard of volume() spans snapshots
const realStatfs: DiskDeps['statfs'] = async (p) => fsStatfs(p);
const realStat: DiskDeps['stat'] = async (p) => fsStat(p);

/** All probes in parallel, each bounded by the 3 s probe timeout; a failing probe is that row's state, never a failed snapshot. */
export async function buildSnapshot(ctx: Ctx, deps: HealthDeps = {}): Promise<HealthSnapshot> {
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const fetchImpl = deps.fetchImpl ?? ctx.fetchImpl;
  const d: DiskDeps = { statfs: deps.statfs ?? realStatfs, stat: deps.stat ?? realStat };
  const [svcs, dsks, errs, pending] = await Promise.all([services(ctx, fetchImpl, timeoutMs), disks(ctx, d, timeoutMs), errorHealth(ctx), pendingApprovals(ctx, timeoutMs)]);
  const issues = issuesOf(svcs, dsks, errs, pending);
  return { at: new Date().toISOString(), services: svcs, disks: dsks, errors: errs, issues, worst: worstOf([...svcs.map((s) => s.level), ...dsks.map((x) => x.level), errs.level]) };
}

// single flight per process (keyed by ctx: tests run several apps in one process)
const inflight = new WeakMap<object, Promise<HealthSnapshot>>();

function rebuild(ctx: Ctx, deps?: HealthDeps): Promise<HealthSnapshot> {
  let p = inflight.get(ctx);
  if (!p) {
    p = (async () => {
      const s = await buildSnapshot(ctx, deps);
      await ctx.kv.set(SNAP_KEY, JSON.stringify(s), SNAP_TTL).catch(() => undefined);
      return s;
    })().finally(() => inflight.delete(ctx));
    inflight.set(ctx, p);
  }
  return p;
}

/** Tests: resolves once a background rebuild (if any) has finished. */
export async function healthSettled(ctx: Ctx): Promise<void> {
  await inflight.get(ctx)?.catch(() => undefined);
}

async function storedSnapshot(ctx: Ctx): Promise<HealthSnapshot | null> {
  const raw = await ctx.kv.get(SNAP_KEY).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw) as HealthSnapshot; } catch { return null; }
}

/** The stored snapshot when it is at most 90 s old, else null (callers then use their own cheap checks). */
export async function freshSnapshot(ctx: Ctx): Promise<HealthSnapshot | null> {
  const s = await storedSnapshot(ctx);
  return s && Date.now() - Date.parse(s.at) <= STALE_MS ? s : null;
}

/**
 * kv snapshot: fresh → as is; older than 90 s (e.g. a replica without jobs) → served at once and rebuilt in the background
 * (single flight); missing → built (bounded by the probe timeout); refresh → built and awaited.
 */
export async function getSnapshot(ctx: Ctx, opts: { refresh?: boolean } = {}, deps?: HealthDeps): Promise<HealthSnapshot> {
  if (opts.refresh) return rebuild(ctx, deps);
  const s = await storedSnapshot(ctx);
  if (!s) return rebuild(ctx, deps);
  if (Date.now() - Date.parse(s.at) > STALE_MS) void rebuild(ctx, deps).catch(() => undefined);
  return s;
}

/** Background job (every 60 s): rebuild + store; prunes banner dismissals (30 days) and player timings (14 days) once per hour. Never throws. */
export async function healthTick(ctx: Ctx, deps?: HealthDeps): Promise<void> {
  try {
    await rebuild(ctx, deps);
  } catch {
    // a failing build keeps the last snapshot
  }
  try {
    if (await ctx.kv.setnx('health:prune', '1', 3600)) {
      await ctx.db.query("delete from health_dismissals where at < now() - interval '30 days'");
      await pruneTimings(ctx); // player start-time rows: 14 days
    }
  } catch {
    // next hour
  }
}
