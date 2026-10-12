import { describe, expect, it } from 'vitest';
import { brightnessPct, classifyMove, levelFromDrag, registerTap, scrubTarget, volumeSettable, zoneOf } from './gestures';

describe('zoneOf', () => { it('thirds', () => { expect(zoneOf(10, 300)).toBe('left'); expect(zoneOf(150, 300)).toBe('center'); expect(zoneOf(290, 300)).toBe('right'); }); });

describe('registerTap', () => {
  it('first tap is only a candidate', () => expect(registerTap(null, 1000, 'right').kind).toBe('first'));
  it('second tap on the same side seeks +10', () => {
    const a = registerTap(null, 1000, 'right'); const b = registerTap(a.state, 1200, 'right');
    expect(b).toMatchObject({ kind: 'seek', by: 10, total: 10 });
  });
  it('accumulates on repeated taps', () => {
    let s = registerTap(null, 0, 'left').state; const last = [200, 400, 600].map((t) => { const r = registerTap(s, t, 'left'); s = r.state; return r; });
    expect(last.map((x) => x.total)).toEqual([10, 20, 30]); expect(last[2].by).toBe(-10);
  });
  it('too slow, other side or center restarts', () => {
    const a = registerTap(null, 0, 'right').state;
    expect(registerTap(a, 900, 'right').kind).toBe('first');
    expect(registerTap(a, 100, 'left').kind).toBe('first');
    const c = registerTap(null, 0, 'center').state; expect(registerTap(c, 100, 'center').kind).toBe('first');
  });
});

describe('classifyMove', () => {
  it('needs the slop first', () => expect(classifyMove(3, 3, 100, 400)).toBeNull());
  it('horizontal = scrub', () => expect(classifyMove(40, 5, 100, 400)).toBe('scrub'));
  it('vertical right half = volume, left half = brightness', () => {
    expect(classifyMove(2, -40, 300, 400)).toBe('volume'); expect(classifyMove(2, -40, 100, 400)).toBe('brightness');
  });
  it('no volume gesture where the platform cannot set it (iOS)', () => expect(classifyMove(2, -40, 300, 400, { volumeOk: false })).toBeNull());
});

describe('scrubTarget / levelFromDrag', () => {
  it('scrub is clamped and span-limited', () => {
    expect(scrubTarget(100, 100, 400, 3600)).toBe(160); expect(scrubTarget(5, -400, 400, 3600)).toBe(0); expect(scrubTarget(10, 400, 400, 100)).toBe(100);
    expect(scrubTarget(10, 100, 400, 0)).toBe(10);
  });
  it('dragging up raises, down lowers, clamped', () => {
    expect(levelFromDrag(0.5, -300, 1000)).toBe(1); expect(levelFromDrag(0.5, 600, 1000)).toBe(0);
    expect(levelFromDrag(0.8, -60, 1000, 0.5, 1)).toBeCloseTo(0.85);
  });
  it('brightness label', () => { expect(brightnessPct(0.2)).toBe(50); expect(brightnessPct(0.75)).toBe(75); });
});

describe('volumeSettable', () => {
  it('detects a settable and a locked volume', () => {
    expect(volumeSettable({ volume: 1 })).toBe(true);
    const locked = { get volume() { return 1; }, set volume(_v: number) { /* iOS ignores */ } };
    expect(volumeSettable(locked)).toBe(false);
  });
});
