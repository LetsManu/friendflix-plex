// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

test.describe('admin shell (phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('/admin is a grouped list; sub-pages get a back chevron', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByRole('heading', { level: 1, name: 'Admin' })).toBeVisible();
    const list = page.getByRole('navigation', { name: 'Admin-Bereiche' });
    await expect(list).toHaveCount(1); // the desktop sidebar is not rendered for assistive tech on phones
    await expect(list.getByRole('heading', { name: 'Personen' })).toBeVisible();
    await expect(list.getByRole('link', { name: /Geräte.*4 offen/ })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);

    await list.getByRole('link', { name: /Wochenrückblick/ }).click();
    await expect(page).toHaveURL(/\/admin\/digest$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Wochenrückblick' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Admin-Bereiche' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Zurück zur Admin-Übersicht' }).click();
    await expect(page).toHaveURL(/\/admin$/);
  });

  test('overview fits the phone and toasts sit above the tab bar', async ({ page }) => {
    await page.goto('/admin');
    const attn = page.getByRole('region', { name: 'Wartet auf dich' });
    await expect(attn.getByText('Dunmoor: Part Two')).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await attn.getByRole('button', { name: '„Dunmoor: Part Two“ freigeben' }).click();
    const toast = page.getByRole('region', { name: 'Hinweise' }).getByRole('listitem');
    await expect(toast).toBeVisible();
    const tb = await page.getByRole('navigation', { name: 'Mobile Navigation' }).last().boundingBox();
    const box = await toast.boundingBox();
    expect(box && tb && box.y + box.height <= tb.y + 1).toBe(true);
  });
});
