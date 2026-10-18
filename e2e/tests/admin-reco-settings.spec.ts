// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';

// The recommendation settings (Admin → Einstellungen, group "Empfehlungen"): the engine, exploration, half-life and the post-play
// screen are database settings; the admin recommendation card says which engine is active, whether .env locks it, and links here.
type Page = import('@playwright/test').Page;
const group = (page: Page) => page.locator('section', { has: page.getByRole('heading', { level: 2, name: 'Empfehlungen', exact: true }) });
const setting = (page: Page, name: string) => page.getByRole('group', { name, exact: true });

test.describe('admin: recommendation settings', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('the group explains the engines and the .env-only expert keys; switching to v2 saves and the card shows it', async ({ page, api }) => {
    await page.goto('/admin/settings');
    const g = group(page);
    await expect(g.getByText(/RECO_COEFFS.*RECO_W_\*.*\.env/)).toBeVisible();
    const engine = setting(page, 'Empfehlungs-Engine');
    await expect(engine.getByText(/„Ähnliche Titel“-Listen des Medienservers/)).toBeVisible();
    await expect(engine.getByText(/auf v2 umschalten, sobald dessen Zahlen mindestens genauso gut sind/)).toBeVisible();
    const sel = engine.getByRole('combobox');
    await expect(sel).toHaveValue('shadow');
    await expect(sel.locator('option')).toHaveText(['v1 (klassisch)', 'v2 (eigenes Geschmacksmodell)', 'Shadow (v2 neben v1)']);
    await sel.selectOption('v2');
    await setting(page, 'Anteil Exploration').getByRole('spinbutton').fill('0.1');
    await g.getByRole('button', { name: 'Speichern' }).click();
    await expect.poll(() => api.settings.puts.length).toBe(1);
    expect(api.settings.puts[0]!.values).toEqual({ RECO_ENGINE: 'v2', RECO_EXPLORE: 0.1 });
    // live setting: no restart banner
    await expect(group(page).getByText('Neustart nötig', { exact: true })).toHaveCount(0);

    await page.goto('/admin');
    const card = page.getByTestId('reco-card');
    await expect(card.getByTestId('reco-engine')).toContainText('v2 (eigenes Modell) ist aktiv · in Admin → Einstellungen änderbar');
  });

  test('"Engine ändern" on the admin card opens the group, scrolled into view', async ({ page }) => {
    await page.goto('/admin');
    const card = page.getByTestId('reco-card');
    await expect(card.getByTestId('reco-engine')).toContainText('Shadow (v2 läuft nebenher) ist aktiv');
    await card.getByRole('link', { name: 'Engine ändern' }).click();
    await expect(page).toHaveURL(/\/admin\/settings#settings-recommendations$/);
    const heading = page.getByRole('heading', { level: 2, name: 'Empfehlungen', exact: true });
    await expect(heading).toHaveAttribute('id', 'settings-recommendations');
    await expect(heading).toBeInViewport();
  });

  test('RECO_ENGINE from .env: the card says it is locked, the field is disabled', async ({ page, api }) => {
    const item = api.settings.groups.flatMap((x) => x.items).find((i) => i.key === 'RECO_ENGINE')!;
    item.source = 'env';
    item.value = 'v1';
    await page.goto('/admin');
    await expect(page.getByTestId('reco-engine')).toContainText('v1 (klassisch) ist aktiv · in der .env festgelegt (RECO_ENGINE), in den Einstellungen gesperrt');
    await page.goto('/admin/settings#settings-recommendations');
    const engine = setting(page, 'Empfehlungs-Engine');
    await expect(engine.getByText('Aus der Umgebung', { exact: true })).toBeVisible();
    await expect(engine.getByRole('combobox')).toBeDisabled();
  });

  test('the post-play screen can be switched off for everyone', async ({ page, api }) => {
    await page.goto('/admin/settings');
    const post = setting(page, 'Bildschirm nach dem Ende');
    await post.getByRole('switch').click();
    await group(page).getByRole('button', { name: 'Speichern' }).click();
    await expect.poll(() => api.settings.puts.length).toBe(1);
    expect(api.settings.puts[0]!.values).toEqual({ POSTPLAY_ENABLED: false });
  });
});
