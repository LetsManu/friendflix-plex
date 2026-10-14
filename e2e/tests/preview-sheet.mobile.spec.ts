// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import type { Page } from '@playwright/test';
import { row } from '../helpers.js';

/** a real touch swipe (Playwright's touchscreen only taps): start, a few moves, end */
async function swipe(page: Page, x: number, fromY: number, toY: number) {
  const cdp = await page.context().newCDPSession(page);
  const at = (y: number) => [{ x, y }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(fromY) });
  for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(fromY + ((toY - fromY) * i) / 8) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test.describe('preview sheet (phone)', () => {
  test('tapping a poster opens the preview sheet; Escape closes it and returns focus', async ({ page }) => {
    await page.goto('/');
    const poster = row(page, 'Weil du „Inkwell“ gesehen hast').locator('.pc a').first();
    await poster.scrollIntoViewIfNeeded();
    await poster.tap();

    const sheet = page.getByRole('dialog', { name: /^Vorschau: / });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { level: 2, name: 'Interlace' })).toBeVisible();
    await expect(page).toHaveURL(/\/$/); // the sheet does not navigate
    await expect(sheet.getByRole('button', { name: 'Schließen' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(poster).toBeFocused();
  });

  test('the close button and the backdrop dismiss the sheet', async ({ page }) => {
    await page.goto('/');
    const poster = row(page, 'Weil du „Inkwell“ gesehen hast').locator('.pc a').first();
    await poster.scrollIntoViewIfNeeded();
    const sheet = page.getByRole('dialog', { name: /^Vorschau: / });

    await poster.tap();
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Schließen' }).tap();
    await expect(sheet).toBeHidden();

    await poster.tap();
    await expect(sheet).toBeVisible();
    await page.touchscreen.tap(195, 40); // backdrop above the sheet
    await expect(sheet).toBeHidden();
  });

  test('swiping down anywhere on the sheet closes it; a short swipe springs back', async ({ page }) => {
    await page.goto('/');
    const poster = row(page, 'Weil du „Inkwell“ gesehen hast').locator('.pc a').first();
    await poster.scrollIntoViewIfNeeded();
    const sheet = page.getByRole('dialog', { name: /^Vorschau: / });
    await poster.tap();
    await expect(sheet).toBeVisible();

    const title = await sheet.getByRole('heading', { level: 2 }).boundingBox();
    if (!title) throw new Error('no title box');
    const x = title.x + 20, y = title.y + title.height / 2;

    await swipe(page, x, y, y + 30); // short: stays open and returns to its place
    await expect(sheet).toBeVisible();
    await expect.poll(async () => (await sheet.boundingBox())?.y).toBeLessThan(y);

    await swipe(page, x, y, y + 220); // long: closes
    await expect(sheet).toBeHidden();

    // a swipe that starts on the play button closes the sheet without starting playback
    await poster.tap();
    await expect(sheet).toBeVisible();
    const play = await sheet.locator('a.play').boundingBox();
    if (!play) throw new Error('no play box');
    await swipe(page, play.x + play.width / 2, play.y + play.height / 2, play.y + 260);
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/\/$/);
  });
});
