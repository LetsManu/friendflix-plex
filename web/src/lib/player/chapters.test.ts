import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n';
import { chapterIndexAt, chapterLabel, chapterMarks, normalizeChapters, thumbTime, trickFrame, usefulChapters } from './chapters';

const chs = normalizeChapters([
  { start: 600, name: ' Die Nostromo ' }, { start: 0, name: '', image: '/media/Items/x/Images/Chapter/0' }, { start: 1200, name: 'Ende', image: 'https://evil/x.jpg' },
  { start: 600, name: 'doppelt' }, { start: -1, name: 'kaputt' }, null, { start: Number.NaN, name: 'x' },
]);

describe('chapters', () => {
  afterEach(async () => { await setLocale('de'); });
  it('normalizes: sorted, unique starts, trimmed names, only server-relative stills', () => {
    expect(chs).toEqual([{ start: 0, name: '', image: '/media/Items/x/Images/Chapter/0' }, { start: 600, name: 'Die Nostromo' }, { start: 1200, name: 'Ende' }]);
    expect(normalizeChapters('nope')).toEqual([]);
  });
  it('finds the playing chapter', () => {
    expect(chapterIndexAt(chs, 0)).toBe(0); expect(chapterIndexAt(chs, 599.99)).toBe(1); expect(chapterIndexAt(chs, 5000)).toBe(2);
    expect(chapterIndexAt([{ start: 10, name: '' }], 3)).toBe(-1);
  });
  it('labels unnamed chapters in the UI language', async () => {
    expect(chapterLabel(chs[0]!, 0)).toBe('Kapitel 1'); expect(chapterLabel(chs[1]!, 1)).toBe('Die Nostromo');
    await setLocale('en');
    expect(chapterLabel(chs[0]!, 0)).toBe('Chapter 1');
  });
  it('marks every start inside the video except 0', () => {
    expect(chapterMarks(chs, 1800)).toEqual([{ i: 1, pct: (600 / 1800) * 100 }, { i: 2, pct: (1200 / 1800) * 100 }]);
    expect(chapterMarks(chs, 0)).toEqual([]);
    expect(chapterMarks(chs, 900)).toEqual([{ i: 1, pct: (600 / 900) * 100 }]);
  });
  it('a scenes list needs two chapters inside the video', () => {
    expect(usefulChapters(chs, 1800)).toBe(true); expect(usefulChapters(chs, 500)).toBe(false); expect(usefulChapters(chs.slice(0, 1), 0)).toBe(false);
    expect(usefulChapters(chs, 0)).toBe(true); // duration unknown yet
  });
  it('thumb time: a few seconds in, never past a third of the chapter', () => {
    expect(thumbTime(chs, 0, 1800)).toBe(8); expect(thumbTime([{ start: 0, name: '' }, { start: 9, name: '' }], 0, 100)).toBe(3);
    expect(thumbTime(chs, 2, 1800)).toBe(1208);
  });
  it('cuts the right tile out of a trickplay sheet', () => {
    const t = { width: 320, height: 180, tileWidth: 10, tileHeight: 10, count: 250, interval: 10_000, url: '/media/Videos/x/Trickplay/320/{n}.jpg' };
    const f = trickFrame(t, 1234, 160)!;
    expect(f.url).toBe('/media/Videos/x/Trickplay/320/1.jpg'); // frame 123 -> sheet 1, tile 23
    expect([f.x, f.y, f.w, f.h, f.k]).toEqual([3 * 320, 2 * 180, 160, 90, 0.5]);
    expect(trickFrame(t, 99_999, 160)!.url).toBe('/media/Videos/x/Trickplay/320/2.jpg'); // clamped to the last frame
    expect(trickFrame(undefined, 10, 160)).toBeNull();
  });
});
