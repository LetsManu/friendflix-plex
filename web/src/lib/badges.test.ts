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

// ---- Block 17 D1: one tag per card ----
import { cardTag, qualityChips } from './badges';

describe('cardTag', () => {
  const series = { type: 'Series', lastAdded: ago(3), unplayedCount: 2, childCount: 10, playedPercentage: undefined as number | undefined };
  it('nothing until the server answered (no flicker), old hints when it failed', () => {
    expect(cardTag(undefined, series, now)).toBeNull();
    expect(cardTag(null, series, now)).toMatchObject({ kind: 'legacy', label: 'newEpisodes' });
    expect(cardTag(null, { type: 'Movie', lastAdded: ago(5) }, now)).toMatchObject({ kind: 'legacy', label: 'new' });
    expect(cardTag(null, { type: 'Movie' }, now)).toBeNull();
  });
  it('server badge: fresh label, one at most', () => {
    expect(cardTag({ fresh: 'finale' }, series, now)).toMatchObject({ kind: 'fresh', key: 'fresh.label.finale' });
    expect(cardTag({}, series, now)).toBeNull();
  });
  it('a removal date within two weeks wins over a fresh label; further away it is ignored', () => {
    expect(cardTag({ fresh: 'new', daysLeft: 5 }, series, now)).toEqual({ kind: 'leaving', key: 'fresh.leaving.days', n: 5 });
    expect(cardTag({ daysLeft: 0 }, series, now)).toEqual({ kind: 'leaving', key: 'fresh.leaving.today', n: 0 });
    expect(cardTag({ fresh: 'new', daysLeft: 15 }, series, now)).toMatchObject({ kind: 'fresh' });
    expect(cardTag({ daysLeft: 14 }, series, now)).toMatchObject({ kind: 'leaving' });
  });
  it('episodes get the removal date of their series but never a fresh label', () => {
    expect(cardTag({ fresh: 'newEpisode' }, { type: 'Episode' }, now)).toBeNull();
    expect(cardTag({ daysLeft: 3 }, { type: 'Episode' }, now)).toMatchObject({ kind: 'leaving', n: 3 });
  });
});

describe('qualityChips', () => {
  it('stable order resolution, HDR, audio', () => {
    expect(qualityChips({ resolution: '4k', hdr: 'dolbyvision', audio: 'atmos' }).map((c) => c.id)).toEqual(['4k', 'dv', 'atmos']);
    expect(qualityChips({ resolution: 'hd', hdr: 'hdr10', audio: 'surround' }).map((c) => c.id)).toEqual(['hd', 'hdr', 'surround']);
    expect(qualityChips({ resolution: 'hd', hdr: 'hdr10plus', audio: 'stereo' }).map((c) => c.id)).toEqual(['hd', 'hdr10plus', 'stereo']);
    expect(qualityChips({ resolution: 'sd', hdr: null, audio: 'mono' })).toEqual([]);
    expect(qualityChips(null)).toEqual([]);
  });
});
