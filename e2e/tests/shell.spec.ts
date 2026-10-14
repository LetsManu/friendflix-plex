// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { ME } from '../mocks/fixtures.js';

const multi = { ...ME, profileCount: 3, profileChosen: true };
const noIntro = () => { for (const id of ['p1', 'p2', 'p3']) localStorage.setItem(`ff-intro:${id}`, JSON.stringify({ show: false, sound: false })); };

test.describe('app shell (desktop)', () => {
  test('slim header; everything else stays reachable from the avatar menu and the footer', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    await expect(nav.getByRole('link')).toHaveText(['Start', 'Serien', 'Filme', 'Neu & demnächst', 'Merkliste']);
    await expect(nav.getByRole('button', { name: 'Kategorien' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Überrasch mich' })).toHaveCount(0); // moved into the menu

    await page.getByRole('button', { name: /Profilmenü/ }).click();
    const menu = page.getByRole('menu', { name: 'Profilmenü' });
    for (const name of ['Profile bearbeiten', 'Mein Bereich', 'Konto & Einstellungen', 'Geräte', 'Überrasch mich', 'Hilfe', 'Von FriendFlix abmelden']) await expect(menu.getByRole('menuitem', { name })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Admin' })).toHaveCount(0); // not an admin
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    const footer = page.getByRole('contentinfo');
    for (const name of ['Watch-Party', 'Filmabend', 'Kalender', 'Jahresrückblick', 'Fernbedienung']) await expect(footer.getByRole('link', { name })).toBeAttached();

    await nav.getByRole('button', { name: 'Kategorien' }).click();
    const cats = page.getByRole('region', { name: 'Kategorien' });
    await expect(cats.getByRole('link', { name: 'Drama' })).toHaveAttribute('href', '/browse/movies?genre=Drama');
    await expect(cats.getByRole('link', { name: 'Englisch' })).toHaveAttribute('href', '/browse/movies?audio=eng');
  });

  test('header turns solid once the page is scrolled', async ({ page }) => {
    await page.goto('/');
    const header = page.locator('header.nav');
    await expect(header).not.toHaveClass(/solid/);
    await page.evaluate(() => window.scrollTo(0, 400));
    await expect(header).toHaveClass(/solid/);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(header).not.toHaveClass(/solid/);
  });

  test('"Wer ist heute dabei?" once per browser session, deep link continues', async ({ page, api }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: multi }));
    await page.addInitScript(noIntro);
    await page.goto('/watchlist');
    await expect(page).toHaveURL(/\/profiles\?next=%2Fwatchlist$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Wer ist heute dabei?' })).toBeVisible();
    await page.getByRole('button', { name: 'Anna' }).click();
    await expect(page).toHaveURL(/\/watchlist$/);
    expect(api.log.some((l) => l.startsWith('POST /api/profiles/p2/select'))).toBe(true);
    // same session: no second gate
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toBeVisible();
  });

  test('switching profiles from the avatar menu', async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: multi }));
    await page.addInitScript(() => sessionStorage.setItem('ff-profile-picked', '1'));
    await page.addInitScript(noIntro);
    await page.goto('/new');
    await page.getByRole('button', { name: /Profilmenü/ }).click();
    const menu = page.getByRole('menu', { name: 'Profilmenü' });
    await expect(menu.getByRole('menuitem', { name: 'Anna' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Tester' })).toHaveCount(0); // the active profile is not offered
    await menu.getByRole('menuitem', { name: 'Ben' }).click();
    await expect(page).toHaveURL(/\/new$/); // picked right away, back where we were
  });
});
