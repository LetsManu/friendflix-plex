// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';

const table = (page: Page) => page.getByRole('table', { name: 'Nutzung' });

test.describe('admin usage', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('30 days default; rows show hours, streams, "25 % · Videoformat", devices "2/3"', async ({ page, api }) => {
    await page.goto('/admin/usage');
    await expect(page.getByRole('combobox', { name: 'Zeitraum' })).toHaveValue('30');
    const row = table(page).getByRole('row', { name: /Tester/ });
    await expect(row).toContainText('1,5 Std.');
    await expect(row).toContainText('Filme 1 Std. · Serien 0,5 Std.');
    await expect(row).toContainText('25 % · Videoformat');
    await expect(row).toContainText('2/3');
    await expect(row.getByRole('cell').nth(4)).toHaveText('8');
    await expect(table(page).getByRole('row', { name: /Emma Schneider/ }).getByText('Gesperrt')).toBeVisible();
    await expect(page.getByText('Zusammengefasst, ohne Titel: wie viel geschaut wird, nicht was.')).toBeVisible();
    await expect(page.getByText(/^Daten seit /)).toBeVisible();
    expect(api.admin.usageCalls).toEqual(['days=30']);
  });

  test('switching to 7 days requests days=7', async ({ page, api }) => {
    await page.goto('/admin/usage');
    await expect(table(page).getByRole('row', { name: /Tester/ })).toContainText('1,5 Std.');
    await page.getByRole('combobox', { name: 'Zeitraum' }).selectOption('7');
    await expect.poll(() => api.admin.usageCalls.at(-1)).toBe('days=7');
    await expect(table(page).getByRole('row', { name: /Tester/ })).toContainText('0,4 Std.');
    // data recorded for 10 days covers the whole 7-day period: no "Daten seit"
    await expect(page.getByText(/^Daten seit /)).toHaveCount(0);
  });

  test('expand loads detail once, shows bars and devices, aria-expanded toggles', async ({ page, api }) => {
    await page.goto('/admin/usage');
    const btn = table(page).getByRole('button', { name: 'Details zu Tester' });
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-expanded', 'true');
    const panel = page.getByRole('region', { name: 'Tester · Letzte 30 Tage' });
    await expect(panel.getByRole('img', { name: /^Schauzeit pro Tag: insgesamt/ })).toBeVisible();
    await expect(panel.locator('.bar')).toHaveCount(30);
    await expect(panel.getByText('Chrome auf Windows')).toBeVisible();
    await expect(panel.getByText('Infuse')).toBeVisible();
    await expect(panel.getByText('Unbekanntes Gerät')).toBeVisible();
    await expect(panel.getByRole('listitem').filter({ hasText: 'Videoformat' })).toContainText('2');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toHaveCount(0);
    await btn.click();
    await expect(page.getByRole('region', { name: 'Tester · Letzte 30 Tage' })).toBeVisible();
    expect(api.admin.usageDetailCalls).toEqual(['u1']);
  });

  test('"läuft gerade" links to /admin/playback', async ({ page }) => {
    await page.goto('/admin/usage');
    const link = table(page).getByRole('row', { name: /Anna Beispiel/ }).getByRole('link', { name: '1 Stream läuft' });
    await expect(link).toHaveAttribute('href', '/admin/playback');
  });

  test('page text contains no title from the mocks\' running sessions', async ({ page, api }) => {
    await page.goto('/admin/usage');
    await table(page).getByRole('button', { name: 'Details zu Anna Beispiel' }).click();
    await expect(page.getByRole('region', { name: /Anna Beispiel · / }).getByText('Chrome auf Windows')).toBeVisible();
    const text = await page.locator('main').innerText();
    for (const l of api.admin.live) {
      expect(text).not.toContain(l.title);
      if (l.seriesName) expect(text).not.toContain(l.seriesName);
      expect(text).not.toContain(l.itemId);
    }
  });

  test('nav: Nutzung under Personen, active on /admin/usage', async ({ page }) => {
    await page.goto('/admin/usage');
    await expect(page.getByRole('heading', { level: 1, name: 'Nutzung' })).toBeVisible();
    await expect(page).toHaveTitle('Nutzung · Admin – FriendFlix');
    const link = page.getByRole('navigation', { name: 'Admin-Bereiche' }).getByRole('list', { name: 'Personen' }).getByRole('link', { name: /Nutzung/ });
    await expect(link).toHaveAttribute('aria-current', 'page');
  });
});
