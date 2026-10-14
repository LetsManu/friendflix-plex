// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

test.describe('account and news pages', () => {
  test('/me renders the quick links and notifications', async ({ page }) => {
    await page.goto('/me');
    await expect(page.getByRole('heading', { level: 1, name: 'Mein Bereich' })).toBeAttached();
    await expect(page.getByRole('list', { name: 'Schnellzugriff' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Benachrichtigungen' })).toBeVisible();
    await expect(page.getByText('Anna hat dich zur Liste „Annas Klassiker“ eingeladen')).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('/new renders the tabs and the week ranking', async ({ page }) => {
    await page.goto('/new');
    await expect(page.getByRole('heading', { level: 1, name: 'Neu & demnächst' })).toBeVisible();
    const tabs = page.getByRole('tablist', { name: 'Bereich' }).getByRole('tab');
    await expect(tabs).not.toHaveCount(0);
    await expect(page.getByRole('tabpanel')).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
