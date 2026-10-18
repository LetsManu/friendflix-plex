// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { episodes } from './fixtures.js';
import { mockPlayer, videoReady } from './scenes.js';

/** Moving on to the next episode inside the player replaces the history entry: ONE Back leaves the player, however many episodes ran. */
const [E1, E2, E3] = [episodes[1]!, episodes[2]!, episodes[3]!];

async function setup(page: Page) {
  await mockPlayer(page);
  // the episode after the current one
  await page.route('**/api/items/*/next', (r) => {
    const id = /items\/([0-9a-f]+)\/next/.exec(r.request().url())![1];
    const i = episodes.findIndex((e) => e.id === id);
    return r.fulfill({ json: { item: i >= 0 ? episodes[i + 1] ?? null : null } });
  });
  for (const e of episodes) await page.route(`**/api/items/${e.id}`, (r) => r.fulfill({ json: { item: e } }));
}
const path = (page: Page) => new URL(page.url()).pathname;
const watching = (page: Page, id: string) => expect.poll(() => path(page), { timeout: 30_000 }).toBe(`/watch/${id}`);
/** the (new) episode is loaded: the player of the previous one is gone, its video has the duration */
const ready = async (page: Page, ep: { name: string }) => { await expect(page.locator('.top')).toContainText(ep.name); await expect(page.locator('.stage video')).toHaveCount(1); await videoReady(page); await expect(page.locator('.stage.pre')).toHaveCount(0); };
/** jumps into the credits (the card shows from 575 s); the Player may still be settling its own start seek, so retry until it sticks */
async function toCredits(page: Page, playing: boolean) {
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThan(0.5); // playback has really started
  await expect.poll(() => page.evaluate(() => { const v = document.querySelector('video')!; if (v.currentTime < 575) v.currentTime = 580; return !v.seeking && v.currentTime > 575; })).toBe(true);
  // the mock clip has a frame every 20 s: from here it plays to its end at once (the countdown runs on an ended video); never play() it again, that restarts it
  if (!playing) await page.evaluate(() => document.querySelector('video')!.pause());
}

export function backTests() {
test('Back after next-episode button and autoplay countdown leaves the player in one step', async ({ page, api: _api }) => {
  await setup(page);
  await page.goto('/item/' + E1.id);
  await page.getByRole('link', { name: 'Abspielen' }).first().click();
  await watching(page, E1.id);
  await ready(page, E1);
  const historyBefore = await page.evaluate(() => history.length);

  // 1) the "Nächste Folge" button of the card
  await toCredits(page, false);
  await page.locator('.next .go').click();
  await watching(page, E2.id);
  await ready(page, E2);

  // 2) the autoplay countdown (10 s) runs out by itself
  await toCredits(page, true);
  await watching(page, E3.id);
  await ready(page, E3);

  expect(await page.evaluate(() => history.length)).toBe(historyBefore);
  await page.goBack();
  await expect.poll(() => path(page)).toBe('/item/' + E1.id);
});

test('the control-bar next button and the episode "still watching" card replace the entry too', async ({ page, api: _api }) => {
  await setup(page);
  await page.goto('/item/' + E1.id);
  await page.getByRole('link', { name: 'Abspielen' }).first().click();
  await watching(page, E1.id);
  await ready(page, E1);
  if (await page.locator('.ctl.hide').count()) await page.locator('.stage').tap({ position: { x: 30, y: 200 } }).catch(() => page.mouse.move(30, 210));
  await expect(page.locator('.ctl.hide')).toHaveCount(0);
  await page.locator('.ctl button[aria-label^="Nächste"]').click();
  await watching(page, E2.id);
  await ready(page, E2);
  await page.goBack();
  await expect.poll(() => path(page)).toBe('/item/' + E1.id);
});

test('Esc (and the TV back key) after two next episodes also leaves the player in one step', async ({ page, api: _api }) => {
  await setup(page);
  await page.goto('/item/' + E1.id);
  await page.getByRole('link', { name: 'Abspielen' }).first().click();
  await watching(page, E1.id);
  await ready(page, E1);
  for (const next of [E2, E3]) {
    await toCredits(page, false);
    await page.locator('.next .go').click();
    await watching(page, next.id);
    await ready(page, next);
  }
  await page.keyboard.press('Escape');
  await expect.poll(() => path(page)).toBe('/item/' + E1.id);
});

test('the "Are you still watching?" card: continue replaces the entry, Back leaves the player', async ({ page, api: _api }) => {
  test.setTimeout(90_000);
  await setup(page);
  // two unattended autoplays in a row are enough to be asked (the pref's minimum)
  await page.route('**/api/prefs', (r) => r.fulfill({ json: { prefs: { stillWatchingEpisodes: 2 } } }));
  await page.goto('/item/' + E1.id);
  await page.getByRole('link', { name: 'Abspielen' }).first().click();
  await watching(page, E1.id);
  await ready(page, E1);
  for (const next of [E2, E3]) {
    await toCredits(page, true);
    await watching(page, next.id);
    await ready(page, next);
  }
  await toCredits(page, false);
  const card = page.locator('.next.still');
  await expect(card).toBeVisible();
  await card.locator('.go').click();
  await watching(page, episodes[4]!.id);
  await ready(page, episodes[4]!);
  await page.goBack();
  await expect.poll(() => path(page)).toBe('/item/' + E1.id);
});
}
