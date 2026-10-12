import type { Page } from '@playwright/test';
import { MOVIE, items } from './fixtures.js';

/** Block 17 P1: shared mocks of the player specs (cast & info, chapters, sound). */

/** 10 minutes of a 32x18 single-colour VP8 picture, no sound (ffmpeg lavfi color, 0.05 fps): real duration + seeking in the player */
const WEBM = Buffer.from('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', 'base64');

export const CAST = {
  item: { id: MOVIE.id, name: 'Inception', type: 'Movie', year: 2010, rating: 'FSK-12', communityRating: 8.8 },
  cast: [
    { id: 'a'.repeat(31) + '1', name: 'Leonardo DiCaprio', role: 'Dom Cobb', image: true },
    { id: 'a'.repeat(31) + '2', name: 'Joseph Gordon-Levitt', role: 'Arthur', image: true },
    { id: 'a'.repeat(31) + '3', name: 'Elliot Page', role: 'Ariadne', image: false },
    { id: 'a'.repeat(31) + '4', name: 'Tom Hardy', role: 'Eames', image: true },
  ],
  guests: [{ id: 'a'.repeat(31) + '5', name: 'Michael Caine', role: 'Miles', image: true }],
  directors: [{ id: 'b'.repeat(32), name: 'Christopher Nolan', image: true }],
  writers: [{ id: 'b'.repeat(32), name: 'Christopher Nolan', image: true }],
  creators: [],
  studios: ['Syncopy', 'Legendary Pictures'],
  genres: ['Action', 'Sci-Fi'],
  tags: ['dream', 'heist'],
};
export const CHAPTERS = [
  { start: 0, name: '' },
  { start: 200, name: 'Die Verfolgung', image: '/media/Items/' + MOVIE.id + '/Images/Chapter/1?tag=x' },
  { start: 400, name: 'Der Kick' },
];

export async function mockPlayer(page: Page, o: { chapters?: unknown[] } = {}) {
  // Playwright tries the most recently added route first: the catch-all goes first
  await page.route('**/api/playback/**', (r) => r.fulfill({ status: 204 }));
  await page.route('**/api/playback/info', (r) => r.fulfill({ json: { directUrl: '/media/p1test.webm', hlsUrl: '/media/p1test.webm', resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: 'ps1', maxBitrate: 60_000_000, roleMaxBitrate: 60_000_000, subtitles: [], audioTracks: [] } }));
  // with byte ranges, like the gateway: otherwise the browser cannot seek in the file
  await page.route('**/media/p1test.webm', (r) => {
    const m = /bytes=(\d+)-(\d*)/.exec(r.request().headers()['range'] ?? '');
    if (!m) return r.fulfill({ status: 200, contentType: 'video/webm', headers: { 'accept-ranges': 'bytes' }, body: WEBM });
    const a = Number(m[1]), b = m[2] ? Math.min(Number(m[2]), WEBM.length - 1) : WEBM.length - 1;
    return r.fulfill({ status: 206, contentType: 'video/webm', headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${WEBM.length}` }, body: WEBM.subarray(a, b + 1) });
  });
  await page.route('**/api/cast/config', (r) => r.fulfill({ json: { enabled: false } }));
  await page.route('**/api/items/*/next', (r) => r.fulfill({ json: { item: null } }));
  await page.route('**/api/bookmarks?*', (r) => r.fulfill({ json: { bookmarks: [] } }));
  await page.route('**/api/items/*/segments', (r) => r.fulfill({ json: { segments: [] } }));
  await page.route('**/api/items/*/castinfo', (r) => r.fulfill({ json: CAST }));
  await page.route('**/api/items/*/chapters', (r) => r.fulfill({ json: { supported: true, chapters: o.chapters ?? CHAPTERS } }));
}

/** the <video> has its real duration (metadata loaded) */
export const videoReady = (page: Page) => page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 500);
export const otherTitle = items[1]!;
