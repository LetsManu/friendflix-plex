// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { noHorizontalOverflow } from '../helpers.js';
import { expect, test } from '../fixtures.js';
import { airplayRemote, chromecastRemote, rowFits, SHOTS, showControls } from './cast-remote-setup.js';

/** The watch page as the TV's remote on a phone: artwork, one device row, the card; no fullscreen, no volume on AirPlay. */

test.describe('320 px', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('airplay: no horizontal overflow, the device row stays one line, no fullscreen, no volume', async ({ page, api: _api }) => {
    await airplayRemote(page);
    const screen = page.locator('.remote');
    await expect(screen.getByRole('button', { name: 'AirPlay-Gerät wechseln' })).toContainText('AirPlay');
    await expect(screen.getByRole('button', { name: 'Übertragung beenden' })).toBeVisible();
    await rowFits(page);
    expect(await noHorizontalOverflow(page)).toBe(true);
    await showControls(page);
    await expect(page.getByRole('button', { name: 'Vollbild' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stumm' })).toHaveCount(0);
  });

  test('chromecast: the receiver\'s name in the chip; no fullscreen, the TV volume stays', async ({ page, api: _api }) => {
    await chromecastRemote(page);
    await expect(page.locator('.remote').getByRole('button', { name: 'Gerät wechseln' })).toContainText('Wohnzimmer-TV');
    await rowFits(page);
    expect(await noHorizontalOverflow(page)).toBe(true);
    await showControls(page);
    await expect(page.getByRole('button', { name: 'Vollbild' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stumm' })).toBeVisible();
  });
});

test.describe('screenshots', () => {
  test.skip(!process.env.CAST_SHOTS, 'only with CAST_SHOTS=1');
  test('phone: AirPlay, Chromecast, next up', async ({ page, api: _api }) => {
    await airplayRemote(page);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/mobile-airplay.png` });
  });
  test('phone: Chromecast and next up', async ({ page, api: _api }) => {
    const sdk = await chromecastRemote(page);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/mobile-chromecast.png` });
    await sdk.nearEnd();
    await expect(page.getByRole('group', { name: 'Nächste Folge' })).toContainText(/in \d+ s/);
    await page.screenshot({ path: `${SHOTS}/mobile-nextup.png` });
  });
});
