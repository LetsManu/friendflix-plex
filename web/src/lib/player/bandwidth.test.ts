// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BandwidthEstimator, loadStoredEstimate, storeEstimate } from './bandwidth';

/** in-memory stand-in for window.localStorage */
function fakeStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
  };
}
const DAY = 86400000;

afterEach(() => vi.unstubAllGlobals());

describe('BandwidthEstimator', () => {
  it('ignores samples under minBytes (default 64 KiB)', () => {
    const e = new BandwidthEstimator();
    e.add(65535, 100);
    expect(e.samples).toBe(0);
    expect(e.estimate).toBeNull();
    e.add(65536, 100);
    expect(e.samples).toBe(1);
    expect(e.estimate).not.toBeNull();
  });

  it('ignores NaN bytes', () => {
    const e = new BandwidthEstimator();
    e.add(NaN, 100);
    expect(e.samples).toBe(0);
    expect(e.estimate).toBeNull();
  });

  it('honours a custom minBytes and ignores samples that took no time', () => {
    const e = new BandwidthEstimator({ minBytes: 1000 });
    e.add(999, 10);
    expect(e.samples).toBe(0);
    e.add(1000, 0);
    e.add(1000, -5);
    expect(e.samples).toBe(0);
    expect(e.estimate).toBeNull();
  });

  it('reports bit/s: 1 MB in 1000 ms is 8 Mbit/s', () => {
    const e = new BandwidthEstimator();
    e.add(1_000_000, 1000);
    expect(e.estimate).toBe(8_000_000);
  });

  it('ewma converges: add(1_000_000 B, 1000 ms) x5 → estimate ≈ 8_000_000 ±5%', () => {
    const e = new BandwidthEstimator();
    for (let i = 0; i < 5; i++) e.add(1_000_000, 1000);
    expect(e.samples).toBe(5);
    expect(Math.abs((e.estimate ?? 0) - 8_000_000)).toBeLessThanOrEqual(8_000_000 * 0.05);
  });

  it('follows a change in speed (ewma, alpha 0.3)', () => {
    const e = new BandwidthEstimator();
    e.add(1_000_000, 1000); // 8 Mbit/s
    e.add(1_000_000, 2000); // 4 Mbit/s: 8 + 0.3 * (4 - 8) = 6.8 Mbit/s
    expect(e.estimate).toBeCloseTo(6_800_000, -3);
  });

  it('one 10x outlier moves the estimate < 30 %', () => {
    const e = new BandwidthEstimator();
    for (let i = 0; i < 5; i++) e.add(1_000_000, 1000);
    const before = e.estimate!;
    e.add(1_000_000, 10_000); // a 10x slower stall
    expect(Math.abs(e.estimate! - before) / before).toBeLessThan(0.3);
  });

  it('caps an optimistic sample at 1.5x the current estimate', () => {
    const e = new BandwidthEstimator();
    e.add(1_000_000, 1000); // 8 Mbit/s
    e.add(1_000_000, 10); // 800 Mbit/s, capped to 12 Mbit/s: 8 + 0.3 * (12 - 8) = 9.2 Mbit/s
    expect(e.estimate).toBeCloseTo(9_200_000, -3);
  });

  it('fast 10x outlier moves the estimate < 30 %', () => {
    const e = new BandwidthEstimator();
    e.add(1_000_000, 1000); // 8 Mbit/s
    e.add(1_000_000, 100); // 80 Mbit/s, capped to 12 Mbit/s: 0.7 * 8 + 0.3 * 12 = 9.2 Mbit/s
    expect(e.estimate).toBeCloseTo(9_200_000, -3);
    expect(Math.abs(e.estimate! - 8_000_000) / 8_000_000).toBeLessThan(0.3);
  });
});

describe('stored estimate', () => {
  it('store/load roundtrip under key ff_bw as {bps, at}', () => {
    const s = fakeStorage();
    vi.stubGlobal('localStorage', s);
    storeEstimate(5_000_000, 1_000);
    expect(JSON.parse(s.m.get('ff_bw')!)).toEqual({ bps: 5_000_000, at: 1_000 });
    expect(loadStoredEstimate(2_000)).toBe(5_000_000);
  });

  it('load returns null after 7 days', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    storeEstimate(5_000_000, 0);
    expect(loadStoredEstimate(7 * DAY)).toBe(5_000_000);
    expect(loadStoredEstimate(7 * DAY + 1)).toBeNull();
  });

  it('load returns null on corrupt JSON, wrong shape, or a missing value', () => {
    vi.stubGlobal('localStorage', fakeStorage({ ff_bw: '{not json' }));
    expect(loadStoredEstimate(0)).toBeNull();
    vi.stubGlobal('localStorage', fakeStorage({ ff_bw: JSON.stringify({ bps: 'fast', at: 0 }) }));
    expect(loadStoredEstimate(0)).toBeNull();
    vi.stubGlobal('localStorage', fakeStorage());
    expect(loadStoredEstimate(0)).toBeNull();
  });

  it('a throwing storage (private mode, blocked site data) is silent', () => {
    const boom = () => { throw new Error('SecurityError'); };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom });
    expect(() => storeEstimate(5_000_000, 0)).not.toThrow();
    expect(loadStoredEstimate(0)).toBeNull();
  });
});
