// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

test.describe('admin health page (phone)', () => {
  test.beforeEach(({ api }) => {
    api.asAdmin = true;
    api.admin.streams = {
      streams: [{ userId: 'u2', userName: 'Katharina Bauer-Langenberger', profileName: 'Katharina', device: 'Ein sehr langer Gerätename auf einem Fernseher im Wohnzimmer', title: 'Ein ziemlich langer Filmtitel, der umbrechen muss', seriesName: null, source: 'portal', method: 'transcode', reason: 'subtitles', videoCodec: 'hevc', audioCodec: 'eac3', hardware: false, paused: false }],
      totals: { direct: 0, remux: 0, transcode: 1 }, details: true, failed: [],
    };
  });

  test('no horizontal overflow; buttons ≥ 44 px', async ({ page }) => {
    await page.goto('/admin/status');
    const check = page.getByRole('button', { name: 'Jetzt prüfen' });
    await expect(check).toBeVisible();
    await expect(page.getByRole('region', { name: 'Wiedergaben' }).getByText('Untertitel')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    for (const b of [check, page.getByRole('button', { name: 'Aktualisieren' })]) {
      const box = await b.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    const media = await page.getByRole('region', { name: 'Systemzustand' }).getByRole('link', { name: /Medienserver/ }).boundingBox();
    expect(media!.height).toBeGreaterThanOrEqual(44);
  });
});
