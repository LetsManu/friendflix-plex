// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { ME } from '../mocks/fixtures.js';

/** Block 15 K1 on the phone: kids header instead of the chip bar and tab bar, rows scroll sideways, the page itself does not. */
const KID = { ...ME, profileCount: 2, kids: true, onboarded: true, profile: { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };

test('kids home on the phone', async ({ page }) => {
  await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
  await page.addInitScript(() => { localStorage.setItem('ff-intro:p3', JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); });
  await page.goto('/');
  await expect(page).toHaveURL(/\/kids$/);
  await expect(page.getByRole('heading', { level: 2, name: 'Weiterschauen' })).toBeVisible();
  await expect(page.locator('header.kidsnav')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Mobile Navigation' })).toHaveCount(0);
  await expect(page.locator('.tabbar')).toHaveCount(0);
  await expect(page.locator('.chipbar')).toHaveCount(0);
  expect(await noHorizontalOverflow(page)).toBe(true);
  const search = page.getByRole('link', { name: 'Suchen' }).last();
  await expect(search).toBeVisible();
  const box = await search.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(48); // big touch target
});
