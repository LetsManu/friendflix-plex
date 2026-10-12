import { describe, expect, it } from 'vitest';
import { advanceCountdown, cardVisible, creditsStart, mayAutoplay, nextKind, ringOffset, secondsLeft } from './nextup';

describe('creditsStart', () => {
  it('uses the outro segment in the second half', () => expect(creditsStart([{ type: 'outro', start: 2600, end: 2700 }], 2700)).toBe(2600));
  it('also accepts "credits"', () => expect(creditsStart([{ type: 'credits', start: 1300, end: 1400 }], 1400)).toBe(1300));
  it('falls back to the last 25 s', () => expect(creditsStart([{ type: 'intro', start: 10, end: 80 }], 1500)).toBe(1475));
  it('ignores an outro tag in the first half', () => expect(creditsStart([{ type: 'outro', start: 100, end: 200 }], 1500)).toBe(1475));
  it('waits for the duration', () => expect(creditsStart([], NaN)).toBe(Infinity));
  it('short videos never go below 0', () => expect(creditsStart([], 10)).toBe(0));
});

describe('nextKind / cardVisible / mayAutoplay', () => {
  it('episode needs a next one, movie gets suggestions, others nothing', () => {
    expect(nextKind('Episode', true)).toBe('episode'); expect(nextKind('Episode', false)).toBe('none');
    expect(nextKind('Movie', false)).toBe('movie'); expect(nextKind(undefined, true)).toBe('none');
  });
  it('visible from the start mark until dismissed', () => {
    const o = { kind: 'episode' as const, current: 100, start: 90, dismissed: false };
    expect(cardVisible(o)).toBe(true); expect(cardVisible({ ...o, current: 80 })).toBe(false);
    expect(cardVisible({ ...o, dismissed: true })).toBe(false); expect(cardVisible({ ...o, start: Infinity })).toBe(false); expect(cardVisible({ ...o, kind: 'none' })).toBe(false);
  });
  it('movies never autoplay; sleep timer, still-watching and the off switch stop it', () => {
    const o = { kind: 'episode' as const, autoplayNext: true, sleepAfterEpisode: false, askStill: false };
    expect(mayAutoplay(o)).toBe(true); expect(mayAutoplay({ ...o, kind: 'movie' })).toBe(false);
    expect(mayAutoplay({ ...o, autoplayNext: false })).toBe(false); expect(mayAutoplay({ ...o, sleepAfterEpisode: true })).toBe(false); expect(mayAutoplay({ ...o, askStill: true })).toBe(false);
  });
});

describe('countdown', () => {
  it('runs only while playing and finishes after 10 s', () => {
    let e = 0; for (let i = 0; i < 99; i++) e = advanceCountdown(e, 100, true).elapsed;
    expect(advanceCountdown(e, 100, true)).toEqual({ elapsed: 10_000, done: true });
    expect(advanceCountdown(2000, 500, false)).toEqual({ elapsed: 2000, done: false });
  });
  it('labels and ring', () => {
    expect(secondsLeft(0)).toBe(10); expect(secondsLeft(9100)).toBe(1); expect(secondsLeft(10_000)).toBe(0);
    expect(ringOffset(0, 100)).toBe(0); expect(ringOffset(5000, 100)).toBe(50); expect(ringOffset(20_000, 100)).toBe(100);
  });
});
