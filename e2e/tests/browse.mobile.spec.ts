import { expect, test } from '../fixtures.js';

test.describe('browse (phone)', () => {
  test('filters live in a bottom sheet: apply, chip, close with Escape, reset', async ({ page }) => {
    await page.goto('/browse/movies');
    await expect(page.locator('#g')).toBeHidden();
    const open = page.locator('.fbtn');
    await expect(open).toBeVisible();

    await open.tap();
    const sheet = page.getByRole('dialog', { name: 'Filter' });
    await expect(sheet).toBeVisible();
    await sheet.getByLabel('Genre').selectOption('Drama');
    await sheet.getByLabel('Sortierung').selectOption('DateCreated');
    await sheet.getByRole('button', { name: 'Anwenden' }).tap();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/genre=Drama/);
    await expect(page).toHaveURL(/sort=DateCreated/);
    await expect(page.getByRole('button', { name: /^Filter Drama entfernen/ })).toBeVisible();

    await open.tap();
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();

    await open.tap();
    await sheet.getByRole('button', { name: 'Zurücksetzen', exact: true }).tap();
    await expect(page).not.toHaveURL(/genre=/);
    await expect(page.getByRole('list', { name: 'Aktive Filter' })).toHaveCount(0);
  });
});
