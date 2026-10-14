// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from './i18n';
import { renderCard, shareCard } from './wrapped';

/** 2D context double: records every fillText; measureText = 20 px per character. */
function fakeCanvas() {
  const texts: Array<{ text: string; x: number; y: number }> = [];
  const g = {
    font: '', fillStyle: '', textAlign: 'left',
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    fillRect: () => undefined, beginPath: () => undefined, arc: () => undefined, fill: () => undefined, roundRect: () => undefined,
    measureText: (t: string) => ({ width: t.length * 20 }),
    fillText: (text: string, x: number, y: number) => texts.push({ text, x, y }),
  };
  const canvas = { width: 0, height: 0, getContext: () => g, toBlob: (cb: (b: Blob | null) => void) => cb(blobResult) };
  return { canvas, texts };
}
let blobResult: Blob | null;
let canvas: ReturnType<typeof fakeCanvas>;
let anchors: Array<{ href: string; download: string; clicked: boolean }>;

const stats = {
  year: 2025, totalMinutes: 125, titles: 12, movies: 5, episodes: 40, favoriteWeekday: 'Freitag',
  topItems: [
    { name: 'A very long title that certainly does not fit into one single line of the card at all', minutes: 300 },
    { name: 'Short', minutes: 120 },
    { name: 'Third', minutes: 60 },
    { name: 'Fourth is never shown', minutes: 30 },
  ],
  achievements: [{ earnedAt: '2025-01-01' }, { earnedAt: null }, { earnedAt: '2025-03-01' }],
};

beforeEach(async () => {
  await setLocale('en');
  blobResult = new Blob(['png'], { type: 'image/png' });
  canvas = fakeCanvas();
  anchors = [];
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag === 'canvas') return canvas.canvas;
      const a = { href: '', download: '', clicked: false, click() { a.clicked = true; } };
      anchors.push(a);
      return a;
    },
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await setLocale('de');
});

describe('renderCard', () => {
  it('draws a 1080x1350 card with the year, hours and minutes, counts, favourite day and achievements', () => {
    const c = renderCard(stats, 'Lea');
    expect([c.width, c.height]).toEqual([1080, 1350]);
    const all = canvas.texts.map((t) => t.text);
    expect(all).toContain('FriendFlix');
    expect(all).toContain('2025 in review · Lea');
    expect(all).toContain('2'); // 125 min = 2 h ...
    expect(all).toContain('h 5 min'); // ... and 5 min
    expect(all).toContain('12 titles  ·  5 movies  ·  40 episodes');
    expect(all).toContain('Favourite day: Friday'); // the server sends German weekday names
    expect(all).toContain('2 of 3 achievements unlocked');
  });

  it('shows only the top 3, numbered, and wraps long names to at most two lines', () => {
    renderCard(stats);
    const all = canvas.texts.map((t) => t.text);
    expect(all).toEqual(expect.arrayContaining(['1', '2', '3', '300 min', '120 min', '60 min']));
    expect(all.join('|')).not.toContain('Fourth');
    const first = canvas.texts.filter((t) => t.x === 200 && t.y < 900); // first entry: y 780 (second entry starts at 930)
    expect(first).toHaveLength(2);
    expect(first.every((t) => t.text.length * 20 <= 640 || t.text.endsWith('…'))).toBe(true);
    expect(first[1]!.y - first[0]!.y).toBe(46);
    expect(all).toContain('Short');
  });

  it('no name and no favourite day: neither is drawn', () => {
    renderCard({ ...stats, favoriteWeekday: null });
    const all = canvas.texts.map((t) => t.text);
    expect(all).toContain('2025 in review');
    expect(all.some((t) => t.startsWith('Favourite day'))).toBe(false);
  });
});

describe('shareCard', () => {
  it('uses the Web Share API with a PNG file when the browser can share files', async () => {
    const share = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { canShare: () => true, share });
    await shareCard(stats, 'Lea');
    expect(share).toHaveBeenCalledTimes(1);
    const data = (share.mock.calls[0] as unknown as [{ files: File[]; title: string }])[0];
    expect(data.title).toBe('My FriendFlix year in review 2025');
    expect(data.files[0]!.name).toBe('friendflix-year-in-review-2025.png');
    expect(data.files[0]!.type).toBe('image/png');
    expect(anchors).toHaveLength(0);
  });

  it('falls back to a download when sharing is unsupported or cancelled, and frees the blob URL later', async () => {
    vi.useFakeTimers();
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:card');
    vi.stubGlobal('navigator', { canShare: () => true, share: async () => { throw new DOMException('cancelled', 'AbortError'); } });
    await shareCard(stats);
    vi.stubGlobal('navigator', {});
    await shareCard(stats);
    expect(anchors.map((a) => [a.href, a.download, a.clicked])).toEqual([
      ['blob:card', 'friendflix-year-in-review-2025.png', true],
      ['blob:card', 'friendflix-year-in-review-2025.png', true],
    ]);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(revoke).toHaveBeenCalledWith('blob:card');
    vi.restoreAllMocks();
  });

  it('does nothing when the canvas cannot produce a PNG', async () => {
    blobResult = null;
    const share = vi.fn();
    vi.stubGlobal('navigator', { canShare: () => true, share });
    await shareCard(stats);
    expect(share).not.toHaveBeenCalled();
    expect(anchors).toHaveLength(0);
  });
});
