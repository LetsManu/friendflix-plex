// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { MOVIE, MOVIE2 } from '../mocks/fixtures.js';
import { castOn, castSessions, fakeCastSdk } from '../mocks/cast.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';
import type { Page } from '@playwright/test';

/** Play buttons while a cast session runs: the title goes to the TV and the page stays. */

/** a client-side navigation by a link click (a full page load would fire pagehide and end the cast) */
const clientNav = (page: Page, path: string) => page.evaluate((path) => { const a = document.createElement('a'); a.href = path; document.body.appendChild(a); a.click(); a.remove(); }, path);
const castBar = (page: Page) => page.getByRole('region', { name: 'Jetzt auf dem Fernseher' });

test('Play on another title while casting keeps the page and updates the bar', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await castOn(page);
  const sdk = await fakeCastSdk(page);
  const { sessions, deleted } = await castSessions(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await clientNav(page, '/watch/' + MOVIE.id);
  await videoReady(page);
  await sdk.start();
  await expect(page.locator('.castov')).toContainText('Wird auf Wohnzimmer-TV abgespielt');
  await page.locator('.stage').hover();
  await page.getByRole('button', { name: 'Zurück', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(castBar(page)).toContainText(MOVIE.name);

  await clientNav(page, '/item/' + MOVIE2.id);
  await expect(page).toHaveURL(new RegExp('/item/' + MOVIE2.id));
  await page.getByRole('link', { name: 'Abspielen' }).first().click();
  await expect(castBar(page)).toContainText(MOVIE2.name);
  await expect(page).toHaveURL(new RegExp('/item/' + MOVIE2.id));
  await expect.poll(() => sessions.length).toBe(2);
  expect(sessions[1]!.itemId).toBe(MOVIE2.id);
  await expect.poll(() => deleted.length).toBe(1);
  expect(deleted[0]).toBe('c'.repeat(32));
});

test('without a cast the play button navigates as before', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await page.goto('/item/' + MOVIE2.id);
  await page.getByRole('link', { name: 'Abspielen' }).first().click();
  await expect(page).toHaveURL(new RegExp('/watch/' + MOVIE2.id));
});
