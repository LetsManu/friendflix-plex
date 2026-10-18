// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { episodes } from '../mocks/fixtures.js';
import { available, castOn, castSessions, fakeCastSdk, mockHls, stubAirPlay } from '../mocks/cast.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect } from '../fixtures.js';
import type { Page } from '@playwright/test';

/** Shared setup of the cast remote screen specs (desktop + mobile): the watch page as the TV's remote. */

export const SHOTS = '/tmp/claude-0/-home-user/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/cast-ui';

async function clientNav(page: Page, path: string) {
  await page.evaluate((path) => { const a = document.createElement('a'); a.href = path; document.body.appendChild(a); a.click(); a.remove(); }, path);
  await expect(page).toHaveURL((u) => u.pathname === path);
}
/** GET /api/items/{id}/next: episode 2 follows episode 1 */
export const nextAfterFirst = (page: Page) => page.route('**/api/items/*/next', (r) => r.fulfill({ json: { item: r.request().url().includes(episodes[0]!.id) ? episodes[1] : null } }));

/** Chromecast: episode 1 cast from its watch page, which stays open as the remote */
export async function chromecastRemote(page: Page) {
  await mockPlayer(page);
  await castOn(page);
  const sdk = await fakeCastSdk(page);
  await castSessions(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await clientNav(page, '/watch/' + episodes[0]!.id);
  await videoReady(page);
  await sdk.start();
  await expect(page.locator('.remote')).toContainText('Wird auf Wohnzimmer-TV abgespielt');
  await nextAfterFirst(page);
  return sdk;
}

/** AirPlay: episode 1 sent to the TV with the player's AirPlay button; the watch page stays the remote */
export async function airplayRemote(page: Page) {
  await stubAirPlay(page, { pickTv: true });
  await mockPlayer(page);
  await castOn(page);
  await mockHls(page);
  await castSessions(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await clientNav(page, '/watch/' + episodes[0]!.id);
  await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await available(page);
  if (await page.locator('.ctl.hide').count()) await page.locator('.stage').click({ position: { x: 30, y: 200 } });
  await page.getByRole('button', { name: 'Auf AirPlay-Gerät abspielen' }).click();
  await expect(page.getByTestId('airplay-active')).toContainText('Läuft über AirPlay');
}

/** the controls are shown (they hide after a while) */
export async function showControls(page: Page) {
  await page.locator('.stage').hover({ position: { x: 20, y: 20 } }).catch(() => undefined);
  if (await page.locator('.ctl.hide').count()) await page.locator('.stage').click({ position: { x: 20, y: 300 } });
}

/** the device row: one line, inside the 16 px gutters */
export async function rowFits(page: Page) {
  const r = await page.getByTestId('cast-row').evaluate((row) => {
    const vw = document.documentElement.clientWidth;
    const kids = [...row.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
    return { h: row.getBoundingClientRect().height, tops: kids.map((k) => Math.round(k.top)), left: Math.min(...kids.map((k) => k.left)), right: Math.max(...kids.map((k) => k.right)), vw };
  });
  expect(r.h).toBeLessThanOrEqual(48);
  expect(new Set(r.tops).size).toBe(1);
  expect(r.left).toBeGreaterThanOrEqual(16);
  expect(r.right).toBeLessThanOrEqual(r.vw - 16);
}
