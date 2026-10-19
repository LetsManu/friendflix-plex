// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

const notice = (page: import('@playwright/test').Page) => page.getByRole('main').locator('.mv');

test.describe('move notice (phone, 320 px)', () => {
  test.beforeEach(async ({ page, api }) => { api.asAdmin = true; await page.setViewportSize({ width: 320, height: 640 }); });

  test('banner wraps without horizontal overflow, targets ≥ 44 px, clear of the tab bar', async ({ page }) => {
    await page.goto('/browse/movies');
    const n = notice(page);
    await expect(n).toContainText('FriendFlix für Plex ist umgezogen');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    const x = (await n.getByRole('button', { name: 'Für 7 Tage ausblenden' }).boundingBox())!;
    expect(x.width).toBeGreaterThanOrEqual(44);
    expect(x.height).toBeGreaterThanOrEqual(44);
    expect((await n.getByRole('link', { name: 'So wechselst du' }).boundingBox())!.height).toBeGreaterThanOrEqual(24);
    const box = (await n.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    const tab = (await page.getByRole('navigation', { name: 'Mobile Navigation' }).boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(tab.y);
    await n.getByRole('button', { name: 'Für 7 Tage ausblenden' }).click();
    await expect(n).toHaveCount(0);
  });

  test('Admin → Update notice has no horizontal overflow', async ({ page }) => {
    await page.goto('/admin/update');
    await expect(notice(page)).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    expect((await notice(page).boundingBox())!.x + (await notice(page).boundingBox())!.width).toBeLessThanOrEqual(320);
  });
});
