// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { LEAK, settingsState } from '../mocks/settings.js';

// fork: Admin → Einstellungen on a Plex instance: the media group shows only PLEX_* (never JELLYFIN_*), the token is write-only (leak
// canary), Save runs the check first so a token that is not the owner's is noted, and a stale session's Jellyfin key answers 401.
type Page = import('@playwright/test').Page;
const card = (page: Page, name: string) => page.locator('section', { has: page.getByRole('heading', { level: 2, name, exact: true }) });
const setting = (page: Page, name: string) => page.getByRole('group', { name, exact: true });
const TOKEN = 'plex-token-placeholder';

test.describe('admin: settings (Plex)', () => {
  test.use({ allowedConsole: /status of (400|401)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; api.settings = settingsState('plex'); });

  test('the media group shows the Plex address and token only; the token canary never reaches the page', async ({ page }) => {
    await page.goto('/admin/settings');
    const media = card(page, 'Mediaserver');
    await expect(setting(page, 'Plex-Adresse').getByRole('textbox')).toHaveValue('http://plex.example.com:32400');
    const token = setting(page, 'Plex-Token');
    await expect(token.getByText('Gesetzt · …ZZZZ')).toBeVisible();
    await expect(media.getByText(/Jellyfin/)).toHaveCount(0);
    await token.getByRole('button', { name: 'Plex-Token ersetzen' }).click();
    await expect(token.getByLabel('Neuer Wert')).toHaveAttribute('type', 'password');
    expect(await page.content()).not.toContain(LEAK);
    const values = await page.locator('input, textarea').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(values.join('\n')).not.toContain(LEAK);
    expect(await page.locator('main').innerText()).not.toMatch(/jellyfin|seerr/i);
  });

  test('Save checks first: a token that is not the owner\'s is saved and the note is shown', async ({ page, api }) => {
    api.settings.testResult = { ok: true, code: 'warning', detail: 'not_admin' };
    await page.goto('/admin/settings');
    const media = card(page, 'Mediaserver');
    await setting(page, 'Plex-Token').getByRole('button', { name: 'Plex-Token ersetzen' }).click();
    await setting(page, 'Plex-Token').getByLabel('Neuer Wert').fill(TOKEN);
    await media.getByRole('button', { name: 'Speichern' }).click();
    await expect(media.getByRole('status').filter({ hasText: 'gehört aber nicht dem Besitzer des Plex-Servers' })).toBeVisible();
    expect(api.settings.tests).toEqual([{ group: 'media', values: { PLEX_TOKEN: TOKEN } }]);
    expect(api.settings.puts).toEqual([{ values: { PLEX_TOKEN: TOKEN } }]);
    expect(await page.content()).not.toContain(TOKEN);
  });

  test('an owner token is saved without a note; a refused token is not saved', async ({ page, api }) => {
    await page.goto('/admin/settings');
    const media = card(page, 'Mediaserver');
    await setting(page, 'Plex-Adresse').getByRole('textbox').fill('http://plex.example.com:32400/');
    await media.getByRole('button', { name: 'Speichern' }).click();
    await expect(media.getByRole('status')).toHaveCount(0);
    api.settings.probeFail = { ok: false, code: 'unauthorized' };
    await setting(page, 'Plex-Adresse').getByRole('textbox').fill('http://plex.example.com:32401');
    await media.getByRole('button', { name: 'Speichern' }).click();
    await expect(media.getByRole('alert')).toContainText('Zugang abgelehnt');
    await expect(media.getByRole('button', { name: 'Trotzdem speichern' })).toHaveCount(0);
  });

  test('the Test button shows the same note', async ({ page, api }) => {
    api.settings.testResult = { ok: true, code: 'warning', detail: 'not_admin' };
    await page.goto('/admin/settings');
    const media = card(page, 'Mediaserver');
    await media.getByRole('button', { name: 'Testen' }).click();
    await expect(media.getByRole('status')).toContainText('nicht dem Besitzer des Plex-Servers');
  });
});
