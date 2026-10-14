// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'ff.stillwatching';
const MIN = 60_000;
let store: Map<string, string>;
type Mod = typeof import('./stillwatching');
let S: Mod;
type P = Parameters<Mod['shouldAsk']>[1];
const on: P = { stillWatching: true, stillWatchingEpisodes: 3 };

async function fresh() {
  vi.resetModules();
  S = await import('./stillwatching');
}
beforeEach(async () => {
  store = new Map();
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  await fresh();
});
afterEach(() => vi.unstubAllGlobals());

describe('"Are you still watching?"', () => {
  it('asks after the configured number of unattended autoplays; an interaction resets the chain', () => {
    S.noteInteraction(1_000);
    S.noteAutoplay();
    S.noteAutoplay();
    expect(S.shouldAsk(2_000, on)).toBe(false);
    S.noteAutoplay();
    expect(S.shouldAsk(2_000, on)).toBe(true);
    expect(S.shouldAsk(2_000, { ...on, stillWatchingEpisodes: 4 })).toBe(false);
    S.noteInteraction(3_000);
    expect(S.shouldAsk(3_000, on)).toBe(false);
  });

  it('asks after 90 minutes without any interaction, never when the setting is off', () => {
    S.noteInteraction(0);
    expect(S.shouldAsk(90 * MIN - 1, on)).toBe(false);
    expect(S.shouldAsk(90 * MIN, on)).toBe(true);
    expect(S.shouldAsk(90 * MIN, { stillWatching: false, stillWatchingEpisodes: 3 })).toBe(false);
  });

  it('defaults to 3 episodes when the preference is 0/unset', () => {
    S.noteInteraction(0);
    for (let i = 0; i < 3; i++) S.noteAutoplay();
    expect(S.shouldAsk(1, { stillWatching: true, stillWatchingEpisodes: 0 as unknown as P['stillWatchingEpisodes'] })).toBe(true); // legacy/unset value
  });

  it('survives a page load within the tab (sessionStorage) and ignores corrupt data', async () => {
    S.noteInteraction(500);
    S.noteAutoplay();
    S.noteAutoplay();
    S.noteAutoplay();
    expect(JSON.parse(store.get(KEY)!)).toEqual({ chain: 3, lastInteraction: 500 });
    await fresh();
    expect(S.shouldAsk(600, on)).toBe(true);
    store.set(KEY, '{"chain":"x"}');
    await fresh();
    expect(S.shouldAsk(Date.now(), on)).toBe(false);
    store.set(KEY, 'not json');
    await fresh();
    expect(S.shouldAsk(Date.now(), on)).toBe(false);
  });

  it('works in memory when storage is unavailable', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('SecurityError'); } });
    await fresh();
    S.noteInteraction(0);
    for (let i = 0; i < 3; i++) S.noteAutoplay();
    expect(S.shouldAsk(1, on)).toBe(true);
  });

  it('consumeAutoplay is true once after an autoplay', () => {
    expect(S.consumeAutoplay()).toBe(false);
    S.noteAutoplay();
    expect(S.consumeAutoplay()).toBe(true);
    expect(S.consumeAutoplay()).toBe(false);
  });
});
