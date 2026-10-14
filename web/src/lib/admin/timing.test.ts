// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { biggestPhase, fmtMbit, fmtMs, fmtPct, groupBiggest, longRemoteSegments, orderGroups, rowSteps, type TimingGroup, type TimingRow } from './timing';

const pct = (p50: number | null, p90: number | null = p50) => ({ p50, p90 });
const group = (over: Partial<TimingGroup> = {}): TimingGroup => ({
  home: false, device: null, n: 5, switches: 0, total: pct(3000), targetDuration: 6, seekP50: null, stallsPerSession: 0, stallMsPerSession: 0,
  phases: { info: pct(300), manifest: pct(400), firstFrag: pct(1800), firstFrame: pct(500) }, ...over,
});
const row = (over: Partial<TimingRow> = {}): TimingRow => ({
  at: '2026-10-14T08:00:00Z', home: false, device: 'phone', mode: 'hls', qualitySwitch: false, bitrate: 8e6, targetDuration: 6, infoMs: 300, manifestMs: 700,
  firstFragMs: 2500, firstFragBytes: 4e6, firstFragDlMs: 1500, firstFrameMs: 3000, seeks: 0, seekMedianMs: null, seekMaxMs: null, stalls: 0, stallMs: 0, effectiveType: null, ...over,
});

describe('admin start-time helpers', () => {
  it('biggestPhase / groupBiggest pick the largest median', () => {
    expect(groupBiggest(group())).toBe('firstFrag');
    expect(biggestPhase({ info: 900, manifest: null, firstFrame: 100 })).toBe('info');
    expect(biggestPhase({ info: null })).toBeNull();
  });

  it('rowSteps subtracts the last measured earlier phase (direct play: frame minus info)', () => {
    expect(rowSteps(row())).toEqual({ info: 300, manifest: 400, firstFrag: 1800, firstFrame: 500 });
    expect(rowSteps(row({ manifestMs: null, firstFragMs: null, firstFrameMs: 900 }))).toEqual({ info: 300, manifest: null, firstFrag: null, firstFrame: 600 });
    expect(rowSteps(row({ infoMs: null, manifestMs: 50, firstFragMs: 20, firstFrameMs: null }))).toEqual({ info: null, manifest: 50, firstFrag: 0, firstFrame: null });
  });

  it('longRemoteSegments: remote "all devices" row with 6 s or more', () => {
    expect(longRemoteSegments([group({ home: true, targetDuration: 10 }), group({ targetDuration: 6 })])).toBe(6);
    expect(longRemoteSegments([group({ targetDuration: 3 })])).toBeNull();
    expect(longRemoteSegments([group({ targetDuration: null })])).toBeNull();
    expect(longRemoteSegments([group({ n: 0 })])).toBeNull();
    expect(longRemoteSegments([group({ device: 'phone' })])).toBeNull();
    expect(longRemoteSegments([])).toBeNull();
  });

  it('orderGroups: home before remote, "all" first, then phone, pc, tv', () => {
    const gs = [group({ device: 'tv' }), group({ home: true, device: 'pc' }), group({ device: 'phone' }), group(), group({ home: true }), group({ device: 'pc' })];
    expect(orderGroups(gs).map((g) => `${g.home ? 'h' : 'r'}:${g.device ?? 'all'}`)).toEqual(['h:all', 'h:pc', 'r:all', 'r:phone', 'r:pc', 'r:tv']);
  });

  it('formats ms, p50/p90 and Mbit/s', () => {
    expect(fmtMs(null)).toBe('–');
    expect(fmtMs(undefined)).toBe('–');
    expect(fmtMs(849.6)).toMatch(/^850\sms$/);
    expect(fmtMs(3240)).toMatch(/^3[.,]2\ss$/);
    expect(fmtPct(pct(null))).toBe('–');
    expect(fmtPct(pct(300, 1200))).toMatch(/^300\sms \/ 1[.,]2\ss$/);
    expect(fmtMbit(null)).toBe('–');
    expect(fmtMbit(8_000_000)).toMatch(/^8\sMbit\/s$/);
  });
});
