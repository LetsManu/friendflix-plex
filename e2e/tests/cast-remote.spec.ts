// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { noHorizontalOverflow } from '../helpers.js';
import { expect, test } from '../fixtures.js';
import { airplayRemote, chromecastRemote, rowFits, SHOTS, showControls } from './cast-remote-setup.js';

/** The watch page as the TV's remote on desktop: the same screen, centred with a max width. */

test('chromecast: card with titles and device, centred; no fullscreen, TV volume; the card turns into the next episode', async ({ page, api: _api }) => {
  const sdk = await chromecastRemote(page);
  const card = page.locator('.remote .rcard');
  await expect(card).toContainText('Wird auf Wohnzimmer-TV abgespielt');
  const box = (await card.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(420);
  expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThan(4);
  await rowFits(page);
  expect(await noHorizontalOverflow(page)).toBe(true);
  await showControls(page);
  await expect(page.getByRole('button', { name: 'Vollbild' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stumm' })).toBeVisible();
  await sdk.nearEnd();
  const next = page.getByRole('group', { name: 'Nächste Folge' });
  await expect(next).toContainText(/in \d+ s/);
  await expect(next.getByRole('button', { name: 'Jetzt abspielen' })).toBeVisible();
  await next.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(next).not.toContainText(/in \d+ s/);
});

test('airplay: "AirPlay" in the chip, no fullscreen, no volume', async ({ page, api: _api }) => {
  await airplayRemote(page);
  await expect(page.locator('.remote').getByRole('button', { name: 'AirPlay-Gerät wechseln' })).toContainText('AirPlay');
  await expect(page.locator('.remote .rcard')).toContainText('Läuft über AirPlay');
  await showControls(page);
  await expect(page.getByRole('button', { name: 'Vollbild' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stumm' })).toHaveCount(0);
});

test.describe('screenshots', () => {
  test.skip(!process.env.CAST_SHOTS, 'only with CAST_SHOTS=1');
  test('desktop: AirPlay', async ({ page, api: _api }) => {
    await airplayRemote(page);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/desktop-airplay.png` });
  });
  test('desktop: Chromecast and next up', async ({ page, api: _api }) => {
    const sdk = await chromecastRemote(page);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/desktop-chromecast.png` });
    await sdk.nearEnd();
    await expect(page.getByRole('group', { name: 'Nächste Folge' })).toContainText(/in \d+ s/);
    await page.screenshot({ path: `${SHOTS}/desktop-nextup.png` });
  });
});
