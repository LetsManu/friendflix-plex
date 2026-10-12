import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { leaveDay } from '../mocks/admin.js';
import { items } from '../mocks/fixtures.js';

// Admin → Bald weg on the phone (390px): cards instead of table rows, the form stays usable, no horizontal scrolling.
const SHOTS = '/tmp/claude-0/-home-user-friendflix/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/block18/int';
const toasts = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Hinweise' });

test.describe('admin: leaving soon (phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('cards with date + remaining days, edit form in view, nothing overflows', async ({ page, api }) => {
    await page.goto('/admin/leaving');
    await expect(page.getByRole('heading', { level: 1, name: 'Bald weg' })).toBeVisible();
    const card = page.getByRole('row', { name: /Inkwell/ });
    await expect(card).toBeVisible();
    await expect(card.getByText('Nur noch 1 Tag').filter({ visible: true })).toBeVisible();
    const box = await card.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await page.screenshot({ path: `${SHOTS}/leaving-phone.png`, fullPage: true });

    await card.getByRole('button', { name: 'Aktionen für Inkwell' }).click();
    await page.getByRole('dialog', { name: 'Inkwell' }).getByRole('button', { name: 'Datum ändern' }).click();
    const date = page.getByLabel('Verlässt uns am');
    await expect(date).toBeFocused();
    await expect(date).toBeInViewport();
    await date.fill(leaveDay(4));
    await page.getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Datum für „Inkwell“ gespeichert.')).toBeVisible();
    await expect(page.getByRole('row', { name: /Inkwell/ }).getByText('Nur noch 4 Tage').filter({ visible: true })).toBeVisible();
    expect(api.admin.leaving.find((r) => r.itemId === items[0]!.id)?.leavesAt).toBe(leaveDay(4));
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
