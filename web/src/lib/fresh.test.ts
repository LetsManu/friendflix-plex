// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const calls: Array<{ path: string; body?: { ids: string[] } }> = [];
let answer: (ids: string[]) => unknown = () => ({ badges: {} });
let profile = 'p1';
vi.mock('#lib/api', () => ({
  getActiveProfile: () => profile,
  api: vi.fn(async (path: string, o?: { body?: { ids: string[] } }) => {
    calls.push({ path, body: o?.body });
    if (path.endsWith('/facts')) return { fresh: null, leaving: null, traits: null };
    return answer(o?.body?.ids ?? []);
  }),
}));

const mod = () => import('./fresh');
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { calls.length = 0; answer = (ids) => ({ badges: Object.fromEntries(ids.filter((i) => i === 'a').map((i) => [i, { fresh: 'new' }])) }); });

describe('badge batching', () => {
  it('asks of one frame go out as ONE request, answers fill the store, silent ids become {}', async () => {
    const { wantBadge, badges } = await mod();
    wantBadge('a'); wantBadge('b'); wantBadge('a');
    await tick();
    expect(calls.filter((c) => c.path === '/api/discover/badges')).toHaveLength(1);
    expect(calls[0]!.body!.ids.sort()).toEqual(['a', 'b']);
    expect(get(badges)).toMatchObject({ a: { fresh: 'new' }, b: {} });
  });
  it('does not ask again within five minutes, but does afterwards', async () => {
    const { wantBadge } = await mod();
    const t0 = Date.now() + 10 * 60_000; // fresh module state is shared: use a far future clock
    wantBadge('c', t0); await tick();
    const n = calls.length;
    wantBadge('c', t0 + 60_000); await tick();
    expect(calls.length).toBe(n);
    wantBadge('c', t0 + 6 * 60_000); await tick();
    expect(calls.length).toBe(n + 1);
  });
  it('a failed request marks the ids as failed (null) so cards fall back to the old hints', async () => {
    const { wantBadge, badges } = await mod();
    answer = () => { throw new Error('down'); };
    wantBadge('f1', Date.now() + 99 * 60_000); await tick();
    expect(get(badges)['f1']).toBeNull();
  });
  it('a profile switch forgets everything (nothing leaks between profiles)', async () => {
    const { wantBadge, badges } = await mod();
    wantBadge('p1only', Date.now() + 200 * 60_000); await tick();
    expect('p1only' in get(badges)).toBe(true);
    profile = 'p2';
    wantBadge('x', Date.now() + 200 * 60_000);
    expect('p1only' in get(badges)).toBe(false);
    await tick();
  });
  it('ignores empty ids', async () => {
    const { wantBadge } = await mod();
    const n = calls.length;
    wantBadge(undefined); wantBadge(''); await tick();
    expect(calls.length).toBe(n);
  });
});

describe('facts memo', () => {
  it('one request per title and five minutes; forgetFacts drops it', async () => {
    const { loadFacts, forgetFacts } = await mod();
    const t0 = Date.now() + 500 * 60_000;
    await loadFacts('z', t0); await loadFacts('z', t0 + 1000);
    expect(calls.filter((c) => c.path === '/api/items/z/facts')).toHaveLength(1);
    forgetFacts('z');
    await loadFacts('z', t0 + 2000);
    expect(calls.filter((c) => c.path === '/api/items/z/facts')).toHaveLength(2);
  });
});
