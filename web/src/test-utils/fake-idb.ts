// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// In-memory IndexedDB double with the semantics db.ts relies on: async requests, readonly/readwrite transactions that
// commit once no request is pending at the end of a task, keyPath and out-of-line keys, structured-clone storage.
// Requests and commits run on the REAL timer captured at import, so the double keeps working under vi.useFakeTimers();
// tests using fake timers wait for it with idbTick().
// Test infrastructure only: excluded from coverage (see vitest.config.ts).

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const nextTask = (fn: () => void) => void realSetTimeout(fn, 0);
/** resolves after the fake database had a chance to run its pending requests (one real task) */
export const idbTick = () => new Promise<void>((r) => nextTask(r));

type Cb = (() => void) | null;
interface Req<T = unknown> { result: T; error: Error | null; onsuccess: Cb; onerror: Cb; onupgradeneeded?: Cb }

class Store {
  rows = new Map<IDBValidKey, unknown>();
  constructor(public keyPath: string | null) {}
}

class Tx {
  oncomplete: Cb = null; onerror: Cb = null; onabort: Cb = null;
  error: Error | null = null;
  private pending = 0;
  private finished = false;
  constructor(private db: FakeDb, private names: string[], private mode: IDBTransactionMode) { this.check(); }
  objectStore(name: string) {
    if (!this.names.includes(name)) throw Object.assign(new Error(`${name} not in transaction`), { name: 'NotFoundError' });
    const st = this.db.stores.get(name)!;
    const req = <T>(op: () => T, write = false): Req<T> => {
      if (this.finished) throw Object.assign(new Error('transaction finished'), { name: 'TransactionInactiveError' });
      if (write && this.mode !== 'readwrite') throw Object.assign(new Error('read-only transaction'), { name: 'ReadOnlyError' });
      const r: Req<T> = { result: undefined as T, error: null, onsuccess: null, onerror: null };
      this.pending++;
      nextTask(() => {
        this.pending--;
        if (this.db.failNext) { const e = this.db.failNext; this.db.failNext = null; r.error = e; this.error = e; r.onerror?.(); this.abort(); return; }
        r.result = op();
        r.onsuccess?.();
        this.check();
      });
      return r;
    };
    const keyOf = (v: unknown, key?: IDBValidKey) => (st.keyPath ? (v as Record<string, IDBValidKey>)[st.keyPath]! : key!);
    return {
      get: (k: IDBValidKey) => req(() => structuredClone(st.rows.get(k))),
      getAll: () => req(() => [...st.rows.values()].map((v) => structuredClone(v))),
      put: (v: unknown, key?: IDBValidKey) => req(() => { st.rows.set(keyOf(v, key), structuredClone(v)); return keyOf(v, key); }, true),
      delete: (k: IDBValidKey) => req(() => { st.rows.delete(k); }, true),
    };
  }
  private abort() { if (this.finished) return; this.finished = true; this.onerror?.(); this.onabort?.(); }
  /** commits at the end of a task in which no request is pending (promise continuations run before that) */
  private check() {
    nextTask(() => { if (!this.finished && this.pending === 0) { this.finished = true; this.oncomplete?.(); } });
  }
}

export class FakeDb {
  stores = new Map<string, Store>();
  /** test hook: the next request fails with this error */
  failNext: Error | null = null;
  objectStoreNames = { contains: (n: string) => this.stores.has(n) };
  createObjectStore(name: string, opts: { keyPath?: string } = {}) { this.stores.set(name, new Store(opts.keyPath ?? null)); }
  transaction(names: string | string[], mode: IDBTransactionMode = 'readonly') { return new Tx(this, Array.isArray(names) ? names : [names], mode); }
}

export class FakeIndexedDB {
  dbs = new Map<string, FakeDb>();
  opens = 0;
  /** test hook: the next open() fails with this error */
  failOpen: Error | null = null;
  open(name: string, _version?: number) {
    this.opens++;
    const r: Req<FakeDb> = { result: undefined as unknown as FakeDb, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    nextTask(() => {
      if (this.failOpen) { r.error = this.failOpen; this.failOpen = null; r.onerror?.(); return; }
      let db = this.dbs.get(name);
      r.result = db ?? (db = new FakeDb());
      if (!this.dbs.has(name)) { this.dbs.set(name, db); r.onupgradeneeded?.(); }
      r.onsuccess?.();
    });
    return r;
  }
}
