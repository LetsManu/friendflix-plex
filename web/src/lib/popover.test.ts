// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { placePopover } from './popover';

const box = (left: number, top: number, w = 44, h = 44) => ({ left, top, right: left + w, bottom: top + h, width: w });
const vp = { w: 375, h: 812 };

describe('placePopover', () => {
  it('left-aligns below the trigger when there is room', () => {
    const p = placePopover(box(20, 100), vp);
    expect(p).toMatchObject({ left: 20, width: 260, top: 150, up: false });
  });
  it('right-aligns near the right edge and never leaves the viewport', () => {
    const p = placePopover(box(320, 100), vp);
    expect(p.left + p.width).toBeLessThanOrEqual(vp.w - 8);
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + p.width).toBe(364); // right edge of the trigger
  });
  it('opens upward when asked and there is room above', () => {
    const p = placePopover(box(20, 500), vp, { up: true });
    expect(p.up).toBe(true);
    expect(p.bottom).toBe(812 - 500 + 6);
  });
  it('flips upward near the bottom edge, falls back to below when above is tiny', () => {
    expect(placePopover(box(20, 700), vp).up).toBe(true);
    expect(placePopover(box(20, 40), vp, { up: true }).up).toBe(false);
  });
  it('clamps width on narrow viewports and supports wide rows', () => {
    expect(placePopover(box(0, 100), { w: 240, h: 600 }).width).toBe(224);
    expect(placePopover(box(8, 100, 500, 48), vp, { wide: true }).width).toBe(359);
  });
});
