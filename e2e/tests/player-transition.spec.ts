// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page, Route } from '@playwright/test';
import { episodes, MOVIE } from '../mocks/fixtures.js';
import { mockPlayer } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';
import { openPopout, row } from '../helpers.js';

/** Block 20 §4: into the player without a blank stage (prefetched playback info, loading poster, view transition, scroll on back). */
const INFO = { directUrl: '/media/p1test.webm', hlsUrl: '/media/p1test.webm', resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: 'ps1', maxBitrate: 60_000_000, roleMaxBitrate: 60_000_000, subtitles: [], audioTracks: [] };

/** counts /api/playback/info calls (registered after mockPlayer, so it answers them) */
async function countInfo(page: Page): Promise<{ n: number }> {
  const c = { n: 0 };
  await page.route('**/api/playback/info', (r) => { c.n++; return r.fulfill({ json: INFO }); });
  return c;
}
/** holds the video file back until release() (the poster has to be on screen before the first frame) */
async function holdVideo(page: Page): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  await page.route('**/media/p1test.webm', async (r: Route) => { await gate; await r.fallback(); });
  return release;
}
const playButton = (page: Page) => page.locator('.dv .cap').getByRole('link', { name: 'Abspielen' });
const playing = (page: Page) => page.waitForFunction(() => ((document.querySelector('.stage video') as HTMLVideoElement | null)?.readyState ?? 0) >= 2);

/** decodes a PNG screenshot in the page and returns the share of near-black / near-white pixels and the luminance spread */
async function pixelStats(page: Page, png: Buffer) {
  return page.evaluate(async (b64) => {
    const im = new Image();
    im.src = `data:image/png;base64,${b64}`;
    await im.decode();
    const c = document.createElement('canvas');
    c.width = im.naturalWidth; c.height = im.naturalHeight;
    const g = c.getContext('2d')!;
    g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let black = 0, white = 0, min = 255, max = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
      if (l < 12) black++; if (l > 243) white++;
      min = Math.min(min, l); max = Math.max(max, l);
    }
    return { black: black / n, white: white / n, spread: max - min };
  }, png.toString('base64'));
}

test.describe('into the player', () => {
  test('hover on Abspielen triggers one /api/playback/info before the click', async ({ page, api: _api }) => {
    await mockPlayer(page);
    const info = await countInfo(page);
    await page.goto('/item/' + MOVIE.id);
    await expect(playButton(page)).toBeVisible();
    expect(info.n).toBe(0);
    await playButton(page).hover();
    await expect.poll(() => info.n).toBe(1);
    await page.mouse.move(5, 400); await playButton(page).hover(); // leaving and coming back does not ask again
    await page.waitForTimeout(300);
    expect(info.n).toBe(1);
    await expect(page).toHaveURL(/\/item\//);
  });

  test('the click navigates without a second playback/info call (the prefetch is used)', async ({ page, api: _api }) => {
    await mockPlayer(page);
    const info = await countInfo(page);
    await page.goto('/item/' + MOVIE.id);
    await playButton(page).hover();
    await expect.poll(() => info.n).toBe(1);
    await playButton(page).click();
    await expect(page).toHaveURL(new RegExp(`/watch/${MOVIE.id}$`));
    await playing(page);
    expect(info.n).toBe(1);
  });

  test('a quick sweep across the play button fires nothing', async ({ page, api: _api }) => {
    await mockPlayer(page);
    const info = await countInfo(page);
    await page.goto('/item/' + MOVIE.id);
    const box = (await playButton(page).boundingBox())!;
    await page.mouse.move(box.x - 40, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width + 40, box.y + box.height / 2, { steps: 4 }); // a few ms over it, no dwell
    await page.waitForTimeout(400);
    expect(info.n).toBe(0);
  });

  test('the player shows the backdrop poster with the title before the first frame (no blank stage)', async ({ page, api: _api }) => {
    await mockPlayer(page);
    await countInfo(page);
    const release = await holdVideo(page);
    await page.goto('/item/' + MOVIE.id);
    await playButton(page).click();
    const poster = page.locator('.stage .ff-poster');
    await expect(poster).toBeVisible();
    await expect(poster.locator('img')).toHaveAttribute('src', new RegExp(`/media/Items/${MOVIE.id}/Images/Backdrop`));
    await expect(poster).toContainText(MOVIE.name);
    await expect(poster.locator('img')).toHaveJSProperty('complete', true);
    // the control bar waits for playback; the poster lets pointer input through to the stage (wheel, clicks, double clicks)
    await expect(page.locator('.stage .ctl')).toHaveClass(/hide/);
    await expect(poster).toHaveCSS('pointer-events', 'none');
    const stats = await pixelStats(page, await page.locator('.stage').screenshot());
    expect(stats.black, 'stage is not uniform black').toBeLessThan(0.9);
    expect(stats.white, 'stage is not uniform white').toBeLessThan(0.9);
    expect(stats.spread).toBeGreaterThan(40);
    release();
    await playing(page);
  });

  test('the poster fades out once playing', async ({ page, api: _api }) => {
    await mockPlayer(page);
    await countInfo(page);
    await page.goto('/item/' + MOVIE.id);
    await playButton(page).click();
    await playing(page);
    await expect(page.locator('.stage .ff-poster')).toHaveCount(0);
    await page.locator('.stage').hover();
    await expect(page.locator('.stage .ctl')).not.toHaveClass(/hide/);
  });

  test('back restores the scroll position of the home page', async ({ page, api: _api }) => {
    await mockPlayer(page);
    await countInfo(page);
    await page.goto('/');
    const card = row(page, 'Weiterschauen').locator('article.card').first(); // an episode: its play button opens the player
    await expect(card).toBeVisible();
    await page.mouse.wheel(0, 260);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(150);
    const hp = await openPopout(page, card);
    const y = await page.evaluate(() => scrollY);
    expect(y).toBeGreaterThan(150);
    await hp.getByRole('link', { name: `${episodes[0]!.name} abspielen` }).click();
    await expect(page).toHaveURL(new RegExp(`/watch/${episodes[0]!.id}`));
    await playing(page);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(row(page, 'Weiterschauen')).toBeVisible();
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(y);
  });

  test.describe('motion', () => {
    test.use({ reducedMotion: 'no-preference' });
    test('the artwork morphs into the poster with a view transition', async ({ page, api: _api }) => {
      await mockPlayer(page);
      await page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: {} })); // motion allowed: the detail hero asks for its preview
      await countInfo(page);
      await page.goto('/item/' + MOVIE.id);
      await expect(page.locator('.dv img.bg')).toBeVisible();
      await page.evaluate(() => {
        const w = window as unknown as { __vt: string[] };
        w.__vt = [];
        new MutationObserver(() => {
          const root = document.documentElement;
          if (root.classList.contains('ff-vt-in')) w.__vt.push(`in:${document.querySelector('.dv img.bg') ? getComputedStyle(document.querySelector('.dv img.bg')!).viewTransitionName : '-'}`);
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      });
      await playButton(page).click();
      await playing(page);
      const seen = await page.evaluate(() => (window as unknown as { __vt: string[] }).__vt);
      expect(seen[0]).toBe('in:ff-play-art');
      await expect(page.locator('html')).not.toHaveClass(/ff-vt-(in|play)/); // cleaned up after the transition
    });
  });

  test('reduced motion: no view transition class is set', async ({ page, api: _api }) => {
    await mockPlayer(page);
    await countInfo(page);
    await page.goto('/item/' + MOVIE.id);
    await page.evaluate(() => {
      const w = window as unknown as { __vtSeen: boolean };
      w.__vtSeen = false;
      new MutationObserver(() => { if (/ff-vt/.test(document.documentElement.className)) w.__vtSeen = true; })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    });
    await playButton(page).click();
    await playing(page);
    expect(await page.evaluate(() => (window as unknown as { __vtSeen: boolean }).__vtSeen)).toBe(false);
    await expect(page.locator('.stage .ff-poster')).toHaveCount(0);
  });

  test.describe('TV', () => {
    test.use({ reducedMotion: 'no-preference' });
    test('TV: no transition, the player still starts', async ({ page, api: _api }) => {
      await mockPlayer(page);
      const info = await countInfo(page);
      await page.addInitScript(() => sessionStorage.setItem('ff_tv', '1'));
      await page.goto('/item/' + MOVIE.id);
      await expect(page.locator('html')).toHaveClass(/\btv\b/);
      await page.evaluate(() => {
        const w = window as unknown as { __vtSeen: boolean };
        w.__vtSeen = false;
        new MutationObserver(() => { if (/ff-vt/.test(document.documentElement.className)) w.__vtSeen = true; })
          .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      });
      await playButton(page).click();
      await playing(page);
      expect(await page.evaluate(() => (window as unknown as { __vtSeen: boolean }).__vtSeen)).toBe(false);
      expect(await page.locator('.wrap').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
      expect(info.n).toBe(1);
    });
  });
});
