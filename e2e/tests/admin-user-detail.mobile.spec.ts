// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { auid } from '../mocks/admin.js';

const ANNA = auid(2);

test.describe('admin user detail (phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('tabs scroll and cards render', async ({ page }) => {
    await page.goto(`/admin/users/${ANNA}`);
    const list = page.getByRole('tablist', { name: 'Bereiche von Anna Beispiel' });
    await expect(list).toBeVisible();
    // seven tabs do not fit 390px: the strip scrolls sideways, the page does not
    const strip = await list.evaluate((el) => ({ overflow: getComputedStyle(el).overflowX, scroll: el.scrollWidth, client: el.clientWidth }));
    expect(strip.overflow).toBe('auto');
    expect(strip.scroll).toBeGreaterThan(strip.client);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);

    await list.getByRole('tab', { name: 'Audit-Log' }).click();
    await expect(page).toHaveURL(/\?tab=audit$/);
    await list.getByRole('tab', { name: 'Geräte' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Geräte' });
    const card = panel.getByRole('row', { name: /Chrome auf Windows/ });
    await expect(card).toBeVisible();
    expect(await card.evaluate((el) => getComputedStyle(el).display)).toBe('block');
    await expect(card.getByRole('button', { name: '„Chrome auf Windows“ freigeben' })).toBeVisible();
    await card.getByRole('button', { name: 'Aktionen für Chrome auf Windows' }).click();
    await expect(page.getByRole('dialog', { name: 'Chrome auf Windows' }).getByRole('button', { name: 'Entfernen' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);

    await list.getByRole('tab', { name: 'Limits' }).click();
    await expect(page.getByRole('spinbutton', { name: 'Gleichzeitige Streams' })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await list.getByRole('tab', { name: 'Profile' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Profile' }).getByRole('row', { name: /Kinder/ })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
