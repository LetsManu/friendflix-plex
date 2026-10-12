import { describe, expect, it } from 'vitest';
import { hasNewEpisodes, isNewTitle } from './badges';

const now = Date.parse('2026-10-12T12:00:00Z');
const ago = (d: number) => new Date(now - d * 86_400_000).toISOString();
const base = { type: 'Series', lastAdded: ago(3), unplayedCount: 2, childCount: 10, playedPercentage: undefined as number | undefined };

describe('hasNewEpisodes', () => {
  it('true for a started series with recent additions', () => expect(hasNewEpisodes(base, now)).toBe(true));
  it('true when only playedPercentage shows progress', () => expect(hasNewEpisodes({ ...base, childCount: undefined, playedPercentage: 20 }, now)).toBe(true));
  it('false for non-series', () => expect(hasNewEpisodes({ ...base, type: 'Movie' }, now)).toBe(false));
  it('false without lastAdded or with garbage date', () => {
    expect(hasNewEpisodes({ ...base, lastAdded: undefined }, now)).toBe(false);
    expect(hasNewEpisodes({ ...base, lastAdded: 'nope' }, now)).toBe(false);
  });
  it('false when older than 14 days, true at the edge', () => {
    expect(hasNewEpisodes({ ...base, lastAdded: ago(15) }, now)).toBe(false);
    expect(hasNewEpisodes({ ...base, lastAdded: ago(14) }, now)).toBe(true);
  });
  it('false when nothing unwatched', () => {
    expect(hasNewEpisodes({ ...base, unplayedCount: 0 }, now)).toBe(false);
    expect(hasNewEpisodes({ ...base, unplayedCount: undefined }, now)).toBe(false);
  });
  it('false when not started', () => expect(hasNewEpisodes({ ...base, unplayedCount: 10 }, now)).toBe(false));
  it('false for far-future dates', () => expect(hasNewEpisodes({ ...base, lastAdded: ago(-5) }, now)).toBe(false));
});

describe('isNewTitle', () => {
  it('true for a movie added or premiered within 30 days', () => {
    expect(isNewTitle({ type: 'Movie', lastAdded: ago(5) }, now)).toBe(true);
    expect(isNewTitle({ type: 'Movie', premiereDate: ago(29) }, now)).toBe(true);
  });
  it('false for older titles, garbage and future dates', () => {
    expect(isNewTitle({ type: 'Movie', lastAdded: ago(31), premiereDate: ago(400) }, now)).toBe(false);
    expect(isNewTitle({ type: 'Movie', lastAdded: 'x' }, now)).toBe(false);
    expect(isNewTitle({ type: 'Movie', premiereDate: ago(-60) }, now)).toBe(false);
    expect(isNewTitle({ type: 'Movie' }, now)).toBe(false);
  });
  it('episodes never, series with new episodes get the other badge', () => {
    expect(isNewTitle({ type: 'Episode', lastAdded: ago(1) }, now)).toBe(false);
    expect(isNewTitle(base, now)).toBe(false);
    expect(isNewTitle({ type: 'Series', lastAdded: ago(2), unplayedCount: 8, childCount: 8 }, now)).toBe(true);
  });
});
