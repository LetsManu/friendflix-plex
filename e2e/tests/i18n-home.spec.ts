import { LOCKED_ID } from '../mocks/api.js';
import { ME, SERIES } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';

const SHOTS = process.env.I18N_SHOTS; // optional: directory for review screenshots

/** areas "home" and "detail" in English (profile language from /api/me) */
test.describe('home + detail in English', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, language: 'en', languageChosen: true, defaultLanguage: 'de', defaultLanguageSet: true, suggestedLanguage: null } }));
  });

  test('home rows, billboard and cards', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('region', { name: 'Continue Watching' }).or(page.getByRole('region', { name: 'Recently added' })).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /More info/ }).first()).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/home-en.png` });
  });

  test('detail page: labels, language line, cast and ratings', async ({ page }) => {
    await page.goto('/item/' + LOCKED_ID);
    await expect(page.getByRole('heading', { level: 1, name: 'Inception' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Cast & Crew' })).toBeVisible();
    await expect(page.getByText('Audio: German, English · Subtitles: German')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /^Ratings/ })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'About Inception' })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/detail-en.png`, fullPage: true });
  });

  test('series lists its episodes', async ({ page }) => {
    await page.goto('/item/' + SERIES.id);
    await expect(page.getByRole('heading', { level: 2, name: 'Episodes' })).toBeVisible();
    await expect(page.getByText('Episode 1', { exact: false }).first()).toBeAttached();
  });

  test('browse chips and search', async ({ page }) => {
    await page.goto('/browse/movies?genre=Drama&decade=1990&minRating=7&audio=deu');
    await expect(page.getByRole('heading', { level: 1, name: 'Movies' })).toBeVisible();
    const chips = page.getByRole('list', { name: 'Active filters' });
    for (const label of ['1990s', '7+ stars', 'Audio: German']) await expect(chips.getByRole('button', { name: new RegExp(label.replace('+', '\\+')) })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/browse-en.png` });
    await page.goto('/new');
    await expect(page.getByRole('heading', { level: 1, name: 'New & Popular' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Coming soon' })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/new-en.png` });
  });
});
