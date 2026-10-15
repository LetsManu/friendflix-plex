// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

// Admin → Einstellungen on the phone (390px).
test.describe('admin: settings (phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('no horizontal overflow; every control is reachable and at least 44px tall', async ({ page }) => {
    await page.goto('/admin/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Öffentliche Adresse' })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    const vw = await page.evaluate(() => window.innerWidth);
    const controls = page.locator('main').getByRole('button');
    const n = await controls.count();
    expect(n).toBeGreaterThanOrEqual(20);
    for (let i = 0; i < n; i++) {
      const c = controls.nth(i);
      await c.scrollIntoViewIfNeeded();
      const box = (await c.boundingBox())!;
      expect(box.height, await c.innerText()).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(vw + 0.5);
    }
    const inputs = page.locator('main input:not([type=checkbox])');
    for (let i = 0; i < await inputs.count(); i++) {
      const box = (await inputs.nth(i).boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(vw + 0.5);
    }
  });

  test('Replace, Clear and Move buttons carry the setting in their accessible name', async ({ page }) => {
    await page.goto('/admin/settings');
    await expect(page.getByRole('button', { name: 'TMDB-API-Schlüssel ersetzen' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'TMDB-API-Schlüssel entfernen' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Öffentliche Adresse: in die Einstellungen übernehmen' })).toBeVisible();
    // the visible text stays short
    await expect(page.getByRole('group', { name: 'TMDB-API-Schlüssel' }).getByRole('button', { name: 'TMDB-API-Schlüssel ersetzen' })).toHaveText('Ersetzen');
    await page.getByRole('button', { name: 'TMDB-API-Schlüssel ersetzen' }).click();
    await expect(page.getByRole('group', { name: 'TMDB-API-Schlüssel' }).getByLabel('Neuer Wert')).toBeFocused();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
