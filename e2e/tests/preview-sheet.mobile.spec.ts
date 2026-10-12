import { expect, test } from '../fixtures.js';
import { row } from '../helpers.js';

test.describe('preview sheet (phone)', () => {
  test('tapping a poster opens the preview sheet; Escape closes it and returns focus', async ({ page }) => {
    await page.goto('/');
    const poster = row(page, 'Weil du „Inception“ gesehen hast').locator('.pc a').first();
    await poster.scrollIntoViewIfNeeded();
    await poster.tap();

    const sheet = page.getByRole('dialog', { name: /^Vorschau: / });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { level: 2, name: 'Interstellar' })).toBeVisible();
    await expect(page).toHaveURL(/\/$/); // the sheet does not navigate
    await expect(sheet.getByRole('button', { name: 'Schließen' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(poster).toBeFocused();
  });

  test('the close button and the backdrop dismiss the sheet', async ({ page }) => {
    await page.goto('/');
    const poster = row(page, 'Weil du „Inception“ gesehen hast').locator('.pc a').first();
    await poster.scrollIntoViewIfNeeded();
    const sheet = page.getByRole('dialog', { name: /^Vorschau: / });

    await poster.tap();
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Schließen' }).tap();
    await expect(sheet).toBeHidden();

    await poster.tap();
    await expect(sheet).toBeVisible();
    await page.touchscreen.tap(195, 40); // backdrop above the sheet
    await expect(sheet).toBeHidden();
  });
});
