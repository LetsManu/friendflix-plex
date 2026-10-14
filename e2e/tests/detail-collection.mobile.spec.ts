// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { items, MOVIE } from '../mocks/fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

/** Block 21 task 7 on phones: smaller posters, no page overflow, 44 px request button. */
const part = (o: object) => ({ image: true, played: false, current: false, inLibrary: true, from: 'jellyfin', ...o });
const ABOUT = {
  ratings: [], countries: [], studios: [], tags: [], keywords: [], links: [], canRequest: true, sources: ['jellyfin', 'tmdb'],
  collection: {
    name: 'Matrix-Reihe', from: 'jellyfin',
    parts: [
      part({ id: items[3]!.id, name: 'Teil Eins', played: true }), part({ id: MOVIE.id, name: MOVIE.name, current: true }), part({ id: items[4]!.id, name: 'Teil Drei' }),
      part({ tmdbId: 604, name: 'Teil Vier', inLibrary: false, from: 'tmdb', poster: '/api/seerr/image?path=%2Fp4.jpg' }),
      part({ tmdbId: 605, name: 'Teil Fünf', inLibrary: false, from: 'tmdb' }),
    ],
  },
};

test('collection row on a phone: 96 px posters, no horizontal page overflow, Anfragen >= 44 px', async ({ page }) => {
  await page.route(/\/api\/items\/[0-9a-f]{32}\/about$/, (r) => r.fulfill({ json: ABOUT }));
  await page.route('**/api/seerr/image**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>' }));
  await page.goto('/item/' + MOVIE.id);
  const reg = page.getByRole('region', { name: /Teil 2 von 5/ });
  await expect(reg.locator('li')).toHaveCount(5);
  const w = (await reg.locator('li .poster').first().boundingBox())!.width;
  expect(w).toBeGreaterThan(88);
  expect(w).toBeLessThanOrEqual(100);
  expect(await noHorizontalOverflow(page)).toBe(true);
  const b = (await reg.getByRole('button', { name: /^Anfragen/ }).first().boundingBox())!;
  expect(b.height).toBeGreaterThanOrEqual(44);
  expect(b.width).toBeGreaterThanOrEqual(44);
});
