// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

// The recommendation settings on the phone: the card link by tap, the engine saves, nothing overflows (390 and 320 px).
test.describe('admin: recommendation settings (phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  for (const width of [390, 320]) {
    test(`${width} px: the card link opens the group, the engine saves, nothing overflows`, async ({ page, api }) => {
      await page.setViewportSize({ width, height: 740 });
      await page.goto('/admin');
      const card = page.getByTestId('reco-card');
      const link = card.getByRole('link', { name: 'Engine ändern' });
      await link.scrollIntoViewIfNeeded();
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.waitForLoadState('networkidle');
      await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
      for (const el of [card.getByTestId('reco-engine'), link]) {
        const box = (await el.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }

      await link.tap();
      await expect(page).toHaveURL(/\/admin\/settings#settings-recommendations$/);
      const heading = page.getByRole('heading', { level: 2, name: 'Empfehlungen', exact: true });
      await expect(heading).toBeInViewport();
      const group = page.locator('section', { has: heading });
      const sel = page.getByRole('group', { name: 'Empfehlungs-Engine', exact: true }).getByRole('combobox');
      await sel.selectOption('v2');
      const save = group.getByRole('button', { name: 'Speichern' });
      await save.tap();
      await expect.poll(() => api.settings.puts.length).toBe(1);
      expect(api.settings.puts[0]!.values).toEqual({ RECO_ENGINE: 'v2' });
      await page.waitForLoadState('networkidle');
      await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
      for (const el of [group, sel, save]) {
        const box = (await el.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
    });
  }
});
