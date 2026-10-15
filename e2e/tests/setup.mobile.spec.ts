// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { SETUP_CODE, setupState } from '../mocks/setup.js';

// The setup wizard on the phone (390px): every step fits, every control is at least 44px tall and has a name.
const h2 = (page: Page, name: string) => page.getByRole('heading', { level: 2, name, exact: true });

/** no horizontal overflow; every visible button and input inside the wizard fits the width; buttons are >= 44px and named */
async function fits(page: Page) {
  await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  const vw = await page.evaluate(() => window.innerWidth);
  const controls = page.locator('main').locator('button:visible, input:visible, a.btn:visible');
  const n = await controls.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const c = controls.nth(i);
    await c.scrollIntoViewIfNeeded();
    const box = (await c.boundingBox())!;
    const tag = await c.evaluate((e) => e.tagName);
    const name = await c.evaluate((e) => (e as HTMLElement).getAttribute('aria-label') || (e as HTMLInputElement).labels?.[0]?.textContent || e.textContent || '');
    expect(name.trim(), `${tag} without a name`).not.toBe('');
    if (tag !== 'INPUT') expect(box.height, name).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(-0.5);
    expect(box.x + box.width, name).toBeLessThanOrEqual(vw + 0.5);
  }
}

test.describe('setup wizard (phone)', () => {
  test.use({ allowedConsole: /status of (401|503)/ });
  test.beforeEach(({ api }) => { api.setup = setupState(); });

  test('every step is usable at 390px; inputs and step buttons have names', async ({ page }) => {
    await page.goto('/setup');
    await expect(h2(page, 'Einrichtungscode eingeben')).toBeVisible();
    await fits(page);
    const steps = page.getByRole('navigation', { name: 'Schritte der Einrichtung' }).getByRole('button');
    await expect(steps).toHaveCount(5);
    await expect(steps.nth(0)).toHaveAccessibleName('Schritt 1: Einrichtungscode (offen)');
    await page.getByLabel('Einrichtungscode', { exact: true }).fill(SETUP_CODE);
    await page.getByRole('button', { name: 'Entsperren' }).click();

    await expect(h2(page, 'Öffentliche Adresse')).toBeVisible();
    await expect(steps.nth(1)).toHaveAccessibleName('Schritt 2: Öffentliche Adresse (offen)');
    await fits(page);
    await page.getByRole('button', { name: 'Speichern und weiter' }).click();

    await expect(h2(page, 'Medienserver')).toBeVisible();
    await expect(page.getByLabel('Admin-Passwort')).toBeVisible();
    await fits(page);
    await page.getByRole('button', { name: 'Von Hand' }).click();
    await expect(page.getByLabel('Jellyfin-API-Schlüssel (Admin)')).toBeVisible();
    await fits(page);
    await steps.nth(3).click();

    await expect(h2(page, 'Anmeldung')).toBeVisible();
    await page.getByLabel('Authentik-Adresse').fill('https://auth.example.com');
    await page.getByLabel('Admin-API-Token').fill('ak-admin-placeholder');
    await page.getByRole('button', { name: 'Plan anzeigen' }).click();
    await expect(page.getByRole('button', { name: 'Anwenden' })).toBeVisible();
    await fits(page);
    await page.getByRole('button', { name: 'Anwenden' }).click();
    await expect(page.getByRole('list', { name: 'Noch von Hand zu erledigen' })).toBeVisible();
    await fits(page);
    await page.getByRole('button', { name: 'Von Hand' }).click();
    await expect(page.getByLabel('Redirect-URI (strict)')).toBeVisible();
    await fits(page);
    await steps.nth(4).click();

    await expect(h2(page, 'Erster Admin')).toBeVisible();
    await fits(page);
  });

  test('extras fit at 390px', async ({ page, api }) => {
    api.setup = undefined;
    api.asAdmin = true;
    await page.goto('/setup/extras');
    await expect(page.getByRole('heading', { level: 1, name: 'Fast fertig: Extras' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Anfragen überspringen' })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    const vw = await page.evaluate(() => window.innerWidth);
    const buttons = page.locator('main').getByRole('button');
    for (let i = 0; i < await buttons.count(); i++) {
      const b = buttons.nth(i);
      await b.scrollIntoViewIfNeeded();
      const box = (await b.boundingBox())!;
      expect(box.height, await b.innerText()).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width).toBeLessThanOrEqual(vw + 0.5);
    }
  });
});
