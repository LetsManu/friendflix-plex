// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

const SHOTS = process.env.B18_SHOTS;

test.describe('admin people (phone)', () => {
  test.use({ allowedConsole: /status of (500|502)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  for (const [path, h1, probe] of [['users', 'Nutzer', /Anna Beispiel/], ['roles', 'Rollen', null], ['devices', 'Geräte', /Chrome auf Windows/], ['invites', 'Einladungen', /Für Annas Bruder/], ['audit', 'Audit-Log', /Emma Schneider gesperrt/]] as const) {
    test(`${path}: cards instead of a table, nothing overflows at 390px`, async ({ page }) => {
      await page.goto(`/admin/${path}`);
      await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
      if (probe) await expect(page.getByText(probe).first()).toBeVisible();
      else await expect(page.getByRole('form', { name: 'Freund' })).toBeVisible();
      await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
      if (SHOTS) {
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${SHOTS}/${path}-phone.png`, fullPage: true });
      }
    });
  }

  test('users: role select and action menu work in the card layout', async ({ page, api }) => {
    await page.goto('/admin/users');
    const card = page.getByRole('row', { name: /Ben Test/ });
    await card.getByRole('combobox', { name: 'Rolle von Ben Test' }).selectOption('guest');
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('Ben Test ist jetzt Gast.')).toBeVisible();
    await card.getByRole('button', { name: 'Aktionen für Ben Test' }).click();
    await expect(page.getByRole('dialog', { name: 'Ben Test' }).getByRole('button', { name: 'Überall abmelden' })).toBeVisible();
    expect(api.log.some((l) => l.includes('"role":"guest"'))).toBe(true);
  });

  test('roles: editor is usable on the phone', async ({ page, api }) => {
    await page.goto('/admin/roles');
    const card = page.getByRole('form', { name: 'Gast' });
    await card.getByRole('switch', { name: 'Downloads erlauben' }).click();
    await card.getByRole('spinbutton', { name: 'Gleichzeitige Downloads' }).fill('4');
    await card.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('Rolle „Gast“ gespeichert.')).toBeVisible();
    expect(api.log.some((l) => l.startsWith('PUT /api/admin/roles/guest') && l.includes('"maxDownloads":4'))).toBe(true);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('devices: approve button inside the card', async ({ page, api }) => {
    await page.goto('/admin/devices');
    await page.getByRole('button', { name: '„Chrome auf Windows“ von Anna Beispiel freigeben' }).click();
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('„Chrome auf Windows“ von Anna Beispiel freigegeben.')).toBeVisible();
    await expect.poll(() => api.log.some((l) => l.startsWith('POST /api/admin/devices/approve'))).toBe(true);
  });

  test('invites: form + link + QR fit', async ({ page }) => {
    await page.goto('/admin/invites');
    await page.getByRole('button', { name: 'Einladung erstellen' }).click();
    const res = page.getByRole('region', { name: 'Dein Einladungs-Link' });
    await res.getByRole('button', { name: 'QR-Code zeigen' }).click();
    await expect(res.getByRole('img', { name: 'QR-Code' })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
