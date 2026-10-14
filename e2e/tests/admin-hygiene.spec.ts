// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page, Request } from '@playwright/test';
import { expect, test } from '../fixtures.js';

const hx = (n: number): string => n.toString(16).padStart(32, '0');
const LANTERN = hx(0x701), QUIET = hx(0x702), OLD = hx(0x707);
const table = (page: Page) => page.getByRole('table', { name: 'Bibliothekspflege' });
const toasts = (page: Page) => page.getByRole('region', { name: 'Hinweise' });
const listCalls = (page: Page) => {
  const urls: URL[] = [];
  page.on('request', (r: Request) => { const u = new URL(r.url()); if (u.pathname === '/api/admin/hygiene') urls.push(u); });
  return urls;
};

test.describe('admin library hygiene', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('tiles show counts; clicking "Sprache" filters (request has category=language) and marks the tile pressed', async ({ page }) => {
    const urls = listCalls(page);
    await page.goto('/admin/hygiene');
    const lang = page.getByRole('button', { name: /Sprache/ });
    await expect(lang).toHaveAttribute('aria-pressed', 'false');
    await expect(lang).toContainText('2');
    await expect(page.getByRole('button', { name: /Dateien/ })).toContainText('62');
    await expect(table(page).getByRole('row')).toHaveCount(51); // header + 50 per page
    await lang.click();
    await expect(lang).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => urls.at(-1)?.searchParams.get('category')).toBe('language');
    await expect(table(page).getByRole('row')).toHaveCount(3);
    await lang.click();
    await expect(lang).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => urls.at(-1)?.searchParams.has('category')).toBe(false);
  });

  test('issue select narrows to foreign_no_subs; search sends q', async ({ page }) => {
    const urls = listCalls(page);
    await page.goto('/admin/hygiene');
    await page.getByRole('combobox', { name: 'Problem' }).selectOption('foreign_no_subs');
    await expect.poll(() => urls.at(-1)?.searchParams.get('issue')).toBe('foreign_no_subs');
    await expect(table(page).getByRole('row')).toHaveCount(2);
    await expect(page.getByText('Weder Ton noch vollständige Untertitel in einer Sprache des Haushalts: Untertitel ergänzen.')).toBeVisible();
    await page.getByRole('combobox', { name: 'Problem' }).selectOption('');
    await page.getByRole('button', { name: /Sprache/ }).click(); // the issue picked the category; unpress it
    await expect(page.getByRole('button', { name: /Sprache/ })).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('searchbox', { name: 'Tabelle filtern' }).fill('zephyr');
    await expect.poll(() => urls.at(-1)?.searchParams.get('q')).toBe('zephyr');
    await expect(page.getByText('1–50 von 60')).toBeVisible();
  });

  test('row shows pills "Keine Untertitel" (warn) and "HEVC 10-Bit" (info); link goes to /item/<id>', async ({ page }) => {
    await page.goto('/admin/hygiene');
    const row = table(page).getByRole('row', { name: /Lantern Bay/ });
    await expect(row.locator('.pill.warn')).toHaveText('Keine Untertitel');
    await expect(row.locator('.pill.info')).toHaveText('HEVC 10-Bit');
    await expect(row.getByRole('link', { name: 'Lantern Bay' })).toHaveAttribute('href', `/item/${LANTERN}`);
    await expect(row).toContainText('hevc 10-bit 2160p HDR');
    await expect(row).toContainText('Untertitel: keine');
    await expect(row).toContainText('48 Mbit/s');
    const dup = table(page).getByRole('row', { name: /Ironwood/ }).first();
    await expect(dup.getByRole('link', { name: 'Eintrag 1' })).toHaveAttribute('href', /\/item\/0+70[34]$/);
    await expect(table(page).getByRole('row', { name: /Sundial · Pilot/ })).toBeVisible();
  });

  test('ignore → row disappears, toast with Undo; Undo → DELETE and row back', async ({ page, api }) => {
    await page.goto('/admin/hygiene');
    const row = table(page).getByRole('row', { name: /Old Reel/ });
    await row.getByRole('button', { name: /Aktionen/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: '„Seltenes Videoformat“ ignorieren' }).click();
    await expect(row.locator('.pill')).toHaveCount(1);
    await row.getByRole('button', { name: /Aktionen/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: '„Seltenes Tonformat“ ignorieren' }).click();
    await expect(table(page).getByRole('row', { name: /Old Reel/ })).toHaveCount(0);
    await expect(toasts(page).getByText('„Seltenes Tonformat“ bei „Old Reel“ ignoriert.')).toBeVisible();
    expect(api.admin.hygiene.ignored.has(`${OLD}|audio_codec`)).toBe(true);
    await toasts(page).getByRole('button', { name: 'Rückgängig' }).last().click();
    await expect(table(page).getByRole('row', { name: /Old Reel/ })).toHaveCount(1);
    expect(api.log.some((l) => l.startsWith('DELETE /api/admin/hygiene/ignore') && l.includes('audio_codec'))).toBe(true);
    expect(api.admin.hygiene.ignored.has(`${OLD}|audio_codec`)).toBe(false);
  });

  test('refresh metadata posts once and shows a toast; hidden when canRefresh false', async ({ page, api }) => {
    await page.goto('/admin/hygiene');
    const row = table(page).getByRole('row', { name: /Quiet Harbor/ });
    await row.getByRole('button', { name: /Aktionen/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Metadaten neu laden' }).click();
    await expect(toasts(page).getByText('Metadaten für „Quiet Harbor“ werden neu geladen.')).toBeVisible();
    expect(api.admin.hygiene.refreshed).toEqual([QUIET]);
    // a file issue has no refresh
    await table(page).getByRole('row', { name: /Lantern Bay/ }).getByRole('button', { name: /Aktionen/ }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Metadaten neu laden' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    api.admin.hygiene.canRefresh = false;
    await page.reload();
    await table(page).getByRole('row', { name: /Quiet Harbor/ }).getByRole('button', { name: /Aktionen/ }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: /ignorieren/ }).first()).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Metadaten neu laden' })).toHaveCount(0);
  });

  test('Jetzt prüfen → POST scan; running state disables the button', async ({ page, api }) => {
    await page.goto('/admin/hygiene');
    await expect(page.getByText(/Zuletzt geprüft vor 12 Minuten · vollständig vorgestern/)).toBeVisible();
    const btn = page.getByRole('button', { name: 'Jetzt prüfen' });
    await btn.click();
    await expect(toasts(page).getByText('Prüfung gestartet.')).toBeVisible();
    await expect(btn).toBeDisabled();
    await expect(page.getByText('Prüfung läuft …')).toBeVisible();
    expect(api.admin.hygiene.scans).toBe(1);
  });

  test('unsupported → explanation card, no table', async ({ page, api }) => {
    api.admin.hygiene.supported = false;
    await page.goto('/admin/hygiene');
    await expect(page.getByRole('region', { name: 'Nicht unterstützt' })).toContainText('Dieser Medienserver liefert keine Angaben für die Bibliothekspflege.');
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Jetzt prüfen' })).toHaveCount(0);
  });

  test('nav: Bibliothekspflege under Inhalte, active on /admin/hygiene', async ({ page }) => {
    await page.goto('/admin/hygiene');
    await expect(page.getByRole('heading', { level: 1, name: 'Bibliothekspflege' })).toBeVisible();
    await expect(page).toHaveTitle('Bibliothekspflege · Admin – FriendFlix');
    const nav = page.getByRole('navigation', { name: 'Admin-Bereiche' });
    const link = nav.getByRole('list', { name: 'Inhalte' }).getByRole('link', { name: /Bibliothekspflege/ });
    await expect(link).toHaveAttribute('aria-current', 'page');
    await expect(link).toHaveAttribute('href', '/admin/hygiene');
  });
});
