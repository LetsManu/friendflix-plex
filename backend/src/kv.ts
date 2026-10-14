// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Redis } from 'ioredis';

/** Minimal key-value store used for sessions, login state and live playback state. */
export interface KV {
  get(key: string): Promise<string | null>;
  /** Several keys in one round trip (null for missing ones). */
  mget(keys: string[]): Promise<Array<string | null>>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Overwrites only if the key still exists (refreshing a loaded session must not resurrect a revoked one). True if written. */
  replace(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /** Atomic set-if-absent (SET NX): true if this caller wrote the value. */
  setnx(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /** Atomic get-and-delete: only one concurrent caller gets the value. */
  take(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
  /** Atomic counter: increments (creating it at 1 with the ttl on first use) and returns the new value. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  /** Keys starting with prefix. */
  keys(prefix: string): Promise<string[]>;
  ping(): Promise<boolean>;
}

export class RedisKV implements KV {
  constructor(private readonly redis: Redis) {}
  get(key: string) {
    return this.redis.get(key);
  }
  mget(keys: string[]) {
    return keys.length ? this.redis.mget(...keys) : Promise.resolve([]);
  }
  async set(key: string, value: string, ttl: number) {
    await this.redis.set(key, value, 'EX', ttl);
  }
  async replace(key: string, value: string, ttl: number) {
    return (await this.redis.set(key, value, 'EX', ttl, 'XX')) === 'OK';
  }
  async setnx(key: string, value: string, ttl: number) {
    return (await this.redis.set(key, value, 'EX', ttl, 'NX')) === 'OK';
  }
  take(key: string) {
    return this.redis.getdel(key);
  }
  async del(key: string) {
    await this.redis.del(key);
  }
  async incr(key: string, ttl: number) {
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, ttl);
    return n;
  }
  async keys(prefix: string) {
    const out: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', `${prefix.replace(/[*?[\]\\]/g, '\\$&')}*`, 'COUNT', 200);
      cursor = next;
      out.push(...batch);
    } while (cursor !== '0');
    return out;
  }
  async ping() {
    return (await this.redis.ping()) === 'PONG';
  }
}

export class MemoryKV implements KV {
  private readonly m = new Map<string, { v: string; exp: number }>();
  private live(key: string) {
    const e = this.m.get(key);
    if (!e) return null;
    if (e.exp < Date.now()) {
      this.m.delete(key);
      return null;
    }
    return e.v;
  }
  async get(key: string) {
    return this.live(key);
  }
  async set(key: string, value: string, ttl = 3600) {
    this.m.set(key, { v: value, exp: Date.now() + ttl * 1000 });
  }
  async replace(key: string, value: string, ttl: number) {
    if (this.live(key) === null) return false;
    this.m.set(key, { v: value, exp: Date.now() + ttl * 1000 });
    return true;
  }
  async setnx(key: string, value: string, ttl: number) {
    if (this.live(key) !== null) return false;
    this.m.set(key, { v: value, exp: Date.now() + ttl * 1000 });
    return true;
  }
  async take(key: string) {
    const v = this.live(key);
    this.m.delete(key);
    return v;
  }
  async del(key: string) {
    this.m.delete(key);
  }
  async incr(key: string, ttl: number) {
    const cur = this.live(key);
    const n = (cur === null ? 0 : Number(cur)) + 1;
    const e = this.m.get(key);
    this.m.set(key, { v: String(n), exp: cur === null || !e ? Date.now() + ttl * 1000 : e.exp });
    return n;
  }
  async mget(keys: string[]) {
    return keys.map((k) => this.live(k));
  }
  async keys(prefix: string) {
    return [...this.m.keys()].filter((k) => k.startsWith(prefix) && this.live(k) !== null);
  }
  async ping() {
    return true;
  }
}
