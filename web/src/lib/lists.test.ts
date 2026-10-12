import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { coverGradient, isNotFound, moveItem } from './lists';

describe('isNotFound', () => {
  it('is true only for 404', () => {
    expect(isNotFound(new ApiError(404, null))).toBe(true);
    expect(isNotFound(new ApiError(502, null))).toBe(false);
    expect(isNotFound(new TypeError('network'))).toBe(false);
  });
});

describe('themed list helpers', () => {
  it('moveItem reorders without mutating and ignores impossible moves', () => {
    const a = ['a', 'b', 'c'];
    expect(moveItem(a, 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(a, 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveItem(a, 0, 0)).toEqual(a);
    expect(moveItem(a, 0, -1)).toEqual(a);
    expect(moveItem(a, 0, 3)).toEqual(a);
    expect(a).toEqual(['a', 'b', 'c']);
  });
  it('coverGradient uses the colour or a neutral fallback, never raw input', () => {
    expect(coverGradient('#112233')).toContain('#112233');
    expect(coverGradient(null)).toContain('#3d4450');
    expect(coverGradient('red; background:url(x)')).toContain('#3d4450');
  });
});
