// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { barLine, barProgress, barThumb, barVisible, nextSecondsLeft } from './bar';
import { img } from '#lib/api';
import type { CastSession } from './engine';

describe('cast bar', () => {
  it('barVisible', () => {
    const s = { itemId: 'x' } as CastSession;
    expect(barVisible({ path: '/', tv: false, session: s })).toBe(true);
    expect(barVisible({ path: '/watch/x', tv: false, session: s })).toBe(false);
    expect(barVisible({ path: '/party/abc', tv: false, session: s })).toBe(false);
    expect(barVisible({ path: '/', tv: true, session: s })).toBe(false);
    expect(barVisible({ path: '/', tv: false, session: null })).toBe(false);
  });

  const tf = (k: string, p?: Record<string, unknown>) => (k === 'player.castBar.on' ? `auf ${p?.device}` : k);
  const base = { device: 'Wohnzimmer-TV', posterId: 'p1', subtitle: '', isEpisode: false, position: 30, duration: 120 } as CastSession;

  it('barLine', () => {
    expect(barLine({ ...base, subtitle: 'S1:E2 Second' }, tf)).toBe('S1:E2 Second · auf Wohnzimmer-TV');
    expect(barLine(base, tf)).toBe('auf Wohnzimmer-TV');
  });

  it('barProgress', () => {
    expect(barProgress(base)).toBe(25);
    expect(barProgress({ ...base, duration: 0 })).toBe(0);
    expect(barProgress({ ...base, position: 200 })).toBe(100);
  });

  it('barThumb', () => {
    expect(barThumb({ ...base, isEpisode: true })).toEqual({ src: img('p1', 160), ratio: '16/9' });
    expect(barThumb(base).ratio).toBe('2/3');
  });

  it('nextSecondsLeft', () => {
    expect(nextSecondsLeft(9100 + 5000, 5000)).toBe(10);
    expect(nextSecondsLeft(1000, 5000)).toBe(0);
    expect(nextSecondsLeft(null, 5000)).toBeNull();
  });
});
