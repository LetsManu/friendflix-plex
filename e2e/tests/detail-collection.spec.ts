// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { items, MOVIE } from '../mocks/fixtures.js';
import { row, openPopout } from '../helpers.js';

/** Block 21 task 7: collection row on the detail page. */
const [, , , A, B] = items as [unknown, unknown, unknown, (typeof items)[number], (typeof items)[number]];
const part = (o: object) => ({ image: true, played: false, current: false, inLibrary: true, from: 'jellyfin', ...o });
const COLLECTION = {
  name: 'Matrix-Reihe', from: 'jellyfin',
  parts: [
    part({ id: A.id, name: 'Teil Eins', year: 1999, played: true }),
    part({ id: MOVIE.id, name: MOVIE.name, year: 2003, current: true }),
    part({ id: B.id, name: 'Teil Drei', year: 2005 }),
    part({ tmdbId: 604, name: 'Teil Vier', year: 2021, inLibrary: false, from: 'tmdb', poster: '/api/seerr/image?path=%2Fp4.jpg' }),
  ],
};
const BASE = { ratings: [], countries: [], studios: [], tags: [], keywords: [], links: [], collection: COLLECTION, canRequest: true, sources: ['jellyfin', 'tmdb'] };

async function mockAbout(page: Page, body: object) {
  await page.route(/\/api\/items\/[0-9a-f]{32}\/about$/, (r) => r.fulfill({ json: body }));
  await page.route('**/api/seerr/image**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>' }));
}
const region = (page: Page) => page.getByRole('region', { name: /Teil 2 von 4/ });

test.describe('collection row', () => {
  test('heading "Teil 2 von 4 · Matrix-Reihe" and "Weiter mit Teil 3" link', async ({ page }) => {
    await mockAbout(page, BASE);
    await page.goto('/item/' + MOVIE.id);
    await expect(page.getByRole('heading', { level: 2, name: 'Teil 2 von 4 · Matrix-Reihe' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Weiter mit Teil 3' })).toHaveAttribute('href', '/item/' + B.id);
  });

  test('posters in given order; watched tick on part 1; part 2 aria-current', async ({ page }) => {
    await mockAbout(page, BASE);
    await page.goto('/item/' + MOVIE.id);
    const reg = region(page);
    await expect(reg.locator('li')).toHaveCount(4);
    await expect(reg.locator('li .nm')).toHaveText(['Teil Eins', MOVIE.name, 'Teil Drei', 'Teil Vier']);
    await expect(reg.locator('li').nth(0).locator('.tick')).toHaveCount(1);
    await expect(reg.locator('li').nth(1).locator('.tick')).toHaveCount(0);
    await expect(reg.locator('li').nth(1).locator('[aria-current="true"]')).toHaveCount(1);
    await expect(reg.locator('li').nth(2).getByRole('link')).toHaveAttribute('href', '/item/' + B.id);
    // accessible names: the poster links carry the title (watched parts say so)
    await expect(reg.getByRole('link', { name: 'Teil Eins, Gesehen' })).toHaveCount(1);
    await expect(reg.getByRole('link', { name: 'Teil Drei', exact: true })).toHaveCount(1);
  });

  test('missing part greyed, Anfragen posts {mediaType, tmdbId} once and shows Angefragt', async ({ page }) => {
    await mockAbout(page, BASE);
    const posts: unknown[] = [];
    await page.route('**/api/requests', async (r) => {
      if (r.request().method() !== 'POST') return r.fallback();
      posts.push(r.request().postDataJSON());
      await r.fulfill({ status: 200, json: { ok: true } });
    });
    await page.goto('/item/' + MOVIE.id);
    const li = region(page).locator('li').nth(3);
    await expect(li.getByRole('link')).toHaveCount(0);
    await expect(li.locator('img')).toHaveCSS('opacity', '0.5');
    await expect(li.getByText('Nicht in der Bibliothek')).toBeVisible();
    await li.getByRole('button', { name: 'Anfragen: Teil Vier' }).click();
    const done = li.getByRole('button', { name: 'Angefragt: Teil Vier' });
    await expect(done).toHaveAttribute('aria-disabled', 'true');
    await expect(done).toBeFocused(); // stays a focus stop (D-pad position survives)
    await done.click({ force: true }); // aria-disabled: Playwright would wait for it forever
    await page.waitForTimeout(200);
    expect(posts).toEqual([{ mediaType: 'movie', tmdbId: 604 }]);
  });

  test.describe('limit', () => {
  test.use({ allowedConsole: /status of 429/ });
  test('request limit shows a message and keeps the button', async ({ page }) => {
    await mockAbout(page, BASE);
    await page.route('**/api/requests', (r) => r.request().method() === 'POST' ? r.fulfill({ status: 429, json: { error: 'request_limit' } }) : r.fallback());
    await page.goto('/item/' + MOVIE.id);
    const li = region(page).locator('li').nth(3);
    await li.getByRole('button', { name: 'Anfragen: Teil Vier' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Limit erreicht' })).toBeVisible();
    await expect(li.getByRole('button', { name: 'Anfragen: Teil Vier' })).toBeEnabled();
  });
  });

  test('canRequest false -> no Anfragen button', async ({ page }) => {
    await mockAbout(page, { ...BASE, canRequest: false });
    await page.goto('/item/' + MOVIE.id);
    await expect(region(page).locator('li')).toHaveCount(4);
    await expect(page.getByRole('button', { name: /^Anfragen/ })).toHaveCount(0);
  });

  test('no current part: row shows with the name and count, no "Teil i von", no "Weiter mit"', async ({ page }) => {
    const parts = COLLECTION.parts.map((p) => ({ ...p, current: false }));
    await mockAbout(page, { ...BASE, collection: { ...COLLECTION, parts } });
    await page.goto('/item/' + MOVIE.id);
    await expect(page.getByRole('heading', { level: 2, name: 'Matrix-Reihe · 4 Teile' })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Weiter mit/ })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Matrix-Reihe · 4 Teile' }).locator('li')).toHaveCount(4);
  });

  test('no collection -> no row', async ({ page }) => {
    await mockAbout(page, { ...BASE, collection: null });
    await page.goto('/item/' + MOVIE.id);
    await expect(page.getByRole('heading', { level: 1, name: MOVIE.name })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /Teil \d+ von/ })).toHaveCount(0);
  });

  test('modal: Weiter mit Teil 3 swaps the dialog content', async ({ page }) => {
    await mockAbout(page, BASE);
    await page.goto('/');
    const card = row(page, 'Weil du „Inkwell“ gesehen hast').locator('article.card').first();
    const hp = await openPopout(page, card);
    await hp.getByRole('link', { name: /^Mehr Infos zu / }).click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByRole('link', { name: 'Weiter mit Teil 3' })).toBeVisible();
    await modal.getByRole('link', { name: 'Weiter mit Teil 3' }).click();
    await expect(page).toHaveURL(new RegExp('/item/' + B.id));
    await expect(page.getByRole('dialog', { name: new RegExp(B.name) })).toBeVisible();
  });
});
