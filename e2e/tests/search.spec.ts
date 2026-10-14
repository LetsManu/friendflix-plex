// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';

test.describe('search', () => {
  test('typing keeps the input value and shows grouped results; Escape clears', async ({ page }) => {
    await page.goto('/search');
    // desktop: the only search field is the one in the header (the page has none)
    const input = page.locator('#hq');
    await expect(page.locator('#q')).toHaveCount(0);
    await expect(input).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Beliebte Suchen' })).toBeVisible();

    // regression: results used to re-render the page and wipe what was typed
    await input.click();
    await input.pressSequentially('nolan', { delay: 40 });
    await expect(page.getByRole('heading', { level: 2, name: 'Personen' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Filme & Serien' })).toBeVisible();
    await expect(input).toHaveValue('nolan');
    await expect(input).toBeFocused();
    await expect(page).toHaveURL(/\/search\?q=nolan$/);
    await expect(page.getByRole('link', { name: 'Carl Norden' })).toBeVisible();
    await expect(page.locator('section[aria-labelledby="st"] article.card')).toHaveCount(6);

    // keep typing: a longer query replaces the results, input is still intact
    await input.fill('');
    await input.pressSequentially('dahl', { delay: 40 });
    await expect(page).toHaveURL(/q=dahl$/);
    await expect(page.locator('section[aria-labelledby="st"] article.card')).toHaveCount(1); // "Dahlia"
    await expect(input).toHaveValue('dahl');

    await input.press('Escape');
    await expect(input).toHaveValue('');
    await expect(page).toHaveURL(/\/search$/);
    // results are gone; the idle state offers the recent searches
    await expect(page.locator('section[aria-labelledby="st"]')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: 'Zuletzt gesucht' })).toBeVisible();
  });

  test('typing in the header search from another page opens /search and keeps typing', async ({ page }) => {
    await page.goto('/watchlist');
    await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toBeVisible();
    await page.keyboard.press('/');
    const input = page.locator('#hq');
    await expect(input).toBeFocused();
    await page.keyboard.type('nolan', { delay: 40 });
    await expect(page).toHaveURL(/\/search\?q=nolan$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Personen' })).toBeVisible();
    await expect(input).toHaveValue('nolan');
    await expect(input).toBeFocused();
    // a recent search chip on the page drives the header field
    await input.press('Escape');
    await page.getByRole('button', { name: 'nolan' }).click();
    await expect(input).toHaveValue('nolan');
    await expect(page).toHaveURL(/q=nolan$/);
  });

  test('episodes get their own group and unknown terms show the empty state', async ({ page }) => {
    await page.goto('/search?q=breaking');
    await expect(page.getByRole('heading', { level: 2, name: 'Folgen' })).toBeVisible();
    await expect(page.locator('#hq')).toHaveValue('breaking');

    await page.locator('#hq').fill('zzzzz');
    await expect(page.getByRole('heading', { level: 2, name: 'Keine Treffer für „zzzzz“' })).toBeVisible();
  });
});
