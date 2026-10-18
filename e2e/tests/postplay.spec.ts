// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { ME, MOVIE, SERIES, episodes, items } from '../mocks/fixtures.js';
import { CAUGHT_UP, FINISHED, LAST_EP, MOVIE_END, because, endTitle, mockPostplay, toCredits } from '../mocks/postplay.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';

// 1.1 A1+A2: the "caught-up" post-play screen (spec §3.2 / §3.5): movie end, ongoing series with a reminder, finished series with a
// wish, calm mode, TV-mode arrow keys, all 7 languages. Nothing ever autoplays; Esc / Back stays on the title.

const path = (page: Page) => new URL(page.url()).pathname;

test.describe('post-play screen (desktop)', () => {
  test('movie end: card from the credits, full screen on ended, nothing autoplays, Esc stays on the title', async ({ page, api }) => {
    await mockPlayer(page, { chapters: [] });
    await mockPostplay(page, MOVIE.id, MOVIE_END);
    await page.goto('/watch/' + MOVIE.id);
    await videoReady(page);
    await expect(page.getByTestId('postplay-card')).toHaveCount(0);
    await toCredits(page);
    const card = page.getByTestId('postplay-card');
    await expect(card).toContainText('Fertig? Sieh dir an, was als Nächstes kommt');
    await expect(page.getByTestId('postplay')).toHaveCount(0); // the card does not block anything
    await endTitle(page);
    const pp = page.getByTestId('postplay');
    await expect(pp.getByRole('heading', { level: 1 })).toHaveText('Du hast „Inkwell“ gesehen');
    await expect(pp.getByRole('heading', { level: 1 })).toHaveAttribute('aria-live', 'polite');
    await expect(pp.getByRole('heading', { level: 2, name: 'Weil du „Inkwell“ gesehen hast' })).toBeVisible();
    await expect(pp.getByRole('heading', { level: 2, name: 'Passt zu deinem Geschmack' })).toBeVisible();
    await expect(pp.getByText('Unser Tipp für dich')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0); // a screen, not a pop-up
    await expect.poll(() => api.postplayEvents).toContainEqual({ type: 'shown', state: 'movie_end' });
    await page.waitForTimeout(1500);
    expect(path(page)).toBe('/watch/' + MOVIE.id); // never autoplays a recommendation
    await page.keyboard.press('Escape');
    await expect(pp).toHaveCount(0);
    expect(path(page)).toBe('/watch/' + MOVIE.id); // Esc never redirects away from the title
    await expect.poll(() => api.postplayEvents).toContainEqual({ type: 'dismiss' });
  });

  test('inline "Not interested" with Undo, list toggle, play only on request', async ({ page, api }) => {
    await mockPlayer(page, { chapters: [] });
    await mockPostplay(page, MOVIE.id, MOVIE_END);
    await page.goto('/watch/' + MOVIE.id);
    await toCredits(page);
    await page.getByTestId('postplay-card').getByRole('button', { name: 'Was als Nächstes?' }).click();
    const pp = page.getByTestId('postplay');
    const hero = pp.getByRole('article');
    await expect(hero.getByRole('heading', { level: 2 })).toContainText(items[2]!.name);
    await hero.getByRole('button', { name: 'Kein Interesse' }).click();
    await expect(pp.getByText(`Verstanden: „${items[2]!.name}“ schlagen wir dir nicht mehr vor.`)).toBeVisible();
    await expect(pp.getByRole('article')).toHaveCount(0);
    await pp.getByRole('button', { name: 'Rückgängig' }).click();
    await expect(pp.getByText('Rückgängig gemacht.')).toBeVisible();
    await expect(pp.getByRole('article')).toBeVisible();
    expect(api.log.filter((l) => l.includes(`/api/items/${items[2]!.id}/thumb`))).toEqual([
      `PUT /api/items/${items[2]!.id}/thumb {"value":-1} -> 200`, `PUT /api/items/${items[2]!.id}/thumb {"value":0} -> 200`,
    ]);
    const add = pp.getByRole('article').getByRole('button', { name: 'Auf die Merkliste' });
    await add.click();
    await expect(pp.getByRole('article').getByRole('button', { name: 'Auf der Merkliste' })).toHaveAttribute('aria-pressed', 'true');
    await pp.getByRole('article').getByRole('link', { name: 'Abspielen' }).click();
    await expect(page).toHaveURL(new RegExp(`/watch/${items[2]!.id}$`));
    await expect.poll(() => api.postplayEvents).toContainEqual({ type: 'play', row: 'because' });
  });

  test('browser Back while the screen is open closes it and stays on the title', async ({ page }) => {
    await mockPlayer(page, { chapters: [] });
    await mockPostplay(page, MOVIE.id, MOVIE_END);
    await page.goto('/');
    await page.goto('/watch/' + MOVIE.id);
    await toCredits(page);
    await endTitle(page);
    const pp = page.getByTestId('postplay');
    await expect(pp.getByRole('heading', { level: 1 })).toBeVisible();
    await page.goBack();
    await expect(pp).toHaveCount(0);
    expect(path(page)).toBe('/watch/' + MOVIE.id);
    // no extra entry is left behind: the next Back leaves the watch page as usual
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
  });

  test('a title played from the screen replaces the finished one: one Back leaves the player', async ({ page }) => {
    await mockPlayer(page, { chapters: [] });
    await mockPostplay(page, MOVIE.id, MOVIE_END);
    await page.goto('/');
    await page.goto('/watch/' + MOVIE.id);
    await toCredits(page);
    await endTitle(page);
    const pp = page.getByTestId('postplay');
    await pp.getByRole('article').getByRole('link', { name: 'Abspielen' }).click();
    await expect(page).toHaveURL(new RegExp(`/watch/${items[2]!.id}$`));
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
  });

  test('"Not interested" → Undo puts back the thumb the title had before', async ({ page }) => {
    await mockPlayer(page, { chapters: [] });
    await mockPostplay(page, MOVIE.id, MOVIE_END);
    await page.route(`**/api/items/${items[2]!.id}/thumb`, (r) => r.fulfill({ json: { value: r.request().postDataJSON().value, previous: 2 } }));
    await page.goto('/postplay/' + MOVIE.id);
    const pp = page.getByTestId('postplay');
    const puts: unknown[] = [];
    page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes(`/api/items/${items[2]!.id}/thumb`)) puts.push(r.postDataJSON()); });
    await pp.getByRole('article').getByRole('button', { name: 'Kein Interesse' }).click();
    await pp.getByRole('button', { name: 'Rückgängig' }).click();
    await expect(pp.getByText('Rückgängig gemacht.')).toBeVisible();
    expect(puts).toEqual([{ value: -1 }, { value: 2 }]); // the earlier "loved it" comes back, not "no thumb"
  });

  test('ongoing series: "You\'re caught up", next air date, Remind me; Back to the title stays', async ({ page }) => {
    await mockPlayer(page, { chapters: [] });
    await mockPostplay(page, LAST_EP.id, CAUGHT_UP);
    const posted: unknown[] = [];
    await page.route('**/api/reminders', (r) => { posted.push(r.request().postDataJSON()); return r.fulfill({ json: { id: 7, coveredByFollow: false } }); });
    await page.goto('/watch/' + LAST_EP.id);
    await toCredits(page);
    await endTitle(page);
    const pp = page.getByTestId('postplay');
    await expect(pp.getByRole('heading', { level: 1 })).toHaveText('Du bist auf dem neuesten Stand');
    await expect(pp).toContainText('Alle verfügbaren Folgen von „Bright Valley“ gesehen.');
    await expect(pp).toContainText(/Nächste Folge am 21\.10\.2026/);
    const remind = pp.getByRole('button', { name: 'Erinnere mich' });
    await remind.click();
    await expect(pp.getByRole('button', { name: 'Erinnerung aktiv' })).toHaveAttribute('aria-pressed', 'true');
    expect(posted).toEqual([{ episodeId: CAUGHT_UP.remind.episodeId }]);
    await pp.getByRole('button', { name: 'Zurück zum Titel' }).click();
    await expect(pp).toHaveCount(0);
    expect(path(page)).toBe('/watch/' + LAST_EP.id);
  });

  test('finished series on /postplay/:id: wish for the missing season with the monthly limit', async ({ page }) => {
    await mockPostplay(page, LAST_EP.id, FINISHED);
    const wished: unknown[] = [];
    await page.route('**/api/requests', (r) => { wished.push(r.request().postDataJSON()); return r.fulfill({ json: { id: 9, status: 'angefragt' } }); });
    await page.goto('/postplay/' + LAST_EP.id);
    const pp = page.getByTestId('postplay');
    await expect(pp.getByRole('heading', { level: 1 })).toHaveText('Du hast „Bright Valley“ zu Ende geschaut');
    await expect(pp.getByText('Noch 2 Wünsche in diesem Monat')).toBeVisible();
    await pp.getByRole('button', { name: 'Fehlende Staffel wünschen' }).click();
    await expect(pp.getByRole('button', { name: 'Gewünscht' })).toBeVisible();
    expect(wished).toEqual([{ mediaType: 'tv', tmdbId: 1396 }]);
    await expect(page).toHaveTitle(/Was als Nächstes\?/);
  });

  test('gap with spoiler protection: jump back first, no thumbnail of the unwatched episode', async ({ page }) => {
    const gapEp = { ...episodes[1]!, played: false, positionTicks: 0, overview: undefined };
    await page.route('**/api/prefs', (r) => r.fulfill({ json: { prefs: { spoilerProtection: true } } }));
    await mockPostplay(page, LAST_EP.id, { ...CAUGHT_UP, state: 'gap', remind: null, nextAirDate: null, next: gapEp, rows: [{ kind: 'continuation', title: SERIES.name, reason: {}, items: [gapEp] }, because(SERIES)] });
    await page.goto('/postplay/' + LAST_EP.id);
    const pp = page.getByTestId('postplay');
    await expect(pp.getByRole('heading', { level: 1 })).toHaveText('Folge 2 ist noch ungesehen');
    await expect(pp.getByRole('link', { name: 'Zu Folge 2 springen' })).toHaveAttribute('href', `/watch/${gapEp.id}`);
    const tile = pp.locator('[data-kind="continuation"] li').first();
    await expect(tile.locator('img')).toHaveCount(0);
    await expect(tile).toContainText('Ungesehene Folge: Vorschau ausgeblendet');
    await expect(pp).not.toContainText('Episode overview.');
  });

  test.describe('calm mode', () => {
    test.use({ reducedMotion: 'no-preference' });
    test('no motion and no trailer: nothing animates or plays on the screen', async ({ page }) => {
      const media: string[] = [];
      page.on('request', (r) => { if (/\/trailer$|preview\.mp4/.test(r.url())) media.push(r.url()); });
      await mockPostplay(page, MOVIE.id, MOVIE_END);
      // without calm mode the screen fades in (proves the check below can fail)
      await page.goto('/postplay/' + MOVIE.id);
      await expect(page.getByTestId('postplay')).not.toHaveClass(/still/);
      await page.route('**/api/prefs', (r) => r.fulfill({ json: { prefs: { calm: true } } }));
      await page.goto('/postplay/' + MOVIE.id);
      const pp = page.getByTestId('postplay');
      await expect(pp.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(pp).toHaveClass(/still/);
      const animated = await pp.evaluate((el) => [el, ...el.querySelectorAll('*')].filter((e) => getComputedStyle(e).animationName !== 'none' || parseFloat(getComputedStyle(e).transitionDuration) > 0).length);
      expect(animated).toBe(0);
      await expect(pp.locator('video, audio')).toHaveCount(0);
      expect(media).toEqual([]);
    });
  });

  test('TV mode: arrow keys move the focus through the screen', async ({ page }) => {
    await mockPostplay(page, MOVIE.id, MOVIE_END);
    await page.goto(`/postplay/${MOVIE.id}?tv=1`);
    await expect(page.locator('html')).toHaveClass(/\btv\b/);
    const pp = page.getByTestId('postplay');
    const play = pp.getByRole('article').getByRole('link', { name: 'Abspielen' });
    await expect(play).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(pp.getByRole('article').getByRole('button', { name: 'Auf die Merkliste' })).toBeFocused();
    // down through the hero's second button line (large TV type wraps it) into the first row
    const inRow = () => page.evaluate(() => Boolean(document.activeElement?.closest('.tiles')));
    for (let n = 0; n < 4 && !(await inRow()); n++) await page.keyboard.press('ArrowDown');
    expect(await inRow()).toBe(true);
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="postplay"]')))).toBe(true);
    const first = await page.evaluate(() => document.activeElement?.getAttribute('href'));
    const href = () => page.evaluate(() => document.activeElement?.getAttribute('href'));
    await page.keyboard.press('ArrowLeft'); // along the row (Down may land on its last tile)
    if ((await href()) === first) await page.keyboard.press('ArrowRight');
    await expect.poll(href).not.toBe(first);
    expect(await inRow()).toBe(true);
    expect(path(page)).toBe('/postplay/' + MOVIE.id);
  });

  test.describe('i18n: the screen boots in all 7 languages', () => {
    const want: Record<string, string> = {
      de: 'Du hast „Inkwell“ gesehen', en: 'You finished “Inkwell”', fr: 'Vous avez vu « Inkwell »', es: 'Has visto «Inkwell»',
      it: 'Hai visto “Inkwell”', tr: '“Inkwell” izlendi', pl: 'Obejrzano „Inkwell”',
    };
    for (const [lang, head] of Object.entries(want)) {
      test(lang, async ({ page }) => {
        await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, language: lang, languageChosen: true, defaultLanguage: 'de', defaultLanguageSet: true } }));
        await mockPostplay(page, MOVIE.id, MOVIE_END);
        await page.goto('/postplay/' + MOVIE.id);
        await expect(page.locator('html')).toHaveAttribute('lang', lang);
        await expect(page.getByTestId('postplay').getByRole('heading', { level: 1 })).toHaveText(head);
      });
    }
  });

  test('switched off (POSTPLAY_ENABLED=false): the old "more like this" card, no post-play calls', async ({ page, api }) => {
    api.features = { requests: true, postplay: false };
    let calls = 0;
    await page.route('**/api/items/*/postplay', (r) => { calls++; return r.fulfill({ json: MOVIE_END }); });
    await mockPlayer(page, { chapters: [] });
    await page.goto('/watch/' + MOVIE.id);
    await videoReady(page);
    await page.evaluate(() => { const v = document.querySelector('video')!; v.pause(); v.currentTime = v.duration - 8; });
    await expect(page.getByRole('dialog', { name: 'Mehr davon' })).toBeVisible();
    await endTitle(page);
    await page.waitForTimeout(500);
    await expect(page.getByTestId('postplay')).toHaveCount(0);
    expect(calls).toBe(0);
  });
});
