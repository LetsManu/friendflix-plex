// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

test.describe('admin warning banner (phone)', () => {
  test.beforeEach(({ api }) => {
    api.asAdmin = true;
    api.admin.bannerIssues = [
      { id: 'svc:oidc', level: 'err', reason: 'issuer_mismatch', fp: '0123456789ab' },
      { id: 'disk:downloads', level: 'warn', reason: 'cap', fp: 'abcdef012345', detail: { pct: 92 } },
      { id: 'errors:playback', level: 'warn', reason: 'failed_playbacks', fp: 'fedcba987654', detail: { n: 5 } },
    ];
  });

  test('banner wraps without horizontal overflow; close button ≥ 44 px; does not cover the tab bar', async ({ page }) => {
    await page.goto('/browse/movies');
    const b = page.getByRole('main').locator('.hb');
    await expect(b).toContainText('Anmeldung: Anbieter passt nicht zur Einstellung');
    await b.getByRole('button', { name: '+2 weitere' }).click();
    await expect(b.getByRole('listitem')).toHaveCount(2);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    const close = await b.getByRole('button', { name: 'Ausblenden', exact: true }).boundingBox();
    expect(close!.width).toBeGreaterThanOrEqual(44);
    expect(close!.height).toBeGreaterThanOrEqual(44);
    for (const x of await b.getByRole('listitem').getByRole('button').all()) expect((await x.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const box = (await b.boundingBox())!;
    const tab = (await page.getByRole('navigation', { name: 'Mobile Navigation' }).boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(tab.y);
    expect(box.width).toBeLessThanOrEqual(390);
  });
});
