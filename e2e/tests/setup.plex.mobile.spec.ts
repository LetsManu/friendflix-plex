// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { SETUP_CODE, setupState } from '../mocks/setup.js';

// fork: the Plex media step on the phone (390px): fields and buttons fit, buttons are at least 44px tall.
const h2 = (page: Page, name: string) => page.getByRole('heading', { level: 2, name, exact: true });

test.describe('setup wizard: Plex media step (phone)', () => {
  test.use({ allowedConsole: /status of (401|503)/ });
  test.beforeEach(({ api }) => { api.setup = setupState('plex'); api.setup.steps.publicUrl = 'done'; });

  test('fits at 390px, also with the not_admin note and Next', async ({ page, api }) => {
    api.setup!.testResults.media = { ok: true, code: 'warning', detail: 'not_admin' };
    await page.goto('/setup');
    await page.getByLabel('Einrichtungscode', { exact: true }).fill(SETUP_CODE);
    await page.getByRole('button', { name: 'Entsperren' }).click();
    await expect(h2(page, 'Medienserver')).toBeVisible();
    await page.getByLabel('Plex-Adresse').fill('http://plex.example.com:32400');
    await page.getByLabel('Plex-Token').fill('plex-token-placeholder');
    await page.getByRole('button', { name: 'Speichern und weiter' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'nicht dem Besitzer' })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    const vw = await page.evaluate(() => window.innerWidth);
    const buttons = page.locator('main').locator('button:visible');
    for (let i = 0; i < await buttons.count(); i++) {
      const b = buttons.nth(i);
      await b.scrollIntoViewIfNeeded();
      const box = (await b.boundingBox())!;
      expect(box.height, await b.innerText()).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width).toBeLessThanOrEqual(vw + 0.5);
    }
  });
});
