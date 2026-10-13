import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { MOVIE } from '../mocks/fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

/** Block 21 on phones: clamped synopsis, sticky tab bar, horizontally scrolling ratings line, 44 px tabs. */
const LONG = 'Ein Dieb, der Geheimnisse aus Träumen stiehlt, bekommt einen letzten Auftrag. '.repeat(8);
const ABOUT = {
  ratings: [
    { key: 'community', value: 7.8, max: 10, from: 'jellyfin' }, { key: 'imdb', value: 8.1, max: 10, from: 'omdb' }, { key: 'rt', value: 92, max: 100, from: 'omdb' },
    { key: 'mc', value: 81, max: 100, from: 'omdb' }, { key: 'friends', value: 4.5, max: 5, from: 'friends' },
  ],
  tagline: 'Dein Traum ist der Tatort.',
  countries: ['US'], studios: ['Wardell Pictures'], tags: [], keywords: [], links: [{ kind: 'imdb', url: 'https://www.imdb.com/title/tt1375666/' }],
  collection: null, canRequest: false, sources: ['jellyfin', 'omdb'],
};

async function open(page: Page) {
  await page.route(/\/api\/items\/[0-9a-f]{32}\/about$/, (r) => r.fulfill({ json: ABOUT }));
  await page.route(new RegExp(`/api/items/${MOVIE.id}$`), (r) => r.fulfill({ json: { item: { ...MOVIE, overview: LONG }, inWatchlist: false, thumb: 0, langs: { audio: ['deu'], subs: [] } } }));
  await page.goto('/item/' + MOVIE.id);
  await expect(page.getByRole('heading', { level: 1, name: 'Inkwell' })).toBeVisible();
}
const tablist = (page: Page) => page.getByRole('tablist', { name: 'Weitere Inhalte' });

test.describe('detail page (phone)', () => {
  test('synopsis clamped to 4 lines with Mehr; Mehr expands, aria-expanded true', async ({ page }) => {
    await open(page);
    const syn = page.locator('#dv-syn');
    const btn = page.getByRole('button', { name: 'Mehr lesen', exact: true });
    await expect(btn).toHaveAttribute('aria-controls', 'dv-syn');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    const lines = () => syn.evaluate((e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)));
    expect(await lines()).toBe(4);
    await btn.click();
    const less = page.getByRole('button', { name: 'Weniger anzeigen', exact: true });
    await expect(less).toHaveAttribute('aria-expanded', 'true');
    expect(await lines()).toBeGreaterThan(4);
    await less.click();
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  test('ratings line and tagline sit together right under the meta line, above the buttons', async ({ page }) => {
    await open(page);
    const meta = (await page.locator('.pcap .meta').boundingBox())!;
    const line = (await page.getByRole('list', { name: 'Bewertungen' }).boundingBox())!;
    const tag = page.locator('.pcap .tagline');
    await expect(tag).toHaveText('Dein Traum ist der Tatort.');
    const tagBox = (await tag.boundingBox())!;
    const play = (await page.locator('.pcap a.play').boundingBox())!;
    expect(line.y).toBeGreaterThanOrEqual(meta.y + meta.height - 1);
    expect(tagBox.y).toBeGreaterThanOrEqual(line.y + line.height - 1);
    expect(tagBox.y + tagBox.height).toBeLessThanOrEqual(play.y + 1);
  });

  test('tab bar sticks under the app bar while scrolling', async ({ page }) => {
    await open(page);
    const bar = tablist(page);
    await expect(bar).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 1500));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
    const navH = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h')));
    const box = (await bar.boundingBox())!;
    expect(Math.abs(box.y - navH)).toBeLessThan(2);
  });

  test('ratings line scrolls horizontally, page has no horizontal overflow', async ({ page }) => {
    await open(page);
    const line = page.getByRole('list', { name: 'Bewertungen' });
    await expect(line).toContainText('Freunde 4,5 ★');
    const m = await line.evaluate((e) => ({ wrap: getComputedStyle(e).flexWrap, ox: getComputedStyle(e).overflowX, sw: e.scrollWidth, cw: e.clientWidth, h: e.getBoundingClientRect().height }));
    expect(m.wrap).toBe('nowrap');
    expect(m.ox).toBe('auto');
    expect(m.h).toBeLessThan(40); // one line
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('tabs are at least 44 px high', async ({ page }) => {
    await open(page);
    const tabs = tablist(page).getByRole('tab');
    await expect(tabs).toHaveText(['Details', 'Mehr davon']);
    for (const t of await tabs.all()) expect((await t.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
});
