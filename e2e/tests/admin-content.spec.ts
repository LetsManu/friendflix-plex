// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import type { AdminRequest } from '../mocks/admin.js';

const toasts = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Hinweise' });

test.describe('admin content pages (desktop)', () => {
  test.use({ allowedConsole: /status of (404|409|500|502)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test.describe('requests', () => {
    test('status keys instead of German literals; approve is optimistic with a toast and a badge update', async ({ page, api }) => {
      await page.goto('/admin/requests');
      await expect(page.getByRole('heading', { level: 1, name: 'Wünsche' })).toBeVisible();
      const table = page.getByRole('table', { name: 'Wünsche' });
      await expect(table.getByRole('row', { name: /Dunmoor: Part Two/ })).toBeVisible();
      await expect(table).not.toContainText('angefragt');
      await expect(table.getByRole('row', { name: /Dunmoor: Part Two/ })).toContainText('Offen');
      await table.getByRole('button', { name: '„Dunmoor: Part Two“ freigeben' }).click();
      await expect(toasts(page).getByText('„Dunmoor: Part Two“ freigegeben.')).toBeVisible();
      await expect(table.getByRole('row', { name: /Dunmoor: Part Two/ })).toHaveCount(0);
      expect(api.log.some((l) => l.startsWith('POST /api/admin/requests/101/approve'))).toBe(true);
      await expect(page.getByRole('navigation', { name: 'Admin-Bereiche' }).getByRole('link', { name: /Wünsche.*3 offen/ })).toBeVisible();
    });

    test('decline waits for the toast: Undo restores the row and sends nothing, closing commits', async ({ page, api }) => {
      await page.goto('/admin/requests');
      const table = page.getByRole('table', { name: 'Wünsche' });
      await table.getByRole('button', { name: '„Sundial“ ablehnen' }).click();
      await expect(table.getByRole('row', { name: /Sundial/ })).toHaveCount(0);
      await toasts(page).getByRole('button', { name: 'Rückgängig' }).click();
      await expect(table.getByRole('row', { name: /Sundial/ })).toBeVisible();
      expect(api.log.some((l) => l.includes('/decline'))).toBe(false);
      await table.getByRole('button', { name: '„Sundial“ ablehnen' }).click();
      await toasts(page).getByRole('button', { name: 'Hinweis schließen' }).click();
      await expect.poll(() => api.log.some((l) => l.startsWith('POST /api/admin/requests/102/decline'))).toBe(true);
    });

    test('a waiting decline is committed at once when the page is left (other admin page, reload)', async ({ page, api }) => {
      await page.goto('/admin/requests');
      const table = page.getByRole('table', { name: 'Wünsche' });
      await table.getByRole('button', { name: '„Sundial“ ablehnen' }).click();
      await expect(toasts(page).getByRole('button', { name: 'Rückgängig' })).toBeVisible();
      await page.getByRole('navigation', { name: 'Admin-Bereiche' }).getByRole('link', { name: /Abstimmungen/ }).click();
      // well inside the 6 s undo window: the navigation flushed it
      await expect.poll(() => api.log.some((l) => l.startsWith('POST /api/admin/requests/102/decline')), { timeout: 2500 }).toBe(true);
      await expect(toasts(page).getByRole('button', { name: 'Rückgängig' })).toHaveCount(0);

      await page.goto('/admin/requests');
      await table.getByRole('button', { name: '„Paper Lanterns“ ablehnen' }).click();
      await expect(table.getByRole('row', { name: /Paper Lanterns/ })).toHaveCount(0);
      await page.reload();
      await expect.poll(() => api.log.some((l) => l.startsWith('POST /api/admin/requests/103/decline')), { timeout: 2500 }).toBe(true);
      await expect(table.getByRole('row', { name: /Dunmoor: Part Two/ })).toBeVisible();
      await expect(table.getByRole('row', { name: /Paper Lanterns/ })).toHaveCount(0);
    });

    test('server paging and the status filter (deep-linkable)', async ({ page, api }) => {
      for (let i = 0; i < 30; i++) api.admin.requests.push({ id: 200 + i, title: `Zusatz ${String(i).padStart(2, '0')}`, mediaType: 'movie', requestedBy: 'Ben Test', status: 'angefragt', createdAt: new Date().toISOString() } as AdminRequest);
      await page.goto('/admin/requests');
      const table = page.getByRole('table', { name: 'Wünsche' });
      await expect(table.getByRole('row')).toHaveCount(26); // header + 25
      await expect(page.getByText('1–25 von 34')).toBeVisible();
      await page.getByRole('button', { name: 'Nächste Seite' }).click();
      await expect(page.getByText('26–34 von 34')).toBeVisible();
      await expect(table.getByRole('row')).toHaveCount(10);
      await page.getByRole('combobox', { name: 'Status' }).selectOption('available');
      await expect(page).toHaveURL(/\?status=available$/);
      await expect(table.getByRole('row', { name: /Quiet Mornings/ })).toContainText('Verfügbar');
      await expect(table.getByRole('row')).toHaveCount(2);
      await page.reload();
      await expect(page.getByRole('combobox', { name: 'Status' })).toHaveValue('available');
    });

    test('empty state and an unreachable request service with retry', async ({ page, api }) => {
      api.admin.requests = [];
      await page.goto('/admin/requests');
      await expect(page.getByText('Nichts offen – alle Wünsche sind bearbeitet.')).toBeVisible();
      api.admin.seerrUp = false;
      await page.getByRole('combobox', { name: 'Status' }).selectOption('all');
      const alert = page.getByRole('alert').filter({ hasText: 'Der Wunsch-Dienst ist gerade nicht erreichbar.' });
      await expect(alert).toBeVisible();
      api.admin.seerrUp = true;
      await alert.getByRole('button', { name: 'Erneut versuchen' }).click();
      await expect(alert).toBeHidden();
      await expect(page.getByText('Noch keine Wünsche.')).toBeVisible();
    });
  });

  test.describe('polls', () => {
    test('result bars, winner and approve', async ({ page, api }) => {
      await page.goto('/admin/polls');
      const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Filmabend Freitag' }) });
      await expect(card).toContainText('von Anna Beispiel');
      await expect(card.getByRole('progressbar', { name: '5 Stimmen' })).toBeVisible();
      await expect(card.getByRole('progressbar', { name: '2 Stimmen' })).toBeVisible();
      await expect(card.getByText('Gewinner')).toBeVisible();
      await expect(card.getByText('Nicht in der Bibliothek')).toBeVisible();
      await card.getByRole('button', { name: 'Freigeben' }).click();
      await expect(toasts(page).getByText('„Dunmoor: Part Two“ freigegeben – der Wunsch ist angelegt.')).toBeVisible();
      await expect(page.getByText('Nichts offen.')).toBeVisible();
      expect(api.log.some((l) => l.startsWith('POST /api/admin/polls/p1/approve'))).toBe(true);
    });

    test('reject is delay-committed with Undo; a failing approve rolls back with a readable error', async ({ page, api }) => {
      await page.goto('/admin/polls');
      const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Filmabend Freitag' }) });
      await card.getByRole('button', { name: 'Ablehnen' }).click();
      await expect(card).toHaveCount(0);
      await toasts(page).getByRole('button', { name: 'Rückgängig' }).click();
      await expect(card).toBeVisible();
      expect(api.log.some((l) => l.includes('/reject'))).toBe(false);

      await page.route('**/api/admin/polls/p1/approve', (r) => r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"seerr_failed"}' }));
      await card.getByRole('button', { name: 'Freigeben' }).click();
      await expect(toasts(page).getByText('Der Wunsch-Dienst ist nicht erreichbar. Bitte später noch einmal versuchen.')).toBeVisible();
      await expect(card).toBeVisible();
    });
  });

  test.describe('lists', () => {
    test('toggle is optimistic with Undo; a 409 rolls back with the limit text', async ({ page, api }) => {
      await page.goto('/admin/lists');
      await expect(page.getByRole('progressbar', { name: 'Auf der Startseite: 1 von 5' })).toBeVisible();
      const sw = page.getByRole('switch', { name: '„Annas Klassiker“ auf der Startseite zeigen' });
      await expect(sw).toHaveAttribute('aria-checked', 'false');
      await sw.click();
      await expect(sw).toHaveAttribute('aria-checked', 'true');
      await expect(toasts(page).getByText('„Annas Klassiker“ wird jetzt auf der Startseite gezeigt.')).toBeVisible();
      await expect(page.getByRole('progressbar', { name: 'Auf der Startseite: 2 von 5' })).toBeVisible();
      await toasts(page).getByRole('button', { name: 'Rückgängig' }).click();
      await expect(sw).toHaveAttribute('aria-checked', 'false');
      expect(api.admin.lists.find((l) => l.name === 'Annas Klassiker')!.featured).toBe(false);

      await page.route('**/api/admin/lists/*/featured', (r) => r.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"too_many_featured"}' }));
      await sw.click();
      await expect(toasts(page).getByText('Es können höchstens 5 Listen auf der Startseite gezeigt werden.')).toBeVisible();
      await expect(sw).toHaveAttribute('aria-checked', 'false');
    });

    test('search runs on the server', async ({ page }) => {
      await page.goto('/admin/lists');
      await expect(page.getByRole('table', { name: 'Listen' }).getByRole('row')).toHaveCount(3);
      await page.getByRole('main').getByRole('searchbox').fill('klass');
      await expect(page.getByRole('table', { name: 'Listen' }).getByRole('row')).toHaveCount(2);
      await expect(page.getByRole('table', { name: 'Listen' })).toContainText('Annas Klassiker');
    });
  });

  test.describe('hubs', () => {
    test('reorder with the buttons keeps keyboard focus; form shows a live tile preview', async ({ page, api }) => {
      await page.goto('/admin/hubs');
      await expect(page.getByRole('heading', { level: 1, name: 'Marken' })).toBeVisible();
      await expect(page.getByRole('heading', { level: 2, name: 'Marken-Kacheln' })).toBeVisible();
      const down = page.getByRole('button', { name: 'Mythos nach hinten' });
      await down.focus();
      await page.keyboard.press('Enter');
      await expect(toasts(page).getByText('„Mythos“ steht jetzt an Position 2.')).toBeVisible();
      expect(api.admin.hubs.map((h) => h.name)).toEqual(['Pinecone', 'Mythos']);
      await expect(page.getByRole('button', { name: 'Mythos nach hinten' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Mythos nach vorne' })).toBeFocused();

      await page.getByRole('button', { name: 'Marke anlegen' }).click();
      await expect(page.locator('#hub-name')).toBeFocused();
      await page.locator('#hub-name').fill('Glimmerhill');
      await expect(page.getByRole('img', { name: 'Glimmerhill' })).toBeVisible();
      await page.getByLabel('Name in Jellyfin').fill('Studio Glimmerhill');
      await page.getByRole('button', { name: 'Speichern' }).click();
      await expect(toasts(page).getByText('„Glimmerhill“ gespeichert.')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Marke anlegen' })).toHaveCount(0);
      expect(api.admin.hubs.some((h) => h.name === 'Glimmerhill')).toBe(true);
    });

    test('a failed reorder rolls back', async ({ page, api }) => {
      await page.route('**/api/admin/hubs/order', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }));
      await page.goto('/admin/hubs');
      await page.getByRole('button', { name: 'Mythos nach hinten' }).click();
      await expect(toasts(page).getByText('Serverfehler. Bitte später noch einmal versuchen.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Mythos nach hinten' })).toBeEnabled();
      expect(api.admin.hubs.map((h) => h.name)).toEqual(['Mythos', 'Pinecone']);
    });

    test('the visibility switch saves with Undo', async ({ page, api }) => {
      await page.goto('/admin/hubs');
      await page.getByRole('switch', { name: '„Pinecone“ auf der Startseite zeigen' }).click();
      await expect(toasts(page).getByText('„Pinecone“ wird auf der Startseite gezeigt.')).toBeVisible();
      expect(api.admin.hubs.find((h) => h.name === 'Pinecone')!.enabled).toBe(true);
      await toasts(page).getByRole('button', { name: 'Rückgängig' }).click();
      await expect.poll(() => api.admin.hubs.find((h) => h.name === 'Pinecone')!.enabled).toBe(false);
    });
  });

  test.describe('previews', () => {
    test('server paging, status filter, search and sorting', async ({ page }) => {
      await page.goto('/admin/previews');
      const table = page.getByRole('table', { name: 'Vorschauen' });
      await expect(table.getByRole('row')).toHaveCount(26);
      await expect(page.getByText('1–25 von 60')).toBeVisible();
      await expect(table.getByRole('row').nth(1)).toContainText('Fehlgeschlagen'); // failed first
      await page.getByRole('combobox', { name: 'Status' }).selectOption('failed');
      await expect(page.getByText('1–10 von 10')).toBeHidden(); // single page: no pager
      await expect(table.getByRole('row')).toHaveCount(11);
      await page.getByRole('combobox', { name: 'Status' }).selectOption('');
      await page.getByRole('main').getByRole('searchbox').fill('Nummer 59');
      await expect(table.getByRole('row')).toHaveCount(2);
      await expect(table).toContainText('Titel Nummer 59');
    });

    test('summary tiles and a progress bar, no raw errors without opening the details', async ({ page }) => {
      await page.goto('/admin/previews');
      await expect(page.getByRole('progressbar', { name: '30 / 60 fertig' })).toBeVisible();
      await expect(page.getByText('ffmpeg exited with code 1').first()).toBeHidden();
      await page.getByText('Fehlerdetails').first().click();
      await expect(page.getByText('ffmpeg exited with code 1').first()).toBeVisible();
    });

    test('retry marks the row as in progress; only the preparing rows are polled and only changed rows update', async ({ page, api }) => {
      await page.goto('/admin/previews');
      const polls: string[] = [];
      page.on('request', (r) => { if (r.url().includes('/api/admin/previews?ids=')) polls.push(r.url()); });
      const table = page.getByRole('table', { name: 'Vorschauen' });
      const failed = table.getByRole('row').filter({ hasText: 'Fehlgeschlagen' }).first();
      const name = (await failed.getByRole('cell').first().innerText()).split('\n')[0]!.trim();
      await failed.getByRole('button', { name: /Aktionen für/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Neu erzeugen' }).click();
      await expect(toasts(page).getByText(`„${name}“ wird neu erzeugt.`)).toBeVisible();
      const row = table.getByRole('row').filter({ has: page.getByText(name, { exact: true }) });
      await expect(row).toContainText('In Arbeit');
      // the backend finishes the clip: the next poll updates just that row
      const item = api.admin.previews.find((p) => p.name === name)!;
      Object.assign(item, { status: 'ok', bytes: 4_000_000, audioLang: 'deu' });
      await expect(row).toContainText('OK', { timeout: 10_000 });
      expect(polls.length).toBeGreaterThan(0);
      expect(polls.every((u) => u.includes('ids='))).toBe(true);
      expect(polls.some((u) => u.includes(item.itemId))).toBe(true);
    });

    test('regenerate all failed and clear a clip', async ({ page, api }) => {
      await page.goto('/admin/previews');
      await page.getByRole('button', { name: 'Alle fehlgeschlagenen neu erzeugen' }).click();
      await expect(toasts(page).getByText('10 Clips werden neu erzeugt.')).toBeVisible();
      expect(api.admin.previews.filter((p) => p.status === 'failed')).toHaveLength(0);

      const ok = api.admin.previews.find((p) => p.status === 'ok')!;
      await page.getByRole('main').getByRole('searchbox').fill(ok.name);
      const row = page.getByRole('table', { name: 'Vorschauen' }).getByRole('row', { name: new RegExp(`${ok.name}$|${ok.name} `) }).first();
      await row.getByRole('button', { name: /Aktionen für/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Clip löschen' }).click();
      await expect(toasts(page).getByText(`Clip von „${ok.name}“ gelöscht.`)).toBeVisible();
      expect(api.log.some((l) => l.startsWith(`DELETE /api/admin/previews/${ok.itemId}`))).toBe(true);
    });

    test('load failure shows an error with retry', async ({ page }) => {
      let fail = true;
      await page.route('**/api/admin/previews?**', (r) => (fail ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }) : r.fallback()));
      await page.goto('/admin/previews');
      const alert = page.getByRole('alert').filter({ hasText: 'Serverfehler' });
      await expect(alert).toBeVisible();
      fail = false;
      await alert.getByRole('button', { name: 'Erneut versuchen' }).click();
      await expect(page.getByText('1–25 von 60')).toBeVisible();
    });
  });

  test.describe('playback', () => {
    test('live streams are titled by name; stopping asks first', async ({ page, api }) => {
      await page.goto('/admin/playback');
      const live = page.getByRole('table', { name: 'Läuft gerade' });
      await expect(live.getByRole('row', { name: /Sundial · Pilot/ })).toContainText('Pausiert');
      await expect(live.getByRole('row', { name: /Hearth/ })).toContainText('Anna Beispiel (Anna)');
      await expect(live).not.toContainText('it1');
      await live.getByRole('row', { name: /Hearth/ }).getByRole('button', { name: /Aktionen für/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Wiedergabe beenden' }).click();
      const dlg = page.getByRole('alertdialog', { name: '„Hearth“ von Anna Beispiel beenden?' });
      await expect(dlg).toBeVisible();
      await dlg.getByRole('button', { name: 'Abbrechen' }).click();
      expect(api.admin.live).toHaveLength(2);
      await live.getByRole('row', { name: /Hearth/ }).getByRole('button', { name: /Aktionen für/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Wiedergabe beenden' }).click();
      await dlg.getByRole('button', { name: 'Wiedergabe beenden' }).click();
      await expect(toasts(page).getByText('Wiedergabe von Anna Beispiel beendet.')).toBeVisible();
      await expect(live.getByRole('row', { name: /Hearth/ })).toHaveCount(0);
      expect(api.admin.live).toHaveLength(1);
    });

    test('downloads: jobs show the title, licences can be revoked after a confirmation', async ({ page, api }) => {
      await page.goto('/admin/playback');
      const jobs = page.getByRole('table', { name: /Vorbereitung/ });
      await expect(jobs.getByRole('row', { name: /Inkwell/ })).toContainText('HD');
      await expect(jobs).not.toContainText('abcdef0123456789');
      await expect(jobs.getByRole('progressbar')).toBeVisible();
      const lic = page.getByRole('table', { name: /Aktive Lizenzen/ });
      await lic.getByRole('row', { name: /Inkwell/ }).getByRole('button', { name: /Aktionen für/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Widerrufen' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Widerrufen' }).click();
      await expect(toasts(page).getByText('Download von Anna widerrufen.')).toBeVisible();
      expect(api.log.some((l) => l.startsWith('DELETE /api/admin/downloads/'))).toBe(true);
    });

    test('the health check lists failures without raw ids', async ({ page }) => {
      await page.goto('/admin/playback');
      await expect(page.getByText('1 fehlgeschlagen')).toBeVisible();
      await expect(page.getByText('Kaputter Film')).toBeVisible();
      await expect(page.getByText('Jellyfin konnte nicht umwandeln')).toBeVisible();
    });

    test('empty video from the media server: hint under the row, once on top when every title failed, and on a failed download', async ({ page }) => {
      const hint = 'Medienserver liefert leere Videostücke – Jellyfin neu starten; hilft das nicht, Hardware-Beschleunigung prüfen';
      const row = (i: number, ok: boolean, error: string | null) => ({ itemId: String(i).repeat(32), name: 'Film ' + i, type: 'Movie', ok, status: 200, ms: 800, bytes: ok ? 1 : 0, error });
      let results = [row(1, false, 'HTTP 200 empty body'), row(2, true, null), row(3, false, 'HTTP 404')];
      await page.route('**/api/admin/playback-check', (r) => (r.request().method() === 'GET'
        ? r.fulfill({ contentType: 'application/json', body: JSON.stringify({ running: false, done: results.length, total: results.length, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), results }) })
        : r.fallback()));
      await page.route('**/api/admin/downloads', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({
        enabled: true, maxBytes: 1e10, diskBytes: 0, licenses: [],
        jobs: [{ id: 'j1', item_id: 'b'.repeat(32), title: 'Inkwell', series_name: null, quality: 'hd', audio_lang: '', status: 'failed', seg_done: 0, seg_total: 10, bytes: null, error: 'empty segment from media server', updated_at: new Date().toISOString(), licenses: 1 }],
      }) }));
      await page.goto('/admin/playback');
      await expect(page.getByTestId('empty-media-row-hint')).toHaveCount(1);
      await expect(page.getByTestId('empty-media-row-hint')).toHaveText(hint);
      await expect(page.getByTestId('empty-media-hint')).toHaveCount(0);
      await expect(page.getByRole('table', { name: /Vorbereitung/ }).getByRole('row', { name: /Inkwell/ })).toContainText(hint);

      results = [row(1, false, 'HTTP 200 empty body'), row(2, false, 'HTTP 200 empty body'), row(3, false, 'empty playlist')];
      await page.reload();
      await expect(page.getByTestId('empty-media-hint')).toHaveText(hint);
      await expect(page.getByText('Film 3')).toBeVisible();
      await expect(page.getByTestId('empty-media-row-hint')).toHaveCount(0);
    });
  });

  test.describe('digest', () => {
    test('Save is only enabled for unsaved changes and confirms with a toast', async ({ page, api }) => {
      await page.goto('/admin/digest');
      const save = page.getByRole('button', { name: 'Speichern' });
      await expect(save).toBeDisabled();
      await page.getByRole('combobox', { name: 'Uhrzeit' }).selectOption('20');
      await expect(save).toBeEnabled();
      await expect(page.getByText('Ungespeicherte Änderungen')).toBeVisible();
      await page.getByRole('button', { name: 'Änderungen verwerfen' }).click();
      await expect(page.getByRole('combobox', { name: 'Uhrzeit' })).toHaveValue('18');
      await page.getByRole('combobox', { name: 'Uhrzeit' }).selectOption('20');
      await save.click();
      await expect(toasts(page).getByText('Gespeichert.')).toBeVisible();
      await expect(save).toBeDisabled();
      expect(api.log.some((l) => l.startsWith('PUT /api/admin/digest') && l.includes('"hour":20'))).toBe(true);
      await page.getByRole('button', { name: 'Test an mich senden' }).click();
      await expect(toasts(page).getByText('Test gesendet.', { exact: false })).toBeVisible();
    });
  });

  test.describe('update', () => {
    test('version card, check, confirm and the progress steps', async ({ page, api }) => {
      await page.route('**/api/version', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"sha":"ff00aa1deadbeef"}' }));
      await page.goto('/admin/update');
      await expect(page.getByRole('heading', { level: 1, name: 'Update' })).toBeVisible();
      const ver = page.getByRole('region', { name: 'Version' });
      await expect(ver).toContainText('Build c0be6c5');
      await expect(ver).toContainText('Update verfügbar');
      await expect(ver).toContainText('main ist 3 Commits weiter als diese Version');
      await expect(page.getByRole('table', { name: 'Änderungen' }).getByRole('row', { name: /local request-service users/ })).toBeVisible();
      await ver.getByRole('button', { name: 'Neu prüfen' }).click();
      await expect(toasts(page).getByText('Update verfügbar')).toBeVisible();

      const go = page.getByRole('button', { name: 'Jetzt aktualisieren' });
      await go.click();
      const dlg = page.getByRole('alertdialog', { name: /Portal jetzt aktualisieren/ });
      await expect(dlg).toContainText('Version ff00aa1');
      await dlg.getByRole('button', { name: 'Abbrechen' }).click();
      expect(api.log.some((l) => l.startsWith('POST /api/admin/update'))).toBe(false);
      await go.click();
      await dlg.getByRole('button', { name: 'Jetzt aktualisieren' }).click();
      await expect.poll(() => api.log.some((l) => l.startsWith('POST /api/admin/update'))).toBe(true);
      await expect(page.getByRole('list').filter({ hasText: 'Update angestoßen' })).toBeVisible();
      await expect(page.getByText('Fertig – die Seite lädt neu')).toBeVisible({ timeout: 10_000 });
    });

    test('before the first release: commits ahead decide the state', async ({ page }) => {
      const now = new Date().toISOString();
      await page.route('**/api/admin/update', (r) => (r.request().method() !== 'GET' ? r.fallback() : r.fulfill({ json: {
        current: { sha: 'c0be6c5deadbeef', builtAt: now, version: '1.0.0', codename: 'Arancini' }, release: null, updateAvailable: null,
        latest: { sha: 'ff00aa1deadbeef', date: now, runUrl: 'https://example.org/run' }, behind: 3, portainer: { configured: true, mode: 'webhook' }, autoUpdateNote: true, commits: [],
      } })));
      await page.goto('/admin/update');
      const ver = page.getByRole('region', { name: 'Version' });
      await expect(ver).toContainText('3 Updates verfügbar');
      await expect(ver).toContainText('Noch kein Release veröffentlicht');
      await expect(ver.getByText('Neueste:')).toHaveCount(0);
      await expect(page.getByText(/Was ist neu/)).toHaveCount(0);
    });

    test('a Portainer error is explained in a toast', async ({ page }) => {
      await page.route('**/api/admin/update', (r) => (r.request().method() === 'POST' ? r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"portainer_unreachable","code":"ENOTFOUND"}' }) : r.fallback()));
      await page.goto('/admin/update');
      await page.getByRole('button', { name: 'Jetzt aktualisieren' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Jetzt aktualisieren' }).click();
      await expect(toasts(page).getByText(/Portainer nicht erreichbar \(ENOTFOUND: Hostname nicht auflösbar/)).toBeVisible();
    });
  });

  test.describe('status', () => {
    test('health and counters link to where they are handled', async ({ page }) => {
      await page.goto('/admin/status');
      await expect(page.getByRole('heading', { level: 1, name: 'Status' })).toBeVisible();
      const health = page.getByRole('region', { name: 'Systemzustand' });
      await expect(health.getByRole('link', { name: /Medienserver.*Läuft/ })).toBeVisible();
      const nums = page.getByRole('region', { name: 'Zahlen' });
      await expect(nums.getByRole('link', { name: /Vorschauen.*10 fehlgeschlagen/ })).toHaveAttribute('href', '/admin/previews');
      await expect(nums.getByRole('link', { name: /Geräte warten/ })).toHaveAttribute('href', '/admin/devices');
      await expect(nums.getByRole('link', { name: /Offene Wünsche/ })).toContainText('4');
      await expect(page.getByRole('region', { name: 'Speicher' }).getByRole('progressbar')).toHaveCount(2);
    });

    test('a failing summary shows one error with retry, no dead space', async ({ page, api }) => {
      api.admin.summaryFails = true;
      await page.goto('/admin/status');
      const alert = page.getByRole('alert').filter({ hasText: 'Der Status konnte nicht geladen werden.' });
      await expect(alert).toBeVisible();
      api.admin.summaryFails = false;
      await alert.getByRole('button', { name: 'Erneut versuchen' }).click();
      await expect(alert).toBeHidden();
      await expect(page.getByRole('region', { name: 'Zahlen' })).toBeVisible();
    });
  });

  test('no page repeats its own heading and no page leaks raw ids or JSON', async ({ page }) => {
    for (const path of ['requests', 'polls', 'lists', 'hubs', 'previews', 'playback', 'digest', 'update', 'status']) {
      await page.goto(`/admin/${path}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.locator('main')).not.toContainText(/undefined|\[object|\{"|"\}|NaN/);
    }
  });
});
