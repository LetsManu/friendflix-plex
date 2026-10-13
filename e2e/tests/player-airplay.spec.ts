import { MOVIE } from '../mocks/fixtures.js';
import { HLS_INIT, HLS_PLAYLIST, HLS_SEGMENTS } from '../mocks/hls.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';
import type { Page } from '@playwright/test';

/**
 * AirPlay button (Safari API simulated): Chromium has no webkitShowPlaybackTargetPicker, so the spec stubs it on
 * HTMLMediaElement and fires Safari's events by hand. The real picker / receiver can only be checked on Apple hardware.
 * `pickTv`: the stubbed picker "chooses the TV" right away (Safari then reports the wireless target); `__srcAtPick` is what the TV
 * would have been handed.
 */
async function stubAirPlay(page: Page, o: { pickTv?: boolean } = {}) {
  await page.addInitScript((pickTv) => {
    const w = window as unknown as { __picks: number; __wireless: boolean; __srcAtPick: string };
    w.__picks = 0; w.__wireless = false; w.__srcAtPick = '';
    Object.defineProperty(HTMLMediaElement.prototype, 'webkitShowPlaybackTargetPicker', { configurable: true, value(this: HTMLMediaElement) {
      w.__picks++; w.__srcAtPick = this.src;
      if (pickTv) { w.__wireless = true; this.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged')); }
    } });
    Object.defineProperty(HTMLMediaElement.prototype, 'webkitCurrentPlaybackTargetIsWireless', { configurable: true, get: () => w.__wireless });
  }, Boolean(o.pickTv));
}
/** /api/cast/config enabled (the AirPlay button's gate); the Chromecast SDK Chromium then asks for is answered empty */
async function castOn(page: Page, enabled = true) {
  await page.route('**/api/cast/config', (r) => r.fulfill({ json: { enabled } }));
  await page.route('https://www.gstatic.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
}
/** the player plays a real HLS stream through hls.js (like Safari normally does) */
async function mockHls(page: Page, segTypes: string[] = []) {
  await page.route('**/api/playback/info', (r) => r.fulfill({ json: {
    resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: 'ps1', roleMaxBitrate: 20_000_000, subtitles: [], audioTracks: [],
    hlsUrl: '/media/hls/4000000/out.m3u8', maxBitrate: 4_000_000, transcodeReason: 'network',
  } }));
  await page.route('**/media/hls/**', (r) => {
    const file = new URL(r.request().url()).pathname.split('/').pop()!;
    const seg = /^s(\d+)\.m4s$/.exec(file);
    if (file === 'out.m3u8') return r.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: HLS_PLAYLIST });
    if (file === 'init.mp4') return r.fulfill({ contentType: 'video/mp4', body: HLS_INIT });
    if (seg) segTypes.push(r.request().resourceType());
    if (seg) return r.fulfill({ contentType: 'video/mp4', body: HLS_SEGMENTS[Number(seg[1])]! }).catch(() => undefined);
    return r.fulfill({ status: 404 });
  });
}
const available = (page: Page) => page.evaluate(() => document.querySelector('video')!.dispatchEvent(Object.assign(new Event('webkitplaybacktargetavailabilitychanged'), { availability: 'available' })));
const wireless = (page: Page, on: boolean) => page.evaluate((on) => {
  (window as unknown as { __wireless: boolean }).__wireless = on;
  document.querySelector('video')!.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged'));
}, on);
const src = (page: Page) => page.evaluate(() => document.querySelector('video')!.src);
const hlsPlaying = async (page: Page) => {
  await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 0.5);
};

test('AirPlay: the button appears once Safari reports a receiver and opens the system picker (with the token URL on the element)', async ({ page, api: _api }) => {
  await stubAirPlay(page);
  await mockPlayer(page);
  await castOn(page);
  await castSessions(page);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  const btn = page.getByRole('button', { name: 'Auf AirPlay-Gerät abspielen' });
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.getAttribute('x-webkit-airplay'))).toBe('allow');
  await expect(btn).toHaveCount(0); // no receiver yet
  await available(page);
  await page.locator('.stage').hover();
  await expect(btn).toBeVisible();
  await btn.click();
  await expect.poll(() => picks(page)).toBe(1);
  expect(await srcAtPick(page)).toContain('#airplay');
});

test('AirPlay: no button while the server has casting off (same gate as Chromecast)', async ({ page, api: _api }) => {
  await stubAirPlay(page);
  await mockPlayer(page);
  await castOn(page, false);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await available(page);
  await page.locator('.stage').hover();
  await expect(page.locator('.ctl')).toBeVisible();
  await expect(page.getByTestId('airplay')).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelector('video')!.getAttribute('x-webkit-airplay'))).toBeNull();
});

test('Safari-like playback keeps hls.js (MSE + bandwidth samples) until the AirPlay button is used', async ({ page, api: _api }) => {
  await stubAirPlay(page);
  await mockPlayer(page);
  await castOn(page);
  const segTypes: string[] = [];
  await mockHls(page, segTypes);
  await page.goto('/watch/' + MOVIE.id);
  await hlsPlaying(page);
  await available(page);
  expect(await src(page)).toMatch(/^blob:/); // hls.js (MSE), not native HLS
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 3);
  // every fragment came through hls.js' loader (fetch/xhr -> FRAG_LOADED feeds the bandwidth estimate), none as a native media load
  expect(segTypes.length).toBeGreaterThan(2);
  expect(segTypes.every((t) => t === 'xhr' || t === 'fetch')).toBe(true);
  // the AirPlay button is there, but nothing switched away from hls.js on its own
  await page.locator('.stage').hover();
  await expect(page.getByTestId('airplay')).toBeVisible();
  expect(await src(page)).toMatch(/^blob:/);
});

/** POST /api/cast/session answers with a token URL (a test file the phone can play); `fail` -> 429 max_streams */
async function castSessions(page: Page, o: { fail?: () => boolean; castId?: string } = {}) {
  const sessions: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  await page.route('**/api/cast/session', (r) => {
    sessions.push(r.request().postDataJSON());
    if (o.fail?.()) return r.fulfill({ status: 429, json: { error: 'max_streams', max: 1 } });
    return r.fulfill({ json: {
      castId: o.castId ?? 'c'.repeat(32), expiresAt: Date.now() + 3 * 3600_000, playSessionId: 'air-ps', mediaSourceId: 'ms', startTime: 0,
      contentUrl: `${new URL(page.url()).origin}/media/p1test.webm#airplay`, contentType: 'application/x-mpegURL', hlsSegmentFormat: 'ts', title: 'Film', subtitles: [],
    } });
  });
  await page.route('**/api/cast/session/*', (r) => { deleted.push(r.request().url().split('/').pop()!); return r.fulfill({ json: { ok: true } }); });
  return { sessions, deleted };
}
const picks = (page: Page) => page.evaluate(() => (window as unknown as { __picks: number }).__picks);
const srcAtPick = (page: Page) => page.evaluate(() => (window as unknown as { __srcAtPick: string }).__srcAtPick);

test('AirPlay: tap -> cast token URL on the element FIRST, then the picker; TV -> active without a new token; end -> token revoked, hls.js again', async ({ page, api: _api }) => {
  await stubAirPlay(page, { pickTv: true });
  await mockPlayer(page);
  await castOn(page);
  await mockHls(page);
  const { sessions, deleted } = await castSessions(page);
  await page.goto('/watch/' + MOVIE.id);
  await hlsPlaying(page);
  await available(page);
  expect(await src(page)).toMatch(/^blob:/);
  await page.evaluate(() => { document.querySelector('video')!.currentTime = 12; });
  await page.locator('.stage').hover();
  await page.getByRole('button', { name: 'Auf AirPlay-Gerät abspielen' }).click();
  await expect(page.getByTestId('airplay-active')).toContainText('Läuft über AirPlay');
  // the TV was handed the token URL, never the MSE blob or the cookie URL
  expect(await picks(page)).toBe(1);
  expect(await srcAtPick(page)).toContain('#airplay');
  expect(await src(page)).toContain('#airplay');
  expect(sessions).toHaveLength(1); // the wireless event did not fetch a second token
  expect(sessions[0]!.via).toBe('airplay');
  expect(Math.round(Number(sessions[0]!.startTicks) / 10_000_000)).toBe(12); // the phone's position
  expect(await page.evaluate(() => document.querySelector('video')!.getAttribute('crossorigin'))).toBeNull();

  await wireless(page, false);
  await expect(page.getByTestId('airplay-active')).toHaveCount(0);
  await expect.poll(() => deleted).toEqual(['c'.repeat(32)]);
  await expect.poll(() => src(page)).toMatch(/^blob:/); // hls.js again
  expect(await page.evaluate(() => document.querySelector('video')!.getAttribute('crossorigin'))).toBe('use-credentials');
  expect(sessions).toHaveLength(1); // no automatic token request after the end either

  // the AirPlay event log on /diagnose: the decisions, never a URL / token / cast id
  await page.goto('/diagnose');
  const log = page.getByTestId('airplay-log');
  await expect(page.getByRole('heading', { name: 'AirPlay-Protokoll' })).toBeVisible();
  await expect(log).toContainText('token-ok');
  await expect(log).toContainText('sustained off -> stop');
  const text = (await log.textContent()) ?? '';
  for (const bad of ['p1test', '/media/', 'c'.repeat(32), '127.0.0.1', 'blob:']) expect(text).not.toContain(bad);
  await page.getByRole('button', { name: 'Leeren' }).click();
  await expect(page.getByTestId('airplay-log-empty')).toBeVisible();
});

test('AirPlay: picker did not lead to a TV yet -> prompt "Fernseher auswählen" opens it from a fresh tap; then TV -> active', async ({ page, api: _api }) => {
  await stubAirPlay(page);
  await mockPlayer(page);
  await castOn(page);
  await mockHls(page);
  const { sessions } = await castSessions(page);
  await page.goto('/watch/' + MOVIE.id);
  await hlsPlaying(page);
  await available(page);
  await page.locator('.stage').hover();
  const btn = page.getByRole('button', { name: 'Auf AirPlay-Gerät abspielen' });
  await btn.click();
  const prompt = page.getByTestId('airplay-ready');
  await expect(prompt).toContainText('Jetzt den Fernseher in der Liste auswählen');
  expect(await srcAtPick(page)).toContain('#airplay');
  await prompt.getByRole('button', { name: 'Fernseher auswählen' }).click();
  expect(await picks(page)).toBe(2);
  expect(await srcAtPick(page)).toContain('#airplay');
  await page.locator('.stage').hover();
  await btn.click(); // the AirPlay button does the same while waiting: picker, no new token
  expect(await picks(page)).toBe(3);
  await wireless(page, true);
  await expect(page.getByTestId('airplay-active')).toContainText('Läuft über AirPlay');
  await expect(prompt).toHaveCount(0);
  expect(sessions).toHaveLength(1);
});

test.describe('AirPlay token failure', () => {
  test.use({ allowedConsole: /status of 429/ });
  test('AirPlay: token request fails before any TV is chosen -> toast, normal stream, no picker, no AirPlay overlay', async ({ page, api: _api }) => {
    await stubAirPlay(page, { pickTv: true });
    await mockPlayer(page);
    await castOn(page);
    await mockHls(page);
    const { sessions } = await castSessions(page, { fail: () => true });
    await page.goto('/watch/' + MOVIE.id);
    await hlsPlaying(page);
    await available(page);
    await page.locator('.stage').hover();
    await page.getByRole('button', { name: 'Auf AirPlay-Gerät abspielen' }).click();
    await expect(page.locator('.toast')).toContainText('Maximal 1 gleichzeitiger Stream erlaubt.');
    await expect.poll(() => src(page)).toMatch(/^blob:/); // hls.js again
    expect(sessions).toHaveLength(1);
    expect(await picks(page)).toBe(0); // the TV never saw a URL it cannot load
    await expect(page.getByTestId('airplay-active')).toHaveCount(0);
    await expect(page.getByTestId('airplay-ready')).toHaveCount(0);
  });

  test('AirPlay: a TV route without our token (Control Center) and the token request fails -> error with Retry, no fallback to the cookie stream', async ({ page, api: _api }) => {
    await stubAirPlay(page);
    await mockPlayer(page);
    await castOn(page);
    await mockHls(page);
    let fail = true;
    await castSessions(page, { fail: () => fail, castId: 'e'.repeat(32) });
    await page.goto('/watch/' + MOVIE.id);
    await hlsPlaying(page);
    await available(page);
    await wireless(page, true);
    const box = page.getByTestId('airplay-active');
    await expect(box).toContainText('Übertragung per AirPlay fehlgeschlagen.');
    await expect(box).toContainText('dieses Gerät wählen');
    expect(await src(page)).not.toMatch(/^blob:/); // no hls.js / cookie stream comes back while the TV is the target
    fail = false;
    await box.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(box).toContainText('Läuft über AirPlay');
    await expect.poll(() => src(page)).toContain('#airplay');
  });
});

test('Chromium without the AirPlay API: no AirPlay button', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await castOn(page);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await available(page);
  await page.locator('.stage').hover();
  await expect(page.locator('.ctl')).toBeVisible();
  await expect(page.getByTestId('airplay')).toHaveCount(0);
});
