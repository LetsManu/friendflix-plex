import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROBE_KEY, checkSupport, detectSupport, probeSyncAccess, resetProbe } from './opfs';

/** a main thread like real Chrome/Firefox/Safari: OPFS + FileSystemFileHandle, but no createSyncAccessHandle outside workers */
function stubBrowser(over: { secure?: boolean; tv?: boolean; ios?: boolean } = {}) {
  const ss = new Map<string, string>();
  vi.stubGlobal('window', { isSecureContext: over.secure ?? true, indexedDB: {} });
  vi.stubGlobal('document', { documentElement: { classList: { contains: (c: string) => c === 'tv' && Boolean(over.tv) } } });
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => ss.get(k) ?? null, setItem: (k: string, v: string) => ss.set(k, v), removeItem: (k: string) => ss.delete(k) });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({}) }, userAgent: over.ios ? 'iPhone' : 'Chrome', platform: 'Linux', maxTouchPoints: 0 });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('FileSystemFileHandle', class { getFile() { return null; } });
  vi.stubGlobal('Worker', class {});
  return ss;
}

/** fake probe worker answering `sync` (or never answering with null) */
function fakeWorker(sync: boolean | null, made: { n: number } = { n: 0 }) {
  return () => {
    made.n++;
    const w = { onmessage: null as null | ((e: MessageEvent) => void), onerror: null, terminate: vi.fn() };
    if (sync !== null) queueMicrotask(() => w.onmessage?.({ data: { type: 'opfs-probe', sync } } as MessageEvent));
    return w as unknown as Worker;
  };
}

beforeEach(() => { resetProbe(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('download support', () => {
  it('the main thread no longer requires createSyncAccessHandle (only exposed in workers)', () => {
    stubBrowser();
    expect(detectSupport()).toEqual({ ok: true });
  });

  it('keeps the tv / insecure / ios-install reasons', () => {
    stubBrowser({ tv: true }); expect(detectSupport()).toEqual({ ok: false, reason: 'tv' });
    stubBrowser({ secure: false }); expect(detectSupport()).toEqual({ ok: false, reason: 'insecure' });
    stubBrowser({ ios: true }); expect(detectSupport()).toEqual({ ok: false, reason: 'ios-install' });
  });

  it('checkSupport asks a worker once and caches the answer (memory + sessionStorage)', async () => {
    const ss = stubBrowser();
    const made = { n: 0 };
    expect(await checkSupport(fakeWorker(true, made))).toEqual({ ok: true });
    expect(await checkSupport(fakeWorker(true, made))).toEqual({ ok: true });
    expect(made.n).toBe(1);
    expect(ss.get(PROBE_KEY)).toBe('1');
    resetProbe(); // new module state (e.g. reload): the sessionStorage answer is used, no new worker
    expect(await probeSyncAccess(fakeWorker(false, made))).toBe(true);
    expect(made.n).toBe(1);
  });

  it('no sync access in the worker → no-opfs', async () => {
    const ss = stubBrowser();
    expect(await checkSupport(fakeWorker(false))).toEqual({ ok: false, reason: 'no-opfs' });
    expect(ss.get(PROBE_KEY)).toBe('0');
  });

  it('a silent worker times out as unsupported without caching', async () => {
    const ss = stubBrowser();
    vi.useFakeTimers();
    const p = checkSupport(fakeWorker(null), 2000);
    await vi.advanceTimersByTimeAsync(2001);
    expect(await p).toEqual({ ok: false, reason: 'no-opfs' });
    expect(ss.has(PROBE_KEY)).toBe(false);
  });

  it('a worker that cannot start → unsupported; other reasons skip the probe', async () => {
    stubBrowser();
    expect(await checkSupport(() => { throw new Error('csp'); })).toEqual({ ok: false, reason: 'no-opfs' });
    resetProbe();
    stubBrowser({ tv: true });
    const made = { n: 0 };
    expect(await checkSupport(fakeWorker(true, made))).toEqual({ ok: false, reason: 'tv' });
    expect(made.n).toBe(0);
  });
});
