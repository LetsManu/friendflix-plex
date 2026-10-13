import type { Page } from '@playwright/test';
import { MOVIE } from '../mocks/fixtures.js';
import { HLS_INIT, HLS_PLAYLIST, HLS_SEGMENTS } from '../mocks/hls.js';
import { mockPlayer } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';

/** Block 20: adaptive quality (auto rung, stall step-down, pinned manual pick) and the "Original / Umgewandelt" chip. */
interface InfoCall { maxBitrate?: number; reasonHint?: string; startTicks?: number; audioIndex?: number }

/**
 * /api/playback/info answers like the server: no maxBitrate = original (direct play of the file), otherwise a transcode at that rung
 * (a real 30 s HLS stream). `stallAt` = rungs whose segments from the 4th on arrive after 7 s, so playback really runs dry at about 6 s.
 */
async function mockAbr(page: Page, o: { stallAt?: number[]; slowFirst?: number[]; tracks?: boolean; direct?: boolean; sourceBps?: number } = {}) {
  await mockPlayer(page);
  const calls: InfoCall[] = [];
  const firstSeg = new Set<number>();
  await page.route('**/api/playback/info', async (r) => {
    const b = r.request().postDataJSON() as InfoCall;
    calls.push(b);
    const base = { resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: `ps${calls.length}`, roleMaxBitrate: 20_000_000, subtitles: [],
      audioTracks: o.tracks ? [{ index: 1, title: 'Deutsch', language: 'ger', isDefault: true }, { index: 2, title: 'English', language: 'eng', isDefault: false }] : [] };
    if (b.audioIndex !== undefined) Object.assign(base, { audioIndex: b.audioIndex });
    // the server caps at the role ceiling (20 Mbit/s here) and plays the file directly when the source fits under that cap
    const fits = o.sourceBps !== undefined && b.maxBitrate !== undefined && o.sourceBps <= Math.min(b.maxBitrate, 20_000_000);
    if (o.direct || !b.maxBitrate || fits) return r.fulfill({ json: { ...base, directUrl: '/media/p1test.webm', hlsUrl: '/media/p1test.webm', maxBitrate: 60_000_000 } });
    return r.fulfill({ json: { ...base, hlsUrl: `/media/hls/${b.maxBitrate}/out.m3u8`, maxBitrate: b.maxBitrate, transcodeReason: b.reasonHint === 'manual' ? 'manual' : 'network' } });
  });
  await page.route('**/media/hls/**', async (r) => {
    const m = /\/hls\/(\d+)\/(.+)$/.exec(new URL(r.request().url()).pathname)!;
    const [rung, file] = [Number(m[1]), m[2]!];
    const seg = /^s(\d+)\.m4s$/.exec(file);
    if (file === 'out.m3u8') return r.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: HLS_PLAYLIST });
    if (file === 'init.mp4') return r.fulfill({ contentType: 'video/mp4', body: HLS_INIT });
    if (seg) {
      if (o.slowFirst?.includes(rung) && !firstSeg.has(rung)) { firstSeg.add(rung); await new Promise((res) => setTimeout(res, 3000)); } // slow start of a new stream
      if (o.stallAt?.includes(rung) && Number(seg[1]) >= 3) await new Promise((res) => setTimeout(res, 7000));
      return r.fulfill({ contentType: 'video/mp4', body: HLS_SEGMENTS[Number(seg[1])]! }).catch(() => undefined);
    }
    return r.fulfill({ status: 404 });
  });
  return calls;
}
const playing = async (page: Page) => {
  await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 0.5);
};
const openQuality = async (page: Page) => {
  await page.getByRole('button', { name: 'Mehr', exact: true }).click();
  await page.getByRole('button', { name: 'Einstellungen' }).click();
};

test.describe('player: adaptive quality', () => {
  test('playback/info called with maxBitrate 4_000_000 when no stored estimate', async ({ page, api: _api }) => {
    const calls = await mockAbr(page);
    await page.goto('/watch/' + MOVIE.id);
    await playing(page);
    expect(calls[0]).toMatchObject({ maxBitrate: 4_000_000, reasonHint: 'network' });
  });

  test('chip shows Umgewandelt · 720p and reason Leitung langsam', async ({ page, api: _api }) => {
    await mockAbr(page);
    await page.goto('/watch/' + MOVIE.id);
    await playing(page);
    const chip = page.getByRole('button', { name: /Umgewandelt · 720p/ });
    await expect(chip).toBeVisible();
    await expect(page.getByText('Leitung langsam', { exact: false })).toBeHidden();
    await chip.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Leitung langsam' })).toBeVisible();
  });

  test('chip says Original when the server plays the file directly', async ({ page, api: _api }) => {
    await mockAbr(page, { direct: true });
    await page.goto('/watch/' + MOVIE.id);
    await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 500);
    const chip = page.getByRole('button', { name: /^Original/ });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page.getByRole('status').filter({ hasText: 'ohne Umwandlung' })).toBeVisible();
  });

  test('a fast remembered link asks for original and the chip says Original (direct play of a 15 Mbit/s file)', async ({ page, api: _api }) => {
    await page.addInitScript(() => localStorage.setItem('ff_bw', JSON.stringify({ bps: 100_000_000, at: Date.now() })));
    const calls = await mockAbr(page, { sourceBps: 15_000_000 });
    await page.goto('/watch/' + MOVIE.id);
    await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 500);
    expect(calls[0]).toMatchObject({ maxBitrate: 70_000_000, reasonHint: 'network' });
    await expect(page.getByRole('button', { name: /^Original/ })).toBeVisible();
  });

  test('auto steps down after a stall and keeps the position (±2 s)', async ({ page, api: _api }) => {
    const calls = await mockAbr(page, { stallAt: [4_000_000] });
    await page.goto('/watch/' + MOVIE.id);
    await playing(page);
    await expect.poll(() => calls.length, { timeout: 25_000 }).toBeGreaterThanOrEqual(2);
    expect(calls[1]).toMatchObject({ maxBitrate: 1_500_000, reasonHint: 'network' });
    const at = (calls[1]!.startTicks ?? 0) / 10_000_000;
    expect(at).toBeGreaterThan(3);
    await expect(page.locator('.toast', { hasText: 'Leitung langsam – 480p' })).toBeVisible();
    await page.waitForFunction((a) => { const t = document.querySelector('video')!.currentTime; return t >= a - 2 && t <= a + 4; }, at);
    await expect(page.getByRole('button', { name: /Umgewandelt · 480p/ })).toBeVisible();
  });

  test('manual 1080p: a stall steps down with a toast, never above the pick, and the same rung can be picked again', async ({ page, api: _api }) => {
    test.setTimeout(60_000); // a real stall (7 s) plus the switches
    const calls = await mockAbr(page, { stallAt: [8_000_000] });
    await page.goto('/watch/' + MOVIE.id);
    await playing(page);
    await openQuality(page);
    await page.getByRole('button', { name: '1080p' }).click();
    await expect(page.locator('.toast', { hasText: 'Qualität fest: 1080p' })).toBeVisible();
    expect(calls[1]).toMatchObject({ maxBitrate: 8_000_000, reasonHint: 'manual' });
    await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
    await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
    await expect(page.locator('.toast', { hasText: 'Leitung langsam – 720p' })).toBeVisible({ timeout: 25_000 });
    expect(calls[2]).toMatchObject({ maxBitrate: 4_000_000 });
    expect(calls.every((c) => (c.maxBitrate ?? 0) <= 8_000_000)).toBe(true); // never above the pick
    await openQuality(page);
    await expect(page.getByRole('button', { name: '720p', exact: true })).toHaveClass(/on/); // the check follows the real rung
    await page.getByRole('button', { name: '1080p' }).click();
    await expect.poll(() => calls.at(-1)?.maxBitrate).toBe(8_000_000);
  });

  test('pause, then switch quality → still paused, same audio track', async ({ page, api: _api }) => {
    const calls = await mockAbr(page, { tracks: true });
    await page.goto('/watch/' + MOVIE.id);
    await playing(page);
    await page.getByRole('button', { name: 'Audio und Untertitel' }).click();
    await page.getByRole('dialog', { name: 'Audio und Untertitel' }).getByRole('button', { name: 'English' }).click();
    await expect.poll(() => calls.at(-1)?.audioIndex).toBe(2);
    await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
    await page.evaluate(() => document.querySelector('video')!.pause());
    await openQuality(page);
    await page.getByRole('button', { name: '480p' }).click();
    await expect.poll(() => calls.at(-1)?.maxBitrate).toBe(1_500_000);
    expect(calls.at(-1)).toMatchObject({ audioIndex: 2, reasonHint: 'manual' });
    await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => document.querySelector('video')!.paused)).toBe(true);
  });

  test('a slow start of the new stream after a switch is no stall', async ({ page, api: _api }) => {
    const calls = await mockAbr(page, { slowFirst: [1_500_000] });
    await page.goto('/watch/' + MOVIE.id);
    await playing(page);
    await openQuality(page);
    await page.getByRole('button', { name: '480p' }).click();
    await expect.poll(() => calls.length).toBe(2);
    await page.waitForTimeout(6500);
    expect(calls).toHaveLength(2);
    await expect(page.locator('.toast', { hasText: 'Leitung langsam' })).toBeHidden();
  });

  test('Escape closes only the reason bubble, the player stays', async ({ page, api: _api }) => {
    await mockAbr(page);
    await page.goto('/watch/' + MOVIE.id);
    await playing(page);
    const chip = page.getByRole('button', { name: /Umgewandelt · 720p/ });
    await chip.click();
    const bubble = page.getByRole('status').filter({ hasText: 'Leitung langsam' });
    await expect(bubble).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(bubble).toBeHidden();
    await page.waitForTimeout(400);
    expect(new URL(page.url()).pathname).toBe('/watch/' + MOVIE.id);
    await expect(page.locator('video')).toBeVisible();
  });
});
