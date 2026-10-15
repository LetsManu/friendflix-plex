// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { SETUP_CODE, setupState } from '../mocks/setup.js';

// The setup wizard (/setup, spec Part F): a new install without users answers 503 setup_required, the wizard opens with the code from
// the log and walks through the public address, the media server, the sign-in and the first admin. /setup/extras (step 6) runs signed in.
const step = (page: Page, n: number) => page.getByRole('navigation', { name: 'Schritte der Einrichtung' }).getByRole('button', { name: new RegExp(`^Schritt ${n}:`) });
const h2 = (page: Page, name: string) => page.getByRole('heading', { level: 2, name, exact: true });

async function unlock(page: Page) {
  await page.goto('/setup');
  await page.getByLabel('Einrichtungscode', { exact: true }).fill(SETUP_CODE.toLowerCase());
  await page.getByRole('button', { name: 'Entsperren' }).click();
}

/** every value the browser storages hold (nothing secret may end up there) */
const storage = (page: Page) => page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);

test.describe('setup wizard', () => {
  test.use({ allowedConsole: /status of (400|401|403|409|410|429|503)/ });
  test.beforeEach(({ api }) => { api.setup = setupState(); });

  test('unauthenticated / redirects to /setup; wrong code shows the error; right code shows step 2 prefilled', async ({ page, api }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole('heading', { level: 1, name: 'FriendFlix einrichten' })).toBeVisible();
    await expect(page.getByText('docker compose logs backend | grep "setup code"')).toBeVisible();
    // the later steps cannot be opened before the code
    await expect(step(page, 2)).toBeDisabled();
    const code = page.getByLabel('Einrichtungscode', { exact: true });
    await code.fill('AAAA-BBBB-CCCC');
    await page.getByRole('button', { name: 'Entsperren' }).click();
    await expect(page.getByRole('alert')).toHaveText('Der Code stimmt nicht. Prüfe ihn im Log des Backends.');
    await code.fill(SETUP_CODE.toLowerCase());
    await page.getByRole('button', { name: 'Entsperren' }).click();
    await expect(h2(page, 'Öffentliche Adresse')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Öffentliche Adresse', exact: true })).toHaveValue('https://tv.example.com');
    await expect(step(page, 2)).toHaveAttribute('aria-current', 'step');
    expect(api.setup!.unlocks).toEqual(['AAAA-BBBB-CCCC', SETUP_CODE.toLowerCase()]);
    expect(await storage(page)).not.toMatch(/K7QM|AAAA/i);
    // saving the address goes on to the media server
    await page.getByRole('button', { name: 'Speichern und weiter' }).click();
    await expect(h2(page, 'Medienserver')).toBeVisible();
    expect(api.setup!.puts).toEqual([{ values: { PUBLIC_URL: 'https://tv.example.com' } }]);
    expect(api.setup!.badCsrf).toBe(0);
  });

  test('public address: http shows the warning; a probe warning (NAT loopback) is shown and Next goes on', async ({ page, api }) => {
    api.setup!.testResults.general = { ok: true, code: 'warning', detail: 'echo_mismatch' };
    await unlock(page);
    const url = page.getByRole('textbox', { name: 'Öffentliche Adresse', exact: true });
    await url.fill('http://tv.example.com');
    await expect(page.getByText(/Mit http:\/\/ sind die Cookies nicht geschützt/)).toBeVisible();
    await url.fill('https://tv.example.com');
    await page.getByRole('button', { name: 'Speichern und weiter' }).click();
    await expect(page.getByText(/NAT-Loopback/)).toBeVisible();
    await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await expect(h2(page, 'Medienserver')).toBeVisible();
    expect(api.setup!.tests).toEqual([{ group: 'general', values: { PUBLIC_URL: 'https://tv.example.com' } }]);
  });

  test('auto path: media auto → step 4 plan list → apply → results → step 5 sign-in button links /auth/login?setup=1', async ({ page, api }) => {
    api.setup!.steps.publicUrl = 'done';
    api.setup!.applyDelayMs = 1200;
    await unlock(page);
    await expect(h2(page, 'Medienserver')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Automatisch', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('Adresse des Medienservers').fill('http://jellyfin:8096');
    await page.getByLabel('Admin-Benutzername').fill('admin');
    await page.getByLabel('Admin-Passwort').fill('pw-placeholder-1');
    await page.getByRole('button', { name: 'API-Schlüssel automatisch anlegen' }).click();
    await expect(h2(page, 'Anmeldung')).toBeVisible();
    expect(api.setup!.autos).toEqual([{ url: 'http://jellyfin:8096', username: 'admin', password: 'pw-placeholder-1' }]);

    await page.getByLabel('Authentik-Adresse').fill('https://auth.example.com');
    const token = page.getByLabel('Admin-API-Token');
    await expect(token).toHaveAttribute('type', 'password');
    await token.fill('ak-admin-placeholder');
    await page.getByRole('button', { name: 'Plan anzeigen' }).click();
    const plan = page.getByRole('list', { name: 'Das richtet FriendFlix in Authentik ein' });
    await expect(plan.getByRole('listitem')).toHaveCount(8);
    await expect(plan.getByRole('listitem').filter({ hasText: 'Gruppen (Admins und Nutzer)' })).toContainText('wird angelegt');
    await expect(plan.getByRole('listitem').filter({ hasText: 'Flow für vergessene Passwörter' })).toContainText('vorhanden');
    await expect(page.getByText(/Ein vorhandener Provider „FriendFlix“ wird angepasst/)).toBeVisible();
    expect(api.setup!.plans).toEqual([{ url: 'https://auth.example.com', token: 'ak-admin-placeholder' }]);

    // the environment sets the client id with another value: it was kept, and the page says so (key names only)
    api.setup!.apply = { status: 200, body: { ...api.setup!.apply.body, envKept: ['OIDC_CLIENT_ID'] } };
    await page.getByRole('button', { name: 'Anwenden' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Authentik wird eingerichtet' })).toBeVisible();
    await expect(page.getByText('Aus der Umgebung (.env) beibehalten: OIDC-Client-ID. Authentik hat dafür jetzt andere Werte')).toBeVisible();
    const results = page.getByRole('list', { name: 'Ergebnis' });
    await expect(results.getByRole('listitem')).toHaveCount(10);
    await expect(page.getByText('Authentik ist eingerichtet, die Anmeldung ist gespeichert.')).toBeVisible();
    const left = page.getByRole('list', { name: 'Noch von Hand zu erledigen' });
    await expect(left.getByRole('listitem')).toHaveCount(3);
    await expect(left).toContainText('SMTP');
    await expect(left).toContainText('/templates');
    expect(api.setup!.applies).toEqual([{ url: 'https://auth.example.com', token: 'ak-admin-placeholder', addMeToAdmins: true }]);
    // the one-time token is gone from the page
    const values = await page.locator('input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(values.join('\n')).not.toContain('ak-admin-placeholder');
    expect(await storage(page)).not.toMatch(/placeholder/);

    await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await expect(h2(page, 'Erster Admin')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Mit Authentik anmelden' })).toHaveAttribute('href', '/auth/login?setup=1');
    // the wording comes from the server state: a reload keeps it
    await page.reload();
    await expect(h2(page, 'Erster Admin')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Mit Authentik anmelden' })).toHaveAttribute('href', '/auth/login?setup=1');
  });

  test('manual path: Jellyfin URL + key with a failing probe shows not_admin; OIDC manual fields with the checklist (redirect URI shows https://tv.example.com/auth/callback)', async ({ page, api }) => {
    api.setup!.steps.publicUrl = 'done';
    api.setup!.testResults.media = { ok: false, code: 'not_admin' };
    api.setup!.saveProbeFail = { ok: false, code: 'not_admin' };
    await unlock(page);
    await page.getByRole('button', { name: 'Von Hand' }).click();
    await page.getByLabel('Jellyfin-Adresse').fill('http://jellyfin:8096');
    const key = page.getByLabel('Jellyfin-API-Schlüssel (Admin)');
    await expect(key).toHaveAttribute('type', 'password');
    await key.fill('jf-key-placeholder');
    await page.getByRole('button', { name: 'Prüfen' }).click();
    await expect(page.getByRole('alert')).toContainText('Das Konto oder der Schlüssel hat keine Admin-Rechte auf dem Medienserver.');
    await page.getByRole('button', { name: 'Speichern und weiter' }).click();
    await expect(page.getByRole('alert')).toContainText('keine Admin-Rechte');
    // a hard failure: no "Save anyway"
    await expect(page.getByRole('button', { name: 'Trotzdem speichern' })).toHaveCount(0);
    expect(api.setup!.tests).toEqual([{ group: 'media', values: { JELLYFIN_URL: 'http://jellyfin:8096', JELLYFIN_ADMIN_API_KEY: 'jf-key-placeholder' } }]);
    expect(api.setup!.puts).toEqual([{ values: { JELLYFIN_URL: 'http://jellyfin:8096', JELLYFIN_ADMIN_API_KEY: 'jf-key-placeholder' } }]);
    // unreachable is soft: "Save anyway" saves with force, and the key field is emptied afterwards
    api.setup!.saveProbeFail = { ok: false, code: 'unreachable' };
    await page.getByRole('button', { name: 'Speichern und weiter' }).click();
    await page.getByRole('button', { name: 'Trotzdem speichern' }).click();
    await expect(h2(page, 'Anmeldung')).toBeVisible();
    expect(api.setup!.puts.at(-1)).toEqual({ values: { JELLYFIN_URL: 'http://jellyfin:8096', JELLYFIN_ADMIN_API_KEY: 'jf-key-placeholder' }, force: true });

    await page.getByRole('button', { name: 'Von Hand' }).click();
    // the backend's prefill is the saved public address (not this browser's origin, 127.0.0.1 here): the strict redirect URI uses it
    await expect(page.getByLabel('Redirect-URI (strict)')).toHaveValue('https://tv.example.com/auth/callback');
    await expect(page.getByText('Grant-Typ: authorization_code')).toBeVisible();
    await expect(page.getByText(/implizite Zustimmung/)).toBeVisible();
    await page.getByLabel('OIDC-Issuer').fill('http://auth.example.com/application/o/friendflix/');
    await expect(page.getByText(/OIDC_ALLOW_INSECURE=true/)).toBeVisible();
    await page.getByLabel('OIDC-Issuer').fill('https://auth.example.com/application/o/friendflix/');
    await expect(page.getByText(/OIDC_ALLOW_INSECURE=true/)).toHaveCount(0);
    await page.getByLabel('OIDC-Client-ID').fill('friendflix');
    await page.getByLabel('OIDC-Client-Geheimnis').fill('client-secret-placeholder');
    await page.getByRole('button', { name: 'Speichern und weiter' }).click();
    await expect(h2(page, 'Erster Admin')).toBeVisible();
    // any OIDC provider: neutral wording
    await expect(page.getByRole('link', { name: 'Anmelden und Einrichtung abschließen' })).toHaveAttribute('href', '/auth/login?setup=1');
    await expect(page.getByRole('link', { name: 'Mit Authentik anmelden' })).toHaveCount(0);
    expect(api.setup!.puts.at(-1)).toEqual({ values: {
      OIDC_ISSUER: 'https://auth.example.com/application/o/friendflix/', OIDC_CLIENT_ID: 'friendflix', OIDC_CLIENT_SECRET: 'client-secret-placeholder',
    } });
    expect(await storage(page)).not.toMatch(/placeholder/);
  });

  test('env-locked step shows "from environment" and a Next button', async ({ page, api }) => {
    api.setup!.steps.publicUrl = 'env';
    api.setup!.steps.media = 'env';
    await unlock(page);
    // both locked steps are skipped on the way in
    await expect(h2(page, 'Anmeldung')).toBeVisible();
    await expect(step(page, 2)).toHaveAccessibleName('Schritt 2: Öffentliche Adresse (aus der Umgebung)');
    await step(page, 2).click();
    await expect(page.getByText('Aus der Umgebung', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Öffentliche Adresse', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await expect(h2(page, 'Medienserver')).toBeVisible();
    await expect(page.getByText('Aus der Umgebung', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await expect(h2(page, 'Anmeldung')).toBeVisible();
    expect(api.setup!.puts).toEqual([]);
  });

  test('the code errors explain what to do: no code, locked, expired, rate limit', async ({ page, api }) => {
    await page.goto('/setup');
    const code = page.getByLabel('Einrichtungscode', { exact: true });
    const submit = page.getByRole('button', { name: 'Entsperren' });
    for (const [status, error, text] of [
      [410, 'no_code', /BACKGROUND_JOBS=true.*starte das Backend neu und lies dann sein Log/],
      [410, 'code_locked', /Zu viele falsche Versuche/],
      [410, 'code_expired', /Der Code ist abgelaufen/],
      [429, 'rate_limited', /Zu viele Versuche\. Warte/],
    ] as const) {
      api.setup!.unlockError = { status, error };
      await code.fill(SETUP_CODE);
      await submit.click();
      await expect(page.getByRole('alert')).toHaveText(text);
    }
  });

  test('an expired setup session goes back to the code; a completed setup goes to /', async ({ page, api }) => {
    await unlock(page);
    await expect(h2(page, 'Öffentliche Adresse')).toBeVisible();
    api.setup!.unlocked = false; // the 2 h session ran out
    await page.getByRole('button', { name: 'Speichern und weiter' }).click();
    await expect(h2(page, 'Einrichtungscode eingeben')).toBeVisible();
    await expect(page.getByText('Deine Einrichtungssitzung ist abgelaufen. Gib den Einrichtungscode noch einmal ein.')).toBeVisible();
    await page.getByLabel('Einrichtungscode', { exact: true }).fill(SETUP_CODE);
    await page.getByRole('button', { name: 'Entsperren' }).click();
    await expect(h2(page, 'Öffentliche Adresse')).toBeVisible();
    api.setup!.complete = true; // someone finished the setup meanwhile
    await page.getByRole('button', { name: 'Speichern und weiter' }).click();
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  });

  test('a sign-in whose setup session ran out comes back to /setup?expired=1: the code step says why', async ({ page }) => {
    await page.goto('/setup?expired=1');
    await expect(h2(page, 'Einrichtungscode eingeben')).toBeVisible();
    await expect(page.getByText('Deine Einrichtungssitzung ist abgelaufen. Gib den Einrichtungscode noch einmal ein.')).toBeVisible();
    await page.getByLabel('Einrichtungscode', { exact: true }).fill(SETUP_CODE);
    await page.getByRole('button', { name: 'Entsperren' }).click();
    await expect(h2(page, 'Öffentliche Adresse')).toBeVisible();
  });

  test('Authentik: plan failures stop before Apply; blueprint_invalid and busy explain the retry; http needs OIDC_ALLOW_INSECURE', async ({ page, api }) => {
    api.setup!.steps.publicUrl = 'done';
    api.setup!.steps.media = 'done';
    api.setup!.planSteps = [{ id: 'check', state: 'failed', detail: 'not_superuser' }];
    await unlock(page);
    await page.getByLabel('Authentik-Adresse').fill('http://auth.example.com');
    await expect(page.getByText(/OIDC_ALLOW_INSECURE=true/)).toBeVisible();
    await page.getByLabel('Authentik-Adresse').fill('https://auth.example.com');
    await page.getByLabel('Admin-API-Token').fill('ak-admin-placeholder');
    await page.getByRole('button', { name: 'Plan anzeigen' }).click();
    await expect(page.getByText('Der Token gehört keinem Superuser. Nimm den Token eines Kontos mit Superuser-Rechten.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Anwenden' })).toHaveCount(0);

    api.setup!.planSteps = setupState().planSteps;
    await page.getByRole('button', { name: 'Plan anzeigen' }).click();
    api.setup!.apply = { status: 200, body: { ok: false, steps: [{ id: 'check', state: 'ok' }, { id: 'groups', state: 'failed', detail: 'blueprint_invalid' }] } };
    await page.getByRole('button', { name: 'Anwenden' }).click();
    await expect(page.getByText(/Authentik startet vielleicht noch; versuche es in ein paar Minuten noch einmal\./)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Ergebnis' }).getByRole('listitem').filter({ hasText: 'Gruppen' })).toContainText('fehlgeschlagen');
    // the token was used: a retry needs it again
    await expect(page.getByLabel('Admin-API-Token')).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Noch einmal versuchen' })).toBeDisabled();
    await page.getByLabel('Admin-API-Token').fill('ak-admin-placeholder');
    api.setup!.apply = { status: 409, body: { error: 'busy' } };
    await page.getByRole('button', { name: 'Noch einmal versuchen' }).click();
    await expect(page.getByText('Gerade läuft schon eine Einrichtung. Warte einen Moment und versuche es dann noch einmal.')).toBeVisible();
  });

  test('a visit to /setup after setup completed goes to /', async ({ page, api }) => {
    api.setup!.complete = true;
    await page.goto('/setup');
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  });

  test('step 5 lists what is still open instead of the sign-in', async ({ page, api }) => {
    api.setup!.steps.publicUrl = 'done';
    await unlock(page);
    await step(page, 5).click();
    await expect(page.getByText('Vorher noch erledigen:')).toBeVisible();
    await expect(page.getByRole('link', { name: /anmelden/i })).toHaveCount(0);
    await page.getByRole('button', { name: 'Medienserver', exact: true }).click();
    await expect(h2(page, 'Medienserver')).toBeVisible();
  });
});

test.describe('setup extras (/setup/extras)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('extras: Skip on every card reaches /; Generate push keys shows "set", never a private key; webhook secret shown once', async ({ page, api }) => {
    const webhook = api.settings.groups.find((g) => g.id === 'general')!.items.find((i) => i.key === 'WEBHOOK_SECRET')!;
    webhook.set = false; webhook.source = 'unset';
    await page.goto('/setup/extras');
    await expect(page.getByRole('heading', { level: 1, name: 'Fast fertig: Extras' })).toBeVisible();
    // push: only the public half comes back; the page shows "set"
    const push = page.locator('section', { has: page.getByRole('heading', { level: 2, name: 'Push-Mitteilungen' }) });
    const gen = page.waitForResponse((r) => r.url().endsWith('/api/admin/settings/generate'));
    await push.getByRole('button', { name: 'Push-Schlüssel erzeugen' }).click();
    expect(Object.keys(await (await gen).json())).toEqual(['publicKey']);
    await expect(push.getByText('Gesetzt', { exact: true })).toBeVisible();
    await expect(push.getByRole('textbox')).toHaveCount(0);
    // webhooks: the secret and the header line, once
    const hooks = page.locator('section', { has: page.getByRole('heading', { level: 2, name: 'Webhooks' }) });
    const answer = page.waitForResponse((r) => r.url().endsWith('/api/admin/settings/generate'));
    await hooks.getByRole('button', { name: 'Webhook-Geheimnis erzeugen' }).click();
    const { secret } = (await (await answer).json()) as { secret: string };
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    await expect(hooks.getByLabel('Webhook-Geheimnis')).toHaveValue(secret);
    await expect(hooks.getByLabel('Header-Zeile')).toHaveValue(`X-Webhook-Secret: ${secret}`);
    await expect(hooks.getByRole('button', { name: 'Kopieren' })).toHaveCount(2);
    await expect(hooks.getByRole('button', { name: 'Webhook-Geheimnis erzeugen' })).toHaveCount(0);
    expect(await storage(page)).not.toContain(secret);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Fast fertig: Extras' })).toBeVisible();
    const values = await page.locator('input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(values.join('\n')).not.toContain(secret);
    expect(await page.content()).not.toContain(secret);
    // Skip every card, then Finish
    const skips = page.getByRole('button', { name: /überspringen$/ });
    const n = await skips.count();
    expect(n).toBe(7);
    for (let i = 0; i < n; i++) await skips.first().click();
    await expect(page.getByText('Übersprungen', { exact: true })).toHaveCount(7);
    await page.getByRole('button', { name: 'Fertig' }).click();
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
    expect(api.settings.puts).toEqual([]);
  });

  test('extras: a card saves only its own changed keys', async ({ page, api }) => {
    await page.goto('/setup/extras');
    const sources = page.locator('section', { has: page.getByRole('heading', { level: 2, name: 'Datenquellen' }) });
    await sources.getByRole('button', { name: 'OMDb-API-Schlüssel ersetzen' }).click();
    await sources.getByLabel('Neuer Wert').fill('omdb-placeholder');
    await sources.getByRole('button', { name: 'Speichern' }).click();
    await expect(sources.getByText('Erledigt', { exact: true })).toBeVisible();
    expect(api.settings.puts).toEqual([{ values: { OMDB_API_KEY: 'omdb-placeholder' } }]);
    expect(await page.content()).not.toContain('omdb-placeholder');
  });
});
