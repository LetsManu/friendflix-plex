import { describe, expect, it } from 'vitest';
import { statusAfterListChange } from './status';

describe('statusAfterListChange', () => {
  it('adding plans none and dropped titles', () => {
    expect(statusAfterListChange('none', true)).toBe('planned');
    expect(statusAfterListChange('dropped', true)).toBe('planned');
  });
  it('removing clears planned only', () => {
    expect(statusAfterListChange('planned', false)).toBe('none');
    expect(statusAfterListChange('dropped', false)).toBe('dropped');
  });
  it('keeps watching / watched', () => {
    for (const s of ['watching', 'watched'] as const) { expect(statusAfterListChange(s, true)).toBe(s); expect(statusAfterListChange(s, false)).toBe(s); }
  });
});
