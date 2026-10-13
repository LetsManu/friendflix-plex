import { MOVIE } from '../mocks/fixtures.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';

test('main bar buttons ≥ 48 px; speed reachable via More', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  if (await page.locator('.ctl.hide').count()) await page.locator('.stage').tap({ position: { x: 195, y: 300 } });
  await expect(page.locator('.ctl.hide')).toHaveCount(0);
  const sizes = await page.locator('.ctl .row .ic').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.width, r.height]; }));
  expect(sizes.length).toBeGreaterThan(4);
  for (const [w, h] of sizes) { expect(w).toBeGreaterThanOrEqual(48); expect(h).toBeGreaterThanOrEqual(48); }
  await expect(page.getByRole('button', { name: /^Wiedergabetempo/ })).toHaveCount(0); // not in the main bar
  await expect(page.getByRole('button', { name: 'Szenen', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Mehr', exact: true }).tap();
  await page.getByRole('button', { name: /^Wiedergabetempo/ }).tap();
  await page.getByRole('button', { name: '1,5×' }).tap();
  expect(await page.evaluate(() => document.querySelector('video')!.playbackRate)).toBe(1.5);
});
