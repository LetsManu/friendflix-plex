import { LIST_A, LIST_C, ME } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';

// Block 17 S1: themed lists (editorial pages, home rows, admin pinning) and calm mode.
const ADMIN = { ...ME, isAdmin: true, profile: { id: 'p1', name: 'Tester', avatar: 'a1', isOwner: true } };

// the home page and cards also ask discovery endpoints of another block; this spec answers them empty so it stays independent
test.beforeEach(async ({ page }) => {
  await page.route('**/api/discover/badges', (r) => r.fulfill({ json: { badges: {} } }));
  await page.route('**/api/library/leaving', (r) => r.fulfill({ json: { items: [] } }));
});

test.describe('themed lists (desktop)', () => {
  test('owner turns a list into a themed list; the page becomes editorial', async ({ page, api }) => {
    await page.goto('/lists/' + LIST_A);
    await page.getByRole('button', { name: 'Umbenennen' }).click();
    await page.getByLabel('Als Themenliste gestalten').check();
    await page.getByLabel('Symbol (Emoji)').fill('🎬');
    await page.getByRole('radio', { name: '#1f5f7a' }).click();
    await page.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.locator('header.cover')).toBeVisible();
    await expect(page.locator('header.cover')).toContainText('Themenliste');
    await expect(page.locator('header.cover h1')).toContainText('Filmabend');
    expect(api.lists.find((l) => l.id === LIST_A)).toMatchObject({ themed: true, emoji: '🎬', coverColor: '#1f5f7a' });
    await page.screenshot({ path: '/tmp/claude-0/-home-user-friendflix/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/block17/s1/themed-page-desktop.png' });
  });

  test('pinned themed lists show as a home row after the second row, without a pin there is none', async ({ page, api }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Weiterschauen' })).toBeVisible();
    await expect(page.getByText('Themenliste', { exact: true })).toHaveCount(0);
    Object.assign(api.lists.find((l) => l.id === LIST_A)!, { themed: true, emoji: '🍿', coverColor: '#7a1f3d', pinned: true });
    await page.reload();
    await expect(page.getByText('Themenliste', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '🍿 Filmabend' })).toBeVisible();
    await page.screenshot({ path: '/tmp/claude-0/-home-user-friendflix/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/block17/s1/themed-row-desktop.png' });
  });

  test('admin pins and reorders themed lists on the lists page', async ({ page, api }) => {
    for (const [id, name] of [[LIST_A, '🍿'], [LIST_C, '🎃']]) Object.assign(api.lists.find((l) => l.id === id)!, { themed: true, emoji: name, items: api.lists.find((l) => l.id === id)!.items.length ? api.lists.find((l) => l.id === id)!.items : ['x'] });
    await page.route('**/api/me', (r) => r.fulfill({ json: ADMIN }));
    await page.goto('/lists');
    const manage = page.getByRole('region', { name: 'Themenlisten auf der Startseite' });
    await expect(manage.getByRole('listitem')).toHaveCount(2);
    await manage.getByRole('button', { name: /Auf der Startseite zeigen\s*: Filmabend/ }).click();
    await manage.getByRole('button', { name: /Auf der Startseite zeigen\s*: Leer/ }).click();
    await expect(manage.getByRole('button', { name: /Von der Startseite nehmen/ })).toHaveCount(2);
    await manage.getByRole('button', { name: 'Leer nach oben' }).click();
    await expect(manage.getByRole('listitem').first()).toContainText('Leer');
    expect(api.lists.filter((l) => l.pinned).map((l) => l.id)).toEqual([LIST_C, LIST_A]);
    await page.screenshot({ path: '/tmp/claude-0/-home-user-friendflix/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/block17/s1/themed-admin-desktop.png', fullPage: true });
  });

  test('settings: calm mode is saved with the prefs', async ({ page, api }) => {
    await page.goto('/settings');
    const calm = page.getByLabel('Ruhiger Modus');
    await expect(calm).not.toBeChecked();
    let saved: any = null;
    await page.route('**/api/prefs', (r) => { if (r.request().method() === 'PUT') { saved = JSON.parse(r.request().postData() ?? '{}'); return r.fulfill({ json: { prefs: saved } }); } return r.fallback(); });
    await calm.check();
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect.poll(() => saved?.calm).toBe(true);
    await expect(page.locator('html')).toHaveClass(/calm/);
    void api;
  });
});

test.describe('calm mode', () => {
  test('no preview request is made for the billboard when calm', async ({ page }) => {
    const trailer: string[] = [];
    await page.route('**/api/prefs', (r) => r.fulfill({ json: { prefs: { calm: true, hoverTrailers: true } } }));
    await page.route('**/api/items/*/trailer', (r) => { trailer.push(r.request().url()); return r.fulfill({ json: {} }); });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Weiterschauen' })).toBeVisible();
    await page.waitForTimeout(3500); // longer than the billboard delay (2.5 s)
    expect(trailer).toEqual([]);
  });
});

test.describe('manifest language', () => {
  test('the manifest link follows a language switch and the route answers in that language', async ({ page, request }) => {
    await page.goto('/settings');
    const link = page.locator('link[rel="manifest"]');
    await expect(link).toHaveAttribute('href', '/manifest.webmanifest?lang=de');
    await page.route('**/api/prefs/language', (r) => r.fulfill({ json: { language: 'en' } }));
    await page.locator('#ui-lang').selectOption('en');
    await expect(link).toHaveAttribute('href', '/manifest.webmanifest?lang=en');
    const res = await request.get('/manifest.webmanifest?lang=en');
    expect(res.headers()['content-type']).toContain('application/manifest+json');
    expect(res.headers()['vary']).toMatch(/Accept-Language/i);
    const m = await res.json();
    expect(m.name).toBe('FriendFlix');
    expect(m.shortcuts[0].name).toBe('Continue Watching');
  });
});
