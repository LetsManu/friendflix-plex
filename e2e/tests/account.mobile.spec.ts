// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

test('phone: cards stack and buttons are ≥ 44 px', async ({ page }) => {
  await page.goto('/me/account');
  const cards = ['Profil', 'Sicherheit', 'Sitzungen & Geräte'].map((name) => page.getByRole('region', { name }));
  await expect(cards[2]!).toBeVisible();
  // one column: same left edge, each below the previous one
  const boxes = await Promise.all(cards.map((c) => c.boundingBox()));
  for (let i = 1; i < boxes.length; i++) {
    expect(Math.abs(boxes[i]!.x - boxes[0]!.x)).toBeLessThan(1);
    expect(boxes[i]!.y).toBeGreaterThanOrEqual(boxes[i - 1]!.y + boxes[i - 1]!.height - 1);
  }
  expect(await noHorizontalOverflow(page)).toBe(true);
  // every button and the manage link are comfortable touch targets
  const targets = page.locator('main').getByRole('button').or(page.locator('main').getByRole('link', { name: /Anmeldeseite/ }));
  const n = await targets.count();
  expect(n).toBeGreaterThan(10);
  for (let i = 0; i < n; i++) {
    const b = await targets.nth(i).boundingBox();
    expect(b!.height, await targets.nth(i).innerText()).toBeGreaterThanOrEqual(44);
  }
  // the confirm dialog fits the phone screen
  await page.getByRole('button', { name: 'Alle anderen Geräte abmelden' }).tap();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Abmelden' }).tap();
  await expect(page.getByText('2 andere Sitzungen beendet.')).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test('phone: delete dialog fits the screen', async ({ page }) => {
  await page.goto('/me/account');
  const link = page.getByRole('region', { name: 'Deine Daten' }).getByRole('link', { name: 'Meine Daten herunterladen' });
  expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByRole('button', { name: 'Konto löschen …' }).tap();
  const dlg = page.getByRole('dialog', { name: 'Konto löschen?' });
  await expect(dlg).toBeVisible();
  const vp = page.viewportSize()!;
  const box = (await dlg.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5);
  expect(await noHorizontalOverflow(page)).toBe(true);
  const targets = dlg.getByRole('button').or(dlg.getByRole('link'));
  const n = await targets.count();
  expect(n).toBe(3); // download, cancel, delete
  for (let i = 0; i < n; i++) expect((await targets.nth(i).boundingBox())!.height, await targets.nth(i).innerText()).toBeGreaterThanOrEqual(44);
  // the last control can be reached on the phone
  await expect(dlg.getByRole('button', { name: 'Mein Konto löschen' })).toBeInViewport();
});
