// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { emailSent, installLogin, loginState, prompt, type LoginMock } from '../mocks/login.js';

// Recovery on the phone (390px): the inbox screen and /reset fit, with controls of at least 44px.
const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name, exact: true });
async function open(page: Page, st: LoginMock, path: string) {
  await installLogin(page.context(), st);
  await page.goto(path);
}
async function fits(page: Page) {
  await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  const vw = page.viewportSize()!.width;
  const card = (await page.locator('main.card').boundingBox())!;
  expect(Math.round(card.x)).toBe(16);
  expect(Math.round(vw - card.x - card.width)).toBe(16);
  const controls = page.locator('main.card').locator('button:visible, a:visible, input:visible');
  for (let i = 0; i < (await controls.count()); i++) expect((await controls.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
}

test.describe('recovery (phone)', () => {
  test('inbox screen fits', async ({ page }) => {
    await open(page, loginState({ starts: [{ body: emailSent() }] }), '/login');
    await expect(h1(page, 'Schau in dein Postfach')).toBeVisible();
    await fits(page);
  });

  test('/reset fits: the start screen and the new-password fields', async ({ page }) => {
    const st = loginState({ resumes: [{ body: prompt([{ key: 'password', type: 'password', label: 'ff:password' }, { key: 'password_repeat', type: 'password', label: 'ff:password_repeat' }]) }] });
    await open(page, st, '/reset?token=fake-link-token_0001');
    await expect(h1(page, 'Neues Passwort festlegen')).toBeVisible();
    await fits(page);
    await page.getByRole('button', { name: 'Weiter' }).click();
    await expect(h1(page, 'Neues Passwort')).toBeVisible();
    await fits(page);
  });
});
