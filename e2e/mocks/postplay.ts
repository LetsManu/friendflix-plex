// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { MOVIE, SERIES, episodes, items } from './fixtures.js';
import { videoReady } from './scenes.js';

/** 1.1 post-play screen: answers of GET /api/items/:id/postplay and player helpers shared by postplay.spec.ts and its mobile twin. */
export const LAST_EP = episodes[5]!;
export const recs = items.filter((i) => i.id !== MOVIE.id && i.type === 'Movie').slice(0, 6);
export const because = (seed: { id: string; name: string }) => ({ kind: 'because', title: seed.name, reason: { seed: { id: seed.id, name: seed.name }, traits: [] }, items: recs });
export const MOVIE_END = { state: 'movie_end', current: MOVIE, next: null, nextAirDate: null, sequel: null, canWish: false, remind: null, rows: [because(MOVIE), { kind: 'taste', title: '', reason: { seed: { id: items[5]!.id, name: items[5]!.name } }, items: items.slice(9, 13) }], hero: items[2]!, suggestions: true };
export const CAUGHT_UP = { state: 'caught_up', current: LAST_EP, next: null, nextAirDate: '2026-10-21', sequel: null, canWish: false, remind: { episodeId: '0'.repeat(29) + '1ff' }, rows: [because(SERIES)], hero: items[3]!, suggestions: true };
export const FINISHED = {
  state: 'series_finished', current: LAST_EP, next: null, nextAirDate: null, sequel: null, canWish: true, remind: null, hero: items[4]!, suggestions: true,
  rows: [{ kind: 'continuation', title: SERIES.name, reason: { seed: { id: SERIES.id, name: SERIES.name } }, items: [], wish: { mediaType: 'tv', tmdbId: 1396, quota: { limit: 5, used: 3, remaining: 2, resetsAt: '2026-11-01T00:00:00.000Z' } } }, because(SERIES)],
};

export async function mockPostplay(page: Page, id: string, body: unknown) {
  await page.route(`**/api/items/${id}/postplay`, (r) => r.fulfill({ json: body }));
}
/** jump into the credits (the card shows from 95 % without outro segment / late chapter) */
export async function toCredits(page: Page) {
  await videoReady(page);
  await page.evaluate(() => { const v = document.querySelector('video')!; v.pause(); v.currentTime = v.duration - 8; });
}
export const endTitle = (page: Page) => page.evaluate(() => document.querySelector('video')!.dispatchEvent(new Event('ended')));
