// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from './db.js';
import type { KV } from './kv.js';

/**
 * Per-request latency breakdown (Server-Timing). One store per API request lives in an AsyncLocalStorage; Jellyfin fetches,
 * Postgres queries and Redis calls add their duration and count to it. Outside a request (background jobs) nothing is recorded.
 * Durations of concurrent calls are summed, so `jf` can exceed the wall time of the request.
 */
export type TimingKind = 'jf' | 'db' | 'kv';
export interface TimingStore {
  start: number;
  jf: { n: number; ms: number };
  db: { n: number; ms: number };
  kv: { n: number; ms: number };
}

export const timingStorage = new AsyncLocalStorage<TimingStore>();

export const newTimingStore = (): TimingStore => ({ start: performance.now(), jf: { n: 0, ms: 0 }, db: { n: 0, ms: 0 }, kv: { n: 0, ms: 0 } });

/** Times a promise-returning call and books it on the current request (if any). Never changes the result or the error. */
export function timed<T>(kind: TimingKind, fn: () => Promise<T>): Promise<T> {
  const s = timingStorage.getStore();
  if (!s) return fn();
  const t = performance.now();
  const book = () => {
    s[kind].n++;
    s[kind].ms += performance.now() - t;
  };
  let p: Promise<T>;
  try {
    p = fn();
  } catch (e) {
    book();
    throw e;
  }
  return p.then((v) => (book(), v), (e: unknown) => { book(); throw e; });
}

const f1 = (ms: number) => (Math.round(ms * 10) / 10).toString();

/** `Server-Timing` value: jf/db/kv only when used, app = total time in the backend so far. */
export function serverTimingHeader(s: TimingStore): string {
  const parts: string[] = [];
  for (const k of ['jf', 'db', 'kv'] as const) {
    if (s[k].n) parts.push(`${k};dur=${f1(s[k].ms)};desc="${s[k].n} call${s[k].n === 1 ? '' : 's'}"`);
  }
  parts.push(`app;dur=${f1(performance.now() - s.start)}`);
  return parts.join(', ');
}

/** Breakdown for the slow-request log line. */
export const timingSummary = (s: TimingStore) => ({
  totalMs: Math.round(performance.now() - s.start),
  jf: { calls: s.jf.n, ms: Math.round(s.jf.ms) },
  db: { calls: s.db.n, ms: Math.round(s.db.ms) },
  kv: { calls: s.kv.n, ms: Math.round(s.kv.ms) },
});

const WRAPPED = Symbol.for('friendflix.timed');

/**
 * Proxy that books the listed async methods under `kind`; everything else (pool.connect, extra methods) passes through
 * untouched. Methods are resolved per call, so later patches on the wrapped object still take effect.
 */
function timedProxy<T extends object>(target: T, kind: TimingKind, methods: ReadonlySet<PropertyKey>): T {
  if ((target as Record<symbol, unknown>)[WRAPPED]) return target;
  return new Proxy(target, {
    get(t, prop) {
      if (prop === WRAPPED) return true;
      const v = Reflect.get(t, prop, t) as unknown;
      if (typeof v !== 'function') return v;
      if (!methods.has(prop)) return (v as (...a: unknown[]) => unknown).bind(t);
      return (...a: unknown[]) => timed(kind, () => (Reflect.get(t, prop, t) as (...x: unknown[]) => Promise<unknown>).apply(t, a));
    },
  });
}

/** Db whose queries are booked as `db` (pool.connect() for transactions is not timed). */
export const timedDb = (db: Db): Db => timedProxy(db, 'db', new Set(['query']));

/** KV whose calls are booked as `kv`. */
export const timedKv = (kv: KV): KV => timedProxy(kv, 'kv', new Set(['get', 'set', 'replace', 'setnx', 'take', 'del', 'delIfEquals', 'incr', 'decr', 'keys', 'ping']));
