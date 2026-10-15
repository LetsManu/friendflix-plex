// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { row } from '../helpers.js';
import { done, installLogin, loginState, prompt, recoveryCodes, totpSetup, type LoginMock } from '../mocks/login.js';

// Invite sign-up in the app (Block 23 phase 3 Task 8): /login?invite=…&enroll=1 → prompt → TOTP setup → recovery codes → home.
const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name, exact: true });
const box = (page: Page, i: number) => page.getByRole('textbox', { name: `Ziffer ${i} von 6` });
const FIELDS = [
  { key: 'username', type: 'username', label: 'Benutzername' },
  { key: 'email', type: 'email', label: 'E-Mail' },
  { key: 'password', type: 'password', label: 'ff:password' },
  { key: 'password_repeat', type: 'password', label: 'ff:password_repeat' },
];
const CODES = ['aaaa-1111', 'bbbb-2222', 'cccc-3333', 'dddd-4444', 'eeee-5555', 'ffff-6666'];

async function open(page: Page, st: LoginMock, path = '/login?invite=inv-0001&enroll=1') {
  await installLogin(page.context(), st);
  await page.goto(path);
}

test.describe('invite sign-up (/login?enroll=1)', () => {
  test.use({ allowedConsole: /status of (400|410)/ });
  test('invite enrol: prompt → TOTP setup (QR rendered, 6 boxes) → recovery codes → home', async ({ page }) => {
    const st = loginState({
      config: { body: { mode: 'app', recovery: true, enroll: true } },
      starts: [{ body: prompt(FIELDS) }],
      answers: [{ body: totpSetup() }, { body: recoveryCodes(CODES) }, { body: done('/') }],
    });
    await open(page, st);
    await expect(h1(page, 'Konto anlegen')).toBeVisible();
    expect(st.calls[0]).toMatchObject({ path: '/auth/flow/start', body: { kind: 'enroll', invite: 'inv-0001' } });
    // labels: Authentik's own text as text, FriendFlix's ff: keys localised
    await page.getByLabel('Benutzername').fill('anna');
    await page.getByLabel('E-Mail').fill('anna@example.com');
    await page.getByLabel('Passwort', { exact: true }).fill('fake-new-pass-1');
    await page.getByLabel('Passwort wiederholen').fill('fake-new-pass-1');
    await page.getByRole('button', { name: 'Weiter' }).click();

    await expect(h1(page, 'Authenticator-App einrichten')).toBeVisible();
    const qr = page.locator('svg.qr');
    await expect(qr).toBeVisible();
    expect(await qr.locator('path').getAttribute('d')).toMatch(/^M\d/);
    await expect(page.locator('[data-secret] span')).toHaveText(['JBSW', 'Y3DP', 'EHPK', '3PXP', 'JBSW', 'Y3DP', 'EHPK', '3PXP']);
    await expect(page.getByRole('textbox', { name: /Ziffer \d von 6/ })).toHaveCount(6);
    await expect(box(page, 1)).toBeFocused();
    await page.keyboard.type('123456');

    await expect(h1(page, 'Wiederherstellungscodes')).toBeVisible();
    await expect(page.locator('[data-codes] li')).toHaveText(CODES);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Als Textdatei speichern' }).click()]);
    expect(dl.suggestedFilename()).toBe('friendflix-recovery-codes.txt');
    await page.getByRole('button', { name: 'Gespeichert – weiter' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(row(page, 'Weiterschauen')).toBeAttached();

    const answers = st.calls.filter((c) => c.path === '/auth/flow/answer').map((c) => { const { step: _s, ...rest } = c.body; return rest; });
    expect(answers).toEqual([
      { stage: 'prompt', username: 'anna', email: 'anna@example.com', password: 'fake-new-pass-1', password_repeat: 'fake-new-pass-1' },
      { stage: 'totp-setup', code: '123456' },
      { stage: 'recovery-codes' },
    ]);
    // nothing secret in the URL or the page storage
    const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, location.href]));
    expect(stored).not.toMatch(/JBSWY3DP|aaaa-1111|fake-new-pass/);
  });

  test('a withdrawn invite says so and falls back to sign-in', async ({ page }) => {
    const st = loginState({ starts: [(b) => (b.kind === 'enroll' ? { status: 410, body: { error: 'invite_invalid' } } : { body: { stage: 'identify', step: 'mock-step-9999', passwordInline: false, canRecover: true, canEnroll: false, passkey: null } })] });
    await open(page, st);
    await expect(page.getByText('Diese Einladung ist nicht mehr gültig.', { exact: false })).toBeVisible();
    await expect(h1(page, 'Willkommen zurück')).toBeVisible();
    expect(st.calls.map((c) => c.body.kind)).toEqual(['enroll', 'login']);
  });

  test('a wrong code in the TOTP setup shows the error and keeps the screen', async ({ page }) => {
    const st = loginState({ starts: [{ body: totpSetup() }], answers: [{ status: 400, body: { errors: ['code_invalid'] } }] });
    await open(page, st);
    await expect(box(page, 1)).toBeFocused();
    await page.keyboard.type('000000');
    await expect(page.getByText('Der Code stimmt nicht. Versuch es noch einmal.')).toBeVisible();
    await expect(h1(page, 'Authenticator-App einrichten')).toBeVisible();
  });
});
