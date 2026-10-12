import { expect, test } from '../fixtures.js';

test.describe('fork branding: "FriendFlix for Plex" (desktop)', () => {
  test('header shows the "for Plex" badge next to the wordmark', async ({ page }) => {
    await page.goto('/');
    const logo = page.locator('header.nav a.logo');
    await expect(logo).toContainText('FriendFlix');
    await expect(logo.locator('.badge')).toBeVisible();
    await expect(logo.locator('.badge')).toHaveText('for Plex');
  });

  test('document titles carry the product name (home and inner pages)', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/FriendFlix for Plex/);
    await page.goto('/watchlist');
    await expect(page).toHaveTitle(/ – FriendFlix for Plex$/);
    await page.goto('/offline');
    await expect(page).toHaveTitle(/FriendFlix for Plex/);
  });

  test('static HTML title and meta tags are branded before the app boots', async ({ request }) => {
    const html = await (await request.get('/')).text();
    expect(html).toContain('<title>FriendFlix for Plex</title>');
    expect(html).toContain('property="og:site_name" content="FriendFlix for Plex"');
    expect(html).toContain('property="og:title" content="FriendFlix for Plex"');
  });

  test('PWA manifest name and short_name (localized manifest route, every language)', async ({ request }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.ok()).toBe(true);
    expect(res.headers()['content-type']).toContain('application/manifest+json');
    const m = await res.json();
    expect(m.name).toBe('FriendFlix for Plex');
    expect(m.short_name).toBe('FriendFlix');
    for (const lang of ['de', 'en', 'es', 'fr', 'it', 'pl', 'tr']) {
      const l = await (await request.get(`/manifest.webmanifest?lang=${lang}`)).json();
      expect(l.lang, lang).toBe(lang);
      expect(l.name, lang).toBe('FriendFlix for Plex');
      expect(l.short_name, lang).toBe('FriendFlix');
    }
  });

  test('the page links the localized manifest', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', /^\/manifest\.webmanifest\?lang=[a-z]{2}$/);
  });
});
