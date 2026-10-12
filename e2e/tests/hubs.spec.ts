import type { Page } from '@playwright/test';
import { items, ME, MOVIE, SERIES } from '../mocks/fixtures.js';
import { LOCKED_ID } from '../mocks/api.js';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

const H1 = '00000000-0000-4000-8000-0000000000a1', H2 = '00000000-0000-4000-8000-0000000000a2', H3 = '00000000-0000-4000-8000-0000000000a3';
const HUBS = [
  { id: H1, name: 'Anime', source: 'genre', accent: '#ff6600' },
  { id: H2, name: 'Meine Sammlung', source: 'collection', imageUrl: `/media/Items/${MOVIE.id}/Images/Backdrop?maxWidth=640&quality=80` },
  { id: H3, name: 'Dokumentationen', source: 'genre' },
];
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockHubs(page: Page, hubs: unknown[] = HUBS) {
  await page.route('**/api/hubs', (r) => r.fulfill(json({ hubs })));
  await page.route(/\/api\/hubs\/[^/]+\/items/, (r) => r.fulfill(json({ items: items.slice(0, 6), total: 14 })));
  await page.route(/\/api\/hubs\/[0-9a-f-]{36}$/, (r) => {
    const id = r.request().url().split('/').pop();
    const hub = (hubs as Array<{ id: string }>).find((h) => h.id === id);
    if (!hub) return r.fulfill(json({ error: 'not_found' }, 404));
    return r.fulfill(json({ hub, total: 14, featured: items[0], rows: [{ key: 'new', items: items.slice(0, 8) }, { key: 'popular', items: items.slice(2, 9) }, { key: 'series', items: [SERIES], total: 1 }] }));
  });
}

test.describe('brand hubs (desktop)', () => {
  test('tiles sit under the billboard and open the hub page', async ({ page }) => {
    await mockHubs(page);
    await page.goto('/');
    const strip = page.getByRole('region', { name: 'Marken und Sammlungen' });
    await expect(strip.getByRole('link')).toHaveCount(3);
    await expect(strip.getByRole('link', { name: 'Alles aus Anime ansehen' })).toHaveAttribute('href', '/hub/' + H1);
    await expect(strip.locator('img')).toHaveCount(1); // only the hub with artwork; the others are generated gradients with text
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);

    await strip.getByRole('link', { name: 'Alles aus Anime ansehen' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Anime' })).toBeVisible();
    await expect(page.getByText('14 Titel')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Neu bei Anime' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Beliebt bei Anime' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Serien' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Alle Titel von A bis Z' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mehr laden' })).toBeVisible(); // 6 of 14 loaded
  });

  test('tiles are keyboard focusable', async ({ page }) => {
    await mockHubs(page);
    await page.goto('/');
    const tile = page.getByRole('link', { name: 'Alles aus Meine Sammlung ansehen' });
    await tile.focus();
    await expect(tile).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp('/hub/' + H2));
  });

  test('no hubs, no strip', async ({ page }) => {
    await mockHubs(page, []);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 2, name: 'Weiterschauen' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Marken und Sammlungen' })).toHaveCount(0);
  });

  test.describe('missing hub', () => {
    test.use({ allowedConsole: /status of 404/ }); // the mocked 404 is logged by the browser
    test('a hub the viewer cannot open is a friendly 404 page', async ({ page }) => {
      await mockHubs(page, []);
      await page.goto('/hub/' + H1);
      await expect(page.getByText(/gibt es nicht \(mehr\)/)).toBeVisible();
      await expect(page.getByRole('link', { name: 'Zur Startseite' })).toBeVisible();
    });
  });
});

test.describe('extras tab (desktop)', () => {
  test('without extras there are no tabs', async ({ page }) => {
    await page.goto('/item/' + LOCKED_ID);
    await expect(page.getByRole('heading', { level: 1, name: 'Inception' })).toBeVisible();
    await expect(page.getByRole('tablist')).toHaveCount(0);
  });

  test('trailers and bonus material appear in their own tab and play through the player route', async ({ page }) => {
    await page.route(/\/api\/items\/[^/]+\/extras\/all$/, (r) => r.fulfill(json({ items: [
      { ...items[3], id: 'a'.repeat(32), name: 'Offizieller Trailer', kind: 'trailer', runtimeTicks: 1_800_000_000 },
      { ...items[4], id: 'b'.repeat(32), name: 'Hinter den Kulissen', kind: 'extra', runtimeTicks: 6_000_000_000 },
    ] })));
    await page.goto('/item/' + LOCKED_ID);
    const tabs = page.getByRole('tablist', { name: 'Weitere Inhalte' });
    await expect(tabs.getByRole('tab')).toHaveText(['Mehr davon', 'Extras']);
    await expect(tabs.getByRole('tab', { name: 'Mehr davon' })).toHaveAttribute('aria-selected', 'true');
    await tabs.getByRole('tab', { name: 'Extras' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Extras' });
    await expect(panel.getByRole('link')).toHaveCount(2);
    await expect(panel.getByRole('link', { name: 'Offizieller Trailer abspielen' })).toHaveAttribute('href', '/watch/' + 'a'.repeat(32));
    await expect(panel.getByText('Trailer', { exact: true })).toBeVisible();
    await expect(panel.getByText('Bonus', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Mehr davon' })).toBeHidden();
    // arrow keys move between the tabs
    await tabs.getByRole('tab', { name: 'Extras' }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(tabs.getByRole('tab', { name: 'Mehr davon' })).toBeFocused();
    await expect(tabs.getByRole('tab', { name: 'Mehr davon' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toHaveCount(0);
  });
});

test.describe('admin hubs (desktop)', () => {
  test('lists hubs, takes a suggestion and saves it', async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill(json({ ...ME, isAdmin: true, role: 'admin' })));
    const posted: unknown[] = [];
    let list = [{ id: H1, name: 'Anime', source: 'genre', sourceValue: 'Anime', enabled: true, sortOrder: 0 }];
    await page.route('**/api/admin/hubs', async (r) => {
      if (r.request().method() === 'POST') {
        const b = r.request().postDataJSON();
        posted.push(b);
        list = [...list, { id: H2, name: b.name, source: b.source, sourceValue: b.sourceValue, enabled: true, sortOrder: 1 }];
        return r.fulfill(json({ hub: list[1] }, 201));
      }
      return r.fulfill(json({ max: 8, hubs: list }));
    });
    await page.route('**/api/admin/hubs/suggestions', (r) => r.fulfill(json({ suggestions: [
      { name: 'Anime', count: 9, source: 'genre', sourceValue: 'Anime', used: true },
      { name: 'Dokumentation', count: 5, source: 'genre', sourceValue: 'Dokumentation', used: false },
      { name: 'Meine Sammlung', count: 3, source: 'collection', sourceValue: MOVIE.id, used: false },
    ] })));
    await page.goto('/admin/hubs');
    await expect(page.getByRole('heading', { level: 2, name: 'Marken-Kacheln' })).toBeVisible();
    await expect(page.getByText('Aktuell: 1.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Anime \(schon angelegt\)/ })).toBeDisabled();
    await page.getByRole('button', { name: 'Dokumentation übernehmen' }).click();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Dokumentation');
    await page.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByText('„Dokumentation“ gespeichert.')).toBeVisible();
    expect(posted).toEqual([{ name: 'Dokumentation', source: 'genre', sourceValue: 'Dokumentation', accent: null, imageItemId: null, enabled: true }]);
    await expect(page.getByText('Aktuell: 2.')).toBeVisible();
  });
});
