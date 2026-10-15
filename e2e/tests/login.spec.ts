// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { row } from '../helpers.js';
import { ART_IMAGES, done, identify, installLogin, loginState, mfa, MOCK_CSRF, password, type LoginMock } from '../mocks/login.js';
import { setupState } from '../mocks/setup.js';

// The in-app sign-in (/login, Block 23 phase 3 Task 7): FriendFlix screens over the cover wall, a scripted Authentik flow behind
// /auth/flow/* (mocks/login.ts). Only the page navigates; the steps answer and the reply decides the next screen.
const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name, exact: true });
const box = (page: Page, i: number) => page.getByRole('textbox', { name: `Ziffer ${i} von 6` });
const answers = (st: LoginMock) => st.calls.filter((c) => c.path === '/auth/flow/answer').map((c) => { const { step: _s, ...rest } = c.body; return rest; });

async function open(page: Page, ctxSt: LoginMock, path = '/login') {
  await installLogin(page.context(), ctxSt);
  await page.goto(path);
}

async function signInToPassword(page: Page, name = 'anna@example.com') {
  await expect(h1(page, 'Willkommen zurück')).toBeVisible();
  await page.getByLabel('E-Mail oder Benutzername').fill(name);
  await page.getByRole('button', { name: 'Weiter' }).click();
  await expect(h1(page, 'Passwort')).toBeVisible();
}

test.describe('in-app sign-in (/login)', () => {
  test('password + TOTP login reaches home', async ({ page }) => {
    const st = loginState({ answers: [{ body: password() }, { body: mfa() }, { body: done('/') }] });
    await open(page, st);
    await signInToPassword(page);
    // the identity pill shows the typed name; the password field has the focus
    await expect(page.locator('.af-pill')).toContainText('anna@example.com');
    await expect(page.getByLabel('Passwort', { exact: true })).toBeFocused();
    await page.getByLabel('Passwort', { exact: true }).fill('fake-password-1');
    await page.getByRole('button', { name: 'Anmelden' }).click();
    await expect(h1(page, 'Bestätigungscode')).toBeVisible();
    await expect(box(page, 1)).toBeFocused();
    await page.keyboard.type('123456'); // submitted on the 6th digit
    await expect(page).toHaveURL(/\/$/);
    await expect(row(page, 'Weiterschauen')).toBeAttached();
    expect(answers(st)).toEqual([
      { stage: 'identify', identifier: 'anna@example.com' },
      { stage: 'password', password: 'fake-password-1' },
      { stage: 'mfa', code: '123456' },
    ]);
    // every POST carried the double-submit header equal to the cookie the config set
    for (const c of st.calls) expect([c.csrf, c.csrfCookie]).toEqual([MOCK_CSRF, MOCK_CSRF]);
    expect(st.calls[0]).toMatchObject({ path: '/auth/flow/start', body: { kind: 'login' } });
  });

  test('renders without /api/me: a public page, and a 401 elsewhere does not send it to /auth/login (preflight D8)', async ({ page }) => {
    let me = 0;
    await page.route('**/api/me', (r) => { me++; return r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthenticated"}' }); });
    await open(page, loginState());
    await expect(h1(page, 'Willkommen zurück')).toBeVisible();
    await page.waitForTimeout(300);
    expect(me).toBe(0);
    await expect(page).toHaveURL(/\/login$/);
  });

  test('wrong password shows the error and keeps the identity pill', async ({ page }) => {
    const first = password('anna');
    const st = loginState({ answers: [{ body: first }, { body: { ...password('anna'), errors: ['invalid'] } }] });
    await open(page, st);
    await signInToPassword(page, 'anna');
    await page.getByLabel('Passwort', { exact: true }).fill('wrong-password');
    await page.getByRole('button', { name: 'Anmelden' }).click();
    await expect(page.getByText('Das hat nicht geklappt. Prüfe deine Eingabe.')).toBeVisible();
    await expect(page.locator('.af-pill')).toContainText('anna');
    await expect(page.getByLabel('Passwort', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Passwort', { exact: true })).toBeFocused();
    // the error sits in a polite live region
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: 'Das hat nicht geklappt' })).toHaveCount(1);
  });

  test('"ändern" starts over; the show-password toggle; "Passwort vergessen?" only with a recovery flow', async ({ page }) => {
    const st = loginState({ config: { body: { mode: 'app', recovery: false, enroll: false } }, starts: [{ body: identify() }, { body: identify() }], answers: [{ body: password() }] });
    await open(page, st);
    await signInToPassword(page);
    const field = page.getByLabel('Passwort', { exact: true });
    await field.fill('secret-1');
    await expect(field).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Passwort anzeigen' }).click();
    await expect(field).toHaveAttribute('type', 'text');
    await expect(page.getByRole('button', { name: 'Passwort anzeigen' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Passwort vergessen?' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Anderes Konto verwenden' }).click();
    await expect(h1(page, 'Willkommen zurück')).toBeVisible();
    expect(st.calls.filter((c) => c.path === '/auth/flow/start')).toHaveLength(2);
  });

  test('too many attempts: the error on the same stage with the sign-in page link', async ({ page }) => {
    const st = loginState({ answers: [{ body: password() }, { body: { ...password(), errors: ['rate_limited'] } }] });
    await open(page, st);
    await signInToPassword(page);
    await page.getByLabel('Passwort', { exact: true }).fill('fake-password-2');
    await page.getByRole('button', { name: 'Anmelden' }).click();
    await expect(page.getByText('Zu viele Versuche.', { exact: false })).toBeVisible();
    await expect(h1(page, 'Passwort')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Zur Anmeldeseite' })).toHaveAttribute('href', '/auth/login?classic=1');
  });

  test('paste fills six boxes and submits', async ({ page }) => {
    const st = loginState({ starts: [{ body: mfa() }], answers: [{ body: done('/') }] });
    await open(page, st);
    await expect(h1(page, 'Bestätigungscode')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Bestätigungscode' })).toBeVisible();
    await box(page, 3).evaluate((el) => {
      const dt = new DataTransfer();
      dt.setData('text', ' 12-34 56 ');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(page).toHaveURL(/\/$/);
    expect(answers(st)).toEqual([{ stage: 'mfa', code: '123456' }]);
  });

  test('a wrong code clears the boxes and keeps the focus on the first one', async ({ page }) => {
    const st = loginState({ starts: [{ body: mfa() }], answers: [{ body: { ...mfa(), errors: ['code_invalid'] } }] });
    await open(page, st);
    await box(page, 1).focus();
    await page.keyboard.type('654321');
    await expect(page.getByText('Der Code stimmt nicht. Versuch es noch einmal.')).toBeVisible();
    for (let i = 1; i <= 6; i++) await expect(box(page, i)).toHaveValue('');
    await expect(box(page, 1)).toBeFocused();
    // the first box takes the whole code (one-time-code autofill), the others one digit
    await expect(box(page, 1)).toHaveAttribute('autocomplete', 'one-time-code');
    await expect(box(page, 2)).toHaveAttribute('autocomplete', 'off');
    await expect(box(page, 1)).toHaveAttribute('inputmode', 'numeric');
  });

  test('recovery-code toggle', async ({ page }) => {
    const st = loginState({ starts: [{ body: mfa() }], answers: [{ body: done('/') }] });
    await open(page, st);
    await page.getByRole('button', { name: 'Stattdessen Wiederherstellungscode nutzen' }).click();
    await expect(h1(page, 'Wiederherstellungscode')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Bestätigungscode' })).toHaveCount(0);
    await expect(page.getByLabel('Wiederherstellungscode')).toBeFocused();
    await page.getByLabel('Wiederherstellungscode').fill('fake-code 0001');
    await page.getByRole('button', { name: 'Bestätigen' }).click();
    await expect(page).toHaveURL(/\/$/);
    expect(answers(st)).toEqual([{ stage: 'mfa', code: 'fakecode0001' }]);
  });

  test('mfa step with passkeyClassic only links to the sign-in page', async ({ page }) => {
    await open(page, loginState({ starts: [{ body: mfa({ passkeyClassic: true }) }] }));
    await expect(h1(page, 'Bestätigungscode')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Passkey verwenden' })).toHaveAttribute('href', '/auth/login?classic=1');
    await expect(page.getByRole('button', { name: 'Passkey verwenden' })).toHaveCount(0);
  });

  test('passkey cancelled shows the classic passkey link', async ({ page }) => {
    await page.addInitScript(() => {
      navigator.credentials.get = () => Promise.reject(new DOMException('cancelled', 'NotAllowedError'));
    });
    const st = loginState({
      starts: [{ body: identify({ passkey: { challenge: 'ZmFrZS1jaGFsbGVuZ2U', rpId: '127.0.0.1', allowCredentials: [], userVerification: 'preferred', timeout: 60000 } }) }],
    });
    await open(page, st);
    await page.getByRole('button', { name: 'Mit Passkey anmelden' }).click();
    await expect(page.getByText('Kein passender Passkey gefunden?')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Auf der Anmeldeseite mit Passkey anmelden' })).toHaveAttribute('href', '/auth/login?classic=1');
    expect(answers(st)).toEqual([]);
  });

  test('"Mit Passkey anmelden" without an in-app passkey goes to the sign-in page, keeping the invite', async ({ page }) => {
    const st = loginState();
    await open(page, st, '/login?invite=inv-0001');
    await page.getByRole('button', { name: 'Mit Passkey anmelden' }).click();
    await expect(page).toHaveURL(/\/auth\/login\?classic=1&invite=inv-0001$/);
    expect(st.calls[0]).toMatchObject({ path: '/auth/flow/start', body: { kind: 'login', invite: 'inv-0001' } });
  });

  test('unknown stage shows "Auf der Anmeldeseite fortfahren" linking /auth/login?classic=1&invite=… (Review Focus 3)', async ({ page }) => {
    const st = loginState({ starts: [{ body: identify() }], answers: [{ body: { stage: 'captcha-v9', step: 'mock-step-x' } }] });
    await open(page, st, '/login?invite=inv-0002');
    await page.getByLabel('E-Mail oder Benutzername').fill('anna');
    await page.getByRole('button', { name: 'Weiter' }).click();
    await expect(h1(page, 'Weiter auf der Anmeldeseite')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Auf der Anmeldeseite fortfahren' })).toHaveAttribute('href', '/auth/login?classic=1&invite=inv-0002');
  });

  test('classic stage from the backend (a captcha) shows the same link', async ({ page }) => {
    await open(page, loginState({ starts: [{ body: { stage: 'classic', reason: 'unsupported_stage' } }] }));
    await expect(page.getByRole('link', { name: 'Auf der Anmeldeseite fortfahren' })).toHaveAttribute('href', '/auth/login?classic=1');
    await expect(h1(page, 'Weiter auf der Anmeldeseite')).toBeFocused();
  });

  test('service unavailable keeps the wall and offers retry (Review Focus 5); retry is a new start', async ({ page, api }) => {
    api.loginArt = { status: 200, images: ART_IMAGES };
    const st = loginState({ starts: [{ body: { stage: 'unavailable' } }, { body: identify() }] });
    await open(page, st);
    await expect(h1(page, 'Anmeldung nicht erreichbar')).toBeVisible();
    await expect(page.locator('.wall[data-wall="covers"]')).toBeAttached();
    await expect(page.getByRole('link', { name: 'Auf der Anmeldeseite fortfahren' })).toHaveAttribute('href', '/auth/login?classic=1');
    await page.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(h1(page, 'Willkommen zurück')).toBeVisible();
    expect(st.calls.filter((c) => c.path === '/auth/flow/start')).toHaveLength(2);
  });

  test.describe('refusals and outages', () => {
    test.use({ allowedConsole: /status of (410|502|503)/ });

    test('a used-up invite: says so and signs in without it', async ({ page }) => {
      const st = loginState({ starts: [{ status: 410, body: { error: 'invite_invalid' } }, { body: identify() }] });
      await open(page, st, '/login?invite=inv-gone');
      await expect(page.getByText('Diese Einladung ist nicht mehr gültig.', { exact: false })).toBeVisible();
      await expect(h1(page, 'Willkommen zurück')).toBeVisible();
      expect(st.calls.map((c) => c.body)).toEqual([{ kind: 'login', invite: 'inv-gone' }, { kind: 'login' }]);
    });

    test('config unreachable: unavailable, retry fetches the config again', async ({ page }) => {
      const st = loginState({ config: { status: 502, body: { error: 'bad_gateway' } } });
      await open(page, st);
      await expect(h1(page, 'Anmeldung nicht erreichbar')).toBeVisible();
      st.config = { body: { mode: 'app', recovery: true, enroll: false } };
      await page.getByRole('button', { name: 'Erneut versuchen' }).click();
      await expect(h1(page, 'Willkommen zurück')).toBeVisible();
    });

    test('during setup the flow config answers 503 setup_required: the page goes to /setup, and the wall falls back to generated art', async ({ page, api }) => {
      api.setup = setupState();
      api.loginArt = { status: 503, images: [] };
      await open(page, loginState({ config: { status: 503, body: { error: 'setup_required' } } }));
      await expect(page).toHaveURL(/\/setup$/);
      await expect(page.getByRole('heading', { level: 1, name: 'FriendFlix einrichten' })).toBeVisible();
    });

    test('a 503 from the cover wall shows generated tiles (no images)', async ({ page, api }) => {
      api.loginArt = { status: 503, images: [] };
      await open(page, loginState());
      await expect(page.locator('.wall[data-wall="generated"]')).toBeAttached();
      await expect(page.locator('.wall img')).toHaveCount(0);
      expect(await page.locator('.wall .tile.art').count()).toBeGreaterThan(10);
    });
  });

  test('LOGIN_UI=authentik: the page goes to the classic sign-in, keeping the invite', async ({ page }) => {
    await open(page, loginState({ config: { body: { mode: 'authentik', recovery: false, enroll: false } } }), '/login?invite=inv-0003');
    await expect(page).toHaveURL(/\/auth\/login\?classic=1&invite=inv-0003$/);
  });

  test('"Noch kein Konto? Einladung einlösen" takes a pasted invite link to /invite/<token>', async ({ page }) => {
    await page.route('**/api/invite/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: true, enrollUrl: '/auth/enroll?invite=tok-000001' }) }));
    await open(page, loginState());
    await page.getByRole('button', { name: 'Noch kein Konto? Einladung einlösen' }).click();
    const field = page.getByLabel('Einladungslink oder Code');
    await expect(field).toBeFocused();
    await field.fill('nope nope');
    await page.getByRole('button', { name: 'Einladung öffnen' }).click();
    await expect(page.getByText('Das sieht nicht nach einer Einladung aus.', { exact: false })).toBeVisible();
    await field.fill('https://friend.example.com/invite/tok-000001');
    await page.getByRole('button', { name: 'Einladung öffnen' }).click();
    await expect(page).toHaveURL(/\/invite\/tok-000001$/);
  });

  test('done sends the browser to next (same-origin only)', async ({ page }) => {
    await open(page, loginState({ starts: [{ body: mfa() }], answers: [{ body: done('/pending') }] }));
    await page.route('**/api/pending', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"state":"pending"}' }));
    await box(page, 1).focus();
    await page.keyboard.type('111111');
    await expect(page).toHaveURL(/\/pending$/);
  });

  test('reduced motion: wall columns have no animation', async ({ page, api }) => {
    api.loginArt = { status: 200, images: ART_IMAGES };
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await open(page, loginState());
    const col = page.locator('.wall .col').first();
    await expect(col).toBeAttached();
    expect(await col.evaluate((el) => getComputedStyle(el).animationName)).not.toBe('none');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await col.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    // 5 tilted columns, alternating up and down
    await expect(page.locator('.wall .col')).toHaveCount(5);
    await expect(page.locator('.wall .col.down')).toHaveCount(2);
  });

  test('wall images are same-origin /api/public paths, lazy and hidden from assistive technology', async ({ page, api }) => {
    api.loginArt = { status: 200, images: [...ART_IMAGES.slice(0, 10), 'https://evil.example.com/cover.jpg', '//evil.example.com/x.jpg'] };
    await open(page, loginState());
    const wall = page.locator('.wall');
    await expect(wall).toHaveAttribute('aria-hidden', 'true');
    await expect(wall.locator('img').first()).toBeAttached();
    const imgs = await wall.locator('img').evaluateAll((els) => els.map((e) => ({
      src: (e as HTMLImageElement).src, alt: e.getAttribute('alt'), hidden: e.getAttribute('aria-hidden'), loading: e.getAttribute('loading'), decoding: e.getAttribute('decoding'),
    })));
    const origin = new URL(page.url()).origin;
    expect(imgs.length).toBeGreaterThan(0);
    for (const i of imgs) {
      expect(i.src.startsWith(`${origin}/api/public/login-art/`)).toBe(true);
      expect(i).toMatchObject({ alt: '', hidden: 'true', loading: 'lazy', decoding: 'async' });
    }
    // nothing on the wall can take the focus
    expect(await wall.locator('a, button, input, [tabindex]').count()).toBe(0);
  });

  test('a11y: each step has labelled inputs and a heading', async ({ page }) => {
    const st = loginState({ starts: [{ body: identify({ passwordInline: true }) }], answers: [{ body: password() }, { body: mfa() }] });
    await open(page, st);
    const check = async (heading: string) => {
      await expect(h1(page, heading)).toBeVisible();
      const inputs = page.locator('main input:visible');
      const n = await inputs.count();
      expect(n).toBeGreaterThan(0);
      for (let i = 0; i < n; i++) {
        const label = await inputs.nth(i).evaluate((el) => (el as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? '');
        expect(label, `input ${i} on "${heading}"`).not.toBe('');
      }
    };
    await check('Willkommen zurück');
    await expect(page.getByLabel('E-Mail oder Benutzername')).toBeFocused();
    await expect(page.getByLabel('E-Mail oder Benutzername')).toHaveAttribute('autocomplete', /username/);
    await expect(page.getByLabel('Passwort', { exact: true })).toHaveAttribute('autocomplete', 'current-password');
    await page.getByLabel('E-Mail oder Benutzername').fill('anna');
    await page.getByLabel('Passwort', { exact: true }).fill('fake-password-3');
    await page.getByRole('button', { name: 'Weiter' }).click();
    expect(answers(st)[0]).toEqual({ stage: 'identify', identifier: 'anna', password: 'fake-password-3' });
    await check('Passwort');
    await expect(page.getByLabel('Passwort', { exact: true })).toHaveAttribute('autocomplete', 'current-password');
    await page.getByLabel('Passwort', { exact: true }).fill('fake-password-3');
    await page.getByRole('button', { name: 'Anmelden' }).click();
    await check('Bestätigungscode');
    await page.getByRole('button', { name: 'Stattdessen Wiederherstellungscode nutzen' }).click();
    await check('Wiederherstellungscode');
  });

  test('nothing secret stays in the page storage or the URL', async ({ page }) => {
    const st = loginState({ answers: [{ body: password() }, { body: { ...password(), errors: ['invalid'] } }] });
    await open(page, st);
    await signInToPassword(page);
    await page.getByLabel('Passwort', { exact: true }).fill('fake-password-4');
    await page.getByRole('button', { name: 'Anmelden' }).click();
    await expect(page.getByText('Das hat nicht geklappt.', { exact: false })).toBeVisible();
    const kept = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href + document.body.innerHTML);
    expect(kept).not.toContain('fake-password-4');
  });

  test('pending page uses the shell', async ({ page }) => {
    await page.route('**/api/pending', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"state":"pending"}' }));
    await page.goto('/pending');
    await expect(h1(page, 'Fast geschafft')).toBeVisible();
    await expect(page.getByText('Dein Konto wartet auf Freigabe durch einen Admin.', { exact: false })).toBeVisible();
    await expect(page.getByText('Diese Seite aktualisiert sich von selbst.')).toBeVisible();
    await expect(page.locator('.wall')).toBeAttached();
    const card = await page.locator('main.card').boundingBox();
    expect(card!.width).toBeLessThanOrEqual(420.5);
  });

  test('desktop: the card is centred and at most 420px wide', async ({ page }) => {
    await open(page, loginState());
    await expect(h1(page, 'Willkommen zurück')).toBeVisible();
    const card = (await page.locator('main.card').boundingBox())!;
    const vw = page.viewportSize()!.width;
    expect(card.width).toBeLessThanOrEqual(420.5);
    expect(Math.abs(card.x + card.width / 2 - vw / 2)).toBeLessThan(2);
  });
});

// ---- passkeys in-app: a Chromium virtual authenticator on http://localhost (WebAuthn refuses IP-address RP IDs, preflight T7-c) ----
const PORT = Number(process.env.E2E_PORT ?? 4173);
const LOCAL = `http://localhost:${PORT}`;

async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const credId = randomBytes(16);
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await cdp.send('WebAuthn.addCredential', {
    authenticatorId,
    credential: {
      credentialId: credId.toString('base64'), isResidentCredential: true, rpId: 'localhost',
      privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), userHandle: Buffer.from('fake-user-0001').toString('base64'), signCount: 0,
    },
  });
  return credId.toString('base64url');
}
const clientData = (cred: any) => JSON.parse(Buffer.from(cred.response.clientDataJSON, 'base64url').toString('utf8'));

test.describe('passkeys in-app (virtual authenticator)', () => {
  test.use({ baseURL: LOCAL });

  test('passkey as second factor: the mock receives { webauthn } with the app origin, and the flow reaches home', async ({ page }) => {
    const credId = await virtualAuthenticator(page);
    const challenge = randomBytes(32).toString('base64url');
    const st = loginState({
      starts: [{ body: mfa({ passkey: { challenge, rpId: 'localhost', allowCredentials: [{ id: credId, type: 'public-key' }], userVerification: 'preferred', timeout: 30000 } }) }],
      answers: [{ body: done('/') }],
    });
    await open(page, st);
    await page.getByRole('button', { name: 'Passkey verwenden' }).click();
    await expect(page).toHaveURL(`${LOCAL}/`);
    await expect(row(page, 'Weiterschauen')).toBeAttached();
    const [a] = answers(st);
    expect(Object.keys(a).sort()).toEqual(['stage', 'webauthn']);
    const cred = a.webauthn;
    expect(clientData(cred)).toMatchObject({ type: 'webauthn.get', origin: LOCAL, challenge });
    expect(cred).toMatchObject({ id: credId, rawId: credId, type: 'public-key', clientExtensionResults: {} });
    expect(Object.keys(cred.response).sort()).toEqual(['authenticatorData', 'clientDataJSON', 'signature', 'userHandle']);
  });

  test('passwordless "Mit Passkey anmelden" with a virtual authenticator sends { passkey }', async ({ page }) => {
    await virtualAuthenticator(page);
    const challenge = randomBytes(32).toString('base64url');
    const st = loginState({
      starts: [{ body: identify({ passkey: { challenge, rpId: 'localhost', allowCredentials: [], userVerification: 'preferred', timeout: 30000 } }) }],
      answers: [{ body: done('/') }],
    });
    await open(page, st);
    await page.getByRole('button', { name: 'Mit Passkey anmelden' }).click();
    await expect(page).toHaveURL(`${LOCAL}/`);
    const [a] = answers(st);
    expect(Object.keys(a).sort()).toEqual(['passkey', 'stage']);
    expect(clientData(a.passkey)).toMatchObject({ type: 'webauthn.get', origin: LOCAL, challenge });
    expect(a.passkey.response.userHandle).toBe(Buffer.from('fake-user-0001').toString('base64url'));
  });
});
