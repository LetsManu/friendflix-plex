// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { coalesceProgress, type QueuedProgress } from './db';
import { CLOCK_TOLERANCE_MS, daysLeft, isPlayable, bumpMaxSeen, toMs } from './license';
import { estimateBytes, fitsQuota, fmtBytes, pct, withMargin } from './size';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const day = 86_400_000;
const dl = (o: Partial<{ state: string; expiresAt: number | string; validUntil: number | string }> = {}) => ({ state: 'done', expiresAt: NOW + 10 * day, validUntil: NOW + 5 * day, ...o });

describe('isPlayable', () => {
  it('allows a valid finished download', () => expect(isPlayable(dl(), NOW, { maxSeenTime: NOW })).toEqual({ ok: true }));
  it('blocks unfinished downloads', () => expect(isPlayable(dl({ state: 'downloading' }), NOW, null)).toEqual({ ok: false, reason: 'not_done' }));
  it('blocks expired state and past expiresAt', () => {
    expect(isPlayable(dl({ state: 'expired' }), NOW, null).reason).toBe('expired');
    expect(isPlayable(dl({ expiresAt: NOW - 1 }), NOW, null).reason).toBe('expired');
  });
  it('requires a check-in after validUntil but before expiresAt', () => {
    expect(isPlayable(dl({ validUntil: NOW - 1 }), NOW, null).reason).toBe('checkin');
  });
  it('clock guard: tolerates 1h skew, blocks more', () => {
    expect(isPlayable(dl(), NOW - CLOCK_TOLERANCE_MS + 1000, { maxSeenTime: NOW }).ok).toBe(true);
    expect(isPlayable(dl(), NOW - CLOCK_TOLERANCE_MS - 1000, { maxSeenTime: NOW }).reason).toBe('clock');
  });
  it('accepts ISO strings', () => expect(isPlayable(dl({ expiresAt: new Date(NOW + day).toISOString(), validUntil: new Date(NOW + day).toISOString() }), NOW, null).ok).toBe(true));
  it('helpers', () => {
    expect(toMs('garbage')).toBe(0);
    expect(daysLeft(NOW + 2.2 * day, NOW)).toBe(3);
    expect(daysLeft(NOW - day, NOW)).toBe(0);
    expect(bumpMaxSeen(10, 5)).toBe(10);
  });
});

describe('progress queue coalescing', () => {
  const ev = (itemId: string, at: number, pos: number, played = false): QueuedProgress => ({ itemId, downloadId: 'd-' + itemId, positionTicks: pos, played, at });
  it('keeps the newest event per item', () => {
    const r = coalesceProgress([ev('a', 1, 10), ev('b', 5, 50), ev('a', 3, 30), ev('a', 2, 20)]);
    expect(r).toHaveLength(2);
    expect(r.find((x) => x.itemId === 'a')?.positionTicks).toBe(30);
  });
  it('later entry wins on equal timestamps', () => {
    expect(coalesceProgress([ev('a', 1, 10), ev('a', 1, 99, true)])[0]).toMatchObject({ positionTicks: 99, played: true });
  });
  it('empty input', () => expect(coalesceProgress([])).toEqual([]));
});

describe('size estimates', () => {
  const hour = 3600 * 10_000_000;
  it('preset estimates match the plan (~0.5 / 1.2 / 2.3 GB per hour)', () => {
    expect(estimateBytes('sd', hour) / 1e9).toBeCloseTo(0.5, 1);
    expect(estimateBytes('hd', hour) / 1e9).toBeCloseTo(1.18, 1);
    expect(estimateBytes('fhd', hour) / 1e9).toBeCloseTo(2.32, 1);
  });
  it('original uses the source size, unknown runtime is 0', () => {
    expect(estimateBytes('original', hour, 1234)).toBe(1234);
    expect(estimateBytes('hd', undefined)).toBe(0);
  });
  it('quota check includes the 5% margin', () => {
    expect(withMargin(100)).toBe(105);
    expect(fitsQuota(100, 105, 0)).toBe(true);
    expect(fitsQuota(100, 104, 0)).toBe(false);
    expect(fitsQuota(100, 200, 150)).toBe(false);
    expect(fitsQuota(1e12, 0, 0)).toBe(true);
  });
  it('formats German sizes', () => {
    expect(fmtBytes(4_200_000_000)).toBe('4,2 GB');
    expect(fmtBytes(850_000_000)).toBe('850 MB');
    expect(fmtBytes(0)).toBe('0 MB');
    expect(pct(50, 200)).toBe(25);
    expect(pct(5, 0)).toBe(0);
  });
});
