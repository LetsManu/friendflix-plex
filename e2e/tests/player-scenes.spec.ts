import { MOVIE, nolan } from '../mocks/fixtures.js';
import { CAST, mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';

/** Block 17 P1: player depth. Cast & info (peek + panel + person sheet), chapters ("Szenen"), sound modes. */
const SHOTS = process.env.P1_SHOTS; // screenshot folder for the block report (optional)
const shot = async (page: import('@playwright/test').Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

test.describe('player: scenes, cast & info, sound', () => {
  test.beforeEach(async ({ page, api: _api }) => { await mockPlayer(page); });

  test('chapter marks on the seek bar, chapter names on hover, the scenes panel jumps', async ({ page }) => {
    await page.goto('/watch/' + MOVIE.id);
    await videoReady(page);
    const track = page.getByRole('slider', { name: 'Position' });
    await expect(page.locator('.track .chap')).toHaveCount(2); // 200 s and 400 s (0 is the left edge)
    const box = (await track.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2); // 300 s
    await expect(page.locator('.tip .chn')).toHaveText('Die Verfolgung');
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2); // 60 s: unnamed chapter
    await expect(page.locator('.tip .chn')).toHaveText('Kapitel 1');
    await shot(page, 'desktop-seekbar-chapter');

    await page.getByRole('button', { name: 'Szenen', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Szenen' });
    await expect(panel.getByText('3 Szenen')).toBeVisible();
    await expect(panel.getByRole('button', { name: /^Kapitel 1, ab 0:00/ })).toHaveAttribute('aria-current', 'true');
    await shot(page, 'desktop-scenes');
    await panel.getByRole('button', { name: /^Der Kick, ab 6:40/ }).click();
    await expect(panel).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => Math.round(document.querySelector('video')!.currentTime))).toBeGreaterThanOrEqual(400);
  });

  test('I peeks at the cast without pausing; the panel shows roles, guests, facts and a person sheet', async ({ page }) => {
    await page.goto('/watch/' + MOVIE.id);
    await videoReady(page);
    await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.paused)).toBe(false);
    await page.locator('body').press('i');
    const peek = page.getByRole('complementary', { name: 'Besetzung auf einen Blick' });
    await expect(peek.getByText('Leonardo DiCaprio')).toBeVisible();
    await expect(peek.getByText('Dom Cobb')).toBeVisible();
    await expect(peek.getByText('Michael Caine')).toBeVisible(); // the first guest stars are part of the peek
    expect(await page.evaluate(() => document.querySelector('video')!.paused)).toBe(false); // playback goes on
    await shot(page, 'desktop-peek');
    await expect(peek).toHaveCount(0, { timeout: 8000 }); // hides by itself

    await page.locator('body').press('i');
    await peek.getByRole('button', { name: /Alle Infos/ }).click();
    const ci = page.getByRole('complementary', { name: 'Besetzung & Infos' });
    await expect(ci.getByRole('heading', { name: 'Besetzung', exact: true })).toBeVisible();
    await expect(ci.getByRole('heading', { name: 'Gaststars' })).toBeVisible();
    await expect(ci.getByText('als Arthur')).toBeVisible();
    await expect(ci.getByRole('heading', { name: 'Hintergrund' })).toBeVisible();
    await expect(ci.getByText('Syncopy und Legendary Pictures')).toBeVisible();
    await expect(ci.getByText('dream · heist')).toBeVisible();
    await expect(ci.getByRole('link', { name: 'Christopher Nolan' }).first()).toHaveAttribute('href', `/person/${'b'.repeat(32)}`);
    await shot(page, 'desktop-castinfo');

    // person sheet: other titles of the library (the playing one is left out) + link to the person page
    await ci.getByRole('button', { name: 'Leonardo DiCaprio, mehr Titel anzeigen' }).click();
    await expect(ci.getByText('spielt Dom Cobb')).toBeVisible();
    await expect(ci.getByRole('link', { name: 'Alle Titel und Infos' })).toHaveAttribute('href', `/person/${CAST.cast[0]!.id}`);
    const others = nolan.filter((i) => i.id !== MOVIE.id);
    await expect(ci.locator('.titles li')).toHaveCount(others.length);
    await expect(ci.getByRole('link', { name: new RegExp(MOVIE.name) })).toHaveCount(0);
    await shot(page, 'desktop-person-sheet');
    await page.keyboard.press('Escape'); // back to the list first …
    await expect(ci.getByRole('heading', { name: 'Gaststars' })).toBeVisible();
    await page.keyboard.press('Escape'); // … then closed
    await expect(ci).toHaveCount(0);
  });

  test('pausing still shows the panel after a moment (as before), without moving the focus', async ({ page }) => {
    await page.goto('/watch/' + MOVIE.id);
    await videoReady(page);
    await page.evaluate(async () => { const v = document.querySelector('video')!; await v.play().catch(() => undefined); v.pause(); });
    await expect(page.getByRole('complementary', { name: 'Besetzung & Infos' }).getByText('Joseph Gordon-Levitt')).toBeVisible();
    await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
    await expect(page.getByRole('complementary', { name: 'Besetzung & Infos' })).toHaveCount(0);
  });

  test('TV: up peeks, OK opens the panel with the focus inside, Back closes it', async ({ page }) => {
    await page.goto('/watch/' + MOVIE.id);
    await videoReady(page);
    await page.evaluate(() => { document.documentElement.classList.add('tv'); (document.activeElement as HTMLElement | null)?.blur(); });
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('complementary', { name: 'Besetzung auf einen Blick' })).toBeVisible();
    await expect(page.getByText('Mehr: OK')).toBeVisible();
    await page.keyboard.press('Enter');
    const ci = page.getByRole('complementary', { name: 'Besetzung & Infos' });
    await expect(ci).toBeVisible();
    await expect(ci.getByRole('button', { name: 'Leonardo DiCaprio, mehr Titel anzeigen' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(ci).toHaveCount(0);
  });

  test('sound: clear voices / night mode toggle in the audio menu, remembered per profile, playback keeps running', async ({ page, api }) => {
    await page.goto('/watch/' + MOVIE.id);
    await videoReady(page);
    await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
    await page.getByRole('button', { name: 'Audio und Untertitel' }).click();
    const menu = page.getByRole('dialog', { name: 'Audio und Untertitel' });
    const voice = menu.getByRole('switch', { name: /Klare Stimmen/ });
    await expect(voice).toHaveAttribute('aria-checked', 'false');
    await voice.click();
    await expect(voice).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.toast')).toHaveText('Klare Stimmen an');
    expect(await page.evaluate(() => localStorage.getItem('ff_audiofx:p1'))).toBe(JSON.stringify({ voice: true, night: false }));
    await menu.getByRole('switch', { name: /Nachtmodus/ }).click(); // the menu stays open for the second switch
    await expect(menu.getByRole('switch', { name: /Nachtmodus/ })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => api.audioFx).toBe('both'); // the profile's server pref (follows it to other devices)
    await shot(page, 'desktop-sound');
    const t0 = await page.evaluate(() => document.querySelector('video')!.currentTime);
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime), { timeout: 5000 }).toBeGreaterThan(t0 + 0.5);
    // a reload keeps the choice (same profile)
    await page.reload();
    await videoReady(page);
    await page.getByRole('button', { name: 'Audio und Untertitel' }).click();
    await expect(page.getByRole('switch', { name: /Nachtmodus/ })).toHaveAttribute('aria-checked', 'true');
  });

  test('sound: the server pref wins over this browser\'s copy (changed on another device)', async ({ page, api }) => {
    api.audioFx = 'night';
    await page.addInitScript(() => localStorage.setItem('ff_audiofx:p1', JSON.stringify({ voice: true, night: false })));
    await page.goto('/watch/' + MOVIE.id);
    await videoReady(page);
    await page.getByRole('button', { name: 'Audio und Untertitel' }).click();
    await expect(page.getByRole('switch', { name: /Nachtmodus/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('switch', { name: /Klare Stimmen/ })).toHaveAttribute('aria-checked', 'false');
  });

  test('sound modes are off and explained where Web Audio is missing', async ({ page }) => {
    await page.addInitScript(() => { delete (window as { AudioContext?: unknown }).AudioContext; delete (window as { webkitAudioContext?: unknown }).webkitAudioContext; });
    await page.goto('/watch/' + MOVIE.id);
    await videoReady(page);
    await page.getByRole('button', { name: 'Audio und Untertitel' }).click();
    await expect(page.getByRole('switch', { name: /Klare Stimmen/ })).toBeDisabled();
    await expect(page.getByText('Auf diesem Gerät nicht verfügbar')).toBeVisible();
  });
});

test.describe('player without chapters', () => {
  test('no marks, no scenes button', async ({ page, api: _api }) => {
    await mockPlayer(page, { chapters: [] });
    await page.goto('/watch/' + MOVIE.id);
    await videoReady(page);
    await expect(page.locator('.track .chap')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Szenen', exact: true })).toHaveCount(0);
  });
});
