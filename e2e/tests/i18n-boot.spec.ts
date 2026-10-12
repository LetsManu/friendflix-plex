import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { ME, MOVIE } from '../mocks/fixtures.js';

/** counts GET requests of exactly this API path (a page that mounts twice fetches twice) */
function countGets(page: Page, path: string): { n: number } {
  const c = { n: 0 };
  page.on('request', (r) => { if (r.method() === 'GET' && new URL(r.url()).pathname === path) c.n++; });
  return c;
}
const hint = (lang: string) => JSON.stringify({ approved: true, multi: false, tv: false, profile: 'p1', lang });

test.describe('UI language at boot: the page mounts once', () => {
  test('server language differs from the remembered one (fresh device / other tab switched)', async ({ page }) => {
    await page.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('ff-locale', 'de'); sessionStorage.setItem('seeded', '1'); } } catch { /* ignore */ } });
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, language: 'en', languageChosen: true, defaultLanguage: 'de', defaultLanguageSet: true } }));
    const gets = countGets(page, '/api/watchlist');
    await page.goto('/watchlist');
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.waitForLoadState('networkidle');
    expect(gets.n).toBe(1);
  });

  test('early render (boot hint) waits for the hinted language and is not rebuilt when /api/me disagrees', async ({ page }) => {
    await page.addInitScript((h) => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('ff-boot-hint', h); localStorage.setItem('ff-locale', 'de'); sessionStorage.setItem('seeded', '1'); } } catch { /* ignore */ } }, hint('fr'));
    let release!: () => void;
    const meGate = new Promise<void>((r) => (release = r));
    await page.route('**/api/me', async (r) => { await meGate; await r.fulfill({ json: { ...ME, language: 'en', languageChosen: true, defaultLanguage: 'de', defaultLanguageSet: true } }); });
    const gets = countGets(page, '/api/watchlist');
    await page.goto('/watchlist');
    // rendered before /api/me answered, already in the hinted language (not in the remembered German)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    release();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(gets.n).toBe(1);
  });

  test('a language switch made by the person still rebuilds the page once', async ({ page }) => {
    const gets = countGets(page, '/api/watchlist');
    await page.goto('/watchlist');
    await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(gets.n).toBe(1);
    await page.getByRole('contentinfo').getByRole('combobox').selectOption('en');
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(gets.n).toBe(2);
  });
});

test.describe('settings: language switch', () => {
  test('keeps unsaved edits and never sends `language` with the full prefs', async ({ page, api }) => {
    await page.goto('/settings');
    await page.locator('#al').selectOption('eng');
    await page.locator('#ui-lang').selectOption('en');
    await expect(page.getByRole('heading', { level: 1, name: 'Playback settings' })).toBeVisible();
    await expect(page.locator('#al')).toHaveValue('eng'); // unsaved edit survived
    await expect(page.locator('#al option[value="eng"]')).toHaveText('English'); // track names follow the language
    await page.getByRole('button', { name: 'Save', exact: true }).last().click();
    await expect.poll(() => api.log.find((l) => l.startsWith('PUT /api/prefs {'))).toBeTruthy();
    const put = api.log.find((l) => l.startsWith('PUT /api/prefs {'))!;
    expect(put).toContain('"audioLang":"eng"');
    expect(put).not.toContain('"language"');
  });
});

test.describe('public pages pick their language without /api/me', () => {
  test.describe('unknown browser language → instance default', () => {
    test.use({ locale: 'ja-JP' });
    test('invite page in the instance default (English), account type in the same language', async ({ page }) => {
      const asked: string[] = [];
      page.on('request', (r) => { if (r.url().includes('/api/invite/')) asked.push(new URL(r.url()).search); });
      await page.goto('/invite/tok123');
      await expect(page.getByRole('heading', { level: 1, name: 'You’ve been invited' })).toBeVisible();
      await expect(page.locator('main b')).toHaveText('Guest');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      expect(asked[0]).toBe(''); // nothing to send yet: the server answers in its default
    });
    test('TV pairing screen in the instance default', async ({ page }) => {
      await page.goto('/tv');
      await expect(page.getByRole('heading', { level: 1, name: 'Connect your TV' })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    });
  });
  test.describe('browser language', () => {
    test.use({ locale: 'fr-FR' });
    test('invite page follows the browser and sends that language', async ({ page }) => {
      const asked: string[] = [];
      page.on('request', (r) => { if (r.url().includes('/api/invite/')) asked.push(new URL(r.url()).search); });
      await page.goto('/invite/tok123');
      await expect(page.locator('main b')).toHaveText('Invité');
      await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
      expect(asked).toEqual(['?lang=fr']);
    });
  });
});

test('a title containing markup is shown as text in the info block', async ({ page }) => {
  const evil = '<a href="/x">Evil</a><b>B</b>';
  await page.route(`**/api/items/${MOVIE.id}`, (r) => r.fulfill({ json: { item: { ...MOVIE, name: evil }, inWatchlist: false, thumb: 0, langs: { audio: ['deu'], subs: [] } } }));
  await page.goto(`/item/${MOVIE.id}`);
  const h = page.locator('#info-h');
  await expect(h).toContainText(evil);
  await expect(h.locator('a')).toHaveCount(0);
  await expect(h.locator('b')).toHaveCount(1); // the markup of the translation itself still works
});

test('downloads: OPFS is detected via a worker (no "not available" in Chromium)', async ({ page }) => {
  await page.goto('/downloads');
  await expect(page.getByText('Downloads sind für dein Konto nicht freigeschaltet.')).toBeVisible();
  await expect(page.getByText('Auf diesem Gerät nicht verfügbar.')).toHaveCount(0);
});
