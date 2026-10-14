// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bumpPending, refreshSummary, setSummary, summary, summaryFailed, type AdminSummary } from './admin/summary';
import { poll } from './adminContent/poll';
import { hubGlow, hubGradient } from './hubs';
import { qrPath } from './qr';

describe('admin summary store', () => {
  let answer: { status: number; body?: unknown };
  const base: AdminSummary = {
    users: { total: 3, active: 2, locked: 1 },
    pending: { requests: 2, devices: 1, polls: 0, invites: 0, previewsFailed: 0 },
    requests: null,
    storage: { downloadsEnabled: true, downloadsBytes: 0, downloadsMaxBytes: 0, previewBytes: 0, previewClips: 0 },
    playbackCheck: null,
    services: { jellyfin: true, seerr: false },
    live: { streams: 0, partyRooms: 0 },
  };
  beforeEach(() => {
    answer = { status: 200, body: base };
    vi.stubGlobal('location', { pathname: '/admin', href: '/admin' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(answer.body ?? {}), { status: answer.status })));
    setSummary(null);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('parallel refreshes share one request; a failure flags the store until the next success', async () => {
    await Promise.all([refreshSummary(), refreshSummary()]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(get(summary)).toEqual(base);
    expect(get(summaryFailed)).toBe(false);
    answer = { status: 500 };
    await refreshSummary();
    expect(get(summaryFailed)).toBe(true);
    expect(get(summary)).toEqual(base); // the last good numbers stay
    answer = { status: 200, body: base };
    await refreshSummary();
    expect(get(summaryFailed)).toBe(false);
  });

  it('bumpPending adjusts a badge optimistically, never below zero, and leaves unknown (null) counts alone', () => {
    bumpPending('devices', -1); // nothing loaded yet
    expect(get(summary)).toBeNull();
    setSummary(base);
    bumpPending('devices', -1);
    bumpPending('requests', -5);
    expect(get(summary)!.pending).toMatchObject({ devices: 0, requests: 0 });
    setSummary({ ...base, pending: { ...base.pending, requests: null } });
    bumpPending('requests', 1);
    expect(get(summary)!.pending.requests).toBeNull();
  });
});

describe('visibility-aware polling', () => {
  let visibility: 'visible' | 'hidden';
  let listeners: Map<string, () => void>;
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    listeners = new Map();
    vi.stubGlobal('document', {
      get visibilityState() { return visibility; },
      addEventListener: (t: string, f: () => void) => listeners.set(t, f),
      removeEventListener: (t: string) => listeners.delete(t),
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('ticks while visible, skips while hidden, runs once on becoming visible, stops cleanly', () => {
    const fn = vi.fn();
    const stop = poll(fn, 1000);
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(2);
    visibility = 'hidden';
    vi.advanceTimersByTime(5000);
    listeners.get('visibilitychange')!();
    expect(fn).toHaveBeenCalledTimes(2);
    visibility = 'visible';
    listeners.get('visibilitychange')!();
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
    expect(listeners.size).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('works without a document (server side): plain interval', () => {
    vi.stubGlobal('document', undefined);
    const fn = vi.fn();
    const stop = poll(fn, 1000);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
  });
});

describe('brand hub tiles', () => {
  it('use the accent colour when set, else a stable hue derived from the name', () => {
    expect(hubGradient({ name: 'Pixar', accent: '#123456' })).toBe('linear-gradient(135deg, #123456, color-mix(in srgb, #123456 22%, #0a0d10))');
    expect(hubGlow({ name: 'Pixar', accent: '#123456' })).toBe('#123456');
    const g = hubGradient({ name: 'Pixar' });
    expect(g).toBe(hubGradient({ name: 'Pixar' }));
    expect(g).not.toBe(hubGradient({ name: 'Marvel' }));
    expect(g).toMatch(/^linear-gradient\(135deg, hsl\(\d{1,3} 58% 36%\), hsl\(\d{1,3} 55% 12%\)\)$/);
    expect(hubGlow({ name: 'Pixar' })).toMatch(/^hsl\(\d{1,3} 70% 55%\)$/);
  });
});

describe('QR code path', () => {
  it('draws one unit square per dark module of a square, version-sized code', () => {
    const { size, d } = qrPath('https://portal.example/tv/pair?code=ABCD-1234');
    expect(size).toBeGreaterThanOrEqual(21);
    expect((size - 17) % 4).toBe(0); // QR sizes are 17 + 4 * version
    const squares = [...d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)];
    expect(squares.length).toBe(d.split('M').length - 1); // nothing but squares
    expect(squares.every(([, c, r]) => Number(c) < size && Number(r) < size)).toBe(true);
    // the three finder patterns: top-left corner module is dark
    expect(d.startsWith('M0 0h1v1h-1z')).toBe(true);
  });

  it('longer text needs a bigger code', () => {
    expect(qrPath('x'.repeat(200)).size).toBeGreaterThan(qrPath('x').size);
  });
});
