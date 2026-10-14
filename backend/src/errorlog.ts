// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { scrub } from './clientErrors.js';
import type { Ctx } from './ctx.js';

/**
 * Block 22: aggregated error log for the admin health page. Fingerprints, not events: one entry per source + code (+ item)
 * with a count, first/last time, release and one scrubbed sample.
 *
 * Storage differs by source (privacy, see docs/monitoring.md "Datenschutz"):
 * - `server` (responses >= 500, keyed by route pattern) and `job` (background job failures) carry no personal data and live
 *   in Redis: `errlog:<source>:<hash>` (7 days), per-minute counters `errlog:b:<source>:<minute>` (2 h).
 * - `client` and `playback` (browser reports) are counted in this process's memory only: 24 h window, lost on restart, never
 *   written to Redis or Postgres. No user id, IP or user agent is ever part of an entry.
 * Each store holds at most 300 fingerprints; a new one evicts the least recently seen (counted as overflow). The per-minute
 * counters behind the health levels count every report regardless. Entry counts are kept per hour, so a list covers only
 * its window. Recording never throws.
 */
export type ErrorSource = 'server' | 'client' | 'playback' | 'job';
export const ERROR_SOURCES = ['server', 'client', 'playback', 'job'] as const;

export interface ErrorEntry {
  source: ErrorSource;
  code: string;
  count: number;
  firstAt: string;
  lastAt: string;
  release?: string;
  sample?: string;
  itemId?: string;
}

export interface ErrorInput {
  source: ErrorSource; code: string; sample?: string; itemId?: string; release?: string;
  /** false: listed, but not counted towards the health levels (anonymous browser reports); default true */
  countRecent?: boolean;
}

/** cfg is optional: index ticks run with a narrower ctx (the release is then left out) */
type KvCtx = Pick<Ctx, 'kv'> & Partial<Pick<Ctx, 'cfg'>>;

const ENTRY_TTL = 7 * 86400; // 604800
const BUCKET_TTL = 2 * 3600;
const MAX_FINGERPRINTS = 300;
const MEMORY_WINDOW_MS = 24 * 3600_000;
const COUNT_CACHE_MS = 60_000;
const ITEM_ID = /^[0-9a-f]{32}$/;

const isMemory = (s: ErrorSource) => s === 'client' || s === 'playback';
const minuteOf = (ms: number) => Math.floor(ms / 60_000);
const fingerprint = (code: string, itemId?: string) => createHash('sha1').update(code + (itemId ?? '')).digest('hex').slice(0, 16);
const clean = (s: string, max: number) => scrub(s).replace(/\s+/g, ' ').trim().slice(0, max);
/** scheme://anything → … (as web/src/lib/admin/health.ts cleanCode) */
const cutUrls = (s: string) => s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '…').trim();

/**
 * A release is set by the app (web: SvelteKit version name = git sha or build epoch; server: APP_VERSION / short sha), never typed by
 * a user. It is kept verbatim when it has one of those shapes (scrub() would turn a full 40-hex sha into "[token]"), dropped otherwise.
 */
const RELEASE = /^(?:v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,30})?|[0-9a-f]{7,40}|\d{1,13})$/;
export function cleanRelease(r: string | undefined): string | undefined {
  const v = r?.trim();
  return v && RELEASE.test(v) ? v : undefined;
}

function releaseOf(cfg: KvCtx['cfg']): string | undefined {
  if (!cfg) return undefined;
  return cfg.APP_VERSION ?? (cfg.GIT_SHA ? cfg.GIT_SHA.slice(0, 7) : undefined);
}

/** per-hour counts of an entry (hour index → n): counts are windowed, never lifetime totals */
type Hours = Record<string, number>;
type Stored = ErrorEntry & { h?: Hours };

const hourOf = (ms: number) => Math.floor(ms / 3600_000);

/** Adds one hit in `now`'s hour and drops hours older than `keepHours`. */
function bumpHours(h: Hours | undefined, now: number, keepHours: number): Hours {
  const cur = hourOf(now);
  const out: Hours = {};
  for (const [k, n] of Object.entries(h ?? {})) if (Number(k) > cur - keepHours) out[k] = n;
  out[cur] = (out[cur] ?? 0) + 1;
  return out;
}

/** The entry as the API returns it: count (and firstAt) only of the hours since `sinceMs`; null when nothing is left. */
function windowed(e: Stored, sinceMs: number, keepHours: number, now: number): ErrorEntry | null {
  const { h, ...entry } = e;
  // an entry written before the hourly counts existed: all its hits count in its last hour
  const hours = h ?? { [hourOf(Date.parse(e.lastAt))]: e.count };
  const from = Math.max(hourOf(sinceMs), hourOf(now) - keepHours + 1);
  let count = 0;
  let first = Infinity;
  for (const [k, n] of Object.entries(hours)) {
    if (Number(k) < from) continue;
    count += n;
    first = Math.min(first, Number(k));
  }
  if (!count) return null;
  const firstMs = Math.max(Date.parse(e.firstAt), first * 3600_000);
  return { ...entry, count, firstAt: new Date(firstMs).toISOString() };
}

/** Key of the least recently seen entry (evicted when a store is full: a new error always gets in). */
function leastRecent<T extends { lastAt: string }>(entries: Iterable<[string, T]>): string | undefined {
  let key: string | undefined;
  let at = '';
  for (const [k, e] of entries) if (key === undefined || e.lastAt < at) { key = k; at = e.lastAt; }
  return key;
}

// ---- memory store (client + playback) ----
const MEMORY_HOURS = MEMORY_WINDOW_MS / 3600_000;
const mem = new Map<string, Stored & { lastMs: number }>();
const memBuckets = new Map<string, number>(); // `${source}:${minute}` -> n
const memOverflow = new Map<number, number>(); // hour -> evicted fingerprints (24 h)

function pruneMemory(now: number) {
  for (const [k, e] of mem) if (now - e.lastMs > MEMORY_WINDOW_MS) mem.delete(k);
  const oldest = minuteOf(now) - BUCKET_TTL / 60;
  for (const k of memBuckets.keys()) if (Number(k.split(':')[1]) < oldest) memBuckets.delete(k);
  for (const h of memOverflow.keys()) if (h <= hourOf(now) - MEMORY_HOURS) memOverflow.delete(h);
}

/** Tests only: forget everything kept in memory (and the cached Redis fingerprint count). */
export function resetErrorLogForTests() {
  mem.clear();
  memBuckets.clear();
  memOverflow.clear();
  keyCount = null;
}

/** Tests only: sizes of the memory structures (they must stay bounded). */
export function errorLogSizesForTests() {
  return { entries: mem.size, buckets: memBuckets.size, overflow: memOverflow.size };
}

// ---- Redis store (server + job) ----
const STORED_HOURS = ENTRY_TTL / 3600;
let keyCount: { n: number; at: number } | null = null;
const STORED_KEY = /^errlog:(server|job):/;

async function storedKeys(ctx: KvCtx): Promise<string[]> {
  return (await ctx.kv.keys('errlog:')).filter((k) => STORED_KEY.test(k));
}

async function storedCount(ctx: KvCtx, now: number): Promise<number> {
  if (!keyCount || now - keyCount.at > COUNT_CACHE_MS) keyCount = { n: (await storedKeys(ctx)).length, at: now };
  return keyCount.n;
}

/** Full Redis store: drops the least recently seen entry (one keys + mget, only when a new fingerprint meets a full store). */
async function evictStored(ctx: KvCtx): Promise<void> {
  const keys = await storedKeys(ctx);
  const vals = await ctx.kv.mget(keys);
  const parsed: Array<[string, { lastAt: string }]> = [];
  vals.forEach((v, i) => {
    try { parsed.push([keys[i]!, v ? (JSON.parse(v) as ErrorEntry) : { lastAt: '' }]); } catch { parsed.push([keys[i]!, { lastAt: '' }]); }
  });
  const victim = leastRecent(parsed);
  if (victim) await ctx.kv.del(victim);
  keyCount = { n: keys.length - (victim ? 1 : 0), at: Date.now() };
}

function normalise(ctx: KvCtx, e: ErrorInput) {
  // browser reports: a resource error names its URL in code and sample, which no response may carry (same cut as the web)
  const browser = isMemory(e.source);
  const code = (browser ? cutUrls(clean(e.code, 400)).slice(0, 120) : clean(e.code, 120)) || 'unknown';
  const sample = e.sample ? (browser ? cutUrls(clean(e.sample, 600)).slice(0, 300) : clean(e.sample, 300)) : undefined;
  const itemId = e.itemId && ITEM_ID.test(e.itemId) ? e.itemId : undefined;
  const release = e.release ? cleanRelease(e.release) : releaseOf(ctx.cfg);
  return { code, sample, itemId, release };
}

/**
 * Records one error occurrence. `now` exists for tests. Never throws.
 * The per-minute counters (health levels, banner) always count, even when the fingerprint store is full: a full store
 * evicts its least recently seen entry, so a new error can never be hidden. `countRecent: false` keeps an entry for the
 * list without feeding the counters (anonymous browser reports).
 */
export async function recordError(ctx: KvCtx, e: ErrorInput, now = Date.now()): Promise<void> {
  try {
    const { code, sample, itemId, release } = normalise(ctx, e);
    const hash = fingerprint(code, itemId);
    const at = new Date(now).toISOString();
    const counts = e.countRecent !== false;
    if (isMemory(e.source)) {
      pruneMemory(now);
      if (counts) {
        const bucket = `${e.source}:${minuteOf(now)}`;
        memBuckets.set(bucket, (memBuckets.get(bucket) ?? 0) + 1);
      }
      const key = `${e.source}:${hash}`;
      const cur = mem.get(key);
      if (cur) {
        cur.count++;
        cur.h = bumpHours(cur.h, now, MEMORY_HOURS);
        if (now >= cur.lastMs) Object.assign(cur, { lastAt: at, lastMs: now, ...(release ? { release } : {}), ...(sample ? { sample } : {}) });
        return;
      }
      if (mem.size >= MAX_FINGERPRINTS) {
        const victim = leastRecent(mem);
        if (victim) mem.delete(victim);
        memOverflow.set(hourOf(now), (memOverflow.get(hourOf(now)) ?? 0) + 1);
      }
      mem.set(key, { source: e.source, code, count: 1, firstAt: at, lastAt: at, lastMs: now, h: bumpHours(undefined, now, MEMORY_HOURS), ...(release ? { release } : {}), ...(sample ? { sample } : {}), ...(itemId ? { itemId } : {}) });
      return;
    }
    if (counts) await ctx.kv.incr(`errlog:b:${e.source}:${minuteOf(now)}`, BUCKET_TTL);
    const key = `errlog:${e.source}:${hash}`;
    const raw = await ctx.kv.get(key);
    let entry: Stored;
    if (raw) {
      const prev = JSON.parse(raw) as Stored;
      const newer = at >= prev.lastAt;
      const h = bumpHours(prev.h ?? { [hourOf(Date.parse(prev.lastAt))]: prev.count }, now, STORED_HOURS);
      entry = { ...prev, h, count: prev.count + 1, ...(newer ? { lastAt: at, ...(release ? { release } : {}), ...(sample ? { sample } : {}) } : {}) };
    } else {
      if ((await storedCount(ctx, now)) >= MAX_FINGERPRINTS) {
        await evictStored(ctx);
        await ctx.kv.incr('errlog:overflow', ENTRY_TTL);
      }
      entry = { source: e.source, code, count: 1, firstAt: at, lastAt: at, h: bumpHours(undefined, now, STORED_HOURS), ...(release ? { release } : {}), ...(sample ? { sample } : {}), ...(itemId ? { itemId } : {}) };
      if (keyCount) keyCount.n++;
    }
    await ctx.kv.set(key, JSON.stringify(entry), ENTRY_TTL);
  } catch {
    // the error log must never cause an error of its own
  }
}

/**
 * Entries (newest first) of all or one source, optionally only those seen since a date. `count` and `firstAt` cover only
 * the window (to the hour; memory entries at most 24 h, Redis entries at most 7 days). `overflow`: fingerprints evicted
 * from a full store (they still counted towards the health levels).
 */
export async function listErrors(ctx: KvCtx, opts: { since?: Date; source?: ErrorSource; limit?: number }): Promise<{ entries: ErrorEntry[]; overflow: number }> {
  const now = Date.now();
  pruneMemory(now);
  const sinceMs = opts.since?.getTime() ?? 0;
  const since = opts.since?.toISOString() ?? '';
  const wantStored = !opts.source || !isMemory(opts.source);
  const wantMemory = !opts.source || isMemory(opts.source);
  const out: ErrorEntry[] = [];
  let overflow = 0;
  const add = (e: Stored, keepHours: number) => {
    if (e.lastAt < since) return;
    const w = windowed(e, sinceMs, keepHours, now);
    if (w) out.push(w);
  };
  if (wantStored) {
    const keys = (await storedKeys(ctx)).filter((k) => !opts.source || k.startsWith(`errlog:${opts.source}:`));
    const vals = await ctx.kv.mget(keys);
    for (const v of vals) {
      if (!v) continue;
      try { add(JSON.parse(v) as Stored, STORED_HOURS); } catch { /* skip a broken entry */ }
    }
    overflow += Number((await ctx.kv.get('errlog:overflow')) ?? 0);
  }
  if (wantMemory) {
    for (const e of mem.values()) {
      if (opts.source && e.source !== opts.source) continue;
      const { lastMs: _lastMs, ...entry } = e;
      add(entry, MEMORY_HOURS);
    }
    for (const n of memOverflow.values()) overflow += n;
  }
  const entries = out.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
  return { entries: entries.slice(0, opts.limit ?? 200), overflow };
}

/** Occurrences of one source in the last 15 or 60 minutes (per-minute counters). */
export async function recentCount(ctx: KvCtx, source: ErrorSource, minutes: 15 | 60, now = Date.now()): Promise<number> {
  const cur = minuteOf(now);
  const minutesList = Array.from({ length: minutes }, (_, i) => cur - i);
  if (isMemory(source)) return minutesList.reduce((n, m) => n + (memBuckets.get(`${source}:${m}`) ?? 0), 0);
  try {
    const vals = await ctx.kv.mget(minutesList.map((m) => `errlog:b:${source}:${m}`));
    return vals.reduce((n, v) => n + Number(v ?? 0), 0);
  } catch {
    return 0;
  }
}

/** catch handler for background jobs: keeps the existing log line and records a `job` error with the job's name. */
export function jobFailed(ctx: KvCtx, log: { warn: (obj: unknown, msg?: string) => void }, job: string, msg: string) {
  return (e: unknown) => {
    log.warn({ e }, msg);
    void recordError(ctx, { source: 'job', code: job });
  };
}
