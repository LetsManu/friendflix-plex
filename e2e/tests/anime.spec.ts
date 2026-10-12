import { episodes, items, ME, SERIES } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

const SHOTS = process.env.A1_SHOTS ?? '';
const shot = async (page: import('@playwright/test').Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const XSS = '<img src=x onerror=alert(1)> Krasse Wendung';

const entry = (i: number, weekday: number, anime: boolean) => ({
  item: { ...items[i], type: 'Series' }, anime, weekday, timed: false, airsAt: '2026-10-10T00:00:00.000Z', season: 'fall', seasonYear: 2026,
  latest: { id: episodes[0]!.id, name: 'Folge 3', season: 1, index: 3, premiereDate: '2026-10-10T00:00:00.000Z' },
});
const SIM = {
  season: 'fall', year: 2026, total: 2, anime: false,
  days: Array.from({ length: 7 }, (_, w) => ({ weekday: w, items: w === 6 ? [entry(8, 6, true)] : w === 2 ? [entry(1, 2, false)] : [] })),
};

test.describe('simulcast', () => {
  test('groups by weekday, filter "Nur Anime" reloads, calendar links here', async ({ page }) => {
    const asked: string[] = [];
    await page.route('**/api/simulcast?*', (r) => {
      asked.push(new URL(r.request().url()).search);
      const only = r.request().url().includes('anime=1');
      return r.fulfill(json({ ...SIM, anime: only, total: only ? 1 : 2, days: SIM.days.map((d) => ({ ...d, items: d.items.filter((e) => !only || e.anime) })) }));
    });
    await page.route('**/api/calendar', (r) => r.fulfill(json({ items: [] })));
    await page.goto('/calendar');
    await page.getByRole('link', { name: /Simulcast/ }).click();
    await expect(page).toHaveURL(/\/simulcast$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Herbst 2026');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText([/Dienstag/, /Samstag/]);
    await shot(page, 'simulcast-desktop');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await page.getByLabel('Nur Anime').check();
    await expect(page.getByRole('heading', { level: 2 })).toHaveCount(1);
    expect(asked.some((s) => s.includes('anime=1'))).toBe(true);
  });
});

test.describe('episode comments', () => {
  test('spoiler is blurred until asked, text is never interpreted, post and delete work', async ({ page }) => {
    let dialog = '';
    page.on('dialog', (d) => { dialog = d.message(); void d.dismiss(); });
    const ep = episodes[1]!.id;
    const list = [
      { id: 'c1', name: 'Anna', mine: false, spoiler: true, createdAt: new Date().toISOString(), canDelete: false },
      { id: 'c2', name: 'Ben', mine: false, spoiler: false, body: 'Tolle Folge', createdAt: new Date().toISOString(), canDelete: false },
    ];
    const posted: unknown[] = [];
    await page.route(`**/api/items/${ep}/comments**`, async (r) => {
      const req = r.request();
      if (req.method() === 'POST') {
        posted.push(req.postDataJSON());
        return r.fulfill(json({ id: 'c3', name: 'Admin', mine: true, spoiler: false, body: req.postDataJSON().body, createdAt: new Date().toISOString(), canDelete: true }));
      }
      const reveal = req.url().includes('reveal=1');
      return r.fulfill(json({ watched: false, comments: list.map((c) => (c.spoiler && reveal ? { ...c, body: XSS } : c)) }));
    });
    await page.route('**/api/comments/c3', (r) => r.fulfill(json({ ok: true })));
    await page.goto('/item/' + SERIES.id);
    const row = page.locator('li.eprow').nth(1);
    await row.getByRole('button', { name: 'Kommentare' }).click();
    const panel = row.getByRole('region', { name: 'Kommentare von Freunden' });
    await expect(panel.getByText('Tolle Folge')).toBeVisible();
    await expect(panel.getByText('Du hast diese Folge noch nicht gesehen')).toBeVisible();
    // the spoiler text is not in the page until revealed
    await expect(panel.getByText('Krasse Wendung')).toHaveCount(0);
    await shot(page, 'comments-spoiler-desktop');
    await panel.getByRole('button', { name: 'Spoiler – trotzdem zeigen' }).click();
    await expect(panel.locator('.body', { hasText: 'Krasse Wendung' })).toHaveText(XSS); // literal text
    await expect(panel.locator('img')).toHaveCount(0);
    expect(dialog).toBe('');
    await panel.getByLabel('Dein Kommentar').fill('Meine Meinung');
    await panel.getByRole('button', { name: 'Senden' }).click();
    await expect(panel.getByText('Meine Meinung')).toBeVisible();
    expect(posted).toEqual([{ body: 'Meine Meinung' }]);
    await panel.getByRole('button', { name: /löschen/ }).click();
    await expect(panel.getByText('Meine Meinung')).toHaveCount(0);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('kids profile: no comments button', async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill(json({ ...ME, kids: true })));
    await page.goto('/item/' + SERIES.id);
    await expect(page.locator('li.eprow').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Kommentare' })).toHaveCount(0);
  });
});
