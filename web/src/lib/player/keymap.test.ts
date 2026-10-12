import { describe, expect, it } from 'vitest';
import { isTypingTarget, nextSubtitle, resolveKey, type KeyContext } from './keymap';

const ctx: KeyContext = { tv: false, onBody: true, hasSkip: false, hasNext: true, overlayOpen: false };
const r = (key: string, c: Partial<KeyContext> = {}, m: object = {}) => resolveKey({ key, ...m }, { ...ctx, ...c });

describe('resolveKey', () => {
  it('play/pause on space and k', () => { expect(r(' ')).toEqual({ type: 'toggle' }); expect(r('K')).toEqual({ type: 'toggle' }); });
  it('seeks 10 s with arrows and j/l', () => {
    expect(r('ArrowLeft')).toEqual({ type: 'seek', by: -10 }); expect(r('ArrowRight')).toEqual({ type: 'seek', by: 10 });
    expect(r('j')).toEqual({ type: 'seek', by: -10 }); expect(r('L')).toEqual({ type: 'seek', by: 10 });
  });
  it('volume with up/down, but the TV opens the control bar instead', () => {
    expect(r('ArrowUp')).toEqual({ type: 'volume', delta: 0.1 }); expect(r('ArrowDown')).toEqual({ type: 'volume', delta: -0.1 });
    expect(r('ArrowUp', { tv: true })).toEqual({ type: 'tvControls' });
  });
  it('digits seek to percent', () => { expect(r('0')).toEqual({ type: 'seekPct', pct: 0 }); expect(r('9')).toEqual({ type: 'seekPct', pct: 90 }); });
  it('s only skips while the skip button is visible', () => { expect(r('s')).toBeNull(); expect(r('S', { hasSkip: true })).toEqual({ type: 'skip' }); });
  it('n only with a next episode', () => { expect(r('n', { hasNext: false })).toBeNull(); expect(r('n')).toEqual({ type: 'next' }); });
  it('escape only acts when something is open', () => { expect(r('Escape')).toBeNull(); expect(r('Escape', { overlayOpen: true })).toEqual({ type: 'escape' }); });
  it('? opens the help, c cycles subtitles, m/f', () => {
    expect(r('?')).toEqual({ type: 'help' }); expect(r('c')).toEqual({ type: 'subtitles' }); expect(r('m')).toEqual({ type: 'mute' }); expect(r('F')).toEqual({ type: 'fullscreen' });
  });
  it('ignores modifier combos (browser shortcuts)', () => {
    expect(r('f', {}, { ctrlKey: true })).toBeNull(); expect(r('ArrowLeft', {}, { altKey: true })).toBeNull(); expect(r('l', {}, { metaKey: true })).toBeNull();
  });
  it('enter toggles on the body; on the TV it skips while the button shows', () => {
    expect(r('Enter')).toEqual({ type: 'toggle' }); expect(r('Enter', { onBody: false })).toBeNull();
    expect(r('Enter', { tv: true, hasSkip: true })).toEqual({ type: 'skip' }); expect(r('Enter', { tv: true })).toEqual({ type: 'toggle' });
  });
  it('TV mode leaves digits, c, s, n, ? alone', () => { for (const k of ['0', '5', 'c', 's', 'n', '?']) expect(r(k, { tv: true, hasSkip: true })).toBeNull(); });
  it('media keys', () => {
    expect(r('MediaPlayPause')).toEqual({ type: 'toggle' }); expect(r('MediaFastForward')).toEqual({ type: 'seek', by: 30 });
    expect(r('MediaTrackNext')).toEqual({ type: 'next' }); expect(r('MediaTrackNext', { hasNext: false })).toBeNull();
  });
});

describe('nextSubtitle', () => {
  it('cycles off -> tracks -> off', () => {
    expect(nextSubtitle(-1, [3, 5])).toBe(3); expect(nextSubtitle(3, [3, 5])).toBe(5); expect(nextSubtitle(5, [3, 5])).toBe(-1);
  });
  it('stays off without tracks and recovers from unknown tracks', () => { expect(nextSubtitle(-1, [])).toBe(-1); expect(nextSubtitle(9, [3])).toBe(-1); });
});

describe('isTypingTarget', () => {
  it('text fields yes, range sliders and buttons no', () => {
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' } as never)).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'range' } as never)).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
