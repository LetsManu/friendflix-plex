import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '#lib/api';
import { busyKeys, deferredCount, errorText, flushDeferred, isBusy, runAction } from './action';
import { dismissAll, runToastAction, toasts } from './toast';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { dismissAll(); vi.useRealTimers(); });

describe('runAction', () => {
  it('applies optimistically, toasts success and clears the busy flag', async () => {
    let v = 'old';
    const p = runAction({ key: 'k1', apply: () => { const prev = v; v = 'new'; return () => (v = prev); }, run: async () => 42, success: (r) => `ok ${r}` });
    expect(v).toBe('new');
    expect(isBusy('k1')).toBe(true);
    expect(get(busyKeys).has('k1')).toBe(true);
    expect(await p).toEqual({ ok: true, value: 42 });
    expect(isBusy('k1')).toBe(false);
    expect(get(toasts).map((x) => [x.kind, x.message])).toEqual([['success', 'ok 42']]);
  });
  it('rolls back and shows a status-aware error', async () => {
    let v = 'old';
    const r = await runAction({ apply: () => { v = 'new'; return () => (v = 'old'); }, run: () => Promise.reject(new ApiError(403, {})) });
    expect(r.ok).toBe(false);
    expect(v).toBe('old');
    expect(get(toasts)[0]).toMatchObject({ kind: 'error', message: errorText(new ApiError(403, {})) });
  });
  it('skips a second call with a busy key', async () => {
    let done!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => (done = r)));
    const a = runAction({ key: 'k2', run });
    expect(await runAction({ key: 'k2', run })).toEqual({ ok: false, skipped: true });
    done(); await a;
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('undo calls the inverse and restores the local state', async () => {
    let v = 'a';
    const inverse = vi.fn(async () => undefined);
    await runAction({ key: 'k3', apply: () => { v = 'b'; return () => (v = 'a'); }, run: async () => undefined, success: 'Gesperrt', undo: { run: inverse } });
    const t = get(toasts)[0]!;
    expect(t.action).toBeTruthy();
    runToastAction(t.id);
    await vi.runAllTimersAsync();
    expect(inverse).toHaveBeenCalledTimes(1);
    expect(v).toBe('a');
  });
  it('defer: commits only after the toast is gone; undo just rolls back', async () => {
    let v = 'a';
    const run = vi.fn(async () => 'done');
    const apply = () => { v = 'b'; return () => (v = 'a'); };
    const p1 = runAction({ key: 'd', apply, run, defer: 1000, success: 'Abgelehnt' });
    expect(v).toBe('b');
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(await p1).toEqual({ ok: true, value: 'done' });
    expect(run).toHaveBeenCalledTimes(1);

    const p2 = runAction({ key: 'd', apply, run, defer: true, success: 'Abgelehnt' });
    runToastAction(get(toasts).at(-1)!.id);
    expect(await p2).toEqual({ ok: false, undone: true });
    expect(v).toBe('a');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('defer: flushDeferred() commits waiting actions at once (leaving the page) and closes their toasts', async () => {
    const run = vi.fn(async () => 'x');
    const p = runAction({ key: 'f1', run, defer: true, success: 'Abgelehnt' });
    const q = runAction({ key: 'f2', run, defer: true, success: 'Widerrufen' });
    expect(deferredCount()).toBe(2);
    expect(flushDeferred()).toBe(2);
    expect(run).toHaveBeenCalledTimes(2); // synchronously, before the page can go away
    expect(await p).toEqual({ ok: true, value: 'x' });
    expect(await q).toEqual({ ok: true, value: 'x' });
    expect(get(toasts)).toEqual([]);
    expect(deferredCount()).toBe(0);
    expect(isBusy('f1')).toBe(false);
    expect(flushDeferred()).toBe(0);
  });
  it('defer: pagehide commits with keepalive requests; an undone action is not committed', async () => {
    const win = new EventTarget();
    const fetchMock = vi.fn(async (_u: string, _init: RequestInit) => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('window', win);
    vi.stubGlobal('fetch', fetchMock);
    try {
      const undone = runAction({ key: 'u', run: () => api('/api/x/undone', { method: 'POST' }), defer: true });
      runToastAction(get(toasts).at(-1)!.id);
      expect(await undone).toEqual({ ok: false, undone: true });
      const p = runAction({ key: 'ph', run: () => api('/api/x/decline', { method: 'POST' }), defer: true, success: 'Abgelehnt' });
      win.dispatchEvent(new Event('pagehide'));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toBe('/api/x/decline');
      expect(fetchMock.mock.calls[0]![1].keepalive).toBe(true);
      expect(await p).toMatchObject({ ok: true });
      // a normal request afterwards is not keepalive
      await api('/api/x/other');
      expect(fetchMock.mock.calls[1]![1].keepalive).toBeUndefined();
    } finally { vi.unstubAllGlobals(); }
  });
  it('defer: a failing flushed commit rolls back and reports the error', async () => {
    let v = 'a';
    const p = runAction({ apply: () => { v = 'b'; return () => (v = 'a'); }, run: () => Promise.reject(new ApiError(500, {})), defer: true });
    flushDeferred();
    expect(await p).toMatchObject({ ok: false });
    expect(v).toBe('a');
    expect(get(toasts).at(-1)).toMatchObject({ kind: 'error' });
  });
  it('maps errors to texts', () => {
    expect(errorText(new TypeError('Failed to fetch'))).toBe(errorText(new TypeError('x')));
    expect(errorText(new ApiError(500, null))).not.toBe(errorText(new ApiError(404, null)));
  });
});
