// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { MOVIE } from '../mocks/fixtures.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';

/** Block 20 task 6: desktop player controls (wheel volume, double-click fullscreen, outside click, speed keys). */
async function open(page: import('@playwright/test').Page) {
  await mockPlayer(page);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await page.evaluate(() => { const v = document.querySelector('video')!; return v.play().catch(() => undefined); });
}
const volume = (page: import('@playwright/test').Page) => page.evaluate(() => document.querySelector('video')!.volume);

test('wheel down lowers volume', async ({ page, api: _api }) => {
  await open(page);
  const box = (await page.locator('.stage').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await page.mouse.wheel(0, 100);
  await expect.poll(() => volume(page)).toBeCloseTo(0.95, 2);
  await page.mouse.wheel(0, -100);
  await expect.poll(() => volume(page)).toBeCloseTo(1, 2);
});

test('dblclick toggles fullscreen', async ({ page, api: _api }) => {
  await open(page);
  const box = (await page.locator('.stage').boundingBox())!;
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 3);
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 3);
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
});

test('click outside closes the tracks menu and focus returns', async ({ page, api: _api }) => {
  await open(page);
  await page.locator('.stage').hover();
  const opener = page.getByRole('button', { name: 'Audio und Untertitel' });
  await opener.click();
  await expect(page.locator('.menu.tracks')).toBeVisible();
  const box = (await page.locator('.stage').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 4);
  await expect(page.locator('.menu.tracks')).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => document.querySelector('video')!.paused)).toBe(false); // the click only closed the menu
});

test('> raises speed and shows feedback', async ({ page, api: _api }) => {
  await open(page);
  await page.keyboard.press('>');
  await expect(page.locator('[aria-live]').filter({ hasText: '1,25×' }).first()).toBeAttached();
  expect(await page.evaluate(() => document.querySelector('video')!.playbackRate)).toBe(1.25);
  await page.keyboard.press('<'); await page.keyboard.press('<');
  expect(await page.evaluate(() => document.querySelector('video')!.playbackRate)).toBe(0.75);
});

test('wheel over slot content (chat) leaves the volume alone and scrolls it', async ({ page, api: _api }) => {
  await open(page);
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'fake-chat'; d.style.cssText = 'position:absolute;right:0;top:0;width:200px;height:200px;overflow:auto;z-index:8;background:#222';
    d.innerHTML = '<div style="height:1000px">chat</div>';
    document.querySelector('.stage')!.appendChild(d);
  });
  const b = (await page.locator('#fake-chat').boundingBox())!;
  await page.mouse.move(b.x + 100, b.y + 100);
  await page.mouse.wheel(0, 100);
  await expect.poll(() => page.evaluate(() => document.querySelector('#fake-chat')!.scrollTop)).toBeGreaterThan(0);
  expect(await volume(page)).toBe(1);
});
