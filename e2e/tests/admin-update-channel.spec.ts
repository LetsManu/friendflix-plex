// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

const { version, codename } = JSON.parse(readFileSync(new URL('../../version.json', import.meta.url), 'utf8')) as { version: string; codename: string };
const toasts = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Hinweise' });

test.describe('admin update channel (desktop)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('release build on stable: the running channel, the switch saves UPDATE_CHANNEL, the snippet follows the selection', async ({ page, api }) => {
    await page.goto('/admin/update');
    const card = page.getByRole('region', { name: 'Update-Kanal' });
    await expect(card).toContainText('Läuft auf:');
    await expect(card).toContainText('Stabil (Release 1.0.0)');
    const group = card.getByRole('radiogroup', { name: 'Update-Kanal' });
    const stable = group.getByRole('radio', { name: 'Stabil' });
    const nightly = group.getByRole('radio', { name: 'Nightly' });
    await expect(stable).toHaveAttribute('aria-checked', 'true');
    await expect(nightly).toHaveAttribute('aria-checked', 'false');
    // the mock has a newer release: the update snippet with the stable line
    await expect(card.getByLabel('Zeile in der .env')).toHaveValue('FF_TAG=latest');
    await expect(card.getByLabel('Befehl')).toHaveValue('docker compose -f compose.prod.yaml -f compose.plex.yaml pull && docker compose -f compose.prod.yaml -f compose.plex.yaml up -d');
    await expect(card).toContainText('FriendFlix greift nie selbst auf Docker zu');

    await nightly.click();
    await expect(toasts(page).getByText('Kanal Nightly gespeichert.')).toBeVisible();
    expect(api.settings.puts).toEqual([{ values: { UPDATE_CHANNEL: 'nightly' } }]);
    await expect(nightly).toHaveAttribute('aria-checked', 'true');
    await expect(card.getByLabel('Zeile in der .env')).toHaveValue('FF_TAG=nightly');
    await expect(card).toContainText('Zum Wechsel auf Nightly diese Zeile');
    // nightly: commits on main are the update, the latest main build carries its label, no release notes
    const ver = page.getByRole('region', { name: 'Version' });
    await expect(ver).toContainText('3 Updates verfügbar');
    await expect(ver).toContainText('Nightly · Build ff00aa1');
    await expect(ver.getByText(/Was ist neu/)).toHaveCount(0);
    await expect(page.getByRole('table', { name: 'Änderungen' })).toBeVisible();

    // arrow keys work like a radio group
    await nightly.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(stable).toHaveAttribute('aria-checked', 'true');
    await expect(stable).toBeFocused();
    await expect.poll(() => api.settings.puts.length).toBe(2);
    expect(api.settings.puts[1]).toEqual({ values: { UPDATE_CHANNEL: 'stable' } });
    await expect(card.getByLabel('Zeile in der .env')).toHaveValue('FF_TAG=latest');
  });

  test('nightly build: version text with the sha in the footer and the version card; switching to stable shows FF_TAG=latest', async ({ page, api }) => {
    api.build = { sha: 'abc1234deadbeefabc1234deadbeefabc1234dea', build: 'nightly', channel: 'nightly', label: `${version}-nightly · abc1234` };
    await page.goto('/admin/update');
    await expect(page.getByRole('contentinfo').getByRole('button', { name: `FriendFlix for Plex ${version}-nightly · abc1234` })).toBeVisible();
    const card = page.getByRole('region', { name: 'Update-Kanal' });
    await expect(card).toContainText('Nightly · Build c0be6c5'); // the installed sha of the update answer
    // selected stable (default) differs from the running nightly: the switch hint
    await expect(card).toContainText('Zum Wechsel auf Stabil');
    await expect(card.getByLabel('Zeile in der .env')).toHaveValue('FF_TAG=latest');
    await expect(page.getByRole('region', { name: 'Version' }).getByRole('button', { name: `${version}-nightly · abc1234` })).toBeVisible();
  });

  test('release build: the footer keeps "version · codename"', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('contentinfo').getByRole('button', { name: `FriendFlix for Plex ${version} · ${codename}` })).toBeVisible();
  });

  test('up to date on the running channel: no snippet; a channel set in the environment cannot be switched', async ({ page, api }) => {
    const now = new Date().toISOString();
    await page.route('**/api/admin/update', (r) => r.fulfill({ json: {
      current: { sha: 'c0be6c5deadbeef', builtAt: now, version: '1.1.0', codename: 'Arancini' }, release: null, updateAvailable: false,
      latest: null, behind: 0, portainer: { configured: false, mode: null }, autoUpdateNote: true, commits: [],
      channel: { selected: 'stable', running: 'stable', build: 'release', label: '1.1.0', locked: true, envLine: 'FF_TAG=latest' },
    } }));
    await page.goto('/admin/update');
    const card = page.getByRole('region', { name: 'Update-Kanal' });
    await expect(card.getByRole('radio', { name: 'Stabil' })).toBeDisabled();
    await expect(card.getByRole('radio', { name: 'Nightly' })).toBeDisabled();
    await expect(card).toContainText('In der Umgebung festgelegt (UPDATE_CHANNEL)');
    await expect(card.locator('[data-snippet]')).toHaveCount(0);
    expect(api.settings.puts).toEqual([]);
  });

  test.describe('320 px', () => {
    test.use({ viewport: { width: 320, height: 640 } });
    test('the channel card fits', async ({ page, api }) => {
      api.build = { sha: 'abc1234deadbeefabc1234deadbeefabc1234dea', build: 'nightly', channel: 'nightly', label: `${version}-nightly · abc1234` };
      await page.goto('/admin/update');
      const card = page.getByRole('region', { name: 'Update-Kanal' });
      await expect(card.locator('[data-snippet]')).toBeVisible();
      await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
      for (const el of [card, card.getByRole('radiogroup'), card.getByLabel('Befehl')]) {
        const box = await el.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      }
    });
  });
});
