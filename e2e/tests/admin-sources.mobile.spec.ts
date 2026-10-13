import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

// Admin → Datenquellen on the phone (390px).
test.describe('admin: data sources (phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('no horizontal overflow, buttons are at least 44px tall', async ({ page }) => {
    await page.goto('/admin/sources');
    await expect(page.getByRole('heading', { level: 1, name: 'Datenquellen' })).toBeVisible();
    await expect(page.getByLabel('Neuer Schlüssel').first()).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    const buttons = page.locator('main form').getByRole('button');
    const n = await buttons.count();
    expect(n).toBeGreaterThanOrEqual(6);
    for (let i = 0; i < n; i++) expect((await buttons.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
});
