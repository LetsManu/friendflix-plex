// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { nextLocalState, pumpable } from './transition';

const p = (status: 'queued' | 'preparing' | 'ready' | 'failed', percent = 0) => ({ status, percent });

describe('nextLocalState', () => {
  it('preparing + server ready -> queued, prep cleared (stuck at 99 %)', () => {
    expect(nextLocalState('preparing', p('ready', 100))).toEqual({ state: 'queued', prep: undefined });
  });
  it('a record persisted as preparing recovers once the server is ready', () => {
    const t = nextLocalState('preparing', p('ready', 100));
    expect(pumpable(t!.state, true)).toBe(true);
  });
  it('queued + ready stays queued and is pumpable', () => {
    const t = nextLocalState('queued', p('ready', 100));
    expect(t!.state).toBe('queued');
    expect(pumpable(t!.state, true)).toBe(true);
  });
  it('not pumpable before the server is ready', () => expect(pumpable('preparing', false)).toBe(false));
  it('failed -> error', () => expect(nextLocalState('preparing', p('failed'))?.state).toBe('error'));
  it('preparing keeps its percent, queued resets it', () => {
    expect(nextLocalState('queued', p('preparing', 42))).toEqual({ state: 'preparing', prep: 42 });
    expect(nextLocalState('preparing', p('queued', 5))).toEqual({ state: 'queued', prep: 0 });
  });
  it.each(['downloading', 'done', 'paused', 'error', 'expired'] as const)('does not touch %s', (s) => {
    for (const st of ['ready', 'failed', 'preparing', 'queued'] as const) expect(nextLocalState(s, p(st, 50))).toBeNull();
  });
});
