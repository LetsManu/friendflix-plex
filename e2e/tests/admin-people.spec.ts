// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { auid, type AdminState } from '../mocks/admin.js';

const SHOTS = process.env.B18_SHOTS;
const toasts = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Hinweise' });
const logged = (api: { log: string[] }, re: RegExp) => api.log.some((l) => re.test(l));

test.describe('admin people (desktop)', () => {
  test.use({ allowedConsole: /status of (409|500|502)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test.describe('users', () => {
    test('table with pills, relative last seen, own row protected, search, filters', async ({ page }) => {
      await page.goto('/admin/users');
      await expect(page.getByRole('heading', { level: 1, name: 'Nutzer' })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      const table = page.getByRole('table', { name: 'Nutzer' });
      await expect(table.getByRole('row', { name: /Anna Beispiel/ })).toBeVisible();
      const self = table.getByRole('row', { name: /Tester/ });
      await expect(self.getByText('Du', { exact: true })).toBeVisible();
      await expect(self.getByRole('combobox', { name: 'Rolle von Tester' })).toBeDisabled();
      await expect(table.getByRole('row', { name: /Emma Schneider/ }).getByText('Gesperrt')).toBeVisible();
      await expect(table.getByRole('row', { name: /Ben Test/ }).getByText('Aktiv')).toBeVisible();
      await expect(page.locator('main, body').first()).not.toContainText('undefined');

      await page.getByRole('searchbox', { name: 'Tabelle filtern' }).fill('clara');
      await expect(table.getByRole('row', { name: /Clara Fischer/ })).toBeVisible();
      await expect(table.getByRole('row', { name: /Anna Beispiel/ })).toHaveCount(0);
      await page.getByRole('searchbox', { name: 'Tabelle filtern' }).fill('zzzz');
      await expect(page.getByText('Keine Treffer für „zzzz“.')).toBeVisible();
      await page.getByRole('button', { name: 'Filter zurücksetzen' }).click();
      await page.getByRole('combobox', { name: 'Status' }).selectOption('locked');
      await expect(table.getByRole('row', { name: /Emma Schneider/ })).toBeVisible();
      await expect(table.getByRole('row', { name: /Anna Beispiel/ })).toHaveCount(0);
      await page.getByRole('combobox', { name: 'Status' }).selectOption('');
      await page.getByRole('combobox', { name: 'Rolle', exact: true }).selectOption('guest');
      await expect(table.getByRole('row', { name: /Clara Fischer/ })).toBeVisible();
      await expect(table.getByRole('row', { name: /Ben Test/ })).toHaveCount(0);
      await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    });

    test('server paging and sorting', async ({ page, api }) => {
      const st: AdminState = api.admin;
      for (let i = 0; i < 40; i++) st.users.push({ id: auid(100 + i), name: `Zoe ${String(i).padStart(2, '0')}`, email: null, role: 'guest', disabled: false, jellyfin_username: `zoe${i}`, seerr_user_id: null, created_at: new Date().toISOString(), last_seen: null });
      await page.goto('/admin/users');
      await expect(page.getByText('1–25 von 53')).toBeVisible();
      await page.getByRole('button', { name: 'Nächste Seite' }).click();
      await expect(page.getByText('26–50 von 53')).toBeVisible();
      await page.getByRole('button', { name: 'Nächste Seite' }).click();
      await expect(page.getByText('51–53 von 53')).toBeVisible();
      await page.getByRole('button', { name: /^Name/ }).click();
      await expect(page.getByText('1–25 von 53')).toBeVisible();
      await expect(page.getByRole('row', { name: /Anna Beispiel/ })).toBeVisible();
    });

    test('role change is optimistic, undoable and rolls back on error', async ({ page, api }) => {
      await page.goto('/admin/users');
      const sel = page.getByRole('combobox', { name: 'Rolle von Ben Test' });
      await expect(sel).toHaveValue('family');
      await sel.selectOption('guest');
      await expect(toasts(page).getByText('Ben Test ist jetzt Gast.')).toBeVisible();
      await expect.poll(() => logged(api, new RegExp(`PATCH /api/admin/users/${auid(3)} .*"role":"guest"`))).toBe(true);
      await toasts(page).getByRole('button', { name: 'Rückgängig' }).click();
      await expect(sel).toHaveValue('family');
      await expect.poll(() => logged(api, new RegExp(`PATCH /api/admin/users/${auid(3)} .*"role":"family"`))).toBe(true);

      await page.route(`**/api/admin/users/${auid(4)}`, (r) => r.request().method() === 'PATCH' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }) : r.fallback());
      const sel2 = page.getByRole('combobox', { name: 'Rolle von Clara Fischer' });
      await sel2.selectOption('family');
      await expect(toasts(page).getByText('Serverfehler. Bitte später noch einmal versuchen.')).toBeVisible();
      await expect(sel2).toHaveValue('guest');
    });

    test('lock asks first, offers Undo; unlock needs no question; locking an admin needs the name', async ({ page, api }) => {
      await page.goto('/admin/users');
      await page.getByRole('button', { name: 'Aktionen für Ben Test' }).click();
      await page.getByRole('dialog', { name: 'Ben Test' }).getByRole('button', { name: 'Sperren' }).click();
      const dlg = page.getByRole('alertdialog', { name: 'Ben Test sperren?' });
      await expect(dlg).toBeVisible();
      await expect(dlg.getByRole('textbox')).toHaveCount(0);
      await dlg.getByRole('button', { name: 'Abbrechen' }).click();
      expect(logged(api, /PATCH .*"disabled"/)).toBe(false);
      await page.getByRole('button', { name: 'Aktionen für Ben Test' }).click();
      await page.getByRole('dialog', { name: 'Ben Test' }).getByRole('button', { name: 'Sperren' }).click();
      await dlg.getByRole('button', { name: 'Sperren' }).click();
      const row = page.getByRole('row', { name: /Ben Test/ });
      await expect(row.getByText('Gesperrt')).toBeVisible();
      await expect(toasts(page).getByText('Ben Test wurde gesperrt.')).toBeVisible();
      await toasts(page).getByRole('button', { name: 'Rückgängig' }).click();
      await expect(row.getByText('Aktiv')).toBeVisible();
      expect(api.admin.users.find((u) => u.name === 'Ben Test')!.disabled).toBe(false);

      await page.getByRole('button', { name: 'Aktionen für Emma Schneider' }).click();
      await page.getByRole('dialog', { name: 'Emma Schneider' }).getByRole('button', { name: 'Entsperren' }).click();
      await expect(toasts(page).getByText('Emma Schneider wurde entsperrt.')).toBeVisible();
      await expect(page.getByRole('alertdialog')).toHaveCount(0);

      api.admin.users.find((u) => u.name === 'David Müller')!.role = 'admin';
      await page.reload();
      await page.getByRole('button', { name: 'Aktionen für David Müller' }).click();
      await page.getByRole('dialog', { name: 'David Müller' }).getByRole('button', { name: 'Sperren' }).click();
      const typed = page.getByRole('alertdialog', { name: 'David Müller sperren?' });
      await expect(typed.getByRole('button', { name: 'Sperren' })).toBeDisabled();
      await typed.getByRole('textbox').fill('David Müller');
      await expect(typed.getByRole('button', { name: 'Sperren' })).toBeEnabled();
    });

    test('own row offers no destructive actions; load error has a retry', async ({ page }) => {
      let fail = true;
      await page.route('**/api/admin/users?*', (r) => (fail ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }) : r.fallback()));
      await page.goto('/admin/users');
      const alert = page.getByRole('alert').filter({ hasText: 'Das ließ sich nicht laden' });
      await expect(alert).toBeVisible();
      fail = false;
      await alert.getByRole('button', { name: 'Erneut versuchen' }).click();
      await expect(page.getByRole('row', { name: /Anna Beispiel/ })).toBeVisible();
      await page.getByRole('button', { name: 'Aktionen für Tester' }).click();
      await expect(page.getByRole('dialog', { name: 'Tester' }).getByRole('button', { name: 'Du kannst dich nicht selbst sperren oder herabstufen.' })).toBeDisabled();
    });

    test('bulk lock two users asks and calls the bulk API', async ({ page, api }) => {
      await page.goto('/admin/users');
      const table = page.getByRole('table', { name: 'Nutzer' });
      await expect(table.getByRole('checkbox', { name: 'Tester auswählen' })).toBeDisabled();
      await expect(page.getByRole('region', { name: 'Aktionen für die Auswahl' })).toHaveCount(0);
      await table.getByRole('checkbox', { name: 'Ben Test auswählen' }).check();
      await table.getByRole('checkbox', { name: 'Clara Fischer auswählen' }).check();
      const bar = page.getByRole('region', { name: 'Aktionen für die Auswahl' });
      await expect(bar).toContainText('2 ausgewählt');
      await bar.getByRole('button', { name: 'Sperren', exact: true }).click();
      const dlg = page.getByRole('alertdialog', { name: '2 Nutzer sperren?' });
      await expect(dlg).toContainText('Ben Test, Clara Fischer');
      await dlg.getByRole('button', { name: 'Abbrechen' }).click();
      expect(logged(api, /\/api\/admin\/users\/bulk/)).toBe(false);
      await bar.getByRole('button', { name: 'Sperren', exact: true }).click();
      await dlg.getByRole('button', { name: 'Sperren' }).click();
      await expect(toasts(page).getByText('2 Konten geändert.')).toBeVisible();
      const post = api.log.find((l) => l.startsWith('POST /api/admin/users/bulk '))!;
      expect(post).toContain('"action":"lock"');
      expect(post).toContain(auid(3));
      expect(post).toContain(auid(4));
      await expect(table.getByRole('row', { name: /Ben Test/ }).getByText('Gesperrt')).toBeVisible();
      await expect(table.getByRole('row', { name: /Clara Fischer/ }).getByText('Gesperrt')).toBeVisible();
      await expect(bar).toHaveCount(0);
    });

    test('bulk access +30 days sends a date-time; names link to the detail page', async ({ page, api }) => {
      await page.goto('/admin/users');
      const table = page.getByRole('table', { name: 'Nutzer' });
      await expect(table.getByRole('link', { name: 'Ben Test' })).toHaveAttribute('href', `/admin/users/${auid(3)}`);
      await expect(table.getByRole('row', { name: /Ben Test/ })).toContainText('–');
      await table.getByRole('checkbox', { name: 'Ben Test auswählen' }).check();
      const bar = page.getByRole('region', { name: 'Aktionen für die Auswahl' });
      await bar.getByRole('combobox', { name: 'Zugang bis' }).selectOption('p30');
      // picking (also with arrow keys) does not run anything yet; Apply does
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await bar.getByRole('form', { name: 'Zugang bis' }).getByRole('button', { name: 'Übernehmen' }).click();
      const dlg = page.getByRole('alertdialog', { name: /Zugang für 1 Nutzer bis/ });
      await dlg.getByRole('button', { name: 'Übernehmen' }).click();
      await expect.poll(() => logged(api, /POST \/api\/admin\/users\/bulk .*"action":"access","accessUntil":"\d{4}-\d\d-\d\dT[\d:.]+Z"/)).toBe(true);
      const until = api.admin.users.find((u) => u.name === 'Ben Test')!.access_until!;
      expect(Math.round((Date.parse(until) - Date.now()) / 86400e3)).toBe(30);
    });

    test('bulk lock with an admin selected needs the typed name, like the single lock', async ({ page, api }) => {
      api.admin.users.find((u) => u.name === 'David Müller')!.role = 'admin';
      await page.goto('/admin/users');
      const table = page.getByRole('table', { name: 'Nutzer' });
      await table.getByRole('checkbox', { name: 'Ben Test auswählen' }).check();
      await table.getByRole('checkbox', { name: 'David Müller auswählen' }).check();
      const bar = page.getByRole('region', { name: 'Aktionen für die Auswahl' });
      await bar.getByRole('button', { name: 'Sperren', exact: true }).click();
      const dlg = page.getByRole('alertdialog', { name: '2 Nutzer sperren?' });
      await expect(dlg).toContainText('Darunter Admins: David Müller.');
      await expect(dlg.getByRole('button', { name: 'Sperren' })).toBeDisabled();
      await dlg.getByRole('textbox').fill('David Müller');
      await dlg.getByRole('button', { name: 'Sperren' }).click();
      await expect(toasts(page).getByText('2 Konten geändert.')).toBeVisible();
      // a demoting role change asks the same way; promoting does not
      await table.getByRole('checkbox', { name: 'David Müller auswählen' }).check();
      await bar.getByRole('combobox', { name: 'Rolle ändern' }).selectOption('guest');
      await bar.getByRole('form', { name: 'Rolle ändern' }).getByRole('button', { name: 'Übernehmen' }).click();
      await expect(page.getByRole('alertdialog', { name: /1 Nutzer zu „Gast“ machen\?/ }).getByRole('textbox')).toBeVisible();
    });

    test('a failed bulk call reloads the list and keeps the selection', async ({ page }) => {
      await page.goto('/admin/users');
      const table = page.getByRole('table', { name: 'Nutzer' });
      await table.getByRole('checkbox', { name: 'Ben Test auswählen' }).check();
      await page.route('**/api/admin/users/bulk', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }));
      let reloads = 0;
      page.on('request', (r) => { if (r.method() === 'GET' && /\/api\/admin\/users\?/.test(r.url())) reloads++; });
      const bar = page.getByRole('region', { name: 'Aktionen für die Auswahl' });
      await bar.getByRole('button', { name: 'Überall abmelden' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Überall abmelden' }).click();
      await expect(toasts(page).getByText(/Einige Konten wurden eventuell schon geändert/)).toBeVisible();
      await expect.poll(() => reloads).toBeGreaterThan(0);
      await expect(bar).toContainText('1 ausgewählt');
    });

    test('unlocking an account whose access ended explains why (row and bulk); a past end date cannot be applied', async ({ page, api }) => {
      const emma = api.admin.users.find((u) => u.name === 'Emma Schneider')!;
      emma.access_until = new Date(Date.now() - 86400e3).toISOString();
      emma.locked_reason = 'expired';
      await page.goto('/admin/users');
      const table = page.getByRole('table', { name: 'Nutzer' });
      const row = table.getByRole('row', { name: /Emma Schneider/ });
      await page.getByRole('button', { name: 'Aktionen für Emma Schneider' }).click();
      await page.getByRole('dialog', { name: 'Emma Schneider' }).getByRole('button', { name: 'Entsperren' }).click();
      await expect(toasts(page).getByText('Der Zugang ist abgelaufen – verlängere stattdessen den Zugang.')).toBeVisible();
      await expect(row.getByText('Gesperrt')).toBeVisible(); // rolled back
      expect(emma.disabled).toBe(true);

      await table.getByRole('checkbox', { name: 'Emma Schneider auswählen' }).check();
      const bar = page.getByRole('region', { name: 'Aktionen für die Auswahl' });
      await bar.getByRole('button', { name: 'Entsperren', exact: true }).click();
      await page.getByRole('alertdialog', { name: '1 Nutzer entsperren?' }).getByRole('button', { name: 'Entsperren' }).click();
      await expect.poll(() => logged(api, /POST \/api\/admin\/users\/bulk .*"action":"unlock".* -> 409/)).toBe(true);
      await expect(toasts(page).getByText('Der Zugang ist abgelaufen – verlängere stattdessen den Zugang.').last()).toBeVisible();
      await expect(toasts(page).getByText(/Einige Konten wurden eventuell schon geändert/)).toHaveCount(0); // all or nothing
      expect(emma.disabled).toBe(true);

      // the bulk access form refuses a past day (it would lock everyone selected at the next expiry tick)
      const form = bar.getByRole('form', { name: 'Zugang bis' });
      await form.getByRole('combobox', { name: 'Zugang bis' }).selectOption('date');
      const day = form.getByLabel('Zugang bis (Datum)');
      await expect(day).toHaveAttribute('min', /^\d{4}-\d\d-\d\d$/);
      await day.fill('2020-01-01');
      await expect(form.getByRole('button', { name: 'Übernehmen' })).toBeDisabled();
      await day.fill('2099-01-01');
      await expect(form.getByRole('button', { name: 'Übernehmen' })).toBeEnabled();
    });

    test('approvals: a past end date cannot be approved', async ({ page }) => {
      await page.goto('/admin/users?tab=approvals');
      const card = page.getByRole('region', { name: 'Mia Neu' });
      await card.getByRole('combobox', { name: 'Zugang bis' }).selectOption('date');
      const day = card.getByLabel('Zugang bis (Datum)');
      await expect(day).toHaveAttribute('min', /^\d{4}-\d\d-\d\d$/);
      await day.fill('2020-01-01');
      await expect(card.getByRole('button', { name: 'Freigeben' })).toBeDisabled();
      await day.fill('2099-01-01');
      await expect(card.getByRole('button', { name: 'Freigeben' })).toBeEnabled();
    });

    test('last active: inactive for 90+ days lists never-seen and old accounts', async ({ page, api }) => {
      api.admin.users.find((u) => u.name === 'Felix Weber')!.last_seen = null;
      api.admin.users.find((u) => u.name === 'Greta Wagner')!.last_seen = new Date(Date.now() - 120 * 86400e3).toISOString();
      await page.goto('/admin/users');
      await page.getByRole('combobox', { name: 'Zuletzt aktiv' }).selectOption('90+');
      const table = page.getByRole('table', { name: 'Nutzer' });
      await expect(table.getByRole('row', { name: /Felix Weber/ })).toBeVisible();
      await expect(table.getByRole('row', { name: /Greta Wagner/ })).toBeVisible();
      await expect(table.getByRole('row', { name: /Anna Beispiel/ })).toHaveCount(0);
    });

    test('approval tab approves with role', async ({ page, api }) => {
      await page.goto('/admin/users');
      const tabs = page.getByRole('tablist', { name: 'Nutzerverwaltung' });
      await tabs.getByRole('tab', { name: 'Warten auf Freigabe (2)' }).click();
      await expect(page).toHaveURL(/\?tab=approvals$/);
      const card = page.getByRole('region', { name: 'Mia Neu' });
      await expect(card).toContainText('mia@example.org');
      await card.getByRole('combobox', { name: 'Rolle' }).selectOption('family');
      await card.getByRole('button', { name: 'Freigeben' }).click();
      await expect(toasts(page).getByText('Mia Neu freigegeben.')).toBeVisible();
      await expect(card).toHaveCount(0);
      await expect(tabs.getByRole('tab', { name: 'Warten auf Freigabe (1)' })).toBeVisible();
      const post = api.log.find((l) => l.startsWith(`POST /api/admin/approvals/${auid(401)}/approve `))!;
      expect(post).toContain('"role":"family"');
      expect(post).not.toContain('accessUntil');
      // reject with a message
      const paul = page.getByRole('region', { name: 'Paul Fremd' });
      await paul.getByRole('button', { name: 'Ablehnen' }).click();
      await paul.getByRole('textbox', { name: 'Nachricht (optional)' }).fill('Kenne ich nicht');
      await paul.getByRole('button', { name: 'Paul Fremd ablehnen' }).click();
      await expect(toasts(page).getByText('Paul Fremd abgelehnt.')).toBeVisible();
      await expect.poll(() => logged(api, new RegExp(`POST /api/admin/approvals/${auid(402)}/reject .*"message":"Kenne ich nicht"`))).toBe(true);
      await expect(page.getByText('Niemand wartet auf Freigabe.')).toBeVisible();
    });

    test('approvals: the old ?tab=pending link opens the tab; an already handled request drops its card', async ({ page, api }) => {
      await page.goto('/admin/users?tab=pending');
      await expect(page.getByRole('tab', { name: 'Warten auf Freigabe (2)' })).toHaveAttribute('aria-selected', 'true');
      const card = page.getByRole('region', { name: 'Mia Neu' });
      await expect(card).toBeVisible();
      // someone else approved Mia meanwhile: the server answers 409 and no longer lists her
      api.admin.approvals = api.admin.approvals.filter((a) => a.name !== 'Mia Neu');
      await page.route('**/api/admin/approvals/*/approve', (r) => r.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"user_exists"}' }));
      await card.getByRole('button', { name: 'Freigeben' }).click();
      await expect(toasts(page).getByText('Mia Neu wurde schon bearbeitet.')).toBeVisible();
      await expect(card).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Paul Fremd' })).toBeVisible();
    });

    test('invites tab creates a 3-use invite and shows 0/3', async ({ page, api }) => {
      await page.goto('/admin/users?tab=invites');
      await expect(page.getByRole('tab', { name: 'Einladungen' })).toHaveAttribute('aria-selected', 'true');
      const form = page.getByRole('region', { name: 'Neue Einladung' });
      await form.getByRole('spinbutton', { name: 'Max. Nutzungen' }).fill('3');
      await form.getByRole('spinbutton', { name: 'Zugang (Tage)' }).fill('90');
      await form.getByRole('textbox', { name: 'Notiz' }).fill('Lesekreis');
      await form.getByRole('button', { name: 'Einladung erstellen' }).click();
      await expect(page.getByRole('region', { name: 'Dein Einladungs-Link' })).toBeVisible();
      const post = api.log.find((l) => l.startsWith('POST /api/admin/invites '))!;
      expect(post).toContain('"maxUses":3');
      expect(post).toContain('"accessDays":90');
      const table = page.getByRole('table', { name: 'Einladungen' });
      const row = table.getByRole('row', { name: /Lesekreis/ });
      await expect(row).toContainText('0/3');
      await expect(row).toContainText('90 Tage');
      await expect(row.getByText('Offen')).toBeVisible();
      // a partly used invite stays open; its accounts unfold
      const multi = table.getByRole('row', { name: /Spieleabend/ });
      await expect(multi.getByText('Offen')).toBeVisible();
      await multi.getByText('2/5').click();
      await expect(multi.getByRole('link', { name: 'Tom Kraus' })).toHaveAttribute('href', `/admin/users/${auid(52)}`);
    });

    test('old /admin/invites redirects', async ({ page }) => {
      await page.goto('/admin/invites');
      await expect(page).toHaveURL(/\/admin\/users\?tab=invites$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Nutzer' })).toBeVisible();
      await expect(page.getByRole('table', { name: 'Einladungen' }).getByRole('row', { name: /Für Annas Bruder/ })).toBeVisible();
    });
  });

  test.describe('roles', () => {
    test('one card per role; only changed fields are saved; validation; discard', async ({ page, api }) => {
      await page.goto('/admin/roles');
      await expect(page.getByRole('heading', { level: 1, name: 'Rollen' })).toBeVisible();
      const card = page.getByRole('form', { name: 'Freund' });
      await expect(card).toBeVisible();
      await expect(card.getByText('Nicht gespeichert')).toHaveCount(0);
      const save = card.getByRole('button', { name: 'Speichern' });
      await expect(save).toBeDisabled();
      const perMonth = card.getByRole('spinbutton', { name: 'Wünsche pro Monat' });
      await perMonth.fill('7');
      await expect(card.getByText('Nicht gespeichert')).toBeVisible();
      await perMonth.fill('150');
      await expect(card.getByText('Bitte eine Zahl von 0 bis 100 eingeben.')).toBeVisible();
      await save.click();
      expect(logged(api, /PUT \/api\/admin\/roles\/friend/)).toBe(false);
      await card.getByRole('button', { name: 'Zurücksetzen' }).click();
      await expect(perMonth).toHaveValue('3');
      await perMonth.fill('7');
      await card.getByRole('switch', { name: 'Umwandeln erlaubt' }).click();
      await save.click();
      await expect(toasts(page).getByText('Rolle „Freund“ gespeichert.')).toBeVisible();
      const put = api.log.find((l) => l.startsWith('PUT /api/admin/roles/friend'))!;
      expect(put).toContain('"requestsPerMonth":7');
      expect(put).toContain('"transcoding":false');
      expect(put).not.toContain('maxHeight');
      expect(put).not.toContain('download');
      await expect(card.getByText('Nicht gespeichert')).toHaveCount(0);
    });

    test('remote bitrate limit: default option, values up to the role limit, reset to default, saves only that field', async ({ page, api }) => {
      await page.goto('/admin/roles');
      const card = page.getByRole('form', { name: 'Freund' });
      const cap = card.getByRole('combobox', { name: 'Limit unterwegs' });
      await expect(cap).toHaveValue(''); // role default (no override)
      await expect(cap.getByRole('option', { name: 'Standard (8 Mbit/s)' })).toHaveCount(1);
      await expect(cap.getByRole('option', { name: '40 Mbit/s' })).toHaveCount(1);
      const fam = page.getByRole('form', { name: 'Familie' }).getByRole('combobox', { name: 'Limit unterwegs' });
      await expect(fam).toHaveValue('12000000');
      // the guest role tops out at 8 Mbit/s: higher caps would have no effect and are not offered
      const guest = page.getByRole('form', { name: 'Gast' }).getByRole('combobox', { name: 'Limit unterwegs' });
      await expect(guest.getByRole('option', { name: '8 Mbit/s' })).toHaveCount(1);
      await expect(guest.getByRole('option', { name: '12 Mbit/s' })).toHaveCount(0);
      await cap.selectOption('12000000');
      await card.getByRole('button', { name: 'Speichern' }).click();
      await expect(toasts(page).getByText('Rolle „Freund“ gespeichert.')).toBeVisible();
      const put = api.log.find((l) => l.startsWith('PUT /api/admin/roles/friend'))!;
      expect(put).toContain('"remoteMaxBitrate":12000000');
      expect(put).not.toContain('requestsPerMonth');
      // back to the default sends null
      await cap.selectOption('');
      await card.getByRole('button', { name: 'Speichern' }).click();
      await expect.poll(() => api.log.filter((l) => l.startsWith('PUT /api/admin/roles/friend')).length).toBe(2);
      expect(api.log.filter((l) => l.startsWith('PUT /api/admin/roles/friend'))[1]).toContain('"remoteMaxBitrate":null');
    });

    test('download fields appear with the switch; save failure keeps the edit', async ({ page }) => {
      await page.route('**/api/admin/roles/guest', (r) => r.request().method() === 'PUT' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }) : r.fallback());
      const sent: string[] = [];
      page.on('request', (r) => { if (r.method() === 'PUT' && r.url().endsWith('/api/admin/roles/guest')) sent.push(r.postData() ?? ''); });
      await page.goto('/admin/roles');
      const card = page.getByRole('form', { name: 'Gast' });
      await expect(card.getByRole('spinbutton', { name: 'Gleichzeitige Downloads' })).toHaveCount(0);
      await card.getByRole('switch', { name: 'Downloads erlauben' }).click();
      await expect(card.getByRole('spinbutton', { name: 'Gleichzeitige Downloads' })).toBeVisible();
      await card.getByRole('spinbutton', { name: 'Gültigkeit (Tage)' }).fill('120');
      await expect(card.getByText('Bitte 1 bis 90 Tage eingeben.')).toBeVisible();
      await card.getByRole('spinbutton', { name: 'Gültigkeit (Tage)' }).fill('14');
      await card.getByRole('button', { name: 'Speichern' }).click();
      await expect(toasts(page).getByText('Serverfehler. Bitte später noch einmal versuchen.')).toBeVisible();
      await expect(card.getByText('Nicht gespeichert')).toBeVisible();
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0]!)).toMatchObject({ download: true, downloadDays: 14 });
    });

    test('leaving with unsaved changes asks first', async ({ page }) => {
      await page.goto('/admin/roles');
      const card = page.getByRole('form', { name: 'Familie' });
      await card.getByRole('spinbutton', { name: 'Wünsche pro Monat' }).fill('9');
      const nav = page.getByRole('navigation', { name: 'Admin-Bereiche' });
      await nav.getByRole('link', { name: 'Nutzer' }).click();
      const dlg = page.getByRole('alertdialog', { name: 'Änderungen verwerfen?' });
      await expect(dlg).toBeVisible();
      await expect(dlg).toContainText('1 Rolle hat ungespeicherte Änderungen');
      await dlg.getByRole('button', { name: 'Abbrechen' }).click();
      await expect(page).toHaveURL(/\/admin\/roles$/);
      await nav.getByRole('link', { name: 'Nutzer' }).click();
      await dlg.getByRole('button', { name: 'Verwerfen' }).click();
      await expect(page).toHaveURL(/\/admin\/users$/);
    });

    test('no changes: leaving needs no question', async ({ page }) => {
      await page.goto('/admin/roles');
      await expect(page.getByRole('form', { name: 'Freund' })).toBeVisible();
      await page.getByRole('navigation', { name: 'Admin-Bereiche' }).getByRole('link', { name: 'Nutzer' }).click();
      await expect(page).toHaveURL(/\/admin\/users$/);
    });
  });

  test.describe('devices', () => {
    test('waiting devices first with a count; approve has Undo and updates the badge', async ({ page, api }) => {
      await page.goto('/admin/devices');
      await expect(page.getByRole('heading', { level: 1, name: 'Geräte' })).toBeVisible();
      await expect(page.getByText('4 Geräte warten auf Freigabe.')).toBeVisible();
      const nav = page.getByRole('navigation', { name: 'Admin-Bereiche' });
      await expect(nav.getByRole('link', { name: /Geräte.*4 offen/ })).toBeVisible();
      const first = page.getByRole('table', { name: 'Geräte' }).getByRole('row').nth(1);
      await expect(first).toContainText('Wartet auf Freigabe');
      await page.getByRole('button', { name: '„Chrome auf Windows“ von Anna Beispiel freigeben' }).click();
      await expect(toasts(page).getByText('„Chrome auf Windows“ von Anna Beispiel freigegeben.')).toBeVisible();
      await expect(page.getByText('3 Geräte warten auf Freigabe.')).toBeVisible();
      await expect(nav.getByRole('link', { name: /Geräte.*3 offen/ })).toBeVisible();
      await toasts(page).getByRole('button', { name: 'Rückgängig' }).click();
      await expect(page.getByText('4 Geräte warten auf Freigabe.')).toBeVisible();
      await expect.poll(() => logged(api, /POST \/api\/admin\/devices\/unapprove/)).toBe(true);
      expect(api.admin.devices[0]!.approved).toBe(false);
    });

    test('decline is postponed until the toast is gone and can be undone', async ({ page, api }) => {
      await page.goto('/admin/devices');
      await page.getByRole('button', { name: '„Safari auf iPhone“ von Ben Test ablehnen' }).click();
      await expect(page.getByText('3 Geräte warten auf Freigabe.')).toBeVisible();
      await toasts(page).getByRole('button', { name: 'Rückgängig' }).click();
      await expect(page.getByText('4 Geräte warten auf Freigabe.')).toBeVisible();
      expect(logged(api, /devices\/remove/)).toBe(false);
      await page.getByRole('button', { name: '„Safari auf iPhone“ von Ben Test ablehnen' }).click();
      await toasts(page).getByRole('button', { name: 'Hinweis schließen' }).click();
      await expect.poll(() => logged(api, /POST \/api\/admin\/devices\/remove/)).toBe(true);
      await expect(page.getByText('3 Geräte warten auf Freigabe.')).toBeVisible();
    });

    test('revoking an approved device asks first; filter and search', async ({ page, api }) => {
      await page.goto('/admin/devices');
      await page.getByRole('combobox', { name: 'Status' }).selectOption('approved');
      const rows = page.getByRole('table', { name: 'Geräte' }).getByRole('row');
      await expect(rows.filter({ hasText: 'Wartet auf Freigabe' })).toHaveCount(0);
      const target = rows.filter({ hasText: 'Emma Schneider' });
      await target.getByRole('button', { name: /Aktionen für/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Zugriff entziehen' }).click();
      const dlg = page.getByRole('alertdialog', { name: /Zugriff für „.*“ entziehen\?/ });
      await expect(dlg).toBeVisible();
      await dlg.getByRole('button', { name: 'Zugriff entziehen' }).click();
      await expect(toasts(page).getByText(/Zugriff für „.*“ von Emma Schneider entzogen\./)).toBeVisible();
      await expect.poll(() => logged(api, /POST \/api\/admin\/devices\/remove/)).toBe(true);
      await expect(target).toHaveCount(0);
    });

    test('the device the admin is using is marked and cannot be revoked here', async ({ page, api }) => {
      api.admin.devices.push({ user_id: 'u1', device_id: 'dev-own-0123456789ab', label: 'Chrome auf Linux', approved: true, last_seen: new Date().toISOString(), name: 'Tester', current: true });
      await page.goto('/admin/devices');
      const own = page.getByRole('table', { name: 'Geräte' }).getByRole('row').filter({ hasText: 'Tester' });
      await expect(own.getByText('Dieses Gerät')).toBeVisible();
      await expect(own.getByRole('button', { name: /Aktionen für/ })).toHaveCount(0);
      // other approved devices keep their menu
      await expect(page.getByRole('table', { name: 'Geräte' }).getByRole('row').filter({ hasText: 'Emma Schneider' }).getByRole('button', { name: /Aktionen für/ })).toHaveCount(1);
    });

    test('empty state', async ({ page, api }) => {
      api.admin.devices = [];
      await page.goto('/admin/devices');
      await expect(page.getByText('Noch keine Geräte registriert.')).toBeVisible();
    });
  });

  test.describe('invites', () => {
    test('create → one-time link with Copy and QR; list with status pills', async ({ page, api, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.goto('/admin/users?tab=invites');
      const table = page.getByRole('table', { name: 'Einladungen' });
      await expect(table.getByRole('row', { name: /Für Annas Bruder/ }).getByText('Offen')).toBeVisible();
      await expect(table.getByRole('row', { name: /Oma/ }).getByText('Eingelöst', { exact: true })).toBeVisible();
      await expect(table.getByRole('row', { name: /Oma/ })).toContainText('Eingelöst von Oma Inge');
      await expect(table.getByText('Abgelaufen')).toBeVisible();
      const form = page.getByRole('region', { name: 'Neue Einladung' });
      await form.getByRole('combobox', { name: 'Rolle' }).selectOption('family');
      await form.getByRole('combobox', { name: 'Gültig für' }).selectOption('d7');
      await form.getByRole('textbox', { name: 'Notiz' }).fill('Tante Gerda');
      await form.getByRole('button', { name: 'Einladung erstellen' }).click();
      const res = page.getByRole('region', { name: 'Dein Einladungs-Link' });
      await expect(res.getByRole('textbox', { name: 'Einladungs-Link' })).toHaveValue(/https:\/\/portal\.example\.com\/invite\//);
      await expect(res.getByText('Der Link führt durch die Konto-Erstellung')).toBeVisible();
      const post = api.log.find((l) => l.startsWith('POST /api/admin/invites '))!;
      expect(post).toContain('"role":"family"');
      expect(post).toContain('"ttlHours":168');
      expect(post).toContain('"note":"Tante Gerda"');
      expect(post).toContain('"enroll":true');
      await res.getByRole('button', { name: 'Kopieren' }).click();
      await expect(toasts(page).getByText('In die Zwischenablage kopiert.')).toBeVisible();
      await res.getByRole('button', { name: 'QR-Code zeigen' }).click();
      await expect(res.getByRole('img', { name: 'QR-Code' })).toBeVisible();
      await expect(table.getByRole('row', { name: /Tante Gerda/ }).getByText('Offen')).toBeVisible();
      await res.getByRole('button', { name: 'Link ausblenden' }).click();
      await expect(res).toHaveCount(0);
    });

    test('"already has an account" skips enrollment; revoke asks first and is irreversible', async ({ page, api }) => {
      await page.goto('/admin/users?tab=invites');
      const form = page.getByRole('region', { name: 'Neue Einladung' });
      await form.getByRole('switch', { name: 'Hat schon ein Authentik-Konto' }).click();
      await form.getByRole('button', { name: 'Einladung erstellen' }).click();
      await expect.poll(() => api.log.some((l) => l.startsWith('POST /api/admin/invites ') && l.includes('"enroll":false'))).toBe(true);

      const row = page.getByRole('row', { name: /Für Annas Bruder/ });
      await row.getByRole('button', { name: /Aktionen für/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Widerrufen' }).click();
      const dlg = page.getByRole('alertdialog', { name: 'Einladung widerrufen?' });
      await expect(dlg).toContainText('Das lässt sich nicht rückgängig machen.');
      await dlg.getByRole('button', { name: 'Abbrechen' }).click();
      expect(logged(api, /DELETE \/api\/admin\/invites/)).toBe(false);
      await row.getByRole('button', { name: /Aktionen für/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Widerrufen' }).click();
      await dlg.getByRole('button', { name: 'Widerrufen' }).click();
      await expect(toasts(page).getByText('Einladung widerrufen.')).toBeVisible();
      await expect(row).toHaveCount(0);
      await expect.poll(() => logged(api, /DELETE \/api\/admin\/invites\/00000000-0000-4000-a000-000000000201/)).toBe(true);
    });

    test('expired entries are removed with Undo (no question); status filter; empty state', async ({ page, api }) => {
      await page.goto('/admin/users?tab=invites');
      await page.getByRole('combobox', { name: 'Status' }).selectOption('expired');
      const table = page.getByRole('table', { name: 'Einladungen' });
      await expect(table.getByRole('row')).toHaveCount(2);
      await table.getByRole('button', { name: /Aktionen für/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Entfernen' }).click();
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await toasts(page).getByRole('button', { name: 'Rückgängig' }).click();
      await expect(table.getByText('Abgelaufen')).toBeVisible();
      expect(logged(api, /DELETE/)).toBe(false);
      api.admin.invites = [];
      await page.getByRole('combobox', { name: 'Status' }).selectOption('');
      await expect(page.getByText('Noch keine Einladungen.')).toBeVisible();
    });
  });

  test.describe('audit', () => {
    test('humanised entries, details as key/value without raw JSON or ids', async ({ page }) => {
      await page.goto('/admin/audit');
      await expect(page.getByRole('heading', { level: 1, name: 'Audit-Log' })).toBeVisible();
      const table = page.getByRole('table', { name: 'Audit-Log' });
      const role = table.getByRole('row').filter({ hasText: 'Tester hat Ben Test die Rolle Freund gegeben' });
      await expect(role).toBeVisible();
      await role.getByText('Details', { exact: true }).click();
      await expect(role.getByRole('term').filter({ hasText: 'Vorher' })).toBeVisible();
      await expect(role.getByText('Gast', { exact: true })).toBeVisible();
      await expect(role.getByText('Freund', { exact: true })).toBeVisible();
      const body = await table.innerText();
      expect(body).not.toMatch(/[{}]|user\.role|00000000-0000/);
      await expect(table.getByText('Konto für Leon Richter angelegt')).toBeVisible();
      const dis = table.getByRole('row').filter({ hasText: 'Tester hat Emma Schneider gesperrt' });
      await dis.getByText('Details', { exact: true }).click();
      await expect(dis.getByRole('definition').filter({ hasText: 'Emma Schneider' })).toBeVisible();
    });

    test('filters go to the server: who, area, date range, search; reset', async ({ page }) => {
      await page.goto('/admin/audit');
      const table = page.getByRole('table', { name: 'Audit-Log' });
      await expect(table.getByRole('row')).toHaveCount(10);
      await page.getByRole('combobox', { name: 'Bereich' }).selectOption('user');
      await expect(table.getByRole('row')).toHaveCount(4);
      await page.getByRole('combobox', { name: 'Wer' }).selectOption('system');
      await expect(table.getByRole('row')).toHaveCount(2);
      await expect(table.getByText('Konto für Leon Richter angelegt')).toBeVisible();
      await page.getByRole('button', { name: 'Filter zurücksetzen' }).click();
      await expect(table.getByRole('row')).toHaveCount(10);
      await page.getByRole('searchbox', { name: 'Tabelle filtern' }).fill('Felix');
      await expect(table.getByRole('row')).toHaveCount(2);
      await page.getByRole('button', { name: 'Filter zurücksetzen' }).first().click();
      const today = new Date();
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      await page.getByLabel('Von').fill(iso(new Date(today.getTime() + 86400_000)));
      await expect(page.getByText('Keine Einträge mit diesen Filtern.')).toBeVisible();
      await page.getByRole('button', { name: 'Filter zurücksetzen' }).click();
      await expect(table.getByRole('row')).toHaveCount(10);
    });

    test('paging, sort by time, error with retry', async ({ page, api }) => {
      for (let i = 0; i < 40; i++) api.admin.audit.push({ id: i + 1, at: new Date(Date.now() - (100 + i) * 3600e3).toISOString(), action: 'user.enable', target: null, meta: {}, actor: 'Tester', target_name: `Person ${i}` });
      await page.goto('/admin/audit');
      await expect(page.getByText('1–25 von 49')).toBeVisible();
      await page.getByRole('button', { name: 'Nächste Seite' }).click();
      await expect(page.getByText('26–49 von 49')).toBeVisible();
      let fail = true;
      await page.route('**/api/admin/audit?*', (r) => (fail ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }) : r.fallback()));
      await page.getByRole('button', { name: 'Vorherige Seite' }).click();
      const alert = page.getByRole('alert').filter({ hasText: 'Das ließ sich nicht laden' });
      await expect(alert).toBeVisible();
      fail = false;
      await alert.getByRole('button', { name: 'Erneut versuchen' }).click();
      await expect(page.getByText('1–25 von 49')).toBeVisible();
    });
  });

  test.describe('every page', () => {
    for (const [path, h1] of [['users', 'Nutzer'], ['roles', 'Rollen'], ['devices', 'Geräte'], ['audit', 'Audit-Log']] as const) {
      test(`${path}: one h1 from the shell, no horizontal overflow, keyboard reachable`, async ({ page }) => {
        await page.goto(`/admin/${path}`);
        await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        await expect(page).toHaveTitle(`${h1} · Admin – FriendFlix for Plex`); // fork: brand
        await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
        await page.keyboard.press('Tab');
        const focusable = await page.evaluate(() => document.activeElement !== document.body);
        expect(focusable).toBe(true);
      });
    }
  });

  test.describe('screenshots', () => {
    test.skip(!SHOTS, 'B18_SHOTS not set');
    for (const path of ['users', 'roles', 'devices', 'users?tab=invites', 'audit']) {
      test(`shot ${path}`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(`/admin/${path}`);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${SHOTS}/${path.replace('?tab=', '-')}-desktop.png`, fullPage: true });
      });
    }
  });
});
