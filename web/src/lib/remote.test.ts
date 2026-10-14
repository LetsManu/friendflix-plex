// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Minimal WebSocket double: tests drive open/message/close by hand. */
class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeWS.all.push(this); }
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; this.readyState = 3; }
  // test helpers
  open() { this.readyState = 1; this.onopen?.(); }
  receive(m: unknown) { this.onmessage?.({ data: typeof m === 'string' ? m : JSON.stringify(m) }); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}
const last = () => FakeWS.all.at(-1)!;

let classes: Set<string>;
type Remote = typeof import('./remote');
let R: Remote;

beforeEach(async () => {
  vi.useFakeTimers();
  FakeWS.all = [];
  classes = new Set();
  vi.stubGlobal('WebSocket', FakeWS);
  vi.stubGlobal('location', { protocol: 'https:', host: 'portal.example' });
  vi.stubGlobal('document', { documentElement: { classList: { contains: (c: string) => classes.has(c) } } });
  vi.resetModules();
  R = await import('./remote');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('phone side', () => {
  it('connects as role remote over wss and mirrors hello/peers/status messages into the stores', () => {
    const release = R.holdRemote();
    expect(last().url).toBe('wss://portal.example/ws/remote?role=remote');
    last().open();
    last().receive({ t: 'hello', tvOnline: true });
    expect(get(R.tvOnline)).toBe(true);
    last().receive({ t: 'status', itemId: 'i1', title: 'Film', paused: false });
    expect(get(R.tvStatus)).toEqual({ itemId: 'i1', title: 'Film', paused: false });
    last().receive('not json'); // garbage is ignored
    last().receive({ t: 'peers', tvOnline: false });
    expect(get(R.tvOnline)).toBe(false);
    expect(get(R.tvStatus)).toBeNull();
    release();
  });

  it('closes the connection 4 s after the last hold is released, not while another hold is active', () => {
    const a = R.holdRemote();
    const b = R.holdRemote();
    expect(FakeWS.all).toHaveLength(1); // shared connection
    const ws = last();
    ws.open();
    ws.receive({ t: 'hello', tvOnline: true });
    a();
    a(); // releasing twice counts once
    vi.advanceTimersByTime(5000);
    expect(ws.closed).toBe(false);
    b();
    vi.advanceTimersByTime(3999);
    expect(ws.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(ws.closed).toBe(true);
    expect(get(R.tvOnline)).toBe(false);
  });

  it('sendToTv waits for the socket to open, then sends', async () => {
    const p = R.castToTv('item-1', 42);
    expect(last().sent).toEqual([]);
    last().open();
    await expect(p).resolves.toBe(true);
    expect(last().sent).toEqual([{ t: 'cast', itemId: 'item-1', startSec: 42 }]);
    // already open: sent at once
    await expect(R.sendToTv({ t: 'ctl', action: 'pause' })).resolves.toBe(true);
    expect(last().sent.at(-1)).toEqual({ t: 'ctl', action: 'pause' });
  });

  it('sendToTv gives up after 4 s when the hub is unreachable', async () => {
    const p = R.sendToTv({ t: 'ctl', action: 'toggle' });
    vi.advanceTimersByTime(4000);
    await expect(p).resolves.toBe(false);
    expect(last().sent).toEqual([]);
  });

  it('reconnects with exponential backoff (1 s, 2 s, 4 s ... capped at 15 s), reset after a successful open', () => {
    R.holdRemote();
    last().drop();
    expect(FakeWS.all).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(FakeWS.all).toHaveLength(2);
    last().drop();
    vi.advanceTimersByTime(1999);
    expect(FakeWS.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWS.all).toHaveLength(3);
    for (let i = 0; i < 5; i++) { last().drop(); vi.advanceTimersByTime(15_000); }
    const before = FakeWS.all.length;
    last().drop();
    vi.advanceTimersByTime(14_999);
    expect(FakeWS.all).toHaveLength(before);
    vi.advanceTimersByTime(1);
    expect(FakeWS.all).toHaveLength(before + 1);
    last().open();
    last().drop();
    vi.advanceTimersByTime(1000);
    expect(FakeWS.all).toHaveLength(before + 2);
  });
});

describe('refreshTvOnline', () => {
  it('reads /api/tv/status and updates the store', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ tvOnline: true }))));
    await expect(R.refreshTvOnline()).resolves.toBe(true);
    expect(get(R.tvOnline)).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await expect(R.refreshTvOnline()).resolves.toBe(false);
    expect(get(R.tvOnline)).toBe(false);
  });

  it('a network error answers false; the TV itself never asks', async () => {
    const f = vi.fn(async () => { throw new TypeError('offline'); });
    vi.stubGlobal('fetch', f);
    await expect(R.refreshTvOnline()).resolves.toBe(false);
    classes.add('tv');
    f.mockClear();
    await expect(R.refreshTvOnline()).resolves.toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('TV side', () => {
  it('connects as role tv, forwards only cast/ctl commands', () => {
    const cmds: unknown[] = [];
    const stop = R.startTvLink((m) => cmds.push(m), () => undefined);
    expect(last().url).toBe('wss://portal.example/ws/remote?role=tv');
    last().open();
    last().receive({ t: 'cast', itemId: 'x' });
    last().receive({ t: 'ctl', action: 'seekBy', value: 10 });
    last().receive({ t: 'status' });
    last().receive(null);
    expect(cmds).toEqual([{ t: 'cast', itemId: 'x' }, { t: 'ctl', action: 'seekBy', value: 10 }]);
    stop();
    expect(last().closed).toBe(true);
  });

  it('reports a cleaned status every 2 s and at once when play state or title changes', () => {
    const stop = R.startTvLink(() => undefined, () => undefined);
    const ws = last();
    ws.open();
    R.nowPlaying.set({
      itemId: 'i1', title: 'T'.repeat(300), position: 12.7, duration: Number.NaN, paused: false,
      audio: [{ i: 1, t: 'Deutsch' }], audioSel: 1, subs: Array.from({ length: 20 }, (_, i) => ({ i, t: `S${i}` })), subSel: 3,
    });
    const s = ws.sent.at(-1) as Record<string, any>;
    expect(s).toMatchObject({ t: 'status', itemId: 'i1', position: 12, paused: false, audio: [{ i: 1, t: 'Deutsch' }], audioSel: 1, subSel: 3 });
    expect(s.title).toHaveLength(200);
    expect(s).not.toHaveProperty('duration'); // NaN would make the server drop the whole message
    expect(s.subs).toHaveLength(16);
    const n = ws.sent.length;
    R.nowPlaying.set({ itemId: 'i1', title: 'x', position: 13, paused: false, audio: [{ i: 1, t: 'Deutsch' }], audioSel: 1, subs: s.subs, subSel: 3 });
    expect(ws.sent).toHaveLength(n); // only the position changed: waits for the heartbeat
    vi.advanceTimersByTime(2000);
    expect(ws.sent).toHaveLength(n + 1);
    R.nowPlaying.set({ itemId: 'i1', paused: true });
    expect(ws.sent).toHaveLength(n + 2);
    R.nowPlaying.set(null);
    expect(ws.sent.at(-1)).toEqual({ t: 'status' });
    stop();
    vi.advanceTimersByTime(10_000);
    expect(ws.sent).toHaveLength(n + 3);
  });

  it('stops for good when the server replaces this TV (4000) or rejects it (4401)', () => {
    for (const code of [4000, 4401]) {
      const fatal = vi.fn();
      const before = FakeWS.all.length;
      R.startTvLink(() => undefined, fatal);
      last().drop(code);
      vi.advanceTimersByTime(60_000);
      expect(fatal).toHaveBeenCalledWith(code);
      expect(FakeWS.all).toHaveLength(before + 1);
    }
  });

  it('uses ws:// on plain http and does not reconnect after stop', () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'tv.local:3000' });
    const stop = R.startTvLink(() => undefined, () => undefined);
    expect(last().url).toBe('ws://tv.local:3000/ws/remote?role=tv');
    const ws = last();
    stop();
    ws.drop();
    vi.advanceTimersByTime(30_000);
    expect(FakeWS.all).toHaveLength(1);
  });
});
