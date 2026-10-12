import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow, row } from '../helpers.js';

test.describe('home (phone 390x844)', () => {
  test('shows poster rows, the tab bar and no desktop navigation', async ({ page }) => {
    await page.goto('/');
    const tabbar = page.locator('.tabbar');
    await expect(tabbar).toBeVisible();
    await expect(tabbar.getByRole('link')).not.toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toBeHidden();

    const because = row(page, 'Weil du „Inkwell“ gesehen hast');
    await because.scrollIntoViewIfNeeded();
    await expect(because.locator('.pc').first()).toBeVisible();
    // Weiterschauen keeps 16:9 cards on the phone
    await expect(row(page, 'Weiterschauen').locator('.pc.landscape')).toHaveCount(2);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('tab bar is pinned to the bottom edge', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.tabbar')).toBeVisible();
    const { tab, vh } = await page.evaluate(() => ({ tab: document.querySelector('.tabbar')!.getBoundingClientRect(), vh: window.innerHeight }));
    expect(Math.round(tab.bottom)).toBe(vh);
  });
});
