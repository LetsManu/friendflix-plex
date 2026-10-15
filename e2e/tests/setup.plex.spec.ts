// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { SETUP_CODE, setupState } from '../mocks/setup.js';

// fork: the setup wizard's media step on a Plex instance: manual only (address + token), Test runs before Save so a token that works
// but is not the server owner's (probe warning not_admin) is shown. The token is a placeholder; it never stays in the page or storage.
const h2 = (page: Page, name: string) => page.getByRole('heading', { level: 2, name, exact: true });
const TOKEN = 'plex-token-placeholder';
const VALUES = { PLEX_URL: 'http://plex.example.com:32400', PLEX_TOKEN: TOKEN };

async function toMediaStep(page: Page) {
  await page.goto('/setup');
  await page.getByLabel('Einrichtungscode', { exact: true }).fill(SETUP_CODE);
  await page.getByRole('button', { name: 'Entsperren' }).click();
  await expect(h2(page, 'Medienserver')).toBeVisible();
}
const storage = (page: Page) => page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);

test.describe('setup wizard: Plex media step', () => {
  test.use({ allowedConsole: /status of (400|401|403|409|410|429|503)/ });
  test.beforeEach(({ api }) => { api.setup = setupState('plex'); api.setup.steps.publicUrl = 'done'; });

  test('manual only: Plex address and token fields, no automatic mode, no Jellyfin wording', async ({ page }) => {
    await toMediaStep(page);
    await expect(page.getByRole('button', { name: 'Automatisch', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Passwort')).toHaveCount(0);
    await expect(page.getByLabel('Plex-Adresse')).toBeVisible();
    const token = page.getByLabel('Plex-Token');
    await expect(token).toHaveAttribute('type', 'password');
    await expect(token).toHaveAttribute('autocomplete', 'off');
    const text = await page.locator('main').innerText();
    expect(text).toContain('den Token seines Besitzers');
    expect(text).not.toMatch(/jellyfin|seerr/i);
    await expect(page.locator('main img, main svg[role=img]')).toHaveCount(0);
  });

  test('a token that is not the owner\'s: Test runs before Save, the note is shown, Next goes on; the token is gone from the page', async ({ page, api }) => {
    api.setup!.testResults.media = { ok: true, code: 'warning', detail: 'not_admin' };
    await toMediaStep(page);
    await page.getByLabel('Plex-Adresse').fill(VALUES.PLEX_URL);
    await page.getByLabel('Plex-Token').fill(TOKEN);
    await page.getByRole('button', { name: 'Speichern und weiter' }).click();
    const note = page.getByRole('status').filter({ hasText: 'gehört aber nicht dem Besitzer des Plex-Servers' });
    await expect(note).toBeVisible();
    // saved, but the step waits for "Weiter" so the note can be read
    await expect(h2(page, 'Medienserver')).toBeVisible();
    expect(api.setup!.tests).toEqual([{ group: 'media', values: VALUES }]);
    expect(api.setup!.puts).toEqual([{ values: VALUES }]);
    await expect(page.getByLabel('Plex-Token')).toHaveValue('');
    expect(await page.content()).not.toContain(TOKEN);
    expect(await storage(page)).not.toContain(TOKEN);
    await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await expect(h2(page, 'Anmeldung')).toBeVisible();
  });

  test('an owner token: no note, the step goes on right after the save', async ({ page, api }) => {
    await toMediaStep(page);
    await page.getByLabel('Plex-Adresse').fill(VALUES.PLEX_URL);
    await page.getByLabel('Plex-Token').fill(TOKEN);
    await page.getByRole('button', { name: 'Speichern und weiter' }).click();
    await expect(h2(page, 'Anmeldung')).toBeVisible();
    expect(api.setup!.tests).toHaveLength(1);
    expect(api.setup!.puts).toEqual([{ values: VALUES }]);
  });

  test('a refused token is not saved and has no "Save anyway"; an unreachable server may be forced', async ({ page, api }) => {
    api.setup!.testResults.media = { ok: false, code: 'unauthorized' };
    api.setup!.saveProbeFail = { ok: false, code: 'unauthorized' };
    await toMediaStep(page);
    await page.getByLabel('Plex-Adresse').fill(VALUES.PLEX_URL);
    await page.getByLabel('Plex-Token').fill(TOKEN);
    await page.getByRole('button', { name: 'Speichern und weiter' }).click();
    await expect(page.getByRole('alert')).toContainText('Zugriff verweigert');
    await expect(page.getByRole('button', { name: 'Trotzdem speichern' })).toHaveCount(0);
    api.setup!.saveProbeFail = { ok: false, code: 'unreachable' };
    await page.getByRole('button', { name: 'Speichern und weiter' }).click();
    await page.getByRole('button', { name: 'Trotzdem speichern' }).click();
    await expect(h2(page, 'Anmeldung')).toBeVisible();
    expect(api.setup!.puts.at(-1)).toEqual({ values: VALUES, force: true });
    expect(await page.content()).not.toContain(TOKEN);
  });

  test('fork: an address with ?X-Plex-Token=… is refused with its own hint; nothing is saved, the step stays', async ({ page, api }) => {
    const CANARY = 'url-token-canary-placeholder';
    await toMediaStep(page);
    await page.getByLabel('Plex-Adresse').fill(`http://plex.example.com:32400/?X-Plex-Token=${CANARY}`);
    await page.getByLabel('Plex-Token').fill(TOKEN);
    await page.getByRole('button', { name: 'Speichern und weiter' }).click();
    await expect(page.getByText('Bitte nur die Serveradresse eingeben')).toBeVisible();
    await expect(page.getByLabel('Plex-Adresse')).toHaveAttribute('aria-invalid', 'true');
    await expect(h2(page, 'Medienserver')).toBeVisible();
    expect(api.setup!.steps.media).not.toBe('done');
    expect(await storage(page)).not.toContain(CANARY);
    expect(await storage(page)).not.toContain(TOKEN);
  });

  test('the Test button shows the not_admin note too', async ({ page, api }) => {
    api.setup!.testResults.media = { ok: true, code: 'warning', detail: 'not_admin' };
    await toMediaStep(page);
    await page.getByLabel('Plex-Adresse').fill(VALUES.PLEX_URL);
    await page.getByLabel('Plex-Token').fill(TOKEN);
    await page.getByRole('button', { name: 'Prüfen' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'gehört aber nicht dem Besitzer des Plex-Servers' })).toBeVisible();
    expect(api.setup!.puts).toEqual([]);
  });
});
