import { describe, expect, it } from 'vitest';
import { focusIndex, nextThumb, RATING_OPTIONS, thumbLabel, toThumb } from './rating';

describe('rating', () => {
  it('normalises API values', () => {
    expect(toThumb(1)).toBe(1); expect(toThumb(2)).toBe(2); expect(toThumb(-1)).toBe(-1);
    expect(toThumb('2')).toBe(2); expect(toThumb(null)).toBe(0); expect(toThumb(3)).toBe(0); expect(toThumb(undefined)).toBe(0);
  });
  it('toggles the active option off', () => {
    expect(nextThumb(1, 1)).toBe(0); expect(nextThumb(2, 2)).toBe(0);
    expect(nextThumb(0, 2)).toBe(2); expect(nextThumb(1, -1)).toBe(-1);
  });
  it('labels and focus', () => {
    expect(RATING_OPTIONS.map((o) => o.label)).toEqual(['Nicht mein Fall', 'Gefällt mir', 'Super']);
    expect(thumbLabel(0)).toBe('Bewerten');
    expect(thumbLabel(2)).toContain('Super');
    expect(focusIndex(0)).toBe(1); expect(focusIndex(-1)).toBe(0); expect(focusIndex(2)).toBe(2);
  });
});
