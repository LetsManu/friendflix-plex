import { MOVIE } from '../mocks/fixtures.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';

/** Phone without AirPlay / Chromecast receivers: the "Mehr" menu points to the TV mode (<host>/tv + phone as remote) instead. */
test('phone More menu: TV-mode hint when no AirPlay or Chromecast receiver is around', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await page.evaluate(() => document.querySelector('video')!.pause());
  if (await page.locator('.ctl.hide').count()) await page.locator('.stage').tap({ position: { x: 30, y: page.viewportSize()!.height * 0.3 } });
  await page.getByRole('button', { name: 'Mehr' }).tap();
  const hint = page.getByTestId('tv-hint');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText(`${new URL(page.url()).host}/tv`);
  await expect(page.getByTestId('airplay')).toHaveCount(0);
});
