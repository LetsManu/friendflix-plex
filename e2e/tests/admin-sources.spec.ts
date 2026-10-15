// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';

// Admin → Datenquellen (/admin/sources): optional TMDB/OMDb keys; only last4 is ever shown.
const toasts = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Hinweise' });
const card = (page: import('@playwright/test').Page, name: string) => page.locator('section', { has: page.getByRole('heading', { name, exact: true }) });

test.describe('admin: data sources', () => {
  test.use({ allowedConsole: /status of (401|409|500)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('set key: pill shows …abcd, the typed key is gone from the field and the HTML', async ({ page }) => {
    await page.goto('/admin/sources');
    const tmdb = card(page, 'TMDB');
    await expect(tmdb.getByText('Nicht gesetzt')).toBeVisible();
    const field = tmdb.getByLabel('Neuer Schlüssel');
    await expect(field).toHaveAttribute('type', 'password');
    await expect(field).toHaveAttribute('autocomplete', 'off');
    await field.fill('sekret-key-wxyzabcd');
    const put = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith('/api/admin/sources/tmdb'));
    await tmdb.getByRole('button', { name: 'Speichern' }).click();
    expect(await (await put).text()).not.toContain('sekret-key-wxyzabcd');
    await expect(toasts(page).getByText('Schlüssel gespeichert.')).toBeVisible();
    await expect(tmdb.getByText('Gesetzt · …abcd')).toBeVisible();
    await expect(field).toHaveValue('');
    expect(await page.content()).not.toContain('sekret-key-wxyzabcd');
    const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
    expect(stored).not.toContain('sekret-key-wxyzabcd');
  });

  test('save and remove without a recent sign-in go through /auth/reauth and back to /admin/sources; the key is not kept', async ({ page }) => {
    await page.route('**/api/admin/sources/*', (r) => (['PUT', 'DELETE'].includes(r.request().method())
      ? r.fulfill({ status: 401, json: { error: 'reauth_required' } }) : r.fallback()));
    const nexts: Array<string | null> = [];
    const urls: string[] = [];
    await page.route('**/auth/reauth?**', (r) => {
      urls.push(r.request().url());
      nexts.push(new URL(r.request().url()).searchParams.get('next'));
      return r.fulfill({ status: 200, contentType: 'text/html', body: '<p>sign in</p>' });
    });
    await page.goto('/admin/sources');
    await card(page, 'TMDB').getByLabel('Neuer Schlüssel').fill('sekret-key-reauth99');
    await card(page, 'TMDB').getByRole('button', { name: 'Speichern' }).click();
    await expect.poll(() => nexts).toEqual(['/admin/sources']);
    expect(urls.join('\n')).not.toContain('sekret-key-reauth99');
    expect(await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]))).not.toContain('sekret-key-reauth99');
    await page.goto('/admin/sources');
    await card(page, 'OMDb').getByRole('button', { name: 'Entfernen' }).click();
    await page.getByRole('alertdialog').or(page.getByRole('dialog')).getByRole('button', { name: 'Entfernen' }).click();
    await expect.poll(() => nexts).toEqual(['/admin/sources', '/admin/sources']);
  });

  test('failed save keeps the typed key and shows an error', async ({ page }) => {
    await page.goto('/admin/sources');
    const tmdb = card(page, 'TMDB');
    const field = tmdb.getByLabel('Neuer Schlüssel');
    await field.fill('boom-key-12345');
    await tmdb.getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Speichern fehlgeschlagen.')).toBeVisible();
    await expect(field).toHaveValue('boom-key-12345');
    await expect(tmdb.getByText('Nicht gesetzt')).toBeVisible();
  });

  test('invalid key shows the red "Schlüssel ungültig" pill', async ({ page, api }) => {
    api.admin.sources[1] = { name: 'omdb', set: true, last4: 'k3y9', from: 'db', invalid: true, usedToday: 12, budget: 900 };
    await page.goto('/admin/sources');
    await expect(card(page, 'OMDb').getByText('Schlüssel ungültig')).toBeVisible();
  });

  test('409 from_file on save shows the from-file message', async ({ page }) => {
    await page.route('**/api/admin/sources/tmdb', (r) => (r.request().method() === 'PUT' ? r.fulfill({ status: 409, json: { error: 'from_file' } }) : r.fallback()));
    await page.goto('/admin/sources');
    const tmdb = card(page, 'TMDB');
    await tmdb.getByLabel('Neuer Schlüssel').fill('some-key-12345');
    await tmdb.getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText(/kommt aus einer Datei/)).toBeVisible();
  });

  test('test: success toast; rejected key shows "Schlüssel wurde abgelehnt"', async ({ page }) => {
    await page.goto('/admin/sources');
    const omdb = card(page, 'OMDb');
    await omdb.getByRole('button', { name: 'Testen' }).click();
    await expect(toasts(page).getByText('Verbindung funktioniert.')).toBeVisible();
    await omdb.getByLabel('Neuer Schlüssel').fill('bad-key-12345');
    await omdb.getByRole('button', { name: 'Testen' }).click();
    await expect(toasts(page).getByText('Schlüssel wurde abgelehnt')).toBeVisible();
  });

  test('remove asks for confirmation, then the pill says "Nicht gesetzt"', async ({ page }) => {
    await page.goto('/admin/sources');
    const omdb = card(page, 'OMDb');
    await expect(omdb.getByText('Gesetzt · …k3y9')).toBeVisible();
    await omdb.getByRole('button', { name: 'Entfernen' }).click();
    const dlg = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    await expect(dlg).toContainText('Schlüssel für OMDb entfernen?');
    await dlg.getByRole('button', { name: 'Entfernen' }).click();
    await expect(omdb.getByText('Nicht gesetzt')).toBeVisible();
    await expect(toasts(page).getByText('Schlüssel entfernt.')).toBeVisible();
  });

  test('from file: field and Save are disabled, hint is visible', async ({ page, api }) => {
    api.admin.sources[0] = { name: 'tmdb', set: true, last4: 'file', from: 'file', invalid: false };
    await page.goto('/admin/sources');
    const tmdb = card(page, 'TMDB');
    await expect(tmdb.getByText('Aus Datei')).toBeVisible();
    await expect(tmdb.getByLabel('Neuer Schlüssel')).toBeDisabled();
    await expect(tmdb.getByRole('button', { name: 'Speichern' })).toBeDisabled();
    await expect(tmdb.getByRole('button', { name: 'Entfernen' })).toBeDisabled();
    await expect(tmdb.getByText(/kommt aus einer Datei/)).toBeVisible();
  });

  test('OMDb shows today\'s usage', async ({ page }) => {
    await page.goto('/admin/sources');
    await expect(card(page, 'OMDb').getByText('12 von 900 Abfragen heute')).toBeVisible();
  });

  test('intro carries the TMDB notice as plain text (no logo)', async ({ page }) => {
    await page.goto('/admin/sources');
    const intro = page.locator('p.intro');
    await expect(intro).toContainText('Dieses Produkt nutzt die TMDB-API, ist aber weder von TMDB unterstützt noch zertifiziert.');
    await expect(intro.locator('img, svg')).toHaveCount(0);
  });

  test('nav: Datenquellen under Betrieb, active on /admin/sources', async ({ page }) => {
    await page.goto('/admin/sources');
    await expect(page.getByRole('heading', { level: 1, name: 'Datenquellen' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Admin-Bereiche' });
    await expect(nav.getByRole('link', { name: 'Datenquellen' })).toHaveAttribute('aria-current', 'page');
  });
});
