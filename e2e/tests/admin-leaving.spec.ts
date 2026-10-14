// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { leaveDay } from '../mocks/admin.js';
import { items } from '../mocks/fixtures.js';

// Admin → Bald weg (/admin/leaving) on the UI kit: table, add via search, edit, clear with Undo, validation, error state.
const SHOTS = '/tmp/claude-0/-home-user-friendflix/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/block18/int';
const toasts = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Hinweise' });
const inception = items[0]!, interstellar = items[1]!, dunkirk = items[3]!;

test.describe('admin: leaving soon (desktop)', () => {
  test.use({ allowedConsole: /status of (400|500)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('shell title + nav item, table sorted by date with remaining-days pills', async ({ page }) => {
    await page.goto('/admin/leaving');
    await expect(page.getByRole('heading', { level: 1, name: 'Bald weg' })).toBeVisible();
    await expect(page).toHaveTitle(/Bald weg/);
    const nav = page.getByRole('navigation', { name: 'Admin-Bereiche' });
    await expect(nav.getByRole('link', { name: 'Bald weg' })).toHaveAttribute('aria-current', 'page');
    const table = page.getByRole('table', { name: 'Bald nicht mehr verfügbar' });
    const rows = table.locator('tbody tr');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Inkwell');
    await expect(rows.nth(0)).toContainText('Nur noch 1 Tag');
    await expect(rows.nth(0)).toContainText('Lizenz endet');
    await expect(rows.nth(2)).toContainText('The Dawn Keeper');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: `${SHOTS}/leaving-desktop.png`, fullPage: true });
    // the filter searches notes too
    await page.getByRole('searchbox', { name: 'Tabelle filtern' }).fill('Rechte');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('The Dawn Keeper');
  });

  test('add a title found by search; Undo removes the new date again', async ({ page, api }) => {
    await page.route('**/api/library/items?**', (r) => r.fulfill({ json: { items: [dunkirk, inception], total: 2 } }));
    await page.goto('/admin/leaving');
    await page.getByRole('searchbox', { name: 'Titel suchen' }).fill('Dun');
    const hits = page.getByRole('list', { name: 'Suchergebnisse' });
    await hits.getByRole('button', { name: /Dunwick/ }).click();
    await expect(page.getByText('Ausgewählt: „Dunwick“')).toBeVisible();
    const date = page.getByLabel('Verlässt uns am');
    await expect(date).toBeFocused();
    // empty date → field error, nothing sent
    await page.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByText('Bitte ein Datum wählen.')).toBeVisible();
    await date.fill(leaveDay(9));
    await page.getByLabel('Notiz (nur für Admins)').fill('Lizenz');
    await page.getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Datum für „Dunwick“ gespeichert.')).toBeVisible();
    const table = page.getByRole('table', { name: 'Bald nicht mehr verfügbar' });
    await expect(table.getByRole('row', { name: /Dunwick/ })).toContainText('Nur noch 9 Tage');
    expect(api.log.some((l) => l.startsWith(`PUT /api/admin/leaving/${dunkirk.id}`) && l.includes('"note":"Lizenz"'))).toBe(true);
    await toasts(page).getByRole('button', { name: 'Rückgängig' }).click();
    await expect(table.getByRole('row', { name: /Dunwick/ })).toHaveCount(0);
    await expect.poll(() => api.log.some((l) => l.startsWith(`DELETE /api/admin/leaving/${dunkirk.id}`))).toBe(true);
    expect(api.admin.leaving.some((r) => r.itemId === dunkirk.id)).toBe(false);
  });

  test('a title that already has a date asks before it is changed', async ({ page }) => {
    await page.route('**/api/library/items?**', (r) => r.fulfill({ json: { items: [inception], total: 1 } }));
    await page.goto('/admin/leaving');
    await page.getByRole('searchbox', { name: 'Titel suchen' }).fill('Incep');
    await page.getByRole('list', { name: 'Suchergebnisse' }).getByRole('button', { name: /Inkwell/ }).click();
    const dlg = page.getByRole('alertdialog', { name: /„Inkwell“ hat schon ein Datum/ });
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(page.getByRole('heading', { name: 'Titel hinzufügen' })).toBeVisible();
    await page.getByRole('list', { name: 'Suchergebnisse' }).getByRole('button', { name: /Inkwell/ }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Datum ändern' }).click();
    await expect(page.getByRole('heading', { name: '„Inkwell“: Datum ändern' })).toBeVisible();
    await expect(page.getByLabel('Verlässt uns am')).toHaveValue(leaveDay(1));
  });

  test('edit from the row menu; a server range error keeps the old date', async ({ page, api }) => {
    await page.goto('/admin/leaving');
    const table = page.getByRole('table', { name: 'Bald nicht mehr verfügbar' });
    await page.getByRole('button', { name: 'Aktionen für Interlace' }).click();
    await page.getByRole('dialog', { name: 'Interlace' }).getByRole('button', { name: 'Datum ändern' }).click();
    const date = page.getByLabel('Verlässt uns am');
    await expect(date).toHaveValue(leaveDay(5));
    await date.fill(leaveDay(12));
    await page.getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Datum für „Interlace“ gespeichert.')).toBeVisible();
    await expect(table.getByRole('row', { name: /Interlace/ })).toContainText('Nur noch 12 Tage');
    expect(api.admin.leaving.find((r) => r.itemId === interstellar.id)?.leavesAt).toBe(leaveDay(12));
    // the server refuses (out of range): the row rolls back, the reason is shown
    await page.route(`**/api/admin/leaving/${inception.id}`, (r) => (r.request().method() === 'PUT' ? r.fulfill({ status: 400, json: { error: 'date_out_of_range' } }) : r.fallback()));
    await page.getByRole('button', { name: 'Aktionen für Inkwell' }).click();
    await page.getByRole('dialog', { name: 'Inkwell' }).getByRole('button', { name: 'Datum ändern' }).click();
    await page.getByLabel('Verlässt uns am').fill(leaveDay(3));
    await page.getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText(/Das Datum muss heute oder später liegen/)).toBeVisible();
    await expect(table.getByRole('row', { name: /Inkwell/ })).toContainText('Nur noch 1 Tag');
  });

  test('clear is optimistic with Undo (puts date and note back)', async ({ page, api }) => {
    await page.goto('/admin/leaving');
    const table = page.getByRole('table', { name: 'Bald nicht mehr verfügbar' });
    await page.getByRole('button', { name: 'Aktionen für Inkwell' }).click();
    await page.getByRole('dialog', { name: 'Inkwell' }).getByRole('button', { name: 'Datum entfernen' }).click();
    await expect(table.getByRole('row', { name: /Inkwell/ })).toHaveCount(0);
    await expect(toasts(page).getByText('Datum für „Inkwell“ entfernt.')).toBeVisible();
    await expect.poll(() => api.admin.leaving.some((r) => r.itemId === inception.id)).toBe(false);
    await toasts(page).getByRole('button', { name: 'Rückgängig' }).click();
    await expect(table.getByRole('row', { name: /Inkwell/ })).toContainText('Lizenz endet');
    expect(api.admin.leaving.find((r) => r.itemId === inception.id)).toMatchObject({ leavesAt: leaveDay(1), note: 'Lizenz endet' });
  });

  test('empty and error states', async ({ page, api }) => {
    api.admin.leaving = [];
    await page.goto('/admin/leaving');
    await expect(page.getByText('Aktuell ist für keinen Titel ein Datum gesetzt.')).toBeVisible();
    let fail = true;
    await page.route('**/api/admin/leaving', (r) => (fail ? r.fulfill({ status: 500, json: { error: 'boom' } }) : r.fallback()));
    await page.reload();
    const alert = page.getByRole('alert').filter({ hasText: 'Serverfehler' });
    await expect(alert).toBeVisible();
    fail = false;
    await alert.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(page.getByText('Aktuell ist für keinen Titel ein Datum gesetzt.')).toBeVisible();
  });
});
