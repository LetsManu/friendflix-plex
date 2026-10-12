import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

const PAGES = ['requests', 'polls', 'lists', 'hubs', 'previews', 'playback', 'digest', 'update', 'status'] as const;

test.describe('admin content pages (phone)', () => {
  test.use({ allowedConsole: /status of (404|409|500|502)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  for (const p of PAGES) {
    test(`/admin/${p} fits 390px without horizontal scrolling`, async ({ page }) => {
      await page.goto(`/admin/${p}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('status').filter({ hasText: 'Lädt' })).toHaveCount(0);
      await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    });
  }

  test('requests become cards with the actions inside', async ({ page }) => {
    await page.goto('/admin/requests');
    const card = page.getByRole('row', { name: /Dune: Part Two/ });
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: '„Dune: Part Two“ freigeben' })).toBeVisible();
    const box = await card.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390);
    await card.getByRole('button', { name: '„Dune: Part Two“ freigeben' }).click();
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('„Dune: Part Two“ freigegeben.')).toBeVisible();
  });

  test('hubs: the edit form opens in view on the phone', async ({ page }) => {
    await page.goto('/admin/hubs');
    await page.getByRole('button', { name: /Bearbeiten/ }).first().click();
    const name = page.locator('#hub-name');
    await expect(name).toBeFocused();
    await expect(name).toBeInViewport();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('previews: filter and cards', async ({ page }) => {
    await page.goto('/admin/previews');
    await expect(page.getByText('1–25 von 60')).toBeVisible();
    await page.getByRole('combobox', { name: 'Status' }).selectOption('failed');
    await expect(page.getByRole('table', { name: 'Vorschauen' }).getByRole('row')).toHaveCount(11);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
