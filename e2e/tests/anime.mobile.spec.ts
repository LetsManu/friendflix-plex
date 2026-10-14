// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { episodes, SERIES } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

const SHOTS = process.env.A1_SHOTS ?? '';

test.describe('anime pack (phone)', () => {
  test('comments panel and simulcast fit the screen', async ({ page }) => {
    const ep = episodes[1]!.id;
    await page.route(`**/api/items/${ep}/comments**`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ watched: false, comments: [
      { id: 'c1', name: 'Anna', mine: false, spoiler: true, createdAt: new Date().toISOString(), canDelete: false },
      { id: 'c2', name: 'Ben', mine: false, spoiler: false, body: 'Ein sehr langer Kommentar '.repeat(12), createdAt: new Date().toISOString(), canDelete: false },
    ] }) }));
    await page.goto('/item/' + SERIES.id);
    const row = page.locator('li.eprow').nth(1);
    await row.getByRole('button', { name: 'Kommentare' }).tap();
    await expect(row.getByRole('button', { name: 'Spoiler – trotzdem zeigen' })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    if (SHOTS) await row.screenshot({ path: `${SHOTS}/comments-phone.png` });

    await page.route('**/api/simulcast?*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ season: 'fall', year: 2026, total: 0, anime: false, days: [] }) }));
    await page.goto('/simulcast');
    await expect(page.getByText('Zurzeit laufen keine Serien')).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
