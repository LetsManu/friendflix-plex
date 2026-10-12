import { expect, test } from '../fixtures.js';

test.describe('admin shell + overview (desktop)', () => {
  test.use({ allowedConsole: /status of 500/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('grouped sidebar with aria-current, pending badges and per-page titles', async ({ page }) => {
    await page.goto('/admin/users');
    const nav = page.getByRole('navigation', { name: 'Admin-Bereiche' });
    await expect(nav).toBeVisible();
    for (const g of ['Personen', 'Inhalte', 'Betrieb']) await expect(nav.getByRole('heading', { name: g })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Nutzer' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: /Übersicht/ })).not.toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: /Geräte.*4 offen/ })).toBeVisible();
    await expect(nav.getByRole('link', { name: /Vorschauen.*10 fehlgeschlagen/ })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Nutzer' })).toBeVisible();
    await expect(page).toHaveTitle('Nutzer · Admin – FriendFlix');
    await nav.getByRole('link', { name: /Audit-Log/ }).click();
    await expect(page).toHaveURL(/\/admin\/audit$/);
    await expect(page).toHaveTitle('Audit-Log · Admin – FriendFlix');
    await expect(nav.getByRole('link', { name: /Audit-Log/ })).toHaveAttribute('aria-current', 'page');
    // the phone list and the back chevron are phone-only
    await expect(page.getByRole('link', { name: 'Zurück zur Admin-Übersicht' })).toBeHidden();
  });

  test('overview: health strip, humanised activity, counts', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByRole('heading', { level: 1, name: 'Admin' })).toBeVisible();
    const health = page.getByRole('region', { name: 'Systemzustand' });
    await expect(health.getByRole('link', { name: /Medienserver.*Läuft/ })).toBeVisible();
    await expect(health.getByRole('link', { name: /Version.*3 Updates verfügbar/ })).toBeVisible();
    const act = page.getByRole('region', { name: 'Letzte Aktivität' });
    await expect(act.getByText('Tester hat Emma Schneider gesperrt')).toBeVisible();
    await expect(act.getByText('Tester hat Ben Test die Rolle Freund gegeben')).toBeVisible();
    await expect(act).not.toContainText('{');
    await expect(act).not.toContainText('user.');
    await expect(page.getByRole('region', { name: 'Wünsche', exact: true }).getByText('9 Wünsche insgesamt')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Speicher' }).getByRole('progressbar', { name: 'Offline-Downloads' })).toBeVisible();
  });

  test('approve a request inline: optimistic row removal, toast, badge update', async ({ page, api }) => {
    await page.goto('/admin');
    const attn = page.getByRole('region', { name: 'Wartet auf dich' });
    await attn.getByRole('button', { name: '„Dune: Part Two“ freigeben' }).click();
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('„Dune: Part Two“ freigegeben.')).toBeVisible();
    await expect(attn.getByText('Dune: Part Two')).toHaveCount(0);
    expect(api.log.some((l) => l.startsWith('POST /api/admin/requests/101/approve'))).toBe(true);
    await expect(page.getByRole('navigation', { name: 'Admin-Bereiche' }).getByRole('link', { name: /Wünsche.*3 offen/ })).toBeVisible();
  });

  test('decline is delay-committed: Undo restores the row and sends nothing; closing the toast commits', async ({ page, api }) => {
    await page.goto('/admin');
    const attn = page.getByRole('region', { name: 'Wartet auf dich' });
    const toasts = page.getByRole('region', { name: 'Hinweise' });
    await attn.getByRole('button', { name: '„Severance“ ablehnen' }).click();
    await expect(attn.getByText('Severance', { exact: true })).toHaveCount(0);
    await toasts.getByRole('button', { name: 'Rückgängig' }).click();
    await expect(attn.getByText('Severance', { exact: true })).toBeVisible();
    expect(api.log.some((l) => l.includes('/decline'))).toBe(false);

    await attn.getByRole('button', { name: '„Severance“ ablehnen' }).click();
    await toasts.getByRole('button', { name: 'Hinweis schließen' }).click();
    await expect.poll(() => api.log.some((l) => l.startsWith('POST /api/admin/requests/102/decline'))).toBe(true);
    await expect(attn.getByText('Severance', { exact: true })).toHaveCount(0);
  });

  test('a failed action rolls back and shows an error toast', async ({ page }) => {
    await page.route('**/api/admin/devices/approve', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }));
    await page.goto('/admin');
    const attn = page.getByRole('region', { name: 'Wartet auf dich' });
    await attn.getByRole('button', { name: /Gerät „Chrome auf Windows“ von Anna Beispiel freigeben/ }).click();
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('Serverfehler. Bitte später noch einmal versuchen.')).toBeVisible();
    await expect(attn.getByText('Chrome auf Windows')).toBeVisible();
  });

  test('overview shows an error with retry when the summary fails', async ({ page, api }) => {
    api.admin.summaryFails = true;
    await page.goto('/admin');
    const alert = page.getByRole('alert').filter({ hasText: 'Die Übersicht konnte nicht geladen werden.' });
    await expect(alert).toBeVisible();
    api.admin.summaryFails = false;
    await alert.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(alert).toBeHidden();
    await expect(page.getByRole('region', { name: 'Systemzustand' }).getByRole('link', { name: /Medienserver/ })).toBeVisible();
  });
});

test.describe('toast + confirm replace alert()/confirm()', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('confirm dialog: Escape cancels, focus returns, confirm runs the action', async ({ page, api }) => {
    let dialogs = 0;
    page.on('dialog', (d) => { dialogs++; void d.dismiss(); });
    await page.goto('/admin/hubs');
    const del = page.getByRole('button', { name: 'Marvel löschen' });
    await del.click();
    const dlg = page.getByRole('alertdialog', { name: '„Marvel“ wirklich löschen?' });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Abbrechen' })).toBeFocused(); // danger: focus starts on Cancel
    await page.keyboard.press('Tab');
    await expect(dlg.getByRole('button', { name: 'Löschen' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dlg.getByRole('button', { name: 'Abbrechen' })).toBeFocused(); // focus trap
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
    await expect(del).toBeFocused();
    expect(api.log.some((l) => l.startsWith('DELETE'))).toBe(false);

    await del.click();
    await dlg.getByRole('button', { name: 'Löschen' }).click();
    await expect.poll(() => api.log.some((l) => l.startsWith('DELETE /api/admin/hubs/h1'))).toBe(true);
    expect(dialogs).toBe(0); // no native dialogs
  });

  test('users moved to /admin/users; sign-out asks first and the feedback is a toast, not alert()', async ({ page }) => {
    let dialogs = 0;
    page.on('dialog', (d) => { dialogs++; void d.dismiss(); });
    await page.goto('/admin/users');
    await page.getByRole('button', { name: 'Aktionen für Anna Beispiel' }).click();
    await page.getByRole('dialog', { name: 'Anna Beispiel' }).getByRole('button', { name: 'Überall abmelden' }).click();
    await page.getByRole('alertdialog', { name: 'Anna Beispiel überall abmelden?' }).getByRole('button', { name: 'Überall abmelden' }).click();
    const t = page.getByRole('region', { name: 'Hinweise' }).getByRole('listitem').filter({ hasText: '2 Sitzungen beendet' });
    await expect(t).toBeVisible();
    await t.getByRole('button', { name: 'Hinweis schließen' }).click();
    await expect(t).toBeHidden();
    expect(dialogs).toBe(0);
  });
});
