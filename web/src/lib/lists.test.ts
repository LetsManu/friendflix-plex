import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { isNotFound } from './lists';

describe('isNotFound', () => {
  it('is true only for 404', () => {
    expect(isNotFound(new ApiError(404, null))).toBe(true);
    expect(isNotFound(new ApiError(502, null))).toBe(false);
    expect(isNotFound(new TypeError('network'))).toBe(false);
  });
});
