// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { healthOk } from '../mocks/admin.js';

const GiB = 1024 ** 3;
const ID = 'ab'.repeat(16);

/** a snapshot with problems: media down, TMDB key invalid, OMDb not set up, downloads 93 % (shares one volume with the previews) */
function troubled(): Record<string, any> {
  const h = healthOk();
  h.services = h.services.map((s: any) => (s.id === 'media' ? { id: 'media', level: 'err', reason: 'down', ms: 3000 }
    : s.id === 'tmdb' ? { id: 'tmdb', level: 'warn', reason: 'invalid_key' }
      : s.id === 'omdb' ? { id: 'omdb', level: 'off', reason: 'not_set' } : s));
  h.disks = [
    { id: 'downloads', level: 'warn', reason: 'full', totalBytes: 1000 * GiB, freeBytes: 70 * GiB, usedPct: 93, ownBytes: 20 * GiB, capBytes: 50 * GiB, sharedWith: 'previews', sharedBytes: 2 * GiB },
    { id: 'database', level: 'ok', ownBytes: 512 * 1024 ** 2 },
  ];
  h.worst = 'err';
  return h;
}

test.describe('admin health page', () => {
  test.use({ allowedConsole: /status of 500/ });
  test.beforeEach(({ api }) => {
    api.asAdmin = true;
    api.admin.health = troubled();
    api.admin.streams = {
      streams: [
        { userId: 'u2', userName: 'Anna Beispiel', profileName: 'Anna', device: 'Chrome auf Windows', title: 'Hearth', seriesName: null, source: 'portal', method: 'transcode', reason: 'videoCodec', videoCodec: 'h264', audioCodec: 'aac', hardware: true, paused: false },
        { userId: 'u3', userName: 'Ben Test', profileName: null, device: 'Infuse · iPad', title: 'Pilot', seriesName: 'Sundial', source: 'app', method: 'direct', reason: null, videoCodec: null, audioCodec: null, hardware: null, paused: true },
      ],
      totals: { direct: 1, remux: 0, transcode: 1 }, details: true,
      failed: [{ itemId: ID, title: 'Kaputter Film', count: 4, lastAt: new Date(Date.now() - 600e3).toISOString(), code: 'bufferStalledError' }],
    };
    api.admin.errors = {
      entries: [
        // internal fields that must never reach the page: samples can carry addresses
        { source: 'server', code: 'GET /api/items/:id 500', count: 12, firstAt: new Date(Date.now() - 7200e3).toISOString(), lastAt: new Date().toISOString(), release: 'abc1234', sample: 'fetch failed http://jellyfin:8096/Items?api_key=secret' },
        { source: 'client', code: 'resource Failed to load <script> http://intern.example/x.js', count: 3, firstAt: new Date().toISOString(), lastAt: new Date().toISOString(), sample: 'x (/browse)' },
        { source: 'job', code: 'hygiene', count: 1, firstAt: new Date().toISOString(), lastAt: new Date().toISOString() },
      ],
      overflow: 0,
    };
  });

  test('services: media red "Nicht erreichbar", TMDB yellow "Schlüssel ungültig", OMDb off "Nicht eingerichtet"; every pill has icon + text', async ({ page }) => {
    await page.goto('/admin/status');
    const health = page.getByRole('region', { name: 'Systemzustand' });
    const media = health.getByRole('link', { name: /Medienserver/ });
    await expect(media).toContainText('Nicht erreichbar');
    await expect(media.locator('.pill.err svg')).toHaveCount(1);
    await expect(health.getByRole('link', { name: /TMDB/ }).locator('.pill.warn')).toHaveText('Schlüssel ungültig');
    await expect(health.getByRole('link', { name: /OMDb/ }).locator('.pill.muted')).toHaveText('Nicht eingerichtet');
    // worst first
    await expect(health.locator('li').first()).toContainText('Medienserver');
    for (const pill of await health.locator('.pill').all()) {
      await expect(pill.locator('svg')).toHaveCount(1);
      expect((await pill.innerText()).trim().length).toBeGreaterThan(0);
    }
  });

  test('Jetzt prüfen calls ?refresh=1 once, shows the new state and reloads the banner', async ({ page, api }) => {
    await page.goto('/admin/status');
    const health = page.getByRole('region', { name: 'Systemzustand' });
    await expect(health.getByRole('link', { name: /Medienserver/ })).toContainText('Nicht erreichbar');
    api.admin.healthRefreshed = healthOk();
    const bannerCalls = api.admin.bannerCalls;
    await health.getByRole('button', { name: 'Jetzt prüfen' }).click();
    await expect(health.getByRole('link', { name: /Medienserver/ })).toContainText('Läuft');
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('Neu geprüft.')).toBeVisible();
    expect(api.admin.healthCalls.filter((q) => q === '?refresh=1')).toHaveLength(1);
    await expect.poll(() => api.admin.bannerCalls).toBeGreaterThan(bannerCalls);
  });

  test('disks: downloads 93 % warn with "davon FriendFlix", database size only; shared volume shown once', async ({ page }) => {
    await page.goto('/admin/status');
    const disks = page.getByRole('region', { name: 'Speicher' });
    const items = disks.getByRole('listitem');
    await expect(items).toHaveCount(2);
    const dl = items.filter({ hasText: 'Downloads und Vorschauen' });
    await expect(dl.locator('.pill.warn')).toHaveText('Fast voll');
    await expect(dl.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '93');
    await expect(dl).toContainText('· 93 %');
    await expect(dl).toContainText('davon FriendFlix 22 GB');
    await expect(dl).toContainText('Downloads 20 GB · Vorschauen 2 GB');
    const db = items.filter({ hasText: 'Datenbank' });
    await expect(db).toContainText('Größe 512 MB');
    await expect(db.getByRole('progressbar')).toHaveCount(0);
  });

  test('streams: transcode row shows reason "Videoformat" and "Hardware"; details false → muted hint', async ({ page, api }) => {
    await page.goto('/admin/status');
    const card = page.getByRole('region', { name: 'Wiedergaben' });
    const row = card.getByRole('listitem').filter({ hasText: 'Hearth' });
    await expect(row.locator('.pill.warn')).toHaveText('Umgewandelt');
    await expect(row.getByText('Videoformat')).toBeVisible();
    await expect(row.getByText('Hardware')).toBeVisible();
    await expect(row).toContainText('Anna Beispiel');
    await expect(card.getByRole('listitem').filter({ hasText: 'Sundial · Pilot' })).toContainText('Andere App');
    await expect(card).toContainText('1 direkt · 0 umverpackt · 1 umgewandelt');
    await expect(card.getByText(/keine Details/)).toHaveCount(0);
    api.admin.streams = { ...api.admin.streams, details: false };
    await page.reload();
    await expect(page.getByRole('region', { name: 'Wiedergaben' }).getByText('Der Medienserver liefert gerade keine Details (Formate, Hardware).')).toBeVisible();
  });

  test('failed playbacks link to /item/<id>; errors list shows source and count', async ({ page }) => {
    await page.goto('/admin/status');
    const card = page.getByRole('region', { name: 'Wiedergaben' });
    await expect(card.getByRole('link', { name: 'Kaputter Film' })).toHaveAttribute('href', `/item/${ID}`);
    await expect(card.getByRole('listitem').filter({ hasText: 'Kaputter Film' })).toContainText('4-mal');
    const errs = page.getByRole('region', { name: 'Fehler (24 Std.)' });
    const first = errs.getByRole('listitem').first();
    await expect(first).toContainText('Server');
    await expect(first).toContainText('GET /api/items/:id 500');
    await expect(first).toContainText('12-mal');
    await expect(first).toContainText('Version abc1234');
    await expect(errs.getByRole('listitem').filter({ hasText: 'hygiene' })).toContainText('Hintergrund');
  });

  test('page HTML contains no "http://" from the mocks\' internal fields', async ({ page }) => {
    await page.goto('/admin/status');
    await expect(page.getByRole('region', { name: 'Fehler (24 Std.)' }).getByRole('listitem')).toHaveCount(3);
    const html = await page.locator('main').innerHTML();
    expect(html).not.toContain('http://');
    expect(html).not.toContain('api_key');
    expect(html).not.toContain('jellyfin:8096');
  });

  test('overview strip uses the snapshot (media red there too)', async ({ page }) => {
    await page.goto('/admin');
    const health = page.getByRole('region', { name: 'Systemzustand' });
    const media = health.getByRole('link', { name: /Medienserver/ });
    await expect(media).toContainText('Nicht erreichbar');
    await expect(media.locator('.pill.err')).toBeVisible();
  });

  test('failing health: error with retry in the services section, numbers still shown', async ({ page }) => {
    let fail = true;
    await page.route('**/api/admin/health', (r) => (fail ? r.fulfill({ status: 500, json: { error: 'x' } }) : r.fallback()));
    await page.goto('/admin/status');
    const alert = page.getByRole('alert').filter({ hasText: 'Der Zustand konnte nicht geladen werden.' });
    await expect(alert).toBeVisible();
    await expect(page.getByRole('region', { name: 'Zahlen' }).getByRole('link', { name: /Geräte warten/ })).toBeVisible();
    fail = false;
    await alert.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(page.getByRole('region', { name: 'Systemzustand' }).getByRole('link', { name: /Medienserver/ })).toBeVisible();
  });
});
