// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { updaterState } from '../mocks/updater.js';

const toasts = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Hinweise' });
const card = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Updater' });
const steps = (page: import('@playwright/test').Page) => card(page).locator('ol.steps li');

test.describe('admin update with the opt-in updater (desktop)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });
  // the fake backend answers 502 while it "restarts" during a job, and 401 reauth_required before a sign-in
  test.use({ allowedConsole: /status of (502 \(Bad Gateway\)|401 \(Unauthorized\))/ });

  test('without an updater the page keeps the manual steps', async ({ page }) => {
    await page.goto('/admin/update');
    await expect(page.getByRole('region', { name: 'Update-Kanal' }).getByLabel('Zeile in der .env')).toHaveValue('FF_TAG=latest');
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Aktualisieren', exact: true })).toBeVisible();
  });

  test('update now: inline confirmation, live steps through the backend restart, result', async ({ page, api }) => {
    api.updater = updaterState(true);
    await page.goto('/admin/update');
    const c = card(page);
    await expect(c).toContainText('Installiert:');
    await expect(c.locator('[data-updater]')).toContainText('sha-a1b2c3d');
    // the updater installs the channel: no .env snippet, a note instead
    const channel = page.getByRole('region', { name: 'Update-Kanal' });
    await expect(channel.locator('[data-snippet]')).toHaveCount(0);
    await expect(channel.locator('[data-updater-note]')).toContainText('keine Änderung an der .env');
    await expect(page.getByRole('region', { name: 'Aktualisieren', exact: true })).toHaveCount(0);

    await c.getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    const confirm = c.getByRole('group', { name: /Jetzt auf latest aktualisieren/ });
    await expect(confirm).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0); // inline, no pop-up
    await confirm.getByRole('button', { name: 'Ja, starten' }).click();
    await expect(steps(page)).toHaveCount(4);
    await expect(c.locator('[data-reconnecting]')).toContainText('FriendFlix startet neu');
    await expect(c.locator('[data-result="succeeded"]')).toContainText('Update auf latest abgeschlossen.', { timeout: 20_000 });
    for (const s of ['pull', 'verify', 'restart', 'health']) await expect(c.locator(`li[data-step="${s}"]`)).toHaveAttribute('data-state', 'ok');
    await expect(c.locator('[data-reconnecting]')).toHaveCount(0);
    expect(api.updater.posts).toEqual(['update']);
  });

  test('an unhealthy new version: the rollback step shows and the result says rolled back', async ({ page, api }) => {
    api.updater = { ...updaterState(true), outcome: 'rolled_back', downPolls: 0 };
    await page.goto('/admin/update');
    await card(page).getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    await card(page).getByRole('button', { name: 'Ja, starten' }).click();
    await expect(card(page).locator('[data-result="rolled_back"]')).toContainText('zurückgerollt auf sha-c0be6c5', { timeout: 20_000 });
    await expect(card(page).locator('li[data-step="health"]')).toHaveAttribute('data-state', 'failed');
    await expect(card(page).locator('li[data-step="rollback"]')).toHaveAttribute('data-state', 'ok');
  });

  test('back to the previous version; cancel leaves everything as it was; without a previous build the button is off', async ({ page, api }) => {
    api.updater = updaterState(true);
    await page.goto('/admin/update');
    const back = card(page).getByRole('button', { name: 'Zurück zur vorherigen Version' });
    await back.click();
    await card(page).getByRole('button', { name: 'Abbrechen' }).click();
    expect(api.updater.posts).toEqual([]);
    await back.click();
    await expect(card(page).getByRole('group', { name: /Zurück zu sha-a1b2c3d/ })).toBeVisible();
    await card(page).getByRole('button', { name: 'Ja, starten' }).click();
    await expect(card(page).locator('[data-result="succeeded"]')).toBeVisible({ timeout: 20_000 });
    expect(api.updater.posts).toEqual(['rollback']);

    api.updater = { ...updaterState(true), previous: null };
    await page.reload();
    await expect(card(page).getByRole('button', { name: 'Zurück zur vorherigen Version' })).toBeDisabled();
  });

  test('a start that needs a recent sign-in goes through /auth/reauth and says so on return', async ({ page, api }) => {
    api.updater = { ...updaterState(true), reauthRequired: true };
    let next: string | null = null;
    await page.route('**/auth/reauth?**', (r) => {
      next = new URL(r.request().url()).searchParams.get('next');
      api.updater!.reauthRequired = false;
      return r.fulfill({ status: 302, headers: { location: next ?? '/' } });
    });
    await page.goto('/admin/update');
    await card(page).getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    await card(page).getByRole('button', { name: 'Ja, starten' }).click();
    await expect.poll(() => next).toBe('/admin/update?reauth=1');
    await expect(card(page)).toContainText('Erneut angemeldet');
    await expect(page).toHaveURL(/\/admin\/update$/);
    expect(api.updater.posts).toEqual([]); // nothing restarted on its own
  });

  test('a running job is picked up after a reload; the updater itself; automatic updates', async ({ page, api }) => {
    api.updater = updaterState(true);
    api.updater.job = { id: '0123456789abcdef', action: 'update', state: 'running', step: 'pull', from: 'sha-c0be6c5', to: 'latest', startedAt: new Date().toISOString(), finishedAt: null, error: null,
      steps: { pull: 'running', verify: 'pending', restart: 'pending', health: 'pending', rollback: 'skipped' } };
    api.updater.downPolls = 0;
    await page.goto('/admin/update');
    await expect(card(page).locator('[data-result="succeeded"]')).toBeVisible({ timeout: 20_000 });

    await card(page).getByText('Updater selbst').click();
    await card(page).getByRole('button', { name: 'Updater aktualisieren' }).click();
    await card(page).getByRole('button', { name: 'Ja, starten' }).click();
    await expect.poll(() => api.updater!.posts).toEqual(['self-update']);
    await expect(card(page).locator('li[data-step]')).toHaveCount(3); // no health step for the updater itself

    await card(page).getByLabel('Automatische Updates').selectOption('nightly-window');
    await card(page).getByLabel('Uhrzeit').fill('03:30');
    await card(page).getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Automatische Updates gespeichert.')).toBeVisible();
    expect(api.settings.puts.at(-1)).toEqual({ values: { AUTO_UPDATE: 'nightly-window', AUTO_UPDATE_TIME: '03:30' } });
  });

  test('a fixed version: the form opens, a bad version is refused, a good one is saved with the channel', async ({ page, api }) => {
    api.updater = updaterState(true);
    await page.goto('/admin/update');
    const channel = page.getByRole('region', { name: 'Update-Kanal' });
    await channel.getByRole('radio', { name: 'Feste Version' }).click();
    expect(api.settings.puts).toEqual([]);
    const field = channel.getByLabel('Version (X.Y.Z)');
    await field.fill('latest');
    await channel.getByRole('button', { name: 'Version speichern' }).click();
    await expect(channel).toContainText('Bitte eine Version wie 1.2.3 eingeben.');
    await field.fill('1.2.3');
    await channel.getByRole('button', { name: 'Version speichern' }).click();
    await expect(toasts(page).getByText('Kanal Feste Version 1.2.3 gespeichert.')).toBeVisible();
    expect(api.settings.puts).toEqual([{ values: { UPDATE_CHANNEL: 'pinned', UPDATE_VERSION: '1.2.3' } }]);
    await expect(channel.getByRole('radio', { name: 'Feste Version' })).toHaveAttribute('aria-checked', 'true');
    await expect(card(page).locator('[data-updater]')).toContainText('1.2.3');
  });

  test('an updater that refuses the signature is reported', async ({ page, api }) => {
    api.updater = updaterState('unauthorized');
    await page.goto('/admin/update');
    await expect(card(page).getByRole('alert')).toContainText('INTERNAL_SECRET');
  });
});
