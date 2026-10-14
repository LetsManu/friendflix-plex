// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { MOVIE, MOVIE2 } from '../mocks/fixtures.js';
import { available, castOn, castSessions, fakeCastSdk, mockHls, picks, stubAirPlay } from '../mocks/cast.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { noHorizontalOverflow } from '../helpers.js';
import { expect, test } from '../fixtures.js';
import type { Page } from '@playwright/test';

/** The cast bar on the phone: docked on the tab bar, 48 px targets, the offline banner and toasts above it, AirPlay reconnect. */

/** a client-side navigation by a link click (a full page load would fire pagehide and end the cast) */
async function clientNav(page: Page, path: string) {
  await page.evaluate((path) => { const a = document.createElement('a'); a.href = path; document.body.appendChild(a); a.click(); a.remove(); }, path);
  await expect(page).toHaveURL((u) => u.pathname === path);
}
/** a Chromecast cast started on the watch page, then back on the home page; `fail()` -> 429 on a token request */
async function castAndLeave(page: Page, o: { fail?: () => boolean } = {}) {
  await mockPlayer(page);
  await castOn(page);
  const sdk = await fakeCastSdk(page);
  const tokens = await castSessions(page, { fail: o.fail });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await clientNav(page, '/watch/' + MOVIE.id);
  await videoReady(page);
  await sdk.start();
  await expect(page.locator('.castov')).toContainText('Wird auf Wohnzimmer-TV abgespielt');
  await clientNav(page, '/');
  await expect(castBar(page)).toBeVisible();
  return { sdk, ...tokens };
}
const castBar = (page: Page) => page.getByRole('region', { name: 'Jetzt auf dem Fernseher' });

test('airplay route lost -> reconnect text, one tap opens the picker', async ({ page, api: _api }) => {
  await stubAirPlay(page, { pickTv: true });
  await mockPlayer(page);
  await castOn(page);
  await mockHls(page);
  await castSessions(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await clientNav(page, '/watch/' + MOVIE.id);
  await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await available(page);
  if (await page.locator('.ctl.hide').count()) await page.locator('.stage').tap({ position: { x: 30, y: page.viewportSize()!.height * 0.3 } });
  await page.getByRole('button', { name: 'Auf AirPlay-Gerät abspielen' }).tap();
  await expect(page.getByTestId('airplay-active')).toContainText('Läuft über AirPlay');
  await clientNav(page, '/');
  const bar = castBar(page);
  await expect(bar).toBeVisible();
  // the TV is gone for longer than the 4 s grace
  await page.evaluate(() => {
    (window as unknown as { __wireless: boolean }).__wireless = false;
    document.querySelector('video[data-cast-engine]')!.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged'));
  });
  await page.waitForTimeout(4500);
  const hint = bar.getByRole('button', { name: /Verbindung verloren – tippen, um am Fernseher fortzusetzen/ });
  await expect(hint).toBeVisible();
  const before = await picks(page);
  await hint.tap();
  await expect.poll(() => picks(page)).toBe(before + 1);
  await expect(page).toHaveURL(/\/$/); // a reconnect, not the remote
});

test('bar sits directly above the tab bar', async ({ page, api: _api }) => {
  await castAndLeave(page);
  const bar = await castBar(page).boundingBox();
  const tabbar = await page.locator('nav.tabbar').boundingBox();
  expect(bar).not.toBeNull();
  expect(tabbar).not.toBeNull();
  expect(Math.abs(bar!.y + bar!.height - tabbar!.y)).toBeLessThanOrEqual(1);
  expect(bar!.height).toBe(64);
  expect(bar!.width).toBe(390);
});

test.describe('banner and toasts', () => {
  test.use({ allowedConsole: /status of 429|ERR_INTERNET_DISCONNECTED/ });
  test('offline banner and toasts stay visible above the bar', async ({ page, api: _api }) => {
    let fail = false;
    await castAndLeave(page, { fail: () => fail });
    // a switch whose token request fails (429) once the watch page is left: error toast, bar in `reconnect`
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await page.route('**/api/cast/session', async (r) => { if (fail) await gate; return r.fallback(); });
    fail = true;
    await clientNav(page, '/watch/' + MOVIE2.id);
    await expect(page.locator('.castov')).toBeVisible();
    await clientNav(page, '/');
    release();
    const bar = castBar(page);
    await expect(bar).toContainText('Verbindung verloren');
    const toast = page.locator('.toasts .toast').first();
    await expect(toast).toBeVisible();
    await page.context().setOffline(true);
    const banner = page.locator('.offbar');
    await expect(banner).toBeVisible();
    const b = (await bar.boundingBox())!;
    for (const el of [banner, toast]) {
      const r = (await el.boundingBox())!;
      expect(r.y + r.height).toBeLessThanOrEqual(b.y + 0.5);
      expect(r.y).toBeGreaterThanOrEqual(0);
    }
    await page.context().setOffline(false);
  });
});

test('no horizontal overflow', async ({ page, api: _api }) => {
  await castAndLeave(page);
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test('buttons are at least 48 px', async ({ page, api: _api }) => {
  await castAndLeave(page);
  const buttons = castBar(page).getByRole('button');
  await expect(buttons).toHaveCount(3);
  for (const b of await buttons.all()) {
    const r = (await b.boundingBox())!;
    expect(r.width).toBeGreaterThanOrEqual(48);
    expect(r.height).toBeGreaterThanOrEqual(48);
  }
});
