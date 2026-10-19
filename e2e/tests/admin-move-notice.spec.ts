// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';

const TEXT = 'FriendFlix für Plex ist umgezogen: FriendFlix 2.0 unterstützt Plex jetzt direkt. Wechsle, um weiter Updates zu bekommen.';
const GUIDE_DE = 'https://github.com/LetsManu/friendflix/blob/main/docs/de/plex.md#umstieg-von-friendflix-plex-auf-friendflix-20';
const notice = (page: import('@playwright/test').Page) => page.getByRole('main').locator('.mv');

test.describe('move notice (desktop)', () => {
  test('admin sees it on the home page and /browse with the German guide link; no dialog', async ({ page, api }) => {
    api.asAdmin = true;
    for (const path of ['/', '/browse/movies']) {
      await page.goto(path);
      const n = notice(page);
      await expect(n).toBeVisible();
      await expect(n).toContainText(TEXT);
      await expect(n.getByRole('link', { name: 'So wechselst du' })).toHaveAttribute('href', GUIDE_DE);
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
  });

  test('hide for 7 days: stays hidden after a reload, comes back after 7 days', async ({ page, api }) => {
    api.asAdmin = true;
    await page.goto('/browse/movies');
    await notice(page).getByRole('button', { name: 'Für 7 Tage ausblenden' }).click();
    await expect(notice(page)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
    const stored = await page.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('ff-move-notice-hidden:')));
    expect(stored).toBeTruthy();
    await page.evaluate(([k]) => localStorage.setItem(k as string, String(Date.now() - 1000)), stored!);
    await page.reload();
    await expect(notice(page)).toBeVisible();
  });

  test('no notice for a normal user', async ({ page, api }) => {
    api.asAdmin = false;
    await page.goto('/browse/movies');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.mv')).toHaveCount(0);
  });

  test('Admin → Update: fixed notice at the top, not hideable, shown once', async ({ page, api }) => {
    api.asAdmin = true;
    await page.goto('/admin/update');
    const n = notice(page);
    await expect(n).toHaveCount(1);
    await expect(n).toContainText(TEXT);
    await expect(n.getByRole('link', { name: 'So wechselst du' })).toHaveAttribute('href', GUIDE_DE);
    await expect(n.getByRole('button')).toHaveCount(0);
    const h = (await page.getByRole('main').locator('h1').first().boundingBox())!;
    expect((await n.boundingBox())!.y).toBeGreaterThanOrEqual(h.y);
  });
});
