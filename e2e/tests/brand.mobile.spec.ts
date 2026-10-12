import { expect, test } from '../fixtures.js';

test.describe('fork branding: "FriendFlix for Plex" (mobile)', () => {
  test('profile gate shows the badge on a normal phone and hides it only on very small ones', async ({ page }) => {
    await page.goto('/profiles');
    const badge = page.locator('.brand .badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('for Plex');
    await page.setViewportSize({ width: 320, height: 640 });
    await expect(badge).toBeHidden();
  });

  test('document title and manifest carry the product name', async ({ page, request }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/FriendFlix for Plex/);
    const m = await (await request.get('/manifest.webmanifest')).json();
    expect(m.name).toBe('FriendFlix for Plex');
    expect(m.short_name).toBe('FriendFlix');
  });
});
