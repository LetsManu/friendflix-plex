// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

test.describe('admin update channel (phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  for (const width of [390, 320]) {
    test(`${width} px: the switch saves by tap, the snippet shows, nothing overflows`, async ({ page, api }) => {
      await page.setViewportSize({ width, height: 740 });
      await page.goto('/admin/update');
      const card = page.getByRole('region', { name: 'Update-Kanal' });
      const nightly = card.getByRole('radio', { name: 'Nightly' });
      await expect(nightly).toBeVisible();
      const tapBox = await nightly.boundingBox();
      expect(tapBox!.height).toBeGreaterThanOrEqual(44);
      await nightly.tap();
      await expect(nightly).toHaveAttribute('aria-checked', 'true');
      expect(api.settings.puts).toEqual([{ values: { UPDATE_CHANNEL: 'nightly' } }]);
      await expect(card.getByLabel('Zeile in der .env')).toHaveValue('FF_TAG=nightly');
      await expect(card.getByRole('button', { name: 'Kopieren' })).toHaveCount(2);
      await page.waitForLoadState('networkidle');
      await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
      for (const el of [card, card.getByRole('radiogroup'), card.getByLabel('Befehl'), card.getByRole('button', { name: 'Kopieren' }).last()]) {
        const box = await el.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
    });
  }
});
