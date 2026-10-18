// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, type MockState } from '../fixtures.js';
import { done, emailSent, installLogin, loginState, password, prompt, recoveryCodes, totpSetup, type LoginMock } from '../mocks/login.js';

// The account page's security section (Block 23 phase 3 Task 11): in-app re-authentication in a dialog with the follow-up flow's steps
// inline, device removal, the e-mail change and the /confirm-email link page. The flow behind /auth/flow/* is scripted (mocks/login.ts).
const security = (page: Page) => page.getByRole('region', { name: 'Sicherheit' });
/** the e-mail row's "Ändern" (the username row has one too) */
const emailChangeButton = (page: Page) => security(page).locator('button[aria-describedby="sec-email"]');
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Erneut anmelden' });
const startBodies = (st: LoginMock) => st.calls.filter((c) => c.path === '/auth/flow/start').map((c) => c.body);
const answerBodies = (st: LoginMock) => st.calls.filter((c) => c.path === '/auth/flow/answer').map((c) => { const { step: _s, ...rest } = c.body; return rest; });

async function open(page: Page, st: LoginMock, path = '/me/account') {
  await installLogin(page.context(), st);
  await page.goto(path);
  await expect(security(page)).toBeVisible();
}
async function typePassword(page: Page) {
  await dialog(page).getByLabel('Passwort', { exact: true }).fill('hunter2-fixture');
  await dialog(page).getByRole('button', { name: 'Anmelden' }).click();
}

test.describe('security section (/me/account)', () => {
  test('add authenticator: password → QR → code → listed', async ({ page, api }) => {
    const st = loginState({
      starts: [{ body: password('anna') }],
      answers: [{ body: totpSetup() }, () => {
        api.security.devices.push({ id: '12', type: 'totp', name: 'Neues Gerät', lastUsed: null });
        return { body: done('/me/account') };
      }],
    });
    await open(page, st);
    await expect(security(page).getByRole('list', { name: 'Authenticator-App' })).not.toContainText('Neues Gerät');
    await security(page).getByRole('button', { name: 'Hinzufügen' }).click();
    await expect(dialog(page)).toBeVisible();
    await typePassword(page);
    await expect(dialog(page).getByRole('heading', { name: 'Authenticator-App einrichten' })).toBeVisible();
    await expect(dialog(page).getByRole('img', { name: 'QR-Code für die Authenticator-App' })).toBeVisible();
    // the same 6 boxes as at sign-in: the first one takes the focus, the sixth digit sends the code
    await expect(dialog(page).getByRole('textbox', { name: /Ziffer \d von 6/ })).toHaveCount(6);
    await expect(dialog(page).getByRole('textbox', { name: 'Ziffer 1 von 6' })).toBeFocused();
    await page.keyboard.type('123456');
    await expect(dialog(page).getByText('Die Authenticator-App wurde hinzugefügt.')).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Fertig' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(security(page).getByRole('list', { name: 'Authenticator-App' })).toContainText('Neues Gerät');
    expect(startBodies(st)).toEqual([{ kind: 'reauth', then: 'setup-totp' }]);
    expect(answerBodies(st)).toEqual([{ stage: 'password', password: 'hunter2-fixture' }, { stage: 'totp-setup', code: '123456' }]);
    // nothing secret stays in the address or the page storage
    expect(page.url()).not.toContain('placeholder-pw');
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('placeholder-pw');
  });

  test.describe('stale re-authentication', () => {
  test.use({ allowedConsole: /status of 401/ });
  test('remove asks for re-auth when stale, then removes', async ({ page, api }) => {
    api.securityStale = true;
    const st = loginState({ starts: [{ body: password('anna') }], answers: [() => { api.securityStale = false; return { body: done('/me/account') }; }] });
    await open(page, st);
    await security(page).getByRole('button', { name: 'Pixel 8 entfernen' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('„Pixel 8“ entfernen?');
    await confirm.getByRole('button', { name: 'Entfernen' }).click();
    // the backend answered 401 reauth_required: the dialog opens without a follow-up flow
    await expect(dialog(page)).toBeVisible();
    expect(api.securityDeleted).toEqual([]);
    await typePassword(page);
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByText('„Pixel 8“ entfernt.')).toBeVisible();
    expect(api.securityDeleted).toEqual(['totp/11']);
    await expect(security(page).getByRole('list', { name: 'Authenticator-App' })).not.toContainText('Pixel 8');
    expect(startBodies(st)).toEqual([{ kind: 'reauth' }]);
  });
});

  test('regenerate recovery codes shows new codes once', async ({ page }) => {
    const st = loginState({ starts: [{ body: password('anna') }], answers: [{ body: recoveryCodes() }, { body: done('/me/account') }] });
    await open(page, st);
    await security(page).getByRole('button', { name: 'Neu erzeugen' }).click();
    await typePassword(page);
    const list = dialog(page).getByRole('list', { name: 'Wiederherstellungscodes' });
    await expect(list.getByRole('listitem')).toHaveText(['fakecode0001', 'fakecode0002', 'fakecode0003', 'fakecode0004']);
    await dialog(page).getByRole('button', { name: 'Gespeichert – weiter' }).click();
    await expect(dialog(page).getByText('Die neuen Wiederherstellungscodes gelten ab jetzt, die alten nicht mehr.')).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Fertig' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByText('fakecode0001')).toHaveCount(0); // shown once
    expect(startBodies(st)).toEqual([{ kind: 'reauth', then: 'setup-static' }]);
    expect(answerBodies(st)[1]).toEqual({ stage: 'recovery-codes' });
  });

  test('change password with mismatch error then success', async ({ page }) => {
    const fields = [{ key: 'password', type: 'password', label: 'ff:password' }, { key: 'password_repeat', type: 'password', label: 'ff:password_repeat' }];
    const first = prompt(fields);
    const st = loginState({
      starts: [{ body: password('anna') }],
      answers: [{ body: first }, { body: { ...first, step: 'mock-step-again', errors: ['password_mismatch'] } }, { body: done('/me/account') }],
    });
    await open(page, st);
    await security(page).getByRole('button', { name: 'Passwort ändern' }).click();
    await typePassword(page);
    await expect(dialog(page).getByRole('heading', { name: 'Neues Passwort' })).toBeVisible();
    await dialog(page).getByLabel('Passwort', { exact: true }).fill('new-pw-placeholder-1');
    await dialog(page).getByLabel('Passwort wiederholen').fill('new-pw-placeholder-2');
    await dialog(page).getByRole('button', { name: 'Speichern' }).click();
    await expect(dialog(page).getByText('Die Passwörter stimmen nicht überein.')).toBeVisible();
    await dialog(page).getByLabel('Passwort', { exact: true }).fill('new-pw-placeholder-1');
    await dialog(page).getByLabel('Passwort wiederholen').fill('new-pw-placeholder-1');
    await dialog(page).getByRole('button', { name: 'Speichern' }).click();
    await expect(dialog(page).getByText('Dein Passwort wurde geändert.')).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Fertig' }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(startBodies(st)).toEqual([{ kind: 'reauth', then: 'change-password' }]);
    expect(answerBodies(st)[1]).toEqual({ stage: 'prompt', password: 'new-pw-placeholder-1', password_repeat: 'new-pw-placeholder-2' });
  });

  test("passkey add with passkeySetup 'sign-in page' links to the sign-in page (same tab)", async ({ page, api }) => {
    api.security.passkeySetup = 'sign-in page';
    await open(page, loginState());
    await expect(security(page).getByRole('button', { name: 'Passkey hinzufügen' })).toHaveCount(0);
    const link = security(page).getByRole('link', { name: 'Auf der Anmeldeseite hinzufügen' });
    await expect(link).toHaveAttribute('href', '/auth/flow/classic/webauthn-setup');
    await expect(link).not.toHaveAttribute('target', /.+/);
    await expect(security(page).getByText('Passkeys, die du hier anlegst, gelten für FriendFlix.')).toBeVisible();
  });

  test('change e-mail: re-auth → new address → "Bestätigungslink" screen with the masked new address; email_in_use error shown', async ({ page, api }) => {
    const ask = prompt([{ key: 'email', type: 'email', label: 'ff:new_email' }]);
    const st = loginState({
      starts: [{ body: password('anna') }],
      answers: [{ body: ask }, { body: { ...ask, step: 'mock-step-again', errors: ['email_in_use'] } }, { body: emailSent('n•••@example.com') }],
    });
    await open(page, st);
    await emailChangeButton(page).click();
    await typePassword(page);
    await expect(dialog(page).getByRole('heading', { name: 'E-Mail-Adresse ändern' })).toBeVisible();
    await dialog(page).getByLabel('Neue E-Mail-Adresse').fill('taken@example.com');
    await dialog(page).getByRole('button', { name: 'Speichern' }).click();
    await expect(dialog(page).getByText('Diese Adresse wird schon verwendet.')).toBeVisible();
    await dialog(page).getByLabel('Neue E-Mail-Adresse').fill('neu@example.com');
    await dialog(page).getByRole('button', { name: 'Speichern' }).click();
    await expect(dialog(page).getByRole('heading', { name: 'Bestätigungslink gesendet' })).toBeVisible();
    await expect(dialog(page)).toContainText('Wir haben einen Bestätigungslink an n•••@example.com geschickt. Die Adresse ändert sich erst, wenn du den Link öffnest.');
    await expect(dialog(page).getByRole('button', { name: /erneut senden|resend/i })).toHaveCount(0); // the attempt is over on the server
    expect(startBodies(st)).toEqual([{ kind: 'reauth', then: 'change-email' }]);
    api.security.emailChangePending = 'n•••@example.com';
    await dialog(page).getByRole('button', { name: 'Fertig' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(security(page).getByText('Bestätigung ausstehend an n•••@example.com')).toBeVisible();
  });

  test('e-mail change hidden when the flow is not set up; admins are told', async ({ page, api }) => {
    api.security.emailChange = false;
    await open(page, loginState());
    await expect(emailChangeButton(page)).toHaveCount(0);
    await expect(security(page).getByText('E-Mail ändern ist nicht eingerichtet.')).toHaveCount(0); // not an admin
  });

  test('e-mail change not set up, as admin', async ({ page, api }) => {
    api.security.emailChange = false;
    api.asAdmin = true;
    await open(page, loginState());
    await expect(security(page).getByText('E-Mail ändern ist nicht eingerichtet.')).toBeVisible();
  });

  test('dialog has a name and traps focus; Escape cancels the attempt and returns the focus', async ({ page }) => {
    const st = loginState({ starts: [{ body: password('anna') }] });
    await open(page, st);
    const opener = security(page).getByRole('button', { name: 'Passwort ändern' });
    await opener.click();
    const dlg = dialog(page);
    await expect(dlg.getByRole('heading', { name: 'Passwort' })).toBeVisible();
    await expect(page.locator('[role=dialog][aria-modal=true]')).toHaveAttribute('aria-label', 'Erneut anmelden');
    for (let i = 0; i < 9; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true);
    }
    for (let i = 0; i < 9; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect.poll(() => st.calls.some((c) => c.path === '/auth/flow/cancel')).toBe(true);
  });
});

// ---- passkeys in-app: a Chromium virtual authenticator on http://localhost (WebAuthn refuses IP-address RP IDs) ----
const PORT = Number(process.env.E2E_PORT ?? 4173);
const LOCAL = `http://localhost:${PORT}`;

test.describe('passkey add in-app (virtual authenticator)', () => {
  test.use({ baseURL: LOCAL });

  test('reauth → setup-webauthn → "Passkey hinzugefügt"; the mock receives { response } with the app origin', async ({ page, api }: { page: Page; api: MockState }) => {
    api.security.passkeySetup = 'in-app';
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    const challenge = randomBytes(32).toString('base64url');
    const options = {
      challenge, rp: { id: 'localhost', name: 'FriendFlix' }, user: { id: Buffer.from('fake-user-0001').toString('base64url'), name: 'anna', displayName: 'Anna' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], excludeCredentials: [], authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }, attestation: 'none', timeout: 30000,
    };
    const st = loginState({ starts: [{ body: password('anna') }], answers: [{ body: { stage: 'passkey-setup', step: 'mock-step-pk01', options } }, { body: done('/me/account') }] });
    await open(page, st);
    await security(page).getByRole('button', { name: 'Passkey hinzufügen' }).click();
    await typePassword(page);
    await expect(dialog(page).getByRole('heading', { name: 'Passkey hinzufügen' })).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Passkey erstellen' }).click();
    await expect(dialog(page).getByText('Passkey hinzugefügt.')).toBeVisible();
    expect(startBodies(st)).toEqual([{ kind: 'reauth', then: 'setup-webauthn' }]);
    const a = answerBodies(st)[1]!;
    expect(Object.keys(a).sort()).toEqual(['response', 'stage']);
    const client = JSON.parse(Buffer.from(a.response.response.clientDataJSON, 'base64url').toString('utf8'));
    expect(client).toMatchObject({ type: 'webauthn.create', origin: LOCAL, challenge });
    expect(Object.keys(a.response.response).sort()).toEqual(expect.arrayContaining(['attestationObject', 'clientDataJSON']));
    expect(Object.keys(a.response.response)).not.toContain('publicKey');
    expect(a.response.clientExtensionResults).toEqual({});
  });
});

// ---- /confirm-email (Ruling 11) ----
const TOKEN = 'fakeLinkTokenForTestsOnly000000000000000001';

test.describe('/confirm-email', () => {
  test('no resume call before the click; after it "E-Mail-Adresse geändert"; the token leaves the URL; no /api/me', async ({ page }) => {
    let me = 0;
    await page.route('**/api/me', (r) => { me++; return r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthenticated"}' }); });
    const st = loginState({ resumes: [{ body: done('/confirm-email?ok=1') }] });
    await installLogin(page.context(), st);
    await page.goto(`/confirm-email?token=${TOKEN}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Neue E-Mail-Adresse bestätigen' })).toBeVisible();
    await expect(page).toHaveURL(/\/confirm-email$/); // replaceState dropped the token
    expect(st.calls.filter((c) => c.path === '/auth/flow/resume')).toHaveLength(0);
    await page.getByRole('button', { name: 'Adresse bestätigen' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'E-Mail-Adresse geändert' })).toBeVisible();
    expect(st.calls.filter((c) => c.path === '/auth/flow/resume').map((c) => c.body)).toEqual([{ token: TOKEN, kind: 'email-confirm' }]);
    expect(st.calls[0]!.csrf).toBeTruthy(); // flowConfig() ran on mount, so the double-submit cookie existed
    await expect(page.getByRole('link', { name: 'Zum Konto' })).toHaveAttribute('href', '/me/account');
    expect(me).toBe(0);
    expect(page.url()).not.toContain(TOKEN);
    // nor the history entry or the page storage (SvelteKit's replaceState would keep the old URL in history.state)
    const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, location.href, history.state]));
    expect(stored).not.toContain(TOKEN);
  });

  test('a used link → "Link abgelaufen oder schon benutzt"', async ({ page }) => {
    const st = loginState({ resumes: [{ body: { stage: 'expired' } }] });
    await installLogin(page.context(), st);
    await page.goto(`/confirm-email?token=${TOKEN}`);
    await page.getByRole('button', { name: 'Adresse bestätigen' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Link abgelaufen oder schon benutzt' })).toBeVisible();
  });

  test('without a token it says the link is no longer valid, and makes no call', async ({ page }) => {
    const st = loginState();
    await installLogin(page.context(), st);
    await page.goto('/confirm-email');
    await expect(page.getByRole('heading', { level: 1, name: 'Link abgelaufen oder schon benutzt' })).toBeVisible();
    expect(st.calls).toHaveLength(0);
  });
});

// The account-security fix: the username row, a clear message for every failing case, and the reason an action is not possible.
test.describe('security section: username and clear failures', () => {
  const userRow = (page: Page) => security(page).locator('[data-row="username"]');

  test('username: shown, changed inline (trimmed), the new name listed', async ({ page, api }) => {
    await open(page, loginState());
    await expect(userRow(page).getByRole('heading', { name: 'Benutzername' })).toBeVisible();
    await expect(userRow(page)).toContainText('anna');
    await userRow(page).getByRole('button', { name: 'Ändern' }).click();
    const input = userRow(page).getByLabel('Neuer Benutzername');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('anna');
    await input.fill('  anna.neu ');
    await userRow(page).getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByText('Dein Benutzername ist jetzt „anna.neu“.')).toBeVisible();
    await expect(userRow(page).getByLabel('Neuer Benutzername')).toHaveCount(0);
    await expect(userRow(page)).toContainText('anna.neu');
    expect(api.usernamePuts).toEqual(['anna.neu']);
  });

  test.describe('refusals', () => {
    test.use({ allowedConsole: /status of (409|400)/ });
    test('username: a taken or invalid name shows why, the form stays open', async ({ page, api }) => {
      api.usernameError = 'username_taken';
      await open(page, loginState());
      await userRow(page).getByRole('button', { name: 'Ändern' }).click();
      await userRow(page).getByLabel('Neuer Benutzername').fill('ben');
      await userRow(page).getByRole('button', { name: 'Speichern' }).click();
      await expect(userRow(page).getByRole('alert')).toHaveText('Dieser Benutzername ist schon vergeben.');
      await expect(userRow(page).getByLabel('Neuer Benutzername')).toHaveAttribute('aria-invalid', 'true');
      api.usernameError = 'username_invalid';
      await userRow(page).getByRole('button', { name: 'Speichern' }).click();
      await expect(userRow(page).getByRole('alert')).toContainText('Nur Buchstaben, Ziffern und @ . + - _');
      api.usernameError = 'username_is_subject';
      await userRow(page).getByRole('button', { name: 'Speichern' }).click();
      await expect(userRow(page).getByRole('alert')).toContainText('erkennt dein Konto daran');
    });
  });

  test('username: where the sign-in service identifies the account by it, no change button and a note', async ({ page, api }) => {
    api.security = { ...api.security, usernameChange: false };
    await open(page, loginState());
    await expect(userRow(page).getByRole('button', { name: 'Ändern' })).toHaveCount(0);
    await expect(userRow(page)).toContainText('Der Benutzername lässt sich hier nicht ändern');
  });

  test('a refused service token: the section says so instead of showing empty lists', async ({ page, api }) => {
    api.security = { ...api.security, devices: [], mfa: null, username: null, usernameChange: false, problem: 'service_token' };
    await open(page, loginState());
    await expect(security(page).getByRole('status').filter({ hasText: 'verweigert FriendFlix den Zugriff' })).toBeVisible();
    await expect(userRow(page)).toContainText('Gerade nicht lesbar');
  });

  test('change password while the sign-in service refuses the service token: the precise reason and Authentik\'s settings page', async ({ page }) => {
    const st = loginState({ starts: [{ body: { stage: 'unavailable', reason: 'service_token' } }] });
    await open(page, st);
    await security(page).getByRole('button', { name: 'Passwort ändern' }).click();
    await expect(dialog(page).getByText('Der Anmeldedienst verweigert FriendFlix den Zugriff. Ein Admin kann das unter Admin → Status → Anmeldung reparieren.')).toBeVisible();
    await expect(dialog(page).getByRole('link', { name: 'Auf der Anmeldeseite fortfahren' })).toHaveAttribute('href', 'https://login.example.com/if/user/#/settings');
    await expect(dialog(page).getByRole('button', { name: 'Erneut versuchen' })).toBeVisible();
  });

  test('the sign-in service answers too slowly: says so', async ({ page }) => {
    const st = loginState({ starts: [{ body: { stage: 'unavailable', reason: 'timeout' } }] });
    await open(page, st);
    await security(page).getByRole('button', { name: 'Passwort ändern' }).click();
    await expect(dialog(page).getByText('Der Anmeldedienst hat zu lange nicht geantwortet. Versuch es gleich noch einmal.')).toBeVisible();
  });

  test.describe('refused starts', () => {
    test.use({ allowedConsole: /status of (409|404)/ });
    test('sign-in inside FriendFlix switched off (409 classic): explained, continues on Authentik\'s settings page', async ({ page }) => {
      const st = loginState({ starts: [{ status: 409, body: { error: 'classic' } }] });
      await open(page, st);
      await security(page).getByRole('button', { name: 'Passwort ändern' }).click();
      await expect(dialog(page).getByText('Die Anmeldung in FriendFlix ist ausgeschaltet, deshalb änderst du das auf der Anmeldeseite.')).toBeVisible();
      await expect(dialog(page).getByRole('link', { name: 'Auf der Anmeldeseite fortfahren' })).toHaveAttribute('href', 'https://login.example.com/if/user/#/settings');
    });
  });
});
