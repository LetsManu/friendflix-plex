// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { MOVIE, SERIES } from '../mocks/fixtures.js';
import { test } from '../fixtures.js';

/**
 * Block 21: records the scroll height of the detail page (movie + series, desktop + phone width) as annotations, for the
 * before/after numbers of the layout change. Always passes; read the numbers from the report (`--reporter=json` or list output).
 */
const SIZES = [{ w: 1440, h: 900 }, { w: 390, h: 844 }] as const;
const PAGES = [{ name: 'movie', id: MOVIE.id }, { name: 'series', id: SERIES.id }] as const;

test('detail page scroll height', async ({ page }) => {
  const out: string[] = [];
  for (const s of SIZES) {
    for (const p of PAGES) {
      await page.setViewportSize({ width: s.w, height: s.h });
      await page.goto('/item/' + p.id);
      await page.locator('h1').first().waitFor();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(600); // late rows (more like this, cast) settle
      const hgt = await page.evaluate(() => document.scrollingElement!.scrollHeight);
      out.push(`${p.name}@${s.w}=${hgt}`);
      test.info().annotations.push({ type: 'scrollHeight', description: `${p.name} ${s.w}x${s.h}: ${hgt}` });
    }
  }
  console.log('[measure] ' + out.join(' '));
});
