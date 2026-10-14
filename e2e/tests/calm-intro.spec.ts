// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';

// Block 17 calm mode: the cold-start brand intro must not play for a calm profile. The server prefs arrive after the intro
// decision, so the per-profile fast-start copy (localStorage ff_calm:<profile>, written whenever prefs load / save) decides.
test.describe('calm mode and the cold-start intro', () => {
  test.use({ reducedMotion: 'no-preference' }); // the suite default (reduce) would skip the intro anyway

  test('without calm mode the brand intro plays once on a cold start', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.intro')).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('ff-intro-seen'))).toBe('1');
  });

  test('a calm profile gets no cold-start intro', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ff_calm:p1', '1'));
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('ff-intro-seen'))).toBeNull();
    await expect(page.locator('.intro')).toHaveCount(0);
  });
});
