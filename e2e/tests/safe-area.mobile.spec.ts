// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { MOVIE } from '../mocks/fixtures.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';

/**
 * iPhone home-screen app (viewport-fit=cover, black-translucent status bar): env(safe-area-inset-top) is 59 px on an
 * iPhone 15 Pro, so the page starts under the status bar / Dynamic Island. Chromium reports 0, so the tests force the
 * --safe-* tokens from app.css (the app reads the insets only through them) to the values measured on the device.
 */
const TOP = 59;
const BOTTOM = 34;

async function forceSafeArea(page: Page, top = TOP, bottom = BOTTOM) {
  await page.addInitScript(([t, b]) => {
    const apply = () => {
      const s = document.documentElement?.style;
      if (!s) return;
      s.setProperty('--safe-top', `${t}px`);
      s.setProperty('--safe-bottom', `${b}px`);
    };
    apply();
    document.addEventListener('readystatechange', apply);
  }, [top, bottom]);
}

/** Visible, hit-testable controls whose box reaches into the top `limit` px of the viewport. */
const controlsUnder = (page: Page, limit: number) =>
  page.evaluate((lim) => {
    const sel = 'a[href], button, input, select, textarea, [role="button"], [role="tab"], [tabindex]:not([tabindex="-1"])';
    const hits: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      if (getComputedStyle(el).pointerEvents === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.top >= innerHeight) continue;
      if (r.top < lim - 0.5) hits.push(`${el.tagName.toLowerCase()}.${el.className} "${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30)}" @${Math.round(r.top)}`);
    }
    return hits;
  }, limit);

const top = async (l: Locator) => (await l.boundingBox())!.y;

async function expectBelowStatusBar(page: Page, first: Locator) {
  await expect(first).toBeVisible();
  expect(await top(first)).toBeGreaterThanOrEqual(TOP);
  expect(await controlsUnder(page, TOP)).toEqual([]);
}

test.describe('safe area top (iPhone home-screen app)', () => {
  test.beforeEach(async ({ page }) => { await forceSafeArea(page); });

  test('home: the header row sits below the status bar, its background covers the strip', async ({ page }) => {
    await page.goto('/');
    const header = page.locator('header.nav.m');
    await expectBelowStatusBar(page, header.locator('.mrow'));
    const box = (await header.boundingBox())!;
    expect(box.y).toBe(0); // the header itself still starts at the top edge: its background fills the status bar area
    expect(box.height).toBeGreaterThanOrEqual(TOP + 56);
    // the hero starts below the full header (incl. chip bar) + status bar
    const nav = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h')));
    const pad = await page.locator('.mh').first().evaluate((e) => parseFloat(getComputedStyle(e).paddingTop));
    expect(pad).toBeGreaterThanOrEqual(TOP + nav);
  });

  test('detail page: video and sticky tabs stop under header + status bar', async ({ page }) => {
    await page.goto('/item/' + MOVIE.id);
    await expect(page.getByRole('heading', { level: 1, name: MOVIE.name })).toBeVisible();
    await expectBelowStatusBar(page, page.locator('header.nav.m .mrow'));
    const total = await page.evaluate(() => (document.querySelector('header.nav.m') as HTMLElement).getBoundingClientRect().bottom);
    expect(await top(page.locator('.dv .hero').first())).toBeGreaterThanOrEqual(total - 1);
    const tabs = page.getByRole('tablist', { name: 'Weitere Inhalte' });
    await tabs.scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 2000);
    await expect.poll(() => top(tabs)).toBeGreaterThanOrEqual(total - 1);
  });

  for (const [path, name] of [['/downloads', 'Downloads'], ['/diagnose', 'Anzeige-Diagnose']] as const) {
    test(`${path}: header row and heading below the status bar`, async ({ page }) => {
      await page.goto(path);
      const h1 = page.getByRole('heading', { level: 1, name });
      await expect(h1).toBeVisible();
      await expectBelowStatusBar(page, page.locator('header.nav.m .mrow'));
      const header = (await page.locator('header.nav.m').boundingBox())!;
      expect(await top(h1)).toBeGreaterThanOrEqual(header.y + header.height);
    });
  }

  test('/me: header row and content below the status bar', async ({ page }) => {
    await page.goto('/me');
    await expect(page.getByRole('heading', { level: 1, name: 'Mein Bereich' })).toBeAttached();
    await expectBelowStatusBar(page, page.locator('header.nav.m .mrow'));
    const header = (await page.locator('header.nav.m').boundingBox())!;
    const pad = await page.locator('main').evaluate((e) => parseFloat(getComputedStyle(e).paddingTop));
    expect(pad).toBeGreaterThanOrEqual(header.y + header.height);
  });

  test('player: back button and title row below the status bar', async ({ page }) => {
    await mockPlayer(page);
    await page.goto('/watch/' + MOVIE.id);
    await videoReady(page);
    if (await page.locator('.ovl.hide').count()) await page.locator('.stage').tap({ position: { x: 195, y: 400 } });
    await expect(page.locator('.ovl.hide')).toHaveCount(0);
    await expectBelowStatusBar(page, page.locator('.top .icon-btn').first());
  });

  test('offline page: heading below the status bar', async ({ page }) => {
    await page.goto('/offline');
    await expectBelowStatusBar(page, page.getByRole('heading', { level: 1 }));
  });

  test('profiles picker: logo and profiles below the status bar', async ({ page }) => {
    await page.goto('/profiles');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await top(page.locator('.brand'))).toBeGreaterThanOrEqual(TOP);
    expect(await controlsUnder(page, TOP)).toEqual([]);
  });

  test('the bottom tab bar keeps its safe-area padding', async ({ page }) => {
    await page.goto('/me');
    const bar = page.locator('nav.tabbar');
    await expect(bar).toBeVisible();
    expect(await bar.evaluate((e) => getComputedStyle(e).paddingBottom)).toBe(`${BOTTOM}px`);
    const box = (await bar.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(844);
  });
});

test.describe('safe area top = 0 (browsers, Android, TV): layout unchanged', () => {
  test('header at the top edge with its own height; content offset = header height', async ({ page }) => {
    await page.goto('/downloads');
    await expect(page.getByRole('heading', { level: 1, name: 'Downloads' })).toBeVisible();
    const header = (await page.locator('header.nav.m').boundingBox())!;
    expect(header.y).toBe(0);
    expect(await top(page.locator('header.nav.m .mrow'))).toBe(0);
    const { navH, pad, total } = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        navH: parseFloat(root.getPropertyValue('--nav-h')),
        pad: parseFloat(getComputedStyle(document.querySelector('main') as HTMLElement).paddingTop),
        total: (document.querySelector('header.nav.m') as HTMLElement).getBoundingClientRect().height,
      };
    });
    expect(total).toBe(navH);
    expect(pad).toBe(navH + 24); // .page: calc(var(--nav-total) + 1.5rem)
  });

  test('player top bar keeps its .8rem padding', async ({ page }) => {
    await mockPlayer(page);
    await page.goto('/watch/' + MOVIE.id);
    await videoReady(page);
    expect(await page.locator('.top').first().evaluate((e) => getComputedStyle(e).paddingTop)).toBe('12.8px');
  });
});
