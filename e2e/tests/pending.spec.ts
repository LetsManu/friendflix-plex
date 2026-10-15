// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';

test.describe('waiting page (/pending)', () => {
  test.use({ allowedConsole: /status of 503/ });

  test('a 5xx on the first check keeps polling instead of staying on "Checking"', async ({ page }) => {
    await page.clock.install();
    let calls = 0;
    await page.route('**/api/pending', (r) => {
      calls++;
      return calls === 1
        ? r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"x"}' })
        : r.fulfill({ status: 200, contentType: 'application/json', body: '{"state":"pending"}' });
    });
    await page.goto('/pending');
    await expect(page.getByRole('status').filter({ hasText: 'Prüfe Anfrage …' })).toBeVisible();
    await expect.poll(() => calls).toBe(1);
    await page.clock.runFor(31_000);
    await expect(page.getByRole('heading', { level: 1, name: 'Anfrage gesendet' })).toBeVisible();
    expect(calls).toBe(2);
  });
});
