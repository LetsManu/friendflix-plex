import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { mobile, MOBILE_QUERY } from './viewport';

afterEach(() => vi.unstubAllGlobals());

describe('mobile store', () => {
  it('is false without matchMedia', () => {
    expect(get(mobile)).toBe(false);
  });
  it('follows the media query', () => {
    let listener: () => void = () => undefined;
    const mq = { matches: true, addEventListener: (_: string, f: () => void) => (listener = f), removeEventListener: vi.fn() };
    const mm = vi.fn(() => mq);
    vi.stubGlobal('matchMedia', mm);
    const seen: boolean[] = [];
    const un = mobile.subscribe((v) => seen.push(v));
    expect(mm).toHaveBeenCalledWith(MOBILE_QUERY);
    mq.matches = false; listener();
    un();
    expect(seen).toEqual([true, false]);
    expect(mq.removeEventListener).toHaveBeenCalled();
  });
});
