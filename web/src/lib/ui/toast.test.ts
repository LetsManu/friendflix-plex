// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_DURATION, MAX_VISIBLE, close, dismissAll, pause, resume, runToastAction, toast, toasts } from './toast';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { dismissAll(); vi.useRealTimers(); });

describe('toast store', () => {
  it('shows and auto-dismisses after the kind default', () => {
    const onClose = vi.fn();
    toast.success('Gespeichert.', { onClose });
    expect(get(toasts).map((x) => [x.kind, x.message])).toEqual([['success', 'Gespeichert.']]);
    vi.advanceTimersByTime(4999);
    expect(get(toasts)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(get(toasts)).toHaveLength(0);
    expect(onClose).toHaveBeenCalledWith('timeout');
  });
  it('errors stay longer, duration 0 is sticky, actions get the action duration', () => {
    toast.error('x'); toast.info('sticky', { duration: 0 }); toast.info('a', { action: { label: 'Undo', run: () => undefined } });
    expect(get(toasts).find((x) => x.message === 'a')!.duration).toBe(ACTION_DURATION);
    vi.advanceTimersByTime(7000);
    expect(get(toasts).map((x) => x.message)).toEqual(['x', 'sticky']);
    vi.advanceTimersByTime(1000);
    expect(get(toasts).map((x) => x.message)).toEqual(['sticky']);
    vi.advanceTimersByTime(60_000);
    expect(get(toasts)).toHaveLength(1);
  });
  it(`stacks at most ${MAX_VISIBLE}; the oldest is replaced`, () => {
    const first = vi.fn();
    toast.info('1', { onClose: first }); toast.info('2'); toast.info('3'); toast.info('4');
    expect(get(toasts).map((x) => x.message)).toEqual(['2', '3', '4']);
    expect(first).toHaveBeenCalledWith('replaced');
  });
  it('a key replaces the toast with the same key', () => {
    toast.success('a', { key: 'k' }); toast.success('b', { key: 'k' });
    expect(get(toasts).map((x) => x.message)).toEqual(['b']);
  });
  it('runs the action once and closes with reason action', async () => {
    const run = vi.fn(), onClose = vi.fn();
    const id = toast.info('Abgelehnt', { action: { label: 'Rückgängig', run }, onClose });
    runToastAction(id); runToastAction(id);
    await Promise.resolve(); await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('action');
  });
  it('dismiss closes with reason dismiss; pause/resume hold the timer', () => {
    const onClose = vi.fn();
    const id = toast.info('p', { onClose });
    vi.advanceTimersByTime(4000);
    pause();
    vi.advanceTimersByTime(10_000);
    expect(get(toasts)).toHaveLength(1);
    resume();
    vi.advanceTimersByTime(1499);
    expect(get(toasts)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(onClose).toHaveBeenCalledWith('timeout');
    const id2 = toast.info('q', { onClose });
    close(id2);
    expect(onClose).toHaveBeenLastCalledWith('dismiss');
    close(id); // already gone: no-op
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
