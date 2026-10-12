import { describe, expect, it } from 'vitest';
import { fmtRuntime, genreLine, isNewRelease, lengthLabel, previewRect, ratingBadge } from './hover';

const vp = { w: 1440, h: 900 };
const card = (left: number, top = 300, width = 220) => ({ left, top, width, height: Math.round((width * 9) / 16) });

describe('previewRect', () => {
  it('is 1.5x wide, at least 300px, centred over a middle card', () => {
    const r = previewRect(card(600, 300, 240), vp);
    expect(r.width).toBe(360);
    expect(r.left).toBe(600 + 120 - 180);
    expect(r.mediaH).toBe(Math.round((360 * 9) / 16));
    expect(previewRect(card(600, 300, 150), vp).width).toBe(300);
  });
  it('grows from the left edge of the first visible card (no shift past it)', () => {
    const r = previewRect(card(58), vp);
    expect(r.left).toBe(58);
    expect(r.from.dx).toBe(0);
    expect(previewRect(card(20), vp).left).toBe(20);
    expect(previewRect(card(-60), vp).left).toBe(12); // partly scrolled out: viewport margin
  });
  it('grows from the right edge of the last visible card', () => {
    const r = previewRect(card(1440 - 58 - 220), vp);
    expect(r.left + r.width).toBe(1440 - 58);
    expect(previewRect(card(1440 - 220), vp).left + previewRect(card(1440 - 220), vp).width).toBe(1440 - 12);
  });
  it('moves up when there is no room below and down when there is none above', () => {
    const low = previewRect(card(600, 780), vp);
    expect(low.top + low.height).toBeLessThanOrEqual(900 - 12);
    const high = previewRect(card(600, 2), vp);
    expect(high.top).toBe(12);
  });
  it('never leaves the viewport, even in tiny viewports', () => {
    const r = previewRect(card(0, 0, 200), { w: 280, h: 300 });
    expect(r.left).toBeGreaterThanOrEqual(12);
    expect(r.left + r.width).toBeLessThanOrEqual(280 - 12);
    expect(r.top).toBe(12);
  });
  it('starts as the card (scale = card width / width)', () => {
    const r = previewRect(card(600, 300, 240), vp);
    expect(r.from.scale).toBeCloseTo(240 / r.width);
    expect(r.top + r.from.dy).toBe(300);
  });
});

describe('labels', () => {
  const T = 600_000_000;
  it('formats runtimes', () => {
    expect(fmtRuntime(112 * T)).toBe('1 Std. 52 Min.');
    expect(fmtRuntime(120 * T)).toBe('2 Std.');
    expect(fmtRuntime(45 * T)).toBe('45 Min.');
    expect(fmtRuntime(0)).toBe('');
    expect(fmtRuntime(undefined)).toBe('');
  });
  it('length label per type', () => {
    expect(lengthLabel({ type: 'Movie', runtimeTicks: 112 * T })).toBe('1 Std. 52 Min.');
    expect(lengthLabel({ type: 'Series', childCount: 3 })).toBe('3 Staffeln');
    expect(lengthLabel({ type: 'Series', childCount: 1 })).toBe('1 Staffel');
    expect(lengthLabel({ type: 'Series' })).toBe('');
  });
  it('rating badge: stars, else Neu for fresh releases', () => {
    const now = Date.parse('2026-06-01');
    expect(ratingBadge({ communityRating: 8.8, year: 2010 }, now)).toBe('★ 8,8');
    expect(ratingBadge({ year: 2026, premiereDate: '2026-03-01T00:00:00Z' }, now)).toBe('Neu');
    expect(ratingBadge({ year: 2001, premiereDate: '2001-03-01T00:00:00Z' }, now)).toBe('');
  });
  it('isNewRelease falls back to the year', () => {
    expect(isNewRelease({ year: 2026 }, Date.parse('2026-06-01'))).toBe(true);
    expect(isNewRelease({ year: 2020 }, Date.parse('2026-06-01'))).toBe(false);
  });
  it('joins genres with bullets, max 3', () => {
    expect(genreLine(['A', 'B', 'C', 'D'])).toBe('A • B • C');
    expect(genreLine(undefined)).toBe('');
  });
});
