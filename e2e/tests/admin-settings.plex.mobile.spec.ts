// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { settingsState } from '../mocks/settings.js';

// fork: Admin → Einstellungen (Plex) on the phone (390px): the media card fits, with the not_admin note shown.
test.describe('admin: settings (Plex, phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; api.settings = settingsState('plex'); api.settings.testResult = { ok: true, code: 'warning', detail: 'not_admin' }; });

  test('the Plex rows and the note fit without horizontal overflow', async ({ page }) => {
    await page.goto('/admin/settings');
    const media = page.locator('section', { has: page.getByRole('heading', { level: 2, name: 'Mediaserver', exact: true }) });
    await media.getByRole('button', { name: 'Testen' }).click();
    await expect(media.getByRole('status')).toContainText('nicht dem Besitzer des Plex-Servers');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    const vw = await page.evaluate(() => window.innerWidth);
    for (const name of ['Plex-Adresse', 'Plex-Token']) {
      const box = (await page.getByRole('group', { name, exact: true }).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(vw + 0.5);
    }
    const btn = media.getByRole('button', { name: 'Speichern' });
    expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
});
