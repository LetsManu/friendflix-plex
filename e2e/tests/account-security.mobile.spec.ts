// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { installLogin, loginState, password } from '../mocks/login.js';

// The security section on the phone (390px): the rows stack (text above, button full width), the re-auth dialog is a bottom sheet.
test('phone: panel rows stack and the dialog fits', async ({ page }) => {
  await installLogin(page.context(), loginState({ starts: [{ body: password('anna') }] }));
  await page.goto('/me/account');
  const sec = page.getByRole('region', { name: 'Sicherheit' });
  await expect(sec).toBeVisible();
  for (const name of ['Passwort ändern', 'Hinzufügen', 'Neu erzeugen', 'Ändern']) {
    const btn = sec.getByRole('button', { name, exact: true });
    const row = btn.locator('xpath=ancestor::div[contains(@class,"row")][1]');
    const [b, r, text] = await Promise.all([btn.boundingBox(), row.boundingBox(), row.locator('.what, h3').first().boundingBox()]);
    expect(b!.y, name).toBeGreaterThanOrEqual(text!.y + text!.height - 1); // below the text
    expect(Math.round(b!.width), name).toBe(Math.round(r!.width)); // full width
    expect(b!.height, name).toBeGreaterThanOrEqual(44);
  }
  expect(await noHorizontalOverflow(page)).toBe(true);
  await sec.getByRole('button', { name: 'Passwort ändern' }).tap();
  const dlg = page.getByRole('dialog', { name: 'Erneut anmelden' });
  await expect(dlg.getByRole('heading', { name: 'Passwort' })).toBeVisible();
  const box = (await dlg.boundingBox())!;
  const vh = page.viewportSize()!.height;
  expect(Math.round(box.x)).toBe(0);
  expect(Math.round(box.y + box.height)).toBe(vh); // a sheet at the bottom
  expect(await noHorizontalOverflow(page)).toBe(true);
});
