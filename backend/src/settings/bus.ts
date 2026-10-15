// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Redis } from 'ioredis';

/**
 * Tells the other backend instances that the settings changed. A message carries only the new revision, never a value: each instance
 * reloads from the database. Delivery is best effort; the store's poll of settings_meta.rev covers a missed message.
 */
export interface SettingsBus {
  publish(rev: number): Promise<void>;
  subscribe(fn: (rev: number) => void): Promise<() => void>;
}

export const SETTINGS_CHANNEL = 'ff:settings:rev';

/** Redis pub/sub. Subscribing switches a connection into subscriber mode, so the subscriber is a duplicate of the given connection. */
export class RedisSettingsBus implements SettingsBus {
  constructor(private readonly redis: Redis) {}

  async publish(rev: number): Promise<void> {
    await this.redis.publish(SETTINGS_CHANNEL, String(rev));
  }

  async subscribe(fn: (rev: number) => void): Promise<() => void> {
    const sub = this.redis.duplicate();
    sub.on('message', (channel: string, message: string) => {
      if (channel !== SETTINGS_CHANNEL) return;
      const rev = Number(message);
      if (Number.isSafeInteger(rev)) fn(rev);
    });
    // ioredis logs connection errors itself when no listener is attached; the poll covers the outage
    sub.on('error', () => {});
    try {
      await sub.subscribe(SETTINGS_CHANNEL);
    } catch (e) {
      sub.disconnect();
      throw e;
    }
    return async () => {
      await sub.quit().catch(() => sub.disconnect());
    };
  }
}

/** In-process bus for tests: every store subscribed to one instance hears every publish (asynchronously, like Redis). */
export class MemorySettingsBus implements SettingsBus {
  private readonly fns = new Set<(rev: number) => void>();

  async publish(rev: number): Promise<void> {
    for (const fn of [...this.fns]) setImmediate(() => fn(rev));
  }

  async subscribe(fn: (rev: number) => void): Promise<() => void> {
    const own = (rev: number) => fn(rev); // the same fn may subscribe twice
    this.fns.add(own);
    return () => { this.fns.delete(own); };
  }
}
