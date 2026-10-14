// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { MOVIE } from '../mocks/fixtures.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';

/** The audio / subtitle menu must stay inside the window and scroll when a title has many tracks. */
const LANGS = ['Deutsch', 'English', 'Français', 'Español', 'Italiano', 'Polski', 'Türkçe', 'Nederlands', 'Svenska', 'Dansk', 'Norsk', 'Suomi', 'Čeština', 'Magyar', 'Română', 'Ελληνικά', 'Português', 'Português (Brasil)', 'Русский', 'Українська', '日本語', '한국어', '中文', 'العربية', 'עברית', 'Hrvatski'];

test.describe('player: audio and subtitle menu with many tracks', () => {
  for (const vp of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
    test(`fits ${vp.width}x${vp.height} and every option is reachable`, async ({ page, api: _api }) => {
      await page.setViewportSize(vp);
      await mockPlayer(page);
      await page.route('**/api/playback/info', (r) => r.fulfill({ json: {
        directUrl: '/media/p1test.webm', hlsUrl: '/media/p1test.webm', resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: 'ps1', maxBitrate: 60_000_000, roleMaxBitrate: 60_000_000,
        audioTracks: LANGS.slice(0, 12).map((title, index) => ({ index, title: `${title} 5.1`, language: 'x', isDefault: index === 0 })),
        subtitles: LANGS.map((title, i) => ({ index: 100 + i, title, language: 'x', codec: 'subrip' })),
      } }));
      await page.goto('/watch/' + MOVIE.id);
      await videoReady(page);
      await page.getByRole('button', { name: 'Audio und Untertitel' }).click();
      const menu = page.getByRole('dialog', { name: 'Audio und Untertitel' });
      const box = (await menu.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
      // the last subtitle and the last audio track can be scrolled to and clicked
      const last = menu.getByRole('button', { name: 'Hrvatski' });
      await last.scrollIntoViewIfNeeded();
      await last.click();
      await expect(menu).toBeHidden();
      await page.getByRole('button', { name: 'Audio und Untertitel' }).click();
      await expect(menu.getByRole('button', { name: 'Hrvatski' })).toHaveClass(/on/);
      await expect(menu.getByRole('button', { name: 'Hrvatski' })).toBeInViewport(); // reopened at the current choice
      const lastAudio = menu.getByRole('button', { name: 'Norsk 5.1' });
      await lastAudio.scrollIntoViewIfNeeded();
      const ab = (await lastAudio.boundingBox())!;
      expect(ab.y).toBeGreaterThanOrEqual(0);
      expect(ab.y + ab.height).toBeLessThanOrEqual(vp.height);
    });
  }
});
