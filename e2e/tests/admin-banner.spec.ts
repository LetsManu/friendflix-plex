// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { ME, MOVIE } from '../mocks/fixtures.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';

const FP = { media: '0123456789ab', disk: 'abcdef012345', disk2: 'fedcba987654' };
const banner = (page: import('@playwright/test').Page) => page.getByRole('main').locator('.hb');

test.describe('admin warning banner', () => {
  test.beforeEach(({ api }) => {
    api.asAdmin = true;
    api.admin.bannerIssues = [
      { id: 'disk:downloads', level: 'warn', reason: 'full', fp: FP.disk, detail: { pct: 93 } },
      { id: 'svc:media', level: 'err', reason: 'down', fp: FP.media },
    ];
  });

  test('admin sees the banner on / and /browse with the worst issue first and "+1 weitere"', async ({ page }) => {
    for (const path of ['/', '/browse/movies']) {
      await page.goto(path);
      const b = banner(page);
      await expect(b).toBeVisible();
      await expect(b.locator('.msg').first()).toHaveText('Medienserver nicht erreichbar');
      const more = b.getByRole('button', { name: '+1 weitere' });
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      await more.click();
      await expect(b.getByRole('button', { name: 'Weniger anzeigen' })).toHaveAttribute('aria-expanded', 'true');
      await expect(b.getByRole('listitem')).toHaveText('Download-Speicher fast voll (93 %)');
    }
  });

  test('a red issue is announced with role=alert, a yellow one with role=status', async ({ page, api }) => {
    await page.goto('/browse/movies');
    await expect(page.getByRole('alert').filter({ hasText: 'Medienserver nicht erreichbar' })).toBeVisible();
    api.admin.bannerIssues = api.admin.bannerIssues.filter((i) => i.level === 'warn');
    await page.goto('/browse/series');
    await expect(page.getByRole('status').filter({ hasText: 'Download-Speicher fast voll (93 %)' })).toBeVisible();
  });

  test('close → POST dismiss {id, fp}; banner hides; next poll with the same fp stays hidden; a changed fp shows it again', async ({ page, api }) => {
    await page.clock.install();
    api.admin.bannerIssues = [{ id: 'disk:downloads', level: 'warn', reason: 'full', fp: FP.disk, detail: { pct: 93 } }];
    await page.goto('/browse/movies');
    const b = banner(page);
    await expect(b).toContainText('Download-Speicher fast voll (93 %)');
    await b.getByRole('button', { name: 'Ausblenden', exact: true }).click();
    await expect(b).toHaveCount(0);
    expect(api.log.filter((l) => l.startsWith('POST /api/admin/health/dismiss'))).toEqual([`POST /api/admin/health/dismiss {"id":"disk:downloads","fp":"${FP.disk}"} -> 200`]);
    // next poll: same issue, same fingerprint (only the number moved) → stays hidden
    api.admin.bannerIssues = [{ id: 'disk:downloads', level: 'warn', reason: 'full', fp: FP.disk, detail: { pct: 94 } }];
    const calls = api.admin.bannerCalls;
    await page.clock.runFor(61_000);
    await expect.poll(() => api.admin.bannerCalls).toBeGreaterThan(calls);
    await expect(b).toHaveCount(0);
    // the level changed (warn → err): new fingerprint → back
    api.admin.bannerIssues = [{ id: 'disk:downloads', level: 'err', reason: 'full', fp: FP.disk2, detail: { pct: 96 } }];
    await page.clock.runFor(61_000);
    await expect(b).toContainText('Download-Speicher fast voll (96 %)');
  });

  test('Ansehen navigates to /admin/status', async ({ page }) => {
    await page.goto('/browse/movies');
    await banner(page).getByRole('link', { name: 'Ansehen' }).click();
    await expect(page).toHaveURL(/\/admin\/status$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Status' })).toBeVisible();
  });

  test('no banner on /watch/<id>', async ({ page, api }) => {
    await mockPlayer(page);
    await page.goto('/watch/' + MOVIE.id);
    await videoReady(page);
    await expect(page.locator('.hb')).toHaveCount(0);
    expect(api.admin.bannerCalls).toBe(0);
  });

  test('no banner in TV mode (html.tv)', async ({ page, api }) => {
    await page.goto('/browse/movies?tv=1');
    await expect(page.locator('html')).toHaveClass(/\btv\b/);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.locator('.hb')).toHaveCount(0);
    expect(api.admin.bannerCalls).toBe(0);
  });

  test('no banner on a non-owner profile of an admin account', async ({ page, api }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, role: 'admin', roleLabel: 'Admin', isAdmin: true, profile: { id: 'p2', name: 'Anna', avatar: 'a2', isOwner: false } } }));
    await page.goto('/browse/movies');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.hb')).toHaveCount(0);
    expect(api.admin.bannerCalls).toBe(0);
  });

  test('no banner for a friend (no banner request made)', async ({ page, api }) => {
    api.asAdmin = false;
    await page.goto('/browse/movies');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.hb')).toHaveCount(0);
    expect(api.admin.bannerCalls).toBe(0);
  });

  test.describe('failing banner request', () => {
    test.use({ allowedConsole: /status of 500/ });
    test('no banner, no error toast', async ({ page, api }) => {
      api.admin.bannerFails = true;
      await page.goto('/browse/movies');
      await expect.poll(() => api.admin.bannerCalls).toBeGreaterThan(0);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('.hb')).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Hinweise' }).locator('[role=alert], .toast')).toHaveCount(0);
    });
  });
});
