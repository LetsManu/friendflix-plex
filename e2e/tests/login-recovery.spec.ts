// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { done, emailSent, identify, installLogin, loginState, mfa, password, prompt, type LoginMock } from '../mocks/login.js';

// In-app recovery (Block 23 phase 3 Task 8): the inbox screen after "Passwort vergessen?", and /reset, the page of the e-mail link.
// The token (a fake one) must leave the URL on load and reach the backend only in the body of `resume`, after the "Weiter" click.
const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name, exact: true });
const TOKEN = 'fake-link-token_0001';
const PASSWORDS = [
  { key: 'password', type: 'password', label: 'ff:password' },
  { key: 'password_repeat', type: 'password', label: 'ff:password_repeat' },
];
const posts = (st: LoginMock, path: string) => st.calls.filter((c) => c.path === path);

async function open(page: Page, st: LoginMock, path: string) {
  await installLogin(page.context(), st);
  await page.goto(path);
}

test.describe('recovery: inbox screen', () => {
  test('forgot password → inbox screen with masked address and countdown', async ({ page }) => {
    await page.clock.install();
    const st = loginState({
      starts: [{ body: identify() }, { body: emailSent() }, { body: identify() }],
      answers: [{ body: password() }, { body: emailSent() }],
    });
    await open(page, st, '/login');
    await page.getByLabel('E-Mail oder Benutzername').fill('anna@example.com');
    await page.getByRole('button', { name: 'Weiter' }).click();
    await expect(h1(page, 'Passwort')).toBeVisible();
    await page.getByRole('button', { name: 'Passwort vergessen?' }).click();
    await expect(h1(page, 'Schau in dein Postfach')).toBeVisible();
    expect(posts(st, '/auth/flow/start')[1]!.body).toMatchObject({ kind: 'recovery', identifier: 'anna@example.com' });
    await expect(page.getByText('a•••@example.com', { exact: false })).toBeVisible();
    // the countdown from 60 s, then the button enables
    const resend = page.locator('[data-resend]');
    await expect(resend).toBeDisabled();
    await expect(resend).toHaveText('Erneut senden (1:00)');
    await page.clock.runFor(30_000);
    await expect(resend).toHaveText('Erneut senden (0:30)');
    await page.clock.runFor(31_000);
    await expect(resend).toBeEnabled();
    await expect(resend).toHaveText('Erneut senden');
    await resend.click();
    await expect(resend).toBeDisabled(); // a new mail: the countdown starts again
    await expect(resend).toHaveText('Erneut senden (1:00)');
    expect(posts(st, '/auth/flow/answer')[1]!.body).toMatchObject({ stage: 'email-sent' });
    // "Zurück zur Anmeldung" gives the attempt up and starts a fresh sign-in
    await page.getByRole('button', { name: 'Zurück zur Anmeldung' }).click();
    await expect(h1(page, 'Willkommen zurück')).toBeVisible();
    expect(posts(st, '/auth/flow/cancel')).toHaveLength(1);
    expect(posts(st, '/auth/flow/start')[2]!.body).toEqual({ kind: 'login' });
  });

  test('without a known address the screen says so neutrally', async ({ page }) => {
    await open(page, loginState({ starts: [{ body: emailSent(null) }] }), '/login');
    await expect(h1(page, 'Schau in dein Postfach')).toBeVisible();
    await expect(page.getByText('Wenn es zu diesem Konto eine E-Mail-Adresse gibt', { exact: false })).toBeVisible();
  });

  test('/login?reset=1 shows the password-changed banner', async ({ page }) => {
    await open(page, loginState(), '/login?reset=1');
    await expect(page.getByText('Passwort geändert. Melde dich jetzt an.')).toBeVisible();
  });
});

test.describe('/reset (e-mail link)', () => {
  test.use({ allowedConsole: /status of 400/ });
  test('reset link drops the token from the URL, makes no resume call until "Weiter" is clicked, then sets a new password', async ({ page }) => {
    const st = loginState({ resumes: [{ body: prompt(PASSWORDS) }], answers: [{ body: done('/login?reset=1') }] });
    await open(page, st, `/reset?token=${TOKEN}`);
    await expect(h1(page, 'Neues Passwort festlegen')).toBeVisible();
    await expect(page).toHaveURL(/\/reset$/);
    expect(page.url()).not.toContain(TOKEN);
    await page.waitForTimeout(300);
    expect(posts(st, '/auth/flow/resume')).toHaveLength(0);
    expect(st.calls).toHaveLength(0);
    await page.getByRole('button', { name: 'Weiter' }).click();
    // the new-password prompt, labels localised (never the raw ff: keys)
    await expect(h1(page, 'Neues Passwort')).toBeVisible();
    expect(posts(st, '/auth/flow/resume')[0]!.body).toEqual({ token: TOKEN });
    await expect(page.getByText('ff:password')).toHaveCount(0);
    await page.getByLabel('Passwort', { exact: true }).fill('fake-new-pass-1');
    await page.getByLabel('Passwort wiederholen').fill('fake-new-pass-1');
    await page.getByRole('button', { name: 'Passwort speichern' }).click();
    await expect(h1(page, 'Passwort geändert')).toBeVisible();
    expect(posts(st, '/auth/flow/answer')[0]!.body).toMatchObject({ stage: 'prompt', password: 'fake-new-pass-1', password_repeat: 'fake-new-pass-1' });
    await expect(page.getByRole('link', { name: 'Zur Anmeldung' })).toHaveAttribute('href', '/login');
    // the token is nowhere but the one resume body: not in the URL, the history or the page storage
    expect(page.url()).not.toContain(TOKEN);
    const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, location.href, history.state]));
    expect(stored).not.toContain(TOKEN);
    expect(JSON.stringify(st.calls.filter((c) => c.path !== '/auth/flow/resume'))).not.toContain(TOKEN);
  });

  test('flowConfig is called before resume, so the csrf cookie exists', async ({ page }) => {
    const st = loginState({ resumes: [{ body: prompt(PASSWORDS) }] });
    await open(page, st, `/reset?token=${TOKEN}`);
    await page.getByRole('button', { name: 'Weiter' }).click();
    await expect(h1(page, 'Neues Passwort')).toBeVisible();
    expect([st.calls[0]!.csrf, st.calls[0]!.csrfCookie]).toEqual(['mock-flow-csrf-0001', 'mock-flow-csrf-0001']);
  });

  test('Authentik unavailable on "Weiter": the retry sends the same token again (the link was not used), without reloading', async ({ page }) => {
    const st = loginState({ resumes: [{ body: { stage: 'unavailable' } }, { body: prompt(PASSWORDS) }] });
    await open(page, st, `/reset?token=${TOKEN}`);
    await expect(page).toHaveURL(/\/reset$/);
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(h1(page, 'Neues Passwort')).toBeVisible();
    expect(posts(st, '/auth/flow/resume').map((c) => c.body.token)).toEqual([TOKEN, TOKEN]);
    expect(page.url()).not.toContain(TOKEN);
  });

  test('mismatched passwords show the error', async ({ page }) => {
    const st = loginState({ resumes: [{ body: prompt(PASSWORDS) }], answers: [{ status: 400, body: { errors: ['password_mismatch'] } }] });
    await open(page, st, `/reset?token=${TOKEN}`);
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.getByLabel('Passwort', { exact: true }).fill('fake-new-pass-1');
    await page.getByLabel('Passwort wiederholen').fill('fake-new-pass-2');
    await page.getByRole('button', { name: 'Passwort speichern' }).click();
    await expect(page.getByText('Die Passwörter stimmen nicht überein.')).toBeVisible();
    await expect(h1(page, 'Neues Passwort')).toBeVisible();
  });

  test('the MFA step during a reset (TOTP) comes before the new password', async ({ page }) => {
    const st = loginState({ resumes: [{ body: mfa({ recovery: false }) }], answers: [{ body: prompt(PASSWORDS) }, { body: done('/login?reset=1') }] });
    await open(page, st, `/reset?token=${TOKEN}`);
    await page.getByRole('button', { name: 'Weiter' }).click();
    await expect(h1(page, 'Bestätigungscode')).toBeVisible();
    await page.keyboard.type('123456');
    await expect(h1(page, 'Neues Passwort')).toBeVisible();
    expect(posts(st, '/auth/flow/answer')[0]!.body).toMatchObject({ stage: 'mfa', code: '123456' });
    await page.getByLabel('Passwort', { exact: true }).fill('fake-new-pass-1');
    await page.getByLabel('Passwort wiederholen').fill('fake-new-pass-1');
    await page.getByRole('button', { name: 'Passwort speichern' }).click();
    await expect(h1(page, 'Passwort geändert')).toBeVisible();
  });

  test('a passkey-only account is told to add a TOTP app or ask an admin', async ({ page }) => {
    const st = loginState({ resumes: [{ body: { stage: 'classic', reason: 'passkey_origin' } }] });
    await open(page, st, `/reset?token=${TOKEN}`);
    await page.getByRole('button', { name: 'Weiter' }).click();
    await expect(h1(page, 'Zurücksetzen per Passkey nicht möglich')).toBeVisible();
    await expect(page.getByText('Authenticator-App (TOTP)', { exact: false })).toBeVisible();
    await expect(page.getByText('Admin', { exact: false })).toBeVisible();
  });

  test('a used or unknown link ends as expired; no token at all too', async ({ page }) => {
    const st = loginState({ resumes: [{ body: { stage: 'expired' } }] });
    await open(page, st, `/reset?token=${TOKEN}`);
    await page.getByRole('button', { name: 'Weiter' }).click();
    await expect(h1(page, 'Sitzung abgelaufen')).toBeVisible();
    await page.getByRole('button', { name: 'Neu starten' }).click();
    await expect(page).toHaveURL(/\/login$/);
    const st2 = loginState();
    await open(page, st2, '/reset');
    await expect(h1(page, 'Sitzung abgelaufen')).toBeVisible();
    expect(posts(st2, '/auth/flow/resume')).toHaveLength(0);
  });

  test('without the in-app mode nothing is forwarded: the sign-in page notice only', async ({ page }) => {
    const st = loginState({ config: { body: { mode: 'authentik', recovery: false, enroll: false } } });
    await open(page, st, `/reset?token=${TOKEN}`);
    await expect(h1(page, 'Weiter auf der Anmeldeseite')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Auf der Anmeldeseite fortfahren' })).toHaveAttribute('href', '/auth/login?classic=1');
    expect(st.calls).toHaveLength(0);
    expect(page.url()).not.toContain(TOKEN);
  });

  test('renders without /api/me: a public page, a 401 does not send it to /auth/login', async ({ page }) => {
    let me = 0;
    await page.route('**/api/me', (r) => { me++; return r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthenticated"}' }); });
    await open(page, loginState(), `/reset?token=${TOKEN}`);
    await expect(h1(page, 'Neues Passwort festlegen')).toBeVisible();
    await page.waitForTimeout(300);
    expect(me).toBe(0);
    await expect(page).toHaveURL(/\/reset$/);
  });
});
