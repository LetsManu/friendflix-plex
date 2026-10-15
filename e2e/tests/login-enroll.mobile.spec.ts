// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { installLogin, loginState, recoveryCodes, totpSetup, type LoginMock } from '../mocks/login.js';

// Invite sign-up on the phone (390px): the QR fits the card, the secret and the recovery codes wrap.
const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name, exact: true });
async function open(page: Page, st: LoginMock) {
  await installLogin(page.context(), st);
  await page.goto('/login?invite=inv-0001&enroll=1');
}

test.describe('invite sign-up (phone)', () => {
  test('QR fits and codes wrap', async ({ page }) => {
    const st = loginState({ starts: [{ body: totpSetup() }], answers: [{ body: recoveryCodes(Array.from({ length: 10 }, (_, i) => `abcd${i}-efgh${i}-ijkl${i}-mnop${i}`)) }] });
    await open(page, st);
    await expect(h1(page, 'Authenticator-App einrichten')).toBeVisible();
    const card = (await page.locator('main.card').boundingBox())!;
    const qr = (await page.locator('svg.qr').boundingBox())!;
    expect(qr.width).toBeGreaterThan(150);
    expect(qr.x).toBeGreaterThanOrEqual(card.x);
    expect(qr.x + qr.width).toBeLessThanOrEqual(card.x + card.width);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    const boxes = page.getByRole('textbox', { name: /Ziffer \d von 6/ });
    for (let i = 0; i < 6; i++) expect((await boxes.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.type('123456');
    await expect(h1(page, 'Wiederherstellungscodes')).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    const list = (await page.locator('[data-codes]').boundingBox())!;
    expect(list.x + list.width).toBeLessThanOrEqual(card.x + card.width + 1);
    for (const b of await page.locator('main.card button:visible').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
  });
});
