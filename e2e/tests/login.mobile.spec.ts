// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow, row } from '../helpers.js';
import { ART_IMAGES, done, identify, installLogin, loginState, mfa, password, type LoginMock } from '../mocks/login.js';

// The in-app sign-in on the phone (390px): the card sits at the bottom with a 16px gutter over the cover wall, everything fits, every
// control is at least 44px tall and named.
const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name, exact: true });
const box = (page: Page, i: number) => page.getByRole('textbox', { name: `Ziffer ${i} von 6` });

async function open(page: Page, st: LoginMock, path = '/login') {
  await installLogin(page.context(), st);
  await page.goto(path);
}

/** the card is pinned to the bottom with a 16px gutter; no horizontal overflow; buttons and links of the card are >= 44px and named */
async function fits(page: Page) {
  await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  const { width: vw, height: vh } = page.viewportSize()!;
  const card = (await page.locator('main.card').boundingBox())!;
  expect(Math.round(card.x)).toBe(16);
  expect(Math.round(vw - card.x - card.width)).toBe(16);
  expect(Math.round(vh - card.y - card.height)).toBe(16);
  const controls = page.locator('main.card').locator('button:visible, a:visible, input:visible');
  const n = await controls.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const c = controls.nth(i);
    const b = (await c.boundingBox())!;
    const tag = await c.evaluate((e) => e.tagName);
    const name = await c.evaluate((e) => (e as HTMLElement).getAttribute('aria-label') || (e as HTMLInputElement).labels?.[0]?.textContent || e.textContent || '');
    expect(name.trim(), `${tag} without a name`).not.toBe('');
    if (tag === 'BUTTON' && !(await c.evaluate((e) => e.closest('.af-pill') !== null))) expect(b.height, name).toBeGreaterThanOrEqual(44);
    expect(b.x).toBeGreaterThanOrEqual(-0.5);
    expect(b.x + b.width, name).toBeLessThanOrEqual(vw + 0.5);
  }
}

test.describe('in-app sign-in (/login) on the phone', () => {
  test('password + TOTP login reaches home; every screen fits', async ({ page, api }) => {
    api.loginArt = { status: 200, images: ART_IMAGES };
    const st = loginState({ answers: [{ body: password() }, { body: mfa({ passkeyClassic: true }) }, { body: done('/') }] });
    await open(page, st);
    await expect(h1(page, 'Willkommen zurück')).toBeVisible();
    await expect(page.locator('.wall[data-wall="covers"]')).toBeAttached();
    await fits(page);
    await page.getByLabel('E-Mail oder Benutzername').fill('anna@example.com');
    await page.getByRole('button', { name: 'Weiter' }).click();
    await expect(h1(page, 'Passwort')).toBeVisible();
    await fits(page);
    await page.getByLabel('Passwort', { exact: true }).fill('fake-password-1');
    await page.getByRole('button', { name: 'Anmelden' }).click();
    await expect(h1(page, 'Bestätigungscode')).toBeVisible();
    await fits(page);
    // six boxes side by side within the card
    const first = (await box(page, 1).boundingBox())!, last = (await box(page, 6).boundingBox())!;
    expect(Math.abs(first.y - last.y)).toBeLessThan(1);
    await box(page, 1).focus();
    await page.keyboard.type('123456');
    await expect(page).toHaveURL(/\/$/);
    await expect(row(page, 'Weiterschauen')).toBeAttached();
  });

  test('paste fills six boxes and submits', async ({ page }) => {
    const st = loginState({ starts: [{ body: mfa() }], answers: [{ body: done('/') }] });
    await open(page, st);
    await box(page, 1).evaluate((el) => {
      const dt = new DataTransfer();
      dt.setData('text', '987 654');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(page).toHaveURL(/\/$/);
    expect(st.calls.find((c) => c.path === '/auth/flow/answer')?.body).toMatchObject({ stage: 'mfa', code: '987654' });
  });

  test('notices fit: unavailable with retry and the sign-in page link; the invite field fits', async ({ page }) => {
    const st = loginState({ starts: [{ body: { stage: 'unavailable' } }, { body: identify() }] });
    await open(page, st);
    await expect(h1(page, 'Anmeldung nicht erreichbar')).toBeVisible();
    await fits(page);
    await page.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(h1(page, 'Willkommen zurück')).toBeVisible();
    await page.getByRole('button', { name: 'Noch kein Konto? Einladung einlösen' }).click();
    await expect(page.getByLabel('Einladungslink oder Code')).toBeVisible();
    await fits(page);
  });

  test('pending page uses the shell and fits', async ({ page }) => {
    await page.route('**/api/pending', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"state":"pending"}' }));
    await page.goto('/pending');
    await expect(h1(page, 'Fast geschafft')).toBeVisible();
    await expect(page.locator('.wall')).toBeAttached();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
