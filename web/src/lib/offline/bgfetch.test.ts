// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abortBg, bgSupported, bgTag, onBgMessage, startBg, watchBg } from './bgfetch';

class FakeReg extends EventTarget { downloaded = 0; aborted = false; async abort() { this.aborted = true; return true; } }
let regs: Map<string, FakeReg>;
let fetched: Array<{ tag: string; urls: string[]; opts: any }>;
let fetchFails: boolean;
let swListeners: Array<(e: any) => void>;
const bf = {
  get: async (t: string) => regs.get(t),
  fetch: async (tag: string, urls: string[], opts: any) => {
    if (fetchFails) throw new TypeError('denied');
    fetched.push({ tag, urls, opts });
    const r = new FakeReg(); regs.set(tag, r); return r;
  },
};
const stubSw = (registration: unknown) => vi.stubGlobal('navigator', {
  serviceWorker: { getRegistration: async () => registration, addEventListener: (_t: string, f: (e: any) => void) => swListeners.push(f) },
});

beforeEach(() => {
  regs = new Map(); fetched = []; fetchFails = false; swListeners = [];
  stubSw({ backgroundFetch: bf });
});
afterEach(() => vi.unstubAllGlobals());

describe('bgfetch', () => {
  it('is supported only with a service worker registration that has backgroundFetch', async () => {
    expect(await bgSupported()).toBe(true);
    stubSw({});
    expect(await bgSupported()).toBe(false);
    stubSw(undefined);
    expect(await bgSupported()).toBe(false);
    vi.stubGlobal('navigator', {});
    expect(await bgSupported()).toBe(false);
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => { throw new Error('x'); } } });
    expect(await bgSupported()).toBe(false);
  });

  it('starts one fetch per download with title, icon and total; a second start reports running', async () => {
    expect(await startBg('a', '/media/d/a', { title: 'Film', total: 1000, icon: '/icon-192.png' })).toBe('started');
    expect(fetched).toEqual([{ tag: 'ff-dl-a', urls: ['/media/d/a'], opts: { title: 'Film', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }], downloadTotal: 1100 } }]); // room for an estimated size
    expect(await startBg('a', '/media/d/a', { title: 'Film', total: 1000 })).toBe('running');
    expect(await startBg('b', '/media/d/b', { title: 'B', total: 0 })).toBe('started');
    expect(fetched[1]!.opts).toEqual({ title: 'B', icons: [] }); // unknown size: no downloadTotal
  });

  it('a refused fetch or a missing manager is failed', async () => {
    fetchFails = true;
    expect(await startBg('a', '/media/d/a', { title: 'x', total: 1 })).toBe('failed');
    stubSw({});
    expect(await startBg('a', '/media/d/a', { title: 'x', total: 1 })).toBe('failed');
  });

  it('watch reports the current and every later progress; false without a fetch', async () => {
    await startBg('a', '/media/d/a', { title: 'x', total: 1 });
    const seen: number[] = [];
    regs.get(bgTag('a'))!.downloaded = 10;
    expect(await watchBg('a', (n) => seen.push(n))).toBe(true);
    regs.get(bgTag('a'))!.downloaded = 70;
    regs.get(bgTag('a'))!.dispatchEvent(new Event('progress'));
    expect(seen).toEqual([10, 70]);
    expect(await watchBg('zzz', () => undefined)).toBe(false);
    stubSw({});
    expect(await watchBg('a', () => undefined)).toBe(false);
  });

  it('abort stops a running fetch and ignores a missing one', async () => {
    await startBg('a', '/media/d/a', { title: 'x', total: 1 });
    await abortBg('a');
    expect(regs.get('ff-dl-a')!.aborted).toBe(true);
    await abortBg('zzz');
  });

  it('passes on service worker messages about downloads only', () => {
    const ids: string[] = [];
    onBgMessage((id) => ids.push(id));
    for (const data of [{ type: 'ff-dl', id: 'a' }, { type: 'other', id: 'b' }, undefined, { type: 'ff-dl', id: 3 }]) swListeners[0]!({ data });
    expect(ids).toEqual(['a']);
  });
});
