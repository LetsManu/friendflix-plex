// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

test.describe('admin usage (phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('cards, no horizontal overflow, expand button ≥ 44 px', async ({ page }) => {
    await page.goto('/admin/usage');
    const card = page.getByRole('row', { name: /Katharina Bauer-Langenberger/ });
    await expect(card).toBeVisible();
    expect((await card.boundingBox())!.width).toBeLessThanOrEqual(390);
    const btn = card.getByRole('button', { name: 'Details zu Katharina Bauer-Langenberger' });
    const box = (await btn.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    await btn.click();
    const panel = page.getByRole('region', { name: /Katharina Bauer-Langenberger · / });
    await expect(panel.getByRole('img')).toBeInViewport();
    await page.waitForLoadState('networkidle');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    expect((await panel.getByRole('button', { name: 'Schließen' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
});
