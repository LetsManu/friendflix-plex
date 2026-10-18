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
  test('recommendation index tile fits on a phone', async ({ page }) => {
    await page.goto('/admin/status');
    const tile = page.getByText('Empfehlungs-Index').locator('xpath=ancestor::*[contains(@class,"tile")][1]');
    await expect(tile).toContainText('1.234');
    await page.waitForLoadState('networkidle');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
  test('sign-in card fits: long warnings wrap, the switch is at least 44 px', async ({ page, api }) => {
    api.admin.loginCheck = {
      mode: 'app', implicitConsent: false, authCodeGrant: false, issuerMatches: false, passkeys: 'sign-in page', passkeysReason: 'forwarded_host_ignored', unreachable: false,
      warnings: ['flow_unsupported:login', 'consent', 'auth_code_grant', 'issuer', 'passkeys:forwarded_host_ignored'],
      flows: [{ kind: 'login', slug: 'a-very-long-custom-authentication-flow-slug-that-must-wrap-on-a-phone', state: 'unsupported', stages: [] }],
    };
    await page.goto('/admin/status');
    const card = page.getByRole('region', { name: 'Anmeldung', exact: true });
    await expect(card.getByText(/Grant-Typ/)).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    const box = await card.getByRole('switch').boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});
