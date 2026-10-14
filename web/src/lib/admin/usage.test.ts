// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { dayBars, fmtHours, periodStart, showSince, transcodePct } from './usage';

describe('usage view helpers', () => {
  it('fmtHours: one decimal under 10 h, whole hours above', () => {
    expect(fmtHours(5400)).toBe('1,5 Std.');
    expect(fmtHours(0)).toBe('0 Std.');
    expect(fmtHours(36_000 + 1800)).toBe('11 Std.');
    expect(fmtHours(3600 * 1234)).toBe('1.234 Std.');
  });

  it('transcodePct: null with 0 streams, rounded share otherwise', () => {
    expect(transcodePct({ streams: 0, transcodes: 0 })).toBeNull();
    expect(transcodePct({ streams: 4, transcodes: 1 })).toBe(25);
    expect(transcodePct({ streams: 3, transcodes: 2 })).toBe(67);
  });

  it('dayBars scales to the max day; all zero → 0', () => {
    expect(dayBars([{ day: '2026-10-01', seconds: 100 }, { day: '2026-10-02', seconds: 400 }, { day: '2026-10-03', seconds: 0 }]))
      .toEqual([{ day: '2026-10-01', pct: 25 }, { day: '2026-10-02', pct: 100 }, { day: '2026-10-03', pct: 0 }]);
    expect(dayBars([{ day: '2026-10-01', seconds: 0 }])).toEqual([{ day: '2026-10-01', pct: 0 }]);
    expect(dayBars([])).toEqual([]);
  });

  it('"Daten seit" only when the data starts inside the period', () => {
    const today = new Date(2026, 9, 13);
    expect(periodStart(30, today)).toBe('2026-09-14');
    expect(showSince('2026-10-01', 30, today)).toBe(true);
    expect(showSince('2026-09-14', 30, today)).toBe(false);
    expect(showSince('2026-01-01', 30, today)).toBe(false);
    expect(showSince(null, 30, today)).toBe(false);
  });
});
