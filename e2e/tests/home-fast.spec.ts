// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { row } from '../helpers.js';
import { episodes, items } from '../mocks/fixtures.js';

// Task 7 (Block 20): the first screen of the home page comes from ONE request (GET /api/home)

/** /api/ calls the app makes (not the mock's own sub-fetches), minus the ones every page makes */
const watchApi = (page: Page) => {
  const seen: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/') || r.headers()['x-mock-sub']) return;
    if (u.pathname === '/api/me' || u.pathname.startsWith('/api/notifications') || u.pathname.startsWith('/api/prefs')) return;
    seen.push(u.pathname);
  });
  return seen;
};

test.describe('home first screen in one request', () => {
  test('at most 5 /api/ calls until the first row is visible, all rows come from /api/home', async ({ page }, info) => {
    const seen = watchApi(page);
    let atHome = -1; // calls made when /api/home answered: the idle rows only start after that
    page.on('response', (r) => { if (new URL(r.url()).pathname === '/api/home' && atHome < 0) atHome = seen.length; });
    await page.goto('/');
    await expect(row(page, 'Weiterschauen').locator('article.card').first()).toBeVisible();
    const upTo = seen.slice(0, atHome);
    info.annotations.push({ type: 'api calls until first row', description: upTo.join(' ') });
    expect(upTo.length, upTo.join(' ')).toBeLessThanOrEqual(5);
    expect(upTo.filter((p) => p === '/api/home')).toHaveLength(1);
    for (const old of ['/api/library/resume', '/api/library/nextup', '/api/library/leaving', '/api/recommendations', '/api/library/friends-rated', '/api/library/because', '/api/library/because-more', '/api/hubs', '/api/lists/themed']) {
      expect(seen, `${old} is part of /api/home`).not.toContain(old);
    }
    // the rows of the other parts are there too
    await expect(row(page, 'Weil du „Inkwell“ gesehen hast')).toBeAttached();
    await expect(row(page, 'Von Freunden empfohlen')).toBeAttached();
    // the first visible row's images load eagerly with high priority
    await expect(row(page, 'Weiterschauen').locator('article.card img[fetchpriority="high"]').first()).toBeAttached();
    await expect(row(page, 'Nächste Folge').locator('img[fetchpriority="high"]')).toHaveCount(0);
  });

  test('remove from Weiterschauen, open a title, go back: the item stays gone', async ({ page, api }) => {
    await page.goto('/');
    const resume = row(page, 'Weiterschauen');
    await expect(resume.locator('article.card')).toHaveCount(2);
    const gone = episodes[0]!;
    await resume.locator('article.card').first().locator('button.rm').dispatchEvent('click'); // the X shows on hover only
    await expect(resume.locator('article.card')).toHaveCount(1);
    expect(api.resumeGone.has(gone.id)).toBe(true);
    await resume.locator('article.card a').first().click(); // client-side navigation to the title
    await expect(page).toHaveURL(/\/(item|watch)\//);
    await page.goBack();
    await expect(row(page, 'Weiterschauen').locator('article.card')).toHaveCount(1);
    await page.waitForTimeout(600); // the background refresh of /api/home has landed
    await expect(row(page, 'Weiterschauen').locator('article.card')).toHaveCount(1);
  });

  test('a part the server flagged as failed is loaded the old way, the rest still renders', async ({ page }) => {
    const seen = watchApi(page);
    await page.route('**/api/home', (r) => r.fulfill({ json: {
      parts: {
        hero: items[0], resume: [episodes[0], items[2]], nextup: [episodes[1]], leaving: [],
        recs: { items: [], recIds: [], friends: [] }, because: { because: null, items: [], more: [] }, hubs: [], themed: [],
      },
      failed: ['recs'],
    } }));
    await page.goto('/');
    await expect(row(page, 'Weiterschauen').locator('article.card').first()).toBeVisible();
    await expect(row(page, 'Nächste Folge')).toBeAttached();
    // the failed part came through its own endpoints
    await expect(row(page, 'Von Freunden empfohlen').locator('article.card').first()).toBeAttached();
    expect(seen).toContain('/api/recommendations');
    expect(seen).toContain('/api/library/friends-rated');
    expect(seen).not.toContain('/api/library/resume');
  });
});

test.describe('home without /api/home', () => {
  test.use({ allowedConsole: /404/ }); // the 404 of the missing endpoint is the point of the test
  test('an unavailable /api/home falls back to the per-row endpoints (the old behaviour)', async ({ page }, info) => {
    const seen = watchApi(page);
    await page.route('**/api/home', (r) => r.fulfill({ status: 404, json: { error: 'not_found' } }));
    await page.goto('/');
    await expect(row(page, 'Weiterschauen').locator('article.card').first()).toBeVisible();
    await expect(row(page, 'Weil du „Inkwell“ gesehen hast')).toBeAttached();
    info.annotations.push({ type: 'api calls until first row (all fallbacks)', description: `${seen.length}: ${seen.join(' ')}` });
    expect(seen).toContain('/api/library/resume');
    expect(seen).toContain('/api/hubs');
  });
});
