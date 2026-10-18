// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { episodes } from './fixtures.js';
import { mockPlayer, videoReady } from './scenes.js';

/** "Skip intro/credits" and "Next episode": the whole visible button is the hit area (no bar, scrim or seek-bar layer over any part of it). Shared by player-hit(.mobile).spec.ts. */
const EP = episodes[1]!, NEXT = episodes[2]!;
export type HitViewport = { name: string; size: { width: number; height: number } | null; tv?: boolean; /** forced --safe-* insets in px (iPhone: notch / home indicator) */ safe?: { top: number; right: number; bottom: number; left: number } };


async function open(page: Page, skipSeg: boolean) {
  await mockPlayer(page);
  await page.route('**/api/items/*/next', (r) => r.fulfill({ json: { item: NEXT } }));
  if (skipSeg) await page.route('**/api/items/*/segments', (r) => r.fulfill({ json: { segments: [{ type: 'Intro', start: 0, end: 300 }] } }));
  await page.route(`**/api/items/${EP.id}`, (r) => r.fulfill({ json: { item: EP } }));
  await page.goto('/watch/' + EP.id);
  await videoReady(page);
}
/** pauses and seeks, resolves once the seek is done (a seek still pending would swallow the skip's own seek) */
async function seekTo(page: Page, t: number) {
  // playback has really started (the Player's own start seek is over), else it would undo this seek
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThan(0.5);
  await seekNow(page, t);
}
const seekNow = (page: Page, t: number) => page.evaluate((to) => new Promise<void>((res) => {
  const v = document.querySelector('video')!;
  v.pause(); v.addEventListener('seeked', () => res(), { once: true }); v.currentTime = to;
}), t);
async function wake(page: Page) {
  const vp = page.viewportSize()!;
  await page.mouse.move(20, vp.height * 0.3); await page.mouse.move(30, vp.height * 0.3);
  await expect(page.locator('.ctl.hide')).toHaveCount(0);
}
/** points on the button: the four corners (1 px inside), edge midpoints and the centre */
async function probe(page: Page, sel: string) {
  const loc = page.locator(sel);
  await expect(loc).toBeVisible();
  const b = (await loc.boundingBox())!;
  // corners sit inside the rounded corner: inset by r * (1 - cos 45deg) + 1
  const r = await loc.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0);
  const k = Math.min(r, b.height / 2) * 0.293 + 1;
  const xs = [k, b.width / 2, b.width - k], ys = [k, b.height / 2, b.height - k];
  const bad: string[] = [];
  for (const dy of ys) for (const dx of xs) {
    const x = b.x + dx, y = b.y + dy;
    const hit = await page.evaluate(([px, py, s]) => { const e = document.elementFromPoint(px as number, py as number); return e && e.closest(s as string) ? '' : e ? `${e.tagName}.${String(e.className).slice(0, 30)}` : 'none'; }, [x, y, sel]);
    if (hit) bad.push(`${Math.round(dx)},${Math.round(dy)}->${hit}`);
  }
  return { b, bad };
}

export function hitTests(viewports: readonly HitViewport[]) {
for (const v of viewports) {
  test.describe(`hit area, ${v.name}`, () => {
    test.beforeEach(async ({ page }) => {
      if (v.size) await page.setViewportSize(v.size);
      if (v.tv) {
        // TV mode from the first render on (the skip label gets its OK hint at render time), kept even if the layout resets the class
        await page.addInitScript(() => {
          const keep = () => { const h = document.documentElement; if (h && !h.classList.contains('tv')) h.classList.add('tv'); };
          keep(); document.addEventListener('readystatechange', keep);
          new MutationObserver(keep).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] });
        });
      }
      if (v.safe) {
        await page.addInitScript((ins) => {
          const apply = () => { const st = document.documentElement?.style; if (st) for (const [k, px] of Object.entries(ins)) st.setProperty(`--safe-${k}`, `${px}px`); };
          apply(); document.addEventListener('readystatechange', apply);
        }, v.safe);
      }
    });

    test('skip button and next card shown together: both fully hittable', async ({ page, api: _api }) => {
      await mockPlayer(page);
      await page.route('**/api/items/*/next', (r) => r.fulfill({ json: { item: NEXT } }));
      await page.route('**/api/items/*/segments', (r) => r.fulfill({ json: { segments: [{ type: 'Outro', start: 570, end: 600 }] } }));
      await page.route(`**/api/items/${EP.id}`, (r) => r.fulfill({ json: { item: EP } }));
      await page.goto('/watch/' + EP.id);
      await videoReady(page);
      await seekTo(page, 575);
      await wake(page);
      for (const sel of ['.skipbtn', '.next .go', '.next .sec']) {
        const { bad } = await probe(page, sel);
        expect(bad, `${sel}: ${bad.join(' ')}`).toEqual([]);
      }
      // and the two do not overlap each other
      const a = (await page.locator('.skipbtn').boundingBox())!, c = (await page.locator('.next').boundingBox())!;
      expect(a.y + a.height <= c.y + 1 || c.y + c.height <= a.y + 1 || a.x + a.width <= c.x + 1 || c.x + c.width <= a.x + 1).toBe(true);
    });

    test('skip button: every corner and edge hits it and fires the skip', async ({ page, api: _api }) => {
      await open(page, true);
      await seekTo(page, 10);
      const sel = '.skipbtn';
      await wake(page);
      const { b, bad } = await probe(page, sel);
      expect(bad, `points not on the button: ${bad.join(' ')}`).toEqual([]);
      // a real click at each corner: the intro ends at 300 s -> the video jumps there. (TV mode is driven by the remote, not the mouse: the hit-test above is its check.)
      if (v.tv) return;
      for (const [dx, dy] of [[4, 4], [b.width - 4, 4], [4, b.height - 4], [b.width - 4, b.height - 4]] as const) {
        await seekTo(page, 10);
        await wake(page);
        await page.waitForTimeout(500); // the Player's position state settles after the seek (a late timeupdate would re-create the button under the cursor)
        const bb = (await page.locator(sel).boundingBox())!;
        await page.mouse.click(bb.x + dx, bb.y + dy);
        await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThanOrEqual(299);
      }
    });

    test('next-episode card: every corner and edge of the button hits it and fires', async ({ page, api: _api }) => {
      await open(page, false);
      await seekTo(page, 575);
      const sel = '.next .go';
      await wake(page);
      const { b, bad } = await probe(page, sel);
      expect(bad, `points not on the button: ${bad.join(' ')}`).toEqual([]);
      await page.mouse.click(b.x + b.width - 6, b.y + b.height - 6);
      await expect(page).toHaveURL(new RegExp(`/watch/${NEXT.id}`));
    });

    test('control-bar next button: edges hit it', async ({ page, api: _api }) => {
      await open(page, false);
      await wake(page);
      const sel = '.ctl button[aria-label^="Nächste"]';
      const { bad } = await probe(page, sel);
      expect(bad).toEqual([]);
    });
  });
}
}
