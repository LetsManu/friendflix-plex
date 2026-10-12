import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { ME } from '../mocks/fixtures.js';

test.describe('account and news pages (phone)', () => {
  test('/me renders with the tab bar and no horizontal overflow', async ({ page }) => {
    await page.goto('/me');
    await expect(page.getByRole('list', { name: 'Schnellzugriff' })).toBeVisible();
    await expect(page.getByText('Anna hat dich zur Liste „Annas Klassiker“ eingeladen')).toBeVisible();
    await expect(page.locator('.tabbar')).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('/new renders the tabs and cards without horizontal overflow', async ({ page }) => {
    await page.goto('/new');
    await expect(page.getByRole('heading', { level: 1, name: 'Neu & demnächst' })).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Bereich' }).getByRole('tab').first()).toBeVisible();
    await expect(page.getByRole('tabpanel')).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});

test.describe('phone shell', () => {
  test('three tabs; downloads stay in the header and on /me', async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, downloads: { allowed: true, max: 5 } } }));
    await page.goto('/me');
    const tabs = page.locator('.tabbar').getByRole('link');
    await expect(tabs).toHaveCount(3);
    for (const [i, name] of ['Start', 'Neu & demnächst', 'Mein Bereich'].entries()) await expect(tabs.nth(i)).toHaveAccessibleName(name);
    await expect(page.getByRole('link', { name: 'Downloads' }).first()).toBeVisible();
    await expect(page.getByRole('list', { name: 'Schnellzugriff' }).getByRole('link', { name: 'Downloads' })).toBeVisible();
    // tile labels stay on one line
    const tall = await page.locator('.tiles2 .tl').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height > 24).length);
    expect(tall).toBe(0);
  });

  test('search screen keeps its own field and shows popular titles', async ({ page }) => {
    await page.goto('/search');
    await expect(page.locator('#q')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Beliebte Suchen' })).toBeVisible();
    await page.locator('#q').pressSequentially('nolan', { delay: 40 });
    await expect(page).toHaveURL(/\/search\?q=nolan$/);
    await expect(page.locator('#q')).toHaveValue('nolan');
  });
});
