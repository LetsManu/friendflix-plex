// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { items, MOVIE } from '../mocks/fixtures.js';

/**
 * One movie's odd data must never turn /item/<id> into SvelteKit's "Internal Error" page: every optional section renders without the bad
 * piece (or is left out), the title and the Play button stay.
 */
const [, B, C] = items as [unknown, (typeof items)[number], (typeof items)[number]];
const part = (o: object) => ({ image: true, played: false, current: false, inLibrary: true, from: 'jellyfin', ...o });
const ABOUT = { ratings: [], countries: [], studios: [], tags: [], keywords: [], links: [], collection: null, canRequest: false, sources: ['jellyfin'] };

const json = (page: Page, re: RegExp, body: unknown) => page.route(re, (r) => r.fulfill({ json: body }));
async function expectPage(page: Page) {
  await page.goto('/item/' + MOVIE.id);
  await expect(page.getByRole('heading', { level: 1, name: MOVIE.name })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Abspielen' }).first()).toBeVisible();
  await page.waitForTimeout(400); // late sections (about, similar) land after the first paint
  await expect(page.getByText('Internal Error')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: MOVIE.name })).toBeVisible();
}

test.describe('detail page survives odd data of one movie', () => {
  test('cast member without a name (Jellyfin People entry with Name null)', async ({ page }) => {
    await json(page, /\/api\/items\/[0-9a-f]{32}\/people$/, { people: [{ id: 'p1', type: 'Actor', image: false }, { id: 'p2', name: 'Lena Doria', type: 'Actor', image: false }] });
    await expectPage(page);
    await expect(page.locator('section.cast').getByText('Lena Doria')).toBeVisible();
  });

  test('"more like this" with the same title twice', async ({ page }) => {
    await json(page, /\/api\/items\/[0-9a-f]{32}\/similar$/, { items: [B, C, B] });
    await expectPage(page);
    await expect(page.locator('#dv-panel-more .mc')).toHaveCount(2);
  });

  test('collection row naming the same library title twice', async ({ page }) => {
    const collection = { name: 'Reihe', from: 'tmdb', parts: [part({ id: MOVIE.id, tmdbId: 1, name: MOVIE.name, current: true }), part({ id: B.id, tmdbId: 2, name: B.name }), part({ id: B.id, tmdbId: 3, name: B.name })] };
    await json(page, /\/api\/items\/[0-9a-f]{32}\/about$/, { ...ABOUT, collection });
    await expectPage(page);
  });

  test('ratings line with the same source twice, links with the same kind twice', async ({ page }) => {
    await json(page, /\/api\/items\/[0-9a-f]{32}\/about$/, {
      ...ABOUT,
      ratings: [{ key: 'community', value: 7, max: 10, from: 'jellyfin' }, { key: 'community', value: 7.1, max: 10, from: 'jellyfin' }],
      links: [{ kind: 'imdb', url: 'https://www.imdb.com/title/tt0000001/' }, { kind: 'imdb', url: 'https://www.imdb.com/title/tt0000002/' }],
    });
    await expectPage(page);
  });

  test('about with missing lists and a broken release date', async ({ page }) => {
    await json(page, /\/api\/items\/[0-9a-f]{32}\/about$/, { ratings: null, releaseDate: 'unknown', collection: { name: 'X', parts: null } });
    await expectPage(page);
  });

  test('extras with the same id twice', async ({ page }) => {
    const ex = { ...B, kind: 'extra' };
    await json(page, /\/api\/items\/[0-9a-f]{32}\/extras\/all$/, { items: [ex, ex] });
    await expectPage(page);
  });

  test('facts with a broken removal date and unknown traits', async ({ page }) => {
    await json(page, /\/api\/items\/[0-9a-f]{32}\/facts$/, { fresh: 'bogus', leaving: { leavesAt: 'soon', days: 3 }, traits: { resolution: '8k', hdr: null, audio: null } });
    await expectPage(page);
  });

  test('item without year, runtime, rating, genres, premiere date, community rating; odd language codes', async ({ page }) => {
    const bare = { id: MOVIE.id, name: MOVIE.name, type: 'Movie', genres: null, rating: 'XYZ-99', communityRating: null, image: false, backdrop: false, logo: false, played: false, favorite: false, positionTicks: 0, trailers: 0, langs: { audio: ['', 'qaa', 'zz-ZZ'], subs: [null] } };
    await page.route(new RegExp(`/api/items/${MOVIE.id}$`), (r) => r.fulfill({ json: { item: bare, inWatchlist: false, thumb: 0 } }));
    await expectPage(page);
  });

  test.describe('section boundary', () => {
    test.use({ allowedConsole: /iso\.split is not a function|\.split is not a function/ });
    test('a section that still throws is left out, the rest of the page stays (facts with a numeric removal date)', async ({ page }) => {
      await json(page, /\/api\/items\/[0-9a-f]{32}\/facts$/, { fresh: null, leaving: { leavesAt: 20261024, days: 3 }, traits: null });
      await expectPage(page);
      await expect(page.locator('section.cast').getByText('Lena Doria')).toBeVisible();
    });
  });
});
