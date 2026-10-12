import { LIST_A } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';

// Block 17 S1 on a phone: editorial list page, home row, settings toggle. Screenshots go to scratchpad/block17/s1.
test.beforeEach(async ({ page, api }) => {
  await page.route('**/api/discover/badges', (r) => r.fulfill({ json: { badges: {} } }));
  await page.route('**/api/library/leaving', (r) => r.fulfill({ json: { items: [] } }));
  Object.assign(api.lists.find((l) => l.id === LIST_A)!, { themed: true, emoji: '🍿', coverColor: '#7a1f3d', pinned: true });
});

test.describe('themed lists (phone)', () => {
  test('editorial page fits the phone width', async ({ page }) => {
    await page.goto('/lists/' + LIST_A);
    await expect(page.locator('header.cover')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: '/tmp/claude-0/-home-user-friendflix/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/block17/s1/themed-page-phone.png' });
  });

  test('home row and no horizontal scroll', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '🍿 Filmabend' })).toBeVisible();
    await page.getByRole('heading', { name: '🍿 Filmabend' }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: '/tmp/claude-0/-home-user-friendflix/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/block17/s1/themed-row-phone.png' });
  });

  test('settings: calm mode toggle', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByLabel('Ruhiger Modus')).toBeVisible();
    await page.getByLabel('Ruhiger Modus').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/claude-0/-home-user-friendflix/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/block17/s1/calm-settings-phone.png' });
  });
});
