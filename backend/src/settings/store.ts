// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { configSchema, type Config } from '../config.js';
import type { Db } from '../db.js';
import { HttpError } from '../users.js';
import type { SettingsBus } from './bus.js';
import { parseSettingValue, SETTINGS, settingDef } from './registry.js';
import { readRev, readRows, writeRows } from './repo.js';
import { envLayer, resolveConfig, toSchemaInput, toStored, type Source } from './resolve.js';

/**
 * The live settings: an immutable Config snapshot, swapped atomically on every reload. A save writes the rows (one revision), reloads and
 * publishes the revision on the bus; the other instances reload from the database when they hear it, or at the latest on their next
 * poll of settings_meta.rev. The bus never carries values, and a bus (Redis) outage never breaks reads or saves.
 */
export interface SettingsStore {
  current(): Config;
  sources(): Record<string, Source>;
  invalid(): string[];
  rev(): number;
  reload(): Promise<void>;
  /** validates every value first (all or nothing); null or '' deletes the stored value. Returns the new rev. */
  save(changes: Record<string, unknown | null>, actor: string | null): Promise<number>;
  /** copies env-sourced settings into the database (env keeps winning until it is removed); returns the keys copied */
  importEnv(keys: readonly string[] | 'all', actor: string | null): Promise<string[]>;
  onChange(keys: readonly string[], fn: (cfg: Config, changed: string[]) => void | Promise<void>): () => void;
  /** restart keys whose effective value differs from the boot snapshot */
  pendingRestart(): string[];
  /** after a settings_meta write outside save() (setup completion): reloads and publishes the rev, like a save */
  announce(): Promise<void>;
  /** stops the poll and the bus subscription */
  close(): Promise<void>;
}

/** A refused save: `errors` maps each refused key to a code ('unknown', 'locked' or the schema's code); routes answer 400 { errors }. */
export class SettingsError extends HttpError {
  constructor(readonly errors: Record<string, string>) {
    super(400, 'invalid_settings');
  }
}

const KEYS = Object.keys(configSchema.shape) as Array<keyof Config>;
const RESTART_KEYS = SETTINGS.filter((d) => d.apply === 'restart').map((d) => d.key as keyof Config);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface Snapshot { cfg: Config; sources: Record<string, Source>; invalid: string[]; rev: number }

export async function createSettingsStore(deps: {
  db: Db; encKey: Buffer; env: NodeJS.ProcessEnv; bus: SettingsBus; log: { warn(o: object, m: string): void };
  bootstrap?: Partial<Record<string, string>>; pollMs?: number; listenerTimeoutMs?: number;
}): Promise<SettingsStore> {
  const { db, encKey, env, bus, log, bootstrap } = deps;
  const listeners = new Set<{ keys: ReadonlySet<string>; fn: (cfg: Config, changed: string[]) => void | Promise<void> }>();

  async function load(prev: Snapshot | undefined): Promise<Snapshot> {
    const { rev, rows } = await readRows(db);
    const r = resolveConfig({ env, rows, encKey, bootstrap });
    // by key name only, once per key while it stays unreadable
    for (const key of r.invalid) if (!prev?.invalid.includes(key)) log.warn({ key }, 'stored setting is unreadable or invalid and is ignored; enter it again');
    // one level deep: array values (HOME_NETWORKS) are shared by every reader too
    for (const v of Object.values(r.cfg)) if (v && typeof v === 'object') Object.freeze(v);
    return { cfg: Object.freeze(r.cfg), sources: r.sources, invalid: r.invalid, rev };
  }

  let snap = await load(undefined);
  const boot = snap.cfg;

  /**
   * Runs the listeners for one change, each bounded by a timeout. Dispatches are not queued behind each other or behind reloads, so a
   * listener may call save/reload/importEnv, and a hanging one delays only the save that triggered it (by at most the timeout).
   */
  const timeoutMs = deps.listenerTimeoutMs ?? 10_000;
  async function dispatch(cfg: Config, changed: string[]): Promise<void> {
    for (const l of [...listeners]) {
      const mine = changed.filter((k) => l.keys.has(k));
      if (!mine.length) continue;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((res) => { timer = setTimeout(() => res('timeout'), timeoutMs); timer.unref(); });
      try {
        if (await Promise.race([Promise.resolve().then(() => l.fn(cfg, mine)), timedOut]) === 'timeout') {
          log.warn({ keys: mine }, 'settings change listener is still running; continuing without it');
        }
      } catch (err) {
        log.warn({ err, keys: mine }, 'settings change listener failed');
      } finally {
        clearTimeout(timer);
      }
    }
  }

  // reloads run one at a time, so an older read never replaces a newer snapshot; the listeners run after the swap, outside the queue
  let queue: Promise<void> = Promise.resolve();
  const reload = async (): Promise<void> => {
    const run = queue.then(async () => {
      const prev = snap;
      const next = await load(prev);
      snap = next;
      return { cfg: next.cfg, changed: KEYS.filter((k) => !same(prev.cfg[k], next.cfg[k])) };
    });
    queue = run.then(() => {}, () => {});
    const { cfg, changed } = await run;
    if (changed.length) await dispatch(cfg, changed);
  };

  const reloadIfNewer = (rev: number) => {
    if (rev > snap.rev) reload().catch((err) => log.warn({ err }, 'settings reload failed'));
  };

  let unsubscribe: (() => void) | undefined;
  let closed = false;
  let retry: NodeJS.Timeout | undefined;
  // not awaited: a Redis outage at start must not block or fail the backend; the poll covers it while the subscription is retried
  const subscribe = (attempt: number) => {
    bus.subscribe(reloadIfNewer).then(
      (off) => (closed ? off() : (unsubscribe = off)),
      (err: unknown) => {
        if (attempt === 0) log.warn({ err }, 'settings bus subscribe failed; relying on the poll and retrying');
        if (!closed) (retry = setTimeout(() => subscribe(attempt + 1), Math.min(deps.pollMs ?? 30_000, 1000 * 2 ** attempt))).unref();
      },
    );
  };
  subscribe(0);
  const poll = setInterval(() => {
    readRev(db).then(reloadIfNewer, (err) => log.warn({ err }, 'settings poll failed'));
  }, deps.pollMs ?? 30_000);
  poll.unref();

  async function commit(changes: Record<string, unknown | null>, actor: string | null): Promise<number> {
    const rev = await writeRows(db, encKey, changes, actor);
    // the write is stored: publish and return its rev even when the local reload fails (the poll retries it)
    bus.publish(rev).catch((err: unknown) => log.warn({ err }, 'settings bus publish failed; others reload on their poll'));
    await reload().catch((err: unknown) => log.warn({ err }, 'settings reload after save failed'));
    return rev;
  }

  return {
    current: () => snap.cfg,
    sources: () => ({ ...snap.sources }),
    invalid: () => [...snap.invalid],
    rev: () => snap.rev,
    reload,

    async save(changes, actor) {
      const errors: Record<string, string> = {};
      const rows: Record<string, unknown | null> = {};
      for (const [key, v] of Object.entries(changes)) {
        const def = settingDef(key);
        if (!def) {
          errors[key] = Object.hasOwn(configSchema.shape, key) ? 'locked' : 'unknown'; // env-only, bootstrap and build keys never go to the database
          continue;
        }
        if (snap.sources[key] === 'env') {
          errors[key] = 'locked';
          continue;
        }
        if (v === undefined) continue;
        if (v === null || v === '') {
          rows[key] = null;
          continue;
        }
        const r = parseSettingValue(def, toSchemaInput(def, v));
        if (!r.ok) errors[key] = r.code;
        else if (r.value === undefined || r.value === '') rows[key] = null;
        else rows[key] = toStored(def, r.value);
      }
      if (Object.keys(errors).length) throw new SettingsError(errors);
      return commit(rows, actor);
    },

    async importEnv(keys, actor) {
      const wanted = keys === 'all' ? SETTINGS.map((d) => d.key) : keys;
      const unknown = Object.fromEntries(wanted.filter((k) => !settingDef(k)).map((k) => [k, 'unknown']));
      if (Object.keys(unknown).length) throw new SettingsError(unknown);
      const raw = envLayer(env);
      const rows: Record<string, unknown> = {};
      for (const key of wanted) {
        if (snap.sources[key] !== 'env' || raw[key] === undefined) continue;
        const def = settingDef(key)!;
        const r = parseSettingValue(def, raw[key]);
        if (r.ok && r.value !== undefined && r.value !== '') rows[key] = toStored(def, r.value);
      }
      const moved = Object.keys(rows);
      if (moved.length) await commit(rows, actor);
      return moved;
    },

    onChange(keys, fn) {
      const l = { keys: new Set(keys), fn };
      listeners.add(l);
      return () => { listeners.delete(l); };
    },

    async announce() {
      const rev = await readRev(db);
      bus.publish(rev).catch((err: unknown) => log.warn({ err }, 'settings bus publish failed; others reload on their poll'));
      await reload().catch((err: unknown) => log.warn({ err }, 'settings reload failed'));
    },

    pendingRestart: () => RESTART_KEYS.filter((k) => !same(boot[k], snap.cfg[k])),

    async close() {
      closed = true;
      clearInterval(poll);
      clearTimeout(retry);
      await unsubscribe?.();
      await queue;
    },
  };
}
