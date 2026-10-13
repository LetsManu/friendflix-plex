import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { episodes } from '../mocks/fixtures.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';

/**
 * The player on an iPhone 15 Pro (home-screen app): portrait 393x852 with the status bar / Dynamic Island on top (59 px) and
 * the home indicator below (34 px); landscape 852x393 with the island on a side edge (59 px left and right) and 21 px below.
 * Chromium reports no insets, so the --safe-* tokens from app.css are forced (the app reads the insets only through them).
 * PHONE_SHOTS=<dir> [PHONE_SHOTS_TAG=before|after] saves a screenshot of each layout.
 */
type Insets = { top: number; right: number; bottom: number; left: number };
const LAYOUTS = [
  { name: 'portrait', viewport: { width: 393, height: 852 }, safe: { top: 59, right: 0, bottom: 34, left: 0 } },
  { name: 'landscape', viewport: { width: 852, height: 393 }, safe: { top: 0, right: 59, bottom: 21, left: 59 } },
] as const;
const EP = episodes[2]!;
const EP_NAME = 'Overgeared - S01E03 - The Blacksmith Who Would Not Stop Talking';
const SHOTS = process.env.PHONE_SHOTS;

async function forceSafeArea(page: Page, s: Insets) {
  await page.addInitScript((v) => {
    const apply = () => {
      const st = document.documentElement?.style;
      if (!st) return;
      for (const [k, px] of Object.entries(v)) st.setProperty(`--safe-${k}`, `${px}px`);
    };
    apply();
    document.addEventListener('readystatechange', apply);
  }, s);
}

/** iOS ignores a programmatic volume (the hardware buttons own it): reading it back still gives 1 */
const forceIosVolume = (page: Page) => page.addInitScript(() => {
  Object.defineProperty(HTMLMediaElement.prototype, 'volume', { configurable: true, get: () => 1, set: () => undefined });
});

async function openEpisode(page: Page) {
  await mockPlayer(page);
  await page.route(`**/api/items/${EP.id}`, (r) => r.fulfill({ json: { item: { ...EP, name: EP_NAME } } }));
  await page.goto('/watch/' + EP.id);
  await videoReady(page);
  await expect(page.locator('.top .ttl')).toContainText(EP_NAME.slice(0, 12));
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
}

/** the bar hides after 3 s of playback: a tap on the picture (away from the centre controls) brings it back */
async function showControls(page: Page) {
  if (await page.locator('.ctl.hide').count()) await page.locator('.stage').tap({ position: { x: 30, y: page.viewportSize()!.height * 0.3 } });
  await expect(page.locator('.ctl.hide')).toHaveCount(0);
  await expect(page.locator('.cc.hide')).toHaveCount(0);
}

type Box = { name: string; x: number; y: number; w: number; h: number };
/** every visible, hit-testable control of the player chrome (top bar, centre, bottom bar) */
const controls = (page: Page) => page.evaluate(() => {
  const out: Box[] = [];
  for (const el of document.querySelectorAll<HTMLElement>('.ovl button, .cc button, .ctl button, .ctl [role="slider"]')) {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    if (getComputedStyle(el).pointerEvents === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    out.push({ name: el.getAttribute('aria-label') ?? el.textContent!.trim().slice(0, 24), x: r.x, y: r.y, w: r.width, h: r.height });
  }
  return out;
});
const overlap = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;

for (const L of LAYOUTS) {
  test.describe(`phone player, ${L.name} (iPhone safe areas)`, () => {
    test.use({ viewport: L.viewport });
    test.beforeEach(async ({ page }) => { await forceSafeArea(page, L.safe); });

    test('controls do not overlap, stay inside the safe area and are big enough to tap', async ({ page, api: _api }) => {
      await openEpisode(page);
      await showControls(page);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${process.env.PHONE_SHOTS_TAG ?? 'after'}-${L.name}.png` });
      const boxes = await controls(page);
      const { width: vw, height: vh } = L.viewport;
      expect(boxes.length).toBeGreaterThanOrEqual(9);
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i]!;
        // inside the safe area (no control under the Dynamic Island, the status bar or the home indicator)
        expect.soft(b.x, `${b.name} left`).toBeGreaterThanOrEqual(L.safe.left - 0.5);
        expect.soft(b.x + b.w, `${b.name} right`).toBeLessThanOrEqual(vw - L.safe.right + 0.5);
        expect.soft(b.y, `${b.name} top`).toBeGreaterThanOrEqual(L.safe.top - 0.5);
        expect.soft(b.y + b.h, `${b.name} bottom`).toBeLessThanOrEqual(vh - L.safe.bottom + 0.5);
        if (b.name !== 'Position') { // the seek bar is a thin line with a taller invisible hit area
          expect.soft(b.w, `${b.name} width`).toBeGreaterThanOrEqual(44);
          expect.soft(b.h, `${b.name} height`).toBeGreaterThanOrEqual(44);
        }
        for (const o of boxes.slice(i + 1)) expect.soft(overlap(b, o), `${b.name} overlaps ${o.name}`).toBe(false);
      }
      // the centre: big play / pause between -10 and +10, nothing else there
      const cc = page.locator('.cc button');
      await expect(cc).toHaveCount(3);
      for (const name of ['Pause', '10 Sekunden zurück', '10 Sekunden vor']) {
        const b = (await page.locator('.cc').getByRole('button', { name, exact: true }).boundingBox())!;
        expect(b.width).toBeGreaterThanOrEqual(56); expect(b.height).toBeGreaterThanOrEqual(56);
      }
      const centre = (await page.locator('.cc').getByRole('button', { name: 'Pause', exact: true }).boundingBox())!;
      expect(Math.abs(centre.x + centre.width / 2 - vw / 2)).toBeLessThan(2);
      // both times beside the seek bar
      await expect(page.locator('.ctl .cur')).toHaveText(/^\d+:\d\d$/);
      await expect(page.locator('.ctl .rem')).toHaveText(/^−\d+:\d\d$/);
      const [cur, track, rem] = await Promise.all(['.ctl .cur', '.ctl .track', '.ctl .rem'].map(async (s) => (await page.locator(s).boundingBox())!));
      expect(cur!.x + cur!.width).toBeLessThanOrEqual(track!.x);
      expect(track!.x + track!.width).toBeLessThanOrEqual(rem!.x);
      // the quality chip sits in the top bar, the volume / lock buttons are not in the bar's way
      const chip = (await page.getByRole('button', { name: /^Original/ }).boundingBox())!;
      expect(chip.y + chip.height).toBeLessThan(vh / 3);
      await expect(page.getByRole('button', { name: 'Bedienung sperren' })).toHaveCount(0);
      // the bottom bar reaches the screen edge (its background covers the home indicator strip)
      const bar = (await page.locator('.ctl').boundingBox())!;
      expect(Math.round(bar.y + bar.height)).toBe(vh);
    });

    test('the title uses the width of the top bar on one line', async ({ page, api: _api }) => {
      await openEpisode(page);
      await showControls(page);
      const t = await page.locator('.top .ttl').evaluate((el) => {
        const r = el.getBoundingClientRect(), b = el.querySelector('b')!.getBoundingClientRect();
        return { w: r.width, h: r.height, right: r.right, bRight: b.right, lh: parseFloat(getComputedStyle(el).lineHeight) || 20, text: el.textContent ?? '' };
      });
      expect(t.text).toContain('Bright Valley');
      expect(t.text).toContain('S1:E3');
      expect(t.h).toBeLessThan(t.lh * 1.6); // one line
      expect(t.bRight).toBeLessThanOrEqual(t.right + 0.5); // the series name is shown in full
      expect(t.w).toBeGreaterThan(L.name === 'landscape' ? 400 : 150);
      const chip = (await page.getByRole('button', { name: /^Original/ }).boundingBox())!;
      expect(t.right).toBeLessThanOrEqual(chip.x);
    });
  });
}

test.describe('phone player, iOS volume', () => {
  test.use({ viewport: { width: 393, height: 852 } });

  test('no volume button where the volume cannot be set (iOS); mute stays elsewhere', async ({ page, api: _api }) => {
    await forceIosVolume(page);
    await openEpisode(page);
    await showControls(page);
    await expect(page.getByRole('button', { name: 'Vollbild' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Stumm|Ton an)$/ })).toHaveCount(0);
  });

  test('the mute button stays where the volume works', async ({ page, api: _api }) => {
    await openEpisode(page);
    await showControls(page);
    await expect(page.locator('.ctl').getByRole('button', { name: /^(Stumm|Ton an)$/ })).toBeVisible();
  });

  test('lock lives in More; the unlock button sits alone at the bottom', async ({ page, api: _api }) => {
    await forceSafeArea(page, { top: 59, right: 0, bottom: 34, left: 0 });
    await openEpisode(page);
    await showControls(page);
    await page.getByRole('button', { name: 'Mehr', exact: true }).tap();
    await page.getByRole('button', { name: 'Bedienung sperren' }).tap();
    await expect(page.locator('.stage.locked')).toHaveCount(1);
    const unlock = page.getByRole('button', { name: 'Entsperren (gedrückt halten)' });
    await expect(unlock).toBeVisible();
    const b = (await unlock.boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(852 - 34);
    await expect(page.locator('.cc button')).toHaveCount(0);
    await expect(page.locator('.ctl.hide')).toHaveCount(1);
  });

  test('menus open above the bottom bar inside the safe area', async ({ page, api: _api }) => {
    await forceSafeArea(page, { top: 59, right: 0, bottom: 34, left: 0 });
    await openEpisode(page);
    await showControls(page);
    await page.getByRole('button', { name: 'Mehr', exact: true }).tap();
    const menu = page.getByRole('dialog', { name: 'Mehr' });
    await expect(menu).toBeVisible();
    const m = (await menu.boundingBox())!, track = (await page.locator('.ctl .timeline').boundingBox())!;
    expect(m.y + m.height).toBeLessThanOrEqual(track.y);
    expect(m.y).toBeGreaterThanOrEqual(59);
  });
});
