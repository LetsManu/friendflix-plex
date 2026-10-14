// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Review follow-ups: paging totals past the end, collection posters that never reveal hidden members, the ffmpeg subtitle slots.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { encodePlexId } from '../../src/plex/ids.js';
import { Semaphore } from '../../src/plex/subtitles.js';
import { identity, kids, plexEnv, type PlexEnv } from './setup.js';

let env: PlexEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe('paging', () => {
  it('a page past the end still reports the real total', async () => {
    env = await plexEnv();
    const u = await identity(env.ms, 'admin');
    const all = await env.ms.items(u, { types: 'Movie', limit: 1, start: 0 });
    expect(all.total).toBe(2);
    const past = await env.ms.items(u, { types: 'Movie', limit: 10, start: 50 });
    expect(past).toEqual({ items: [], total: 2 });
    expect((await env.ms.items(u, { types: 'Movie', limit: 10, start: 1 })).total).toBe(2);
  });
});

describe('collection posters', () => {
  it('the poster tag names the first member THIS viewer may see; the composite (all members) is never used', async () => {
    let zebra = '';
    env = await plexEnv((f) => {
      zebra = f.addMovie({ title: 'Zebra', rating: 'de/0' });
      f.members.get('12')!.push(zebra);
    });
    const owner = await identity(env.ms, 'admin');
    const kid = await identity(env.ms, 'friend', kids(6));
    const forOwner = (await env.ms.collections(owner)).find((c) => c.name === 'Both Movies')!;
    const forKid = (await env.ms.collections(kid)).find((c) => c.name === 'Both Movies')!;
    expect(forOwner.imageTags?.primary).toBe(`m${encodePlexId('item', '1')}`); // "Test Movie One" sorts before "Zebra"
    expect(forKid.imageTags?.primary).toBe(`m${encodePlexId('item', zebra)}`); // the PG-13 / R members stay hidden
    expect(forKid.childCount).toBe(1);
    for (const c of [forOwner, forKid]) {
      expect(c.image).toBe(false);
      expect(JSON.stringify(c)).not.toContain('composite');
    }
  });
});

describe('subtitle conversion slots', () => {
  it('at most `max` run at once, the queue is bounded, waiting is time-limited', async () => {
    const sem = new Semaphore(2, 1, 50);
    const gates: Array<() => void> = [];
    let peak = 0;
    const job = () => sem.run(async () => {
      peak = Math.max(peak, sem.running);
      await new Promise<void>((r) => gates.push(r));
      return 'ok';
    });
    const a = job();
    const b = job();
    const c = job(); // queued
    await expect(job()).rejects.toThrow(/queue full/);
    await new Promise((r) => setTimeout(r, 0));
    expect([sem.running, sem.waiting]).toEqual([2, 1]);
    gates.shift()!();
    await a;
    await new Promise((r) => setTimeout(r, 0));
    expect([sem.running, sem.waiting]).toEqual([2, 0]);
    gates.splice(0).forEach((g) => g());
    await new Promise((r) => setTimeout(r, 0));
    gates.splice(0).forEach((g) => g());
    expect(await Promise.all([b, c])).toEqual(['ok', 'ok']);
    expect(peak).toBe(2);
    expect([sem.running, sem.waiting]).toEqual([0, 0]);
    // a queued job gives up after waitMs
    const d = job();
    const e = job();
    await expect(sem.run(async () => 'late')).rejects.toThrow(/timeout/);
    gates.splice(0).forEach((g) => g());
    await Promise.all([d, e]);
  });
});
