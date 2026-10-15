// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

test('phone: /restore fits the screen, restores and offers sign in', async ({ page }) => {
  await page.route('**/api/restore', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(r.request().method() === 'POST' ? { ok: true } : { state: 'scheduled', deletionAt: '2026-10-21T12:00:00.000Z' }),
  }));
  await page.goto('/restore');
  const restore = page.getByRole('button', { name: 'Konto wiederherstellen' });
  const keep = page.getByRole('button', { name: 'Löschung beibehalten' });
  await expect(restore).toBeVisible();
  await expect(keep).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
  // stacked full-width buttons, each a comfortable touch target
  const [a, b] = [await restore.boundingBox(), await keep.boundingBox()];
  expect(a!.height).toBeGreaterThanOrEqual(44);
  expect(b!.y).toBeGreaterThan(a!.y + a!.height - 1);
  await restore.tap();
  await expect(page.getByRole('link', { name: 'Anmelden' })).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
});
