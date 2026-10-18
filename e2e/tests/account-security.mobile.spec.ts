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
  // "Ändern" twice: the username and the e-mail address
  const buttons = [];
  for (const name of ['Passwort ändern', 'Hinzufügen', 'Neu erzeugen', 'Ändern']) buttons.push(...(await sec.getByRole('button', { name, exact: true }).all()).map((b) => [name, b] as const));
  expect(buttons.length).toBe(5);
  for (const [name, btn] of buttons) {
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

test('phone: the username form fits and its buttons are touch-sized', async ({ page }) => {
  await installLogin(page.context(), loginState());
  await page.goto('/me/account');
  const row = page.getByRole('region', { name: 'Sicherheit' }).locator('[data-row="username"]');
  await row.getByRole('button', { name: 'Ändern' }).tap();
  const input = row.getByLabel('Neuer Benutzername');
  await expect(input).toBeVisible();
  expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  for (const name of ['Speichern', 'Abbrechen']) expect((await row.getByRole('button', { name }).boundingBox())!.height, name).toBeGreaterThanOrEqual(36);
  expect(await noHorizontalOverflow(page)).toBe(true);
});
