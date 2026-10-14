// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';

test.describe('/diagnose (phone)', () => {
  test('shows the live viewport table and a copy button', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/diagnose');
    await expect(page.getByRole('heading', { level: 1, name: 'Anzeige-Diagnose' })).toBeVisible();
    const table = page.getByTestId('diagnose-table');
    await expect(table.getByRole('row', { name: /innerWidth x innerHeight/ })).toBeVisible();
    await expect(table.getByRole('row', { name: /env\(safe-area-inset-top\)/ })).toBeVisible();
    await expect(table.getByRole('row', { name: /env\(safe-area-inset-bottom\)/ })).toBeVisible();
    await expect(table.getByRole('row', { name: /\.tabbar rect/ })).toContainText(/height \d/);
    const inner = await page.evaluate(() => `${window.innerWidth} x ${window.innerHeight}`);
    await expect(table.getByRole('row', { name: /innerWidth x innerHeight/ })).toContainText(inner);

    await page.getByRole('button', { name: 'Werte kopieren' }).click();
    await expect(page.getByRole('status')).toContainText(/Kopiert|Kopieren nicht möglich/);
    const text = await page.evaluate(() => navigator.clipboard.readText()).catch(() => 'innerWidth x innerHeight: env(safe-area-inset-top)');
    expect(text).toContain('innerWidth x innerHeight');
    expect(text).toContain('env(safe-area-inset-top)');
  });
});

test.describe('/diagnose link (phone)', () => {
  test('admins reach the diagnose page from Mein Bereich without typing a URL', async ({ page, api }) => {
    api.asAdmin = true;
    await page.goto('/me');
    await page.getByTestId('me-diagnose').click();
    await expect(page).toHaveURL(/\/diagnose$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Anzeige-Diagnose' })).toBeVisible();
  });

  test('viewers without admin rights see no diagnose entry', async ({ page }) => {
    await page.goto('/me');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.getByTestId('me-diagnose')).toHaveCount(0);
  });
});

test.describe('tab bar (phone)', () => {
  test('labels share one baseline although the avatar is taller than the icons', async ({ page }) => {
    await page.goto('/me');
    const labels = page.locator('.tabbar a > span:last-child');
    await expect(labels).toHaveCount(3);
    const bottoms = await labels.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().bottom));
    expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThanOrEqual(1);
    const icons = await page.locator('.tabbar .ico').evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return [b.width, b.height]; }));
    expect(icons).toEqual([[24, 24], [24, 24], [24, 24]]);
  });
});
