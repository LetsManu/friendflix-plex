export interface Box { left: number; right: number; top: number; bottom: number; width: number }
export interface Placed { left: number; width: number; top?: number; bottom?: number; maxHeight: number; up: boolean }

/**
 * Position for a `position: fixed` popover next to a trigger: stays inside the viewport,
 * right-aligns to the trigger when the left-aligned box would overflow, and opens upward
 * when asked to (or when there is clearly more room above than below).
 */
export function placePopover(r: Box, vp: { w: number; h: number }, o: { up?: boolean; wide?: boolean } = {}): Placed {
  const m = 8, gap = 6;
  const width = o.wide ? Math.min(Math.max(r.width, 230), vp.w - 2 * m) : Math.min(260, vp.w - 2 * m);
  let left = r.left;
  if (left + width > vp.w - m) left = r.right - width;
  left = Math.max(m, Math.min(left, vp.w - m - width));
  const below = vp.h - r.bottom - gap - m, above = r.top - gap - m;
  const up = o.up ? above >= 160 || above >= below : below < 300 && above > below;
  return up
    ? { left, width, bottom: vp.h - r.top + gap, maxHeight: Math.max(120, above), up }
    : { left, width, top: r.bottom + gap, maxHeight: Math.max(120, below), up };
}

export const placedStyle = (p: Placed): string =>
  `left:${Math.round(p.left)}px;width:${Math.round(p.width)}px;max-height:${Math.round(p.maxHeight)}px;` + (p.up ? `bottom:${Math.round(p.bottom!)}px;` : `top:${Math.round(p.top!)}px;`);
