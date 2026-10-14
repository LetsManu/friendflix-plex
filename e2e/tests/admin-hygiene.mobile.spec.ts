// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

test.describe('admin library hygiene (phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('table becomes cards, no horizontal overflow, actions ≥ 44 px', async ({ page }) => {
    await page.goto('/admin/hygiene');
    const card = page.getByRole('row', { name: /Lantern Bay/ });
    await expect(card).toBeVisible();
    await expect(card.getByText('Keine Untertitel')).toBeVisible();
    expect((await card.boundingBox())!.width).toBeLessThanOrEqual(390);
    await page.waitForLoadState('networkidle');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    const act = await card.getByRole('button', { name: /Aktionen/ }).boundingBox();
    expect(act!.width).toBeGreaterThanOrEqual(44);
    expect(act!.height).toBeGreaterThanOrEqual(44);
    for (const b of [page.getByRole('button', { name: /Sprache/ }), page.getByRole('button', { name: 'Jetzt prüfen' }), card.getByRole('link', { name: 'Lantern Bay' })]) {
      expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await card.getByRole('button', { name: /Aktionen/ }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: '„Keine Untertitel“ ignorieren' })).toBeVisible();
  });
});
