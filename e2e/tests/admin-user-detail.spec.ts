// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { auid } from '../mocks/admin.js';

const ANNA = auid(2);
const toasts = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Hinweise' });
const logged = (api: { log: string[] }, re: RegExp) => api.log.some((l) => re.test(l));
const menu = async (page: import('@playwright/test').Page) => {
  await page.getByRole('button', { name: 'Aktionen', exact: true }).click();
  return page.getByRole('dialog', { name: 'Anna Beispiel' });
};

test.describe('admin user detail (desktop)', () => {
  test.use({ allowedConsole: /status of (404|409|500|501)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('detail shows header and totals', async ({ page }) => {
    await page.goto('/admin/users');
    await page.getByRole('link', { name: 'Anna Beispiel' }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/users/${ANNA}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    const head = page.getByRole('region', { name: 'Anna Beispiel' });
    await expect(head.getByRole('heading', { level: 2, name: 'Anna Beispiel' })).toBeVisible();
    await expect(head).toContainText('anna@example.org');
    await expect(head).toContainText('Freund');
    await expect(head.getByText('Aktiv', { exact: true })).toBeVisible();
    await expect(head.getByText('Authenticator-App')).toBeVisible();
    await expect(head.getByText('Wiederherstellungscodes')).toBeVisible();

    const totals = page.getByRole('region', { name: 'Nutzung' });
    await expect(totals).toContainText('Letzte 7 Tage');
    await expect(totals).toContainText('3,5 Std.');
    await expect(totals).toContainText('15 Streams');
    await expect(totals).toContainText('140 Std.');
    await expect(totals).toContainText('Wünsche');
    const linked = page.getByRole('region', { name: 'Verknüpfte Konten' });
    await expect(linked).toContainText('Verbunden');
    await expect(linked.getByRole('button', { name: /Reparieren/ })).toHaveCount(0);
    const body = page.locator('main, body').first();
    await expect(body).not.toContainText('undefined');
    await expect(body).not.toContainText('Seerr');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('linked accounts: unknown is neutral, broken offers Repair', async ({ page, api }) => {
    api.admin.linkedOk = { jellyfin: null, requests: false };
    await page.goto(`/admin/users/${ANNA}`);
    const linked = page.getByRole('region', { name: 'Verknüpfte Konten' });
    await expect(linked.getByRole('listitem').filter({ hasText: 'Medienserver' })).toContainText('Unbekannt');
    await expect(linked.getByRole('listitem').filter({ hasText: 'Medienserver' })).not.toContainText('Gestört');
    const req = linked.getByRole('listitem').filter({ hasText: 'Wunschliste' });
    await expect(req).toContainText('Gestört');
    await linked.getByRole('button', { name: 'Verknüpfungen reparieren' }).click();
    await expect(toasts(page).getByText('Verknüpfungen repariert.')).toBeVisible();
    expect(logged(api, new RegExp(`POST /api/admin/users/${ANNA}/repair`))).toBe(true);
    await expect(req).toContainText('Verbunden');
    await expect(linked.getByRole('button', { name: 'Verknüpfungen reparieren' })).toHaveCount(0);
  });

  test('activity tab loads only when opened', async ({ page, api }) => {
    await page.goto(`/admin/users/${ANNA}`);
    await expect(page.getByRole('region', { name: 'Nutzung' })).toBeVisible();
    await page.getByRole('tab', { name: 'Profile' }).click();
    await expect(page).toHaveURL(/\?tab=profiles$/);
    expect(api.admin.activityCalls).toBe(0);
    await page.getByRole('tab', { name: 'Verlauf' }).click();
    await expect(page).toHaveURL(/\?tab=activity$/);
    const panel = page.getByRole('tabpanel', { name: 'Verlauf' });
    await expect(panel.getByText('Das Ansehen wird im Audit-Log festgehalten.')).toBeVisible();
    await expect(panel.getByText('Hearth')).toBeVisible();
    await expect(panel.getByText('Sundial')).toBeVisible();
    await expect(panel.getByRole('row', { name: /Hearth/ })).toContainText('45 %');
    await expect(panel.getByRole('row', { name: /Pilot/ })).toContainText('Gesehen');
    expect(api.admin.activityCalls).toBe(1);
    await page.getByRole('tab', { name: 'Übersicht' }).click();
    await page.getByRole('tab', { name: 'Verlauf' }).click();
    await expect(panel.getByText('Hearth')).toBeVisible();
    expect(api.admin.activityCalls).toBe(2);
  });

  test('limits save sends only changed fields', async ({ page, api }) => {
    api.admin.limits[ANNA] = { maxStreams: 2, remoteBitrate: null, maxDownloads: null, downloadMaxHeight: null, requestsPerMonth: null };
    await page.goto(`/admin/users/${ANNA}?tab=limits`);
    const streams = page.getByRole('spinbutton', { name: 'Gleichzeitige Streams' });
    await expect(streams).toHaveValue('2');
    const req = page.getByRole('spinbutton', { name: 'Wünsche pro Monat' });
    await expect(req).toHaveValue('');
    await expect(req).toHaveAttribute('placeholder', 'wie Rolle: 3');
    await expect(page.getByRole('spinbutton', { name: /Limit unterwegs/ })).toHaveAttribute('placeholder', 'wie Rolle: 8');
    await req.fill('5');
    await streams.fill('');
    await page.getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Limits gespeichert.')).toBeVisible();
    const put = api.log.filter((l) => l.startsWith(`PUT /api/admin/users/${ANNA}/limits`));
    expect(put).toHaveLength(1);
    expect(JSON.parse(put[0]!.split(' ')[2]!)).toEqual({ maxStreams: null, requestsPerMonth: 5 });
    await expect(streams).toHaveAttribute('placeholder', 'wie Rolle: 2');

    await req.fill('101');
    await page.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByText('Bitte 0 bis 100 eingeben oder leer lassen.')).toBeVisible();
    expect(api.log.filter((l) => l.startsWith(`PUT /api/admin/users/${ANNA}/limits`))).toHaveLength(1);
  });

  test('extend access +30 days', async ({ page, api }) => {
    await page.goto(`/admin/users/${ANNA}`);
    await (await menu(page)).getByRole('button', { name: 'Zugang verlängern' }).click();
    const form = page.getByRole('form', { name: 'Zugang verlängern' });
    await form.getByRole('combobox', { name: 'Zugang bis' }).selectOption('p30');
    const before = Date.now();
    await form.getByRole('button', { name: 'Übernehmen' }).click();
    await expect(toasts(page).getByText(/^Zugang von Anna Beispiel bis /)).toBeVisible();
    const patch = api.log.find((l) => l.startsWith(`PATCH /api/admin/users/${ANNA} `))!;
    const until = Date.parse(JSON.parse(patch.split(' ')[2]!).accessUntil);
    expect(Math.abs(until - (before + 30 * 86_400_000))).toBeLessThan(60_000);
    await expect(page.getByRole('region', { name: 'Anna Beispiel' }).getByText(/^Zugang bis /)).toBeVisible();
    await expect(form).toHaveCount(0);
  });

  test('an account whose access ended offers "Extend access" instead of "Unlock"', async ({ page, api }) => {
    const anna = api.admin.users.find((u) => u.id === ANNA)!;
    Object.assign(anna, { disabled: true, locked_reason: 'expired', access_until: new Date(Date.now() - 86400e3).toISOString() });
    await page.goto(`/admin/users/${ANNA}`);
    const head = page.getByRole('region', { name: 'Anna Beispiel' });
    await expect(head.getByText('Gesperrt: Zugang abgelaufen')).toBeVisible();
    const m = await menu(page);
    await expect(m.getByRole('button', { name: 'Entsperren' })).toHaveCount(0);
    await expect(m.getByRole('button', { name: 'Zugang verlängern' })).toHaveCount(1);
    await m.getByRole('button', { name: 'Zugang verlängern' }).click();
    const form = page.getByRole('form', { name: 'Zugang verlängern' });
    await form.getByRole('combobox', { name: 'Zugang bis' }).selectOption('p30');
    await form.getByRole('button', { name: 'Übernehmen' }).click();
    await expect(head.getByText('Aktiv', { exact: true })).toBeVisible();
  });

  test('a locked account whose access ended answers an unlock with the reason', async ({ page, api }) => {
    const anna = api.admin.users.find((u) => u.id === ANNA)!;
    Object.assign(anna, { disabled: true, locked_reason: 'manual', access_until: new Date(Date.now() + 86400e3).toISOString() });
    await page.goto(`/admin/users/${ANNA}`);
    await expect(page.getByRole('region', { name: 'Anna Beispiel' }).getByText('Gesperrt: von Hand')).toBeVisible();
    anna.access_until = new Date(Date.now() - 1000).toISOString(); // ended while the page was open
    await (await menu(page)).getByRole('button', { name: 'Entsperren' }).click();
    await expect(toasts(page).getByText('Der Zugang ist abgelaufen – verlängere stattdessen den Zugang.')).toBeVisible();
    expect(anna.disabled).toBe(true);
  });

  test('role change and locking an admin need the typed name', async ({ page, api }) => {
    api.admin.users.find((u) => u.id === ANNA)!.role = 'admin';
    await page.goto(`/admin/users/${ANNA}`);
    await (await menu(page)).getByRole('button', { name: 'Rolle ändern' }).click();
    const form = page.getByRole('form', { name: 'Rolle ändern' });
    await form.getByRole('combobox', { name: 'Neue Rolle' }).selectOption('guest');
    await form.getByRole('button', { name: 'Übernehmen' }).click();
    const demote = page.getByRole('alertdialog', { name: 'Anna Beispiel herabstufen?' });
    await expect(demote.getByRole('button', { name: 'Übernehmen' })).toBeDisabled();
    await demote.getByRole('textbox').fill('Anna Beispiel');
    await demote.getByRole('button', { name: 'Übernehmen' }).click();
    await expect(toasts(page).getByText('Anna Beispiel ist jetzt Gast.')).toBeVisible();
    expect(logged(api, new RegExp(`PATCH /api/admin/users/${ANNA} .*"role":"guest"`))).toBe(true);

    api.admin.users.find((u) => u.id === ANNA)!.role = 'admin';
    await page.reload();
    await (await menu(page)).getByRole('button', { name: 'Sperren' }).click();
    const lock = page.getByRole('alertdialog', { name: 'Anna Beispiel sperren?' });
    await expect(lock.getByRole('button', { name: 'Sperren' })).toBeDisabled();
    await lock.getByRole('textbox').fill('Anna Beispiel');
    await lock.getByRole('button', { name: 'Sperren' }).click();
    await expect(toasts(page).getByText('Anna Beispiel wurde gesperrt.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Anna Beispiel' }).getByText('Gesperrt: von Hand')).toBeVisible();
  });

  test('password reset button hidden without Authentik', async ({ page, api }) => {
    await page.goto(`/admin/users/${ANNA}`);
    let m = await menu(page);
    await expect(m.getByRole('button', { name: '2FA-Einrichtung senden' })).toHaveCount(0); // Authentik has no API for it
    await m.getByRole('button', { name: 'Passwort-Link senden' }).click();
    await page.getByRole('alertdialog', { name: 'Passwort-Link an Anna Beispiel senden?' }).getByRole('button', { name: 'Senden' }).click();
    await expect(toasts(page).getByText('Passwort-Link an Anna Beispiel gesendet.')).toBeVisible();
    expect(logged(api, new RegExp(`POST /api/admin/users/${ANNA}/recovery`))).toBe(true);

    await page.route(`**/api/admin/users/${ANNA}/recovery`, (r) => r.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"recovery_not_configured"}' }));
    m = await menu(page);
    await m.getByRole('button', { name: 'Passwort-Link senden' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Senden' }).click();
    await expect(toasts(page).getByText(/kein Ablauf zum Zurücksetzen/)).toBeVisible();

    api.admin.detailMfa = null;
    await page.reload();
    m = await menu(page);
    await expect(m.getByRole('button', { name: 'Überall abmelden' })).toBeVisible();
    await expect(m.getByRole('button', { name: 'Passwort-Link senden' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Anna Beispiel' }).getByText('2FA unbekannt')).toBeVisible();
    await page.keyboard.press('Escape');

    api.admin.detailMfa = { totp: false, webauthn: false, static: false };
    api.admin.authentik = { recovery: false, mfaSetup: false };
    await page.reload();
    m = await menu(page);
    await expect(m.getByRole('button', { name: 'Überall abmelden' })).toBeVisible();
    await expect(m.getByRole('button', { name: 'Passwort-Link senden' })).toHaveCount(0);
  });

  test('profiles: rename inline and reset PIN with confirm', async ({ page, api }) => {
    await page.goto(`/admin/users/${ANNA}?tab=profiles`);
    const panel = page.getByRole('tabpanel', { name: 'Profile' });
    const kids = panel.getByRole('row', { name: /Kinder/ });
    await expect(kids).toContainText('PIN gesetzt');
    await kids.getByRole('button', { name: '„Kinder“ umbenennen' }).click();
    const name = kids.getByRole('textbox', { name: 'Neuer Name' });
    await expect(name).toHaveAttribute('maxlength', '20');
    await name.fill('Anna');
    await kids.getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Diesen Namen hat schon ein anderes Profil.')).toBeVisible();
    await name.fill('Kids');
    await kids.getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Profil heißt jetzt „Kids“.')).toBeVisible();
    const row = panel.getByRole('row', { name: /Kids/ });
    await row.getByRole('button', { name: 'PIN von „Kids“ zurücksetzen' }).click();
    await page.getByRole('alertdialog', { name: 'PIN von „Kids“ zurücksetzen?' }).getByRole('button', { name: 'PIN zurücksetzen' }).click();
    await expect(toasts(page).getByText('PIN von „Kids“ zurückgesetzt.')).toBeVisible();
    await expect(row).toContainText('Keine PIN');
    expect(logged(api, /PATCH \/api\/admin\/users\/.*\/profiles\/.*"resetPin":true/)).toBe(true);
    // the owner profile can be renamed too
    await expect(panel.getByRole('row', { name: /Hauptprofil/ }).getByRole('button', { name: '„Anna“ umbenennen' })).toBeVisible();
  });

  test('devices: approve, withdraw approval, sign out one device, remove', async ({ page, api }) => {
    await page.goto(`/admin/users/${ANNA}?tab=devices`);
    const panel = page.getByRole('tabpanel', { name: 'Geräte' });
    const row = panel.getByRole('row', { name: /Chrome auf Windows/ });
    await expect(row).toContainText('Wartet auf Freigabe');
    await row.getByRole('button', { name: '„Chrome auf Windows“ freigeben' }).click();
    await expect(toasts(page).getByText('„Chrome auf Windows“ freigegeben.')).toBeVisible();
    expect(logged(api, new RegExp(`POST /api/admin/devices/approve .*"userId":"${ANNA}","deviceId":"dev-0-0123456789ab"`))).toBe(true);
    await expect(row).toContainText('Freigegeben');

    const actions = async () => {
      await row.getByRole('button', { name: 'Aktionen für Chrome auf Windows' }).click();
      return page.getByRole('dialog', { name: 'Chrome auf Windows' });
    };
    await (await actions()).getByRole('button', { name: 'Freigabe zurücknehmen' }).click();
    await expect(toasts(page).getByText('Freigabe von „Chrome auf Windows“ zurückgenommen.')).toBeVisible();
    expect(logged(api, /POST \/api\/admin\/devices\/unapprove /)).toBe(true);
    await expect(row).toContainText('Wartet auf Freigabe');

    await (await actions()).getByRole('button', { name: 'Abmelden' }).click();
    await page.getByRole('alertdialog', { name: '„Chrome auf Windows“ abmelden?' }).getByRole('button', { name: 'Abmelden' }).click();
    await expect(toasts(page).getByText(/Sitzung beendet/)).toBeVisible();
    expect(logged(api, new RegExp(`POST /api/admin/users/${ANNA}/sessions/dev-0-0123456789ab/revoke`))).toBe(true);

    await (await actions()).getByRole('button', { name: 'Entfernen' }).click();
    const dlg = page.getByRole('alertdialog', { name: '„Chrome auf Windows“ entfernen?' });
    await dlg.getByRole('button', { name: 'Abbrechen' }).click();
    expect(logged(api, /devices\/remove/)).toBe(false);
    await (await actions()).getByRole('button', { name: 'Entfernen' }).click();
    await dlg.getByRole('button', { name: 'Entfernen' }).click();
    await expect(toasts(page).getByText('„Chrome auf Windows“ entfernt.')).toBeVisible();
    await expect(row).toHaveCount(0);

    await page.getByRole('tab', { name: 'Audit-Log' }).click();
    const audit = page.getByRole('tabpanel', { name: 'Audit-Log' });
    await expect(audit.getByText('Tester hat Anna Beispiel auf einem Gerät abgemeldet')).toBeVisible();
    await expect(audit.getByText('Tester hat Anna Beispiel überall abgemeldet')).toHaveCount(0);
  });

  test('downloads: revoke a licence with confirm', async ({ page, api }) => {
    await page.goto(`/admin/users/${ANNA}?tab=downloads`);
    const panel = page.getByRole('tabpanel', { name: 'Downloads' });
    const row = panel.getByRole('row', { name: /Hearth/ });
    await row.getByRole('button', { name: 'Aktionen für Hearth' }).click();
    await page.getByRole('dialog', { name: 'Hearth' }).getByRole('button', { name: 'Widerrufen' }).click();
    const dlg = page.getByRole('alertdialog', { name: 'Download „Hearth“ widerrufen?' });
    await dlg.getByRole('button', { name: 'Abbrechen' }).click();
    expect(logged(api, /DELETE \/api\/admin\/downloads/)).toBe(false);
    await row.getByRole('button', { name: 'Aktionen für Hearth' }).click();
    await page.getByRole('dialog', { name: 'Hearth' }).getByRole('button', { name: 'Widerrufen' }).click();
    await dlg.getByRole('button', { name: 'Widerrufen' }).click();
    await expect(toasts(page).getByText('Download „Hearth“ widerrufen.')).toBeVisible();
    expect(logged(api, new RegExp(`DELETE /api/admin/downloads/${auid(601)} `))).toBe(true);
    await expect(panel.getByText('Keine aktiven Downloads.')).toBeVisible();
  });

  test('audit tab lists the entries as sentences', async ({ page, api }) => {
    api.admin.audit.unshift({ id: 99, at: new Date().toISOString(), action: 'user.limits', target: ANNA, meta: { from: { maxStreams: null }, to: { maxStreams: 3 } }, actor: 'Tester', target_name: 'Anna Beispiel' });
    await page.goto(`/admin/users/${ANNA}?tab=audit`);
    await expect(page.getByRole('tabpanel', { name: 'Audit-Log' }).getByText('Tester hat die Limits von Anna Beispiel geändert')).toBeVisible();
  });

  test('own account: no lock, demotion or sign out everywhere', async ({ page }) => {
    await page.goto('/admin/users/u1');
    await page.getByRole('button', { name: 'Aktionen', exact: true }).click();
    const m = page.getByRole('dialog', { name: 'Tester' });
    await expect(m.getByRole('button', { name: 'Du kannst dich nicht selbst sperren oder herabstufen.' })).toBeDisabled();
    await expect(m.getByRole('button', { name: 'Zugang verlängern' })).toBeVisible();
    for (const n of ['Sperren', 'Rolle ändern', 'Überall abmelden']) await expect(m.getByRole('button', { name: n, exact: true })).toHaveCount(0);
  });

  test('unknown user shows not found; a load error offers retry', async ({ page }) => {
    await page.goto(`/admin/users/${auid(999)}`);
    const nf = page.getByRole('alert').filter({ hasText: 'Diesen Nutzer gibt es nicht (mehr).' });
    await expect(nf).toBeVisible();
    await expect(nf.getByRole('button')).toHaveCount(0);

    let fail = true;
    await page.route(`**/api/admin/users/${ANNA}`, (r) => (fail ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }) : r.fallback()));
    await page.goto(`/admin/users/${ANNA}`);
    const err = page.getByRole('alert').filter({ hasText: 'Das ließ sich nicht laden' });
    await expect(err).toBeVisible();
    fail = false;
    await err.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Anna Beispiel' })).toBeVisible();
  });

  test('tablist has names', async ({ page }) => {
    await page.goto(`/admin/users/${ANNA}`);
    const list = page.getByRole('tablist', { name: 'Bereiche von Anna Beispiel' });
    await expect(list).toBeVisible();
    const names = ['Übersicht', 'Profile', 'Geräte', 'Downloads', 'Verlauf', 'Limits', 'Audit-Log'];
    for (const n of names) await expect(list.getByRole('tab', { name: n, exact: true })).toBeVisible();
    await expect(list.getByRole('tab', { name: 'Übersicht' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Übersicht' })).toBeVisible();
    await list.getByRole('tab', { name: 'Übersicht' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(list.getByRole('tab', { name: 'Profile' })).toBeFocused();
    await expect(list.getByRole('tab', { name: 'Profile' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Profile' })).toBeVisible();
  });
});

/** Block 23 self-service: a scheduled deletion on the detail page, cleanup rows in the list */
test.describe('admin user deletion', () => {
  test.use({ allowedConsole: /status of (404|409)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });
  const WEEKISH = () => new Date(Date.now() + 5 * 86400e3).toISOString();

  test('admin restore and delete-now call the APIs', async ({ page, api }) => {
    const anna = api.admin.users.find((u) => u.id === ANNA)!;
    Object.assign(anna, { disabled: true, locked_reason: 'deletion', deletion_at: WEEKISH() });
    await page.goto(`/admin/users/${ANNA}`);
    const head = page.getByRole('region', { name: 'Anna Beispiel' });
    await expect(head.getByText(/^Löschung am \d/)).toBeVisible();
    // a deletion lock: restore takes the place of unlock, plus delete now; nothing else applies to an account being deleted
    let m = await menu(page);
    await expect(m.getByRole('button')).toHaveText(['Konto wiederherstellen', 'Jetzt löschen']);
    await m.getByRole('button', { name: 'Jetzt löschen' }).click();
    const dlg = page.getByRole('alertdialog');
    await expect(dlg).toContainText('Anna Beispiel jetzt löschen?');
    await expect(dlg).toContainText('Das lässt sich nicht rückgängig machen.');
    await expect(dlg.getByRole('button', { name: 'Abbrechen' })).toBeFocused(); // danger: focus starts on cancel
    await dlg.getByRole('button', { name: 'Jetzt löschen' }).click();
    await expect(toasts(page).getByText('Anna Beispiel wird jetzt gelöscht.')).toBeVisible();
    expect(logged(api, new RegExp(`^POST /api/admin/users/${ANNA}/deletion/now `))).toBe(true);

    m = await menu(page);
    await m.getByRole('button', { name: 'Konto wiederherstellen' }).click();
    await expect(toasts(page).getByText('Anna Beispiel wiederhergestellt.')).toBeVisible();
    expect(logged(api, new RegExp(`^POST /api/admin/users/${ANNA}/deletion/restore `))).toBe(true);
    await expect(head.getByText('Aktiv', { exact: true })).toBeVisible();
    await expect(head.getByText(/^Löschung am/)).toHaveCount(0);
  });

  test('restoring an account whose access ended keeps it locked as expired (F8)', async ({ page, api }) => {
    const anna = api.admin.users.find((u) => u.id === ANNA)!;
    Object.assign(anna, { disabled: true, locked_reason: 'deletion', deletion_at: WEEKISH(), access_until: new Date(Date.now() - 86400e3).toISOString() });
    await page.goto(`/admin/users/${ANNA}`);
    await (await menu(page)).getByRole('button', { name: 'Konto wiederherstellen' }).click();
    await expect(toasts(page).getByText('Anna Beispiel wiederhergestellt – bleibt gesperrt, weil der Zugang abgelaufen ist.')).toBeVisible();
    const head = page.getByRole('region', { name: 'Anna Beispiel' });
    await expect(head.getByText('Gesperrt: Zugang abgelaufen')).toBeVisible();
    const m = await menu(page);
    await expect(m.getByRole('button', { name: 'Zugang verlängern' })).toHaveCount(1);
    await expect(m.getByRole('button', { name: 'Entsperren' })).toHaveCount(0);
  });

  test('a deletion already running answers restore with the reason', async ({ page, api }) => {
    const anna = api.admin.users.find((u) => u.id === ANNA)!;
    Object.assign(anna, { disabled: true, locked_reason: 'deletion', deletion_at: WEEKISH() });
    api.admin.claimed.add(ANNA);
    await page.goto(`/admin/users/${ANNA}`);
    await (await menu(page)).getByRole('button', { name: 'Konto wiederherstellen' }).click();
    await expect(toasts(page).getByText('Die Löschung läuft bereits – sie lässt sich nicht mehr aufhalten.')).toBeVisible();
  });

  test('cleanup row shows the pseudonym and step', async ({ page, api }) => {
    Object.assign(api.admin.users.find((u) => u.id === ANNA)!, { disabled: true, locked_reason: 'deletion', deletion_at: WEEKISH() });
    api.admin.cleanups.push({ id: auid(900), pseudonym: 'deleted-1a2b3c4d', started_at: new Date(Date.now() - 3600e3).toISOString(), step: 3, error: 'media_error' });
    api.admin.cleanups.push({ id: auid(901), pseudonym: 'deleted-99ff00aa', started_at: new Date(Date.now() - 600e3).toISOString(), step: 5, error: null });
    // claimed, users row still there (steps 1-4): still has a detail page
    Object.assign(api.admin.users.find((u) => u.id === auid(3))!, { disabled: true, locked_reason: 'deletion', deletion_at: new Date(Date.now() - 60e3).toISOString(), cleanup: { step: 2, error: 'request_error' } });
    await page.goto('/admin/users');
    const table = page.getByRole('table', { name: 'Nutzer' });
    await expect(table.getByRole('row', { name: /Ben Test/ })).toBeVisible();
    await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Löschung ausstehend' });
    await expect(table.getByRole('row', { name: /Clara Fischer/ })).toHaveCount(0);
    const failing = table.getByRole('row', { name: /deleted-1a2b3c4d/ });
    await expect(failing).toContainText('Bereinigung: Schritt 3 von 6 – Fehler: media_error');
    await expect(table.getByRole('row', { name: /deleted-99ff00aa/ })).toContainText('Bereinigung: Schritt 5 von 6');
    await expect(table.getByRole('row', { name: /deleted-99ff00aa/ })).not.toContainText('Fehler');
    // no detail page behind a gone cleanup row, not selectable, no actions
    await expect(failing.getByRole('link')).toHaveCount(0);
    await expect(failing.getByRole('checkbox')).toBeDisabled();
    await expect(failing.getByRole('button')).toHaveCount(0);
    // a claimed account whose users row exists links to its detail page, but is not selectable and has no actions either
    const claimed = table.getByRole('row', { name: /Ben Test/ });
    await expect(claimed).toContainText('Bereinigung: Schritt 2 von 6 – Fehler: request_error');
    await expect(claimed.getByRole('link', { name: 'Ben Test' })).toHaveAttribute('href', `/admin/users/${auid(3)}`);
    await expect(claimed.getByRole('checkbox')).toBeDisabled();
    await expect(claimed.getByRole('button')).toHaveCount(0);
    // the scheduled account keeps its link and shows the date
    const anna = table.getByRole('row', { name: /Anna Beispiel/ });
    await expect(anna.getByRole('link', { name: 'Anna Beispiel' })).toBeVisible();
    await expect(anna.getByText(/^Löschung am \d/)).toBeVisible();
    await expect(page.locator('main')).not.toContainText('undefined');
  });

  test('a scheduled account in the list offers "Restore account" instead of "Unlock" (no undo)', async ({ page, api }) => {
    const anna = api.admin.users.find((u) => u.id === ANNA)!;
    Object.assign(anna, { disabled: true, locked_reason: 'deletion', deletion_at: WEEKISH() });
    await page.goto('/admin/users');
    await page.getByRole('button', { name: 'Aktionen für Anna Beispiel' }).click();
    const m = page.getByRole('dialog', { name: 'Anna Beispiel' });
    await expect(m.getByRole('button', { name: 'Entsperren' })).toHaveCount(0);
    await m.getByRole('button', { name: 'Konto wiederherstellen' }).click();
    await expect(toasts(page).getByText('Anna Beispiel wiederhergestellt.')).toBeVisible();
    await expect(toasts(page).getByRole('button', { name: 'Rückgängig' })).toHaveCount(0);
    expect(logged(api, new RegExp(`^POST /api/admin/users/${ANNA}/deletion/restore `))).toBe(true);
    expect(logged(api, /^PATCH /)).toBe(false);
    expect(anna).toMatchObject({ disabled: false, deletion_at: null });
  });
});
