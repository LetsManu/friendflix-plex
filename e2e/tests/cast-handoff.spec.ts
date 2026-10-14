// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { items, MOVIE, MOVIE2 } from '../mocks/fixtures.js';
import { available, castOn, castSessions, fakeCastSdk, mockHls, picks, stubAirPlay, wireless } from '../mocks/cast.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';
import type { Page } from '@playwright/test';

/**
 * Player -> cast engine hand-off: a running cast (Chromecast or AirPlay) survives leaving the watch page; the engine reports
 * for it from then on, the dead Player never does.
 */

type Report = { kind: string; playSessionId: string; isPaused: boolean };
/** every POST /api/playback/{start,progress,stop} in order (answered like mockPlayer's catch-all) */
async function playbackReports(page: Page) {
  const reports: Report[] = [];
  await page.route(/\/api\/playback\/(start|progress|stop)$/, (r) => {
    const body = r.request().postDataJSON() as { playSessionId: string; isPaused: boolean };
    reports.push({ kind: new URL(r.request().url()).pathname.split('/').pop()!, playSessionId: body.playSessionId, isPaused: body.isPaused });
    return r.fulfill({ status: 204 });
  });
  return reports;
}
/** a client-side navigation by a link click (a full page load would fire pagehide and end the cast) */
async function clientNav(page: Page, path: string) {
  await page.evaluate((path) => { const a = document.createElement('a'); a.href = path; document.body.appendChild(a); a.click(); a.remove(); }, path);
  await expect(page).toHaveURL((u) => u.pathname + u.search === path);
}
/** the watch page through a client-side navigation */
async function openWatch(page: Page, id = MOVIE.id) {
  await page.goto('/');
  await page.waitForLoadState('networkidle'); // hydrated: the app handles the link click itself
  await page.evaluate(() => { (window as unknown as { __sameDoc: boolean }).__sameDoc = true; });
  await clientNav(page, '/watch/' + id);
}
async function leaveWatch(page: Page) {
  await page.locator('.stage').hover();
  await page.getByRole('button', { name: 'Zurück', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.stage')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __sameDoc?: boolean }).__sameDoc)).toBe(true); // no page load in between
}
const hlsPlaying = async (page: Page) => {
  await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 0.5);
};
/** AirPlay to the (stubbed) TV from the player's button */
async function airPlayToTv(page: Page) {
  await hlsPlaying(page);
  await available(page);
  await page.locator('.stage').hover();
  await page.getByRole('button', { name: 'Auf AirPlay-Gerät abspielen' }).click();
  await expect(page.getByTestId('airplay-active')).toContainText('Läuft über AirPlay');
}
const engineVideo = 'video[data-cast-engine]';

test('chromecast: leaving the watch page keeps the receiver playing', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await castOn(page);
  const sdk = await fakeCastSdk(page);
  const { sessions, deleted } = await castSessions(page);
  const reports = await playbackReports(page);
  await openWatch(page);
  await videoReady(page);
  await sdk.start();
  await expect.poll(() => sdk.loads()).toHaveLength(1);
  await expect(page.locator('.castov')).toContainText('Wird auf Wohnzimmer-TV abgespielt');
  await leaveWatch(page);
  // the engine reports the receiver's session (exactly one start), nothing ended it
  await expect.poll(() => reports.filter((r) => r.playSessionId === 'air-ps' && r.kind === 'start')).toHaveLength(1);
  expect(sessions).toHaveLength(1);
  expect(deleted).toEqual([]);
  expect(await sdk.calls()).not.toContain('endCurrentSession');
  expect(reports.filter((r) => r.playSessionId === 'air-ps' && r.kind === 'stop')).toEqual([]);
});

test('chromecast: Stop on the watch page ends the session and plays on locally', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await castOn(page);
  const sdk = await fakeCastSdk(page);
  const { deleted } = await castSessions(page);
  let infos = 0;
  page.on('request', (r) => { if (r.url().endsWith('/api/playback/info')) infos++; });
  await openWatch(page);
  await videoReady(page);
  await sdk.start();
  const box = page.locator('.castov');
  await expect(box).toContainText('Wird auf Wohnzimmer-TV abgespielt');
  await box.getByRole('button', { name: 'Übertragung beenden' }).click();
  await expect(box).toHaveCount(0);
  await expect.poll(() => sdk.calls()).toContain('endCurrentSession');
  await expect.poll(() => deleted).toEqual(['c'.repeat(32)]);
  await expect.poll(() => infos).toBe(2); // the local stream again
  await expect(page.locator('.stage video')).toHaveCount(1);
});

test('airplay: the element moves to body and keeps its token URL after leaving', async ({ page, api: _api }) => {
  await stubAirPlay(page, { pickTv: true });
  await mockPlayer(page);
  await castOn(page);
  await mockHls(page);
  const { sessions, deleted } = await castSessions(page);
  await openWatch(page);
  await airPlayToTv(page);
  await leaveWatch(page);
  expect(await page.evaluate((sel) => document.querySelector(sel)?.parentElement === document.body, engineVideo)).toBe(true);
  expect(await page.evaluate((sel) => document.querySelector<HTMLVideoElement>(sel)!.src, engineVideo)).toContain('#airplay');
  expect(await page.locator('body > video').count()).toBe(2); // the element and the availability probe
  expect(sessions).toHaveLength(1);
  expect(deleted).toEqual([]);
});

test('only the engine reports after leaving the watch page', async ({ page, api: _api }) => {
  await stubAirPlay(page, { pickTv: true });
  await mockPlayer(page);
  await castOn(page);
  await mockHls(page);
  await castSessions(page);
  const reports = await playbackReports(page);
  await openWatch(page);
  await airPlayToTv(page);
  const el = (fn: 'pause' | 'play' | 'ended') => page.evaluate(([sel, fn]) => {
    const v = document.querySelector<HTMLVideoElement>(sel!)!;
    if (fn === 'ended') v.dispatchEvent(new Event('ended'));
    else if (fn === 'pause') v.pause();
    else void v.play().catch(() => undefined);
  }, [engineVideo, fn]);
  /** every report (any play session: the Player would report its own local session) after one element event */
  const after = async (fn: 'pause' | 'play' | 'ended', want: Report) => {
    const n = reports.length;
    await el(fn);
    await expect.poll(() => reports.length).toBeGreaterThan(n);
    await page.waitForTimeout(400); // a second report (the Player's) would arrive with the engine's
    expect(reports.slice(n)).toEqual([want]);
  };
  const progress = (isPaused: boolean): Report => ({ kind: 'progress', playSessionId: 'air-ps', isPaused });
  await expect.poll(() => reports.filter((r) => r.playSessionId === 'air-ps' && r.kind === 'start')).toHaveLength(1);
  // still on the watch page (the Player's handlers are on the moved element), well inside the engine's first 10 s
  const handed = reports.length;
  await after('pause', progress(true));
  await after('play', progress(false));

  await leaveWatch(page);
  // the engine's 10 s progress just went out: the next one is far away, every report below comes from an element event
  const left = reports.length;
  await expect.poll(() => reports.slice(left).filter((r) => r.playSessionId === 'air-ps' && r.kind === 'progress'), { timeout: 15_000 }).toHaveLength(1);
  await after('pause', progress(true));
  await after('play', progress(false));
  await after('ended', { kind: 'stop', playSessionId: 'air-ps', isPaused: true });
  expect(reports.slice(handed).filter((r) => r.kind === 'start')).toEqual([]); // never a second start
});

/** Chromecast plays MOVIE on the TV and the watch page was left; `infos` counts /api/playback/info from here on */
async function castingMovieThenLeft(page: Page) {
  await mockPlayer(page);
  await castOn(page);
  const sdk = await fakeCastSdk(page);
  const cs = await castSessions(page);
  await openWatch(page);
  await videoReady(page);
  await sdk.start();
  await expect.poll(() => sdk.loads()).toHaveLength(1);
  await expect(page.locator('.castov')).toContainText('Wird auf Wohnzimmer-TV abgespielt');
  await leaveWatch(page);
  const counts = { infos: 0 };
  page.on('request', (r) => { if (r.url().endsWith('/api/playback/info')) counts.infos++; });
  return { sdk, ...cs, counts };
}
/** the Player is a remote: the overlay shows, its own <video> never got a stream */
async function attached(page: Page) {
  await expect(page.locator('.castov')).toContainText('Wird auf Wohnzimmer-TV abgespielt');
  expect(await page.locator('.stage video').evaluate((v: HTMLVideoElement) => v.currentSrc)).toBe('');
}

test('reopening the cast title attaches without a new session or playback info', async ({ page, api: _api }) => {
  const { sdk, sessions, deleted, counts } = await castingMovieThenLeft(page);
  await clientNav(page, '/watch/' + MOVIE.id);
  await attached(page);
  await page.waitForTimeout(400); // a late info request / token request would land by now
  expect(sessions).toHaveLength(1);
  expect(counts.infos).toBe(0);
  expect(deleted).toEqual([]);
  expect(await sdk.loads()).toHaveLength(1);
  expect(await sdk.calls()).not.toContain('endCurrentSession');
});

test('same title with ?t= seeks instead of restarting', async ({ page, api: _api }) => {
  const { sdk, sessions, counts } = await castingMovieThenLeft(page);
  await clientNav(page, `/watch/${MOVIE.id}?t=120`);
  await attached(page);
  await expect.poll(() => sdk.calls()).toContain('seek:120');
  expect(sessions).toHaveLength(1);
  expect(counts.infos).toBe(0);
  expect(await sdk.loads()).toHaveLength(1);
});

test('opening another title while casting plays it on the TV', async ({ page, api: _api }) => {
  const { sdk, sessions, deleted, counts } = await castingMovieThenLeft(page);
  await clientNav(page, '/watch/' + MOVIE2.id);
  await expect.poll(() => sessions.length).toBe(2);
  expect(sessions[1]!.itemId).toBe(MOVIE2.id);
  await expect.poll(() => deleted).toEqual(['c'.repeat(32)]);
  await expect.poll(() => sdk.loads()).toHaveLength(2);
  await attached(page);
  expect(counts.infos).toBe(0);
});

test('an id change on the open watch page plays the new title on the TV, never locally', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await castOn(page);
  const sdk = await fakeCastSdk(page);
  const { sessions, deleted } = await castSessions(page);
  let infos = 0;
  page.on('request', (r) => { if (r.url().endsWith('/api/playback/info')) infos++; });
  await openWatch(page);
  await videoReady(page);
  await sdk.start();
  await expect.poll(() => sdk.loads()).toHaveLength(1);
  await expect(page.locator('.castov')).toContainText('Wird auf Wohnzimmer-TV abgespielt');
  // e.g. an episode picked in the player: the page's {#key id} mounts a fresh Player
  await clientNav(page, `/watch/${MOVIE2.id}?t=30`);
  await expect.poll(() => sessions.length).toBe(2);
  expect(sessions[1]).toMatchObject({ itemId: MOVIE2.id, startTicks: 30 * 10_000_000 });
  await expect.poll(() => deleted).toEqual(['c'.repeat(32)]);
  await expect.poll(() => sdk.loads()).toHaveLength(2);
  await attached(page);
  expect(infos).toBe(1); // only the first title's local stream before the cast
  expect(await page.evaluate(() => (window as unknown as { __sameDoc?: boolean }).__sameDoc)).toBe(true);
});

test('airplay: reopening the cast title attaches to the engine element', async ({ page, api: _api }) => {
  await stubAirPlay(page, { pickTv: true });
  await mockPlayer(page);
  await castOn(page);
  await mockHls(page);
  const { sessions, deleted } = await castSessions(page);
  await openWatch(page);
  await airPlayToTv(page);
  await leaveWatch(page);
  let infos = 0;
  page.on('request', (r) => { if (r.url().endsWith('/api/playback/info')) infos++; });
  await clientNav(page, '/watch/' + MOVIE.id);
  await expect(page.getByTestId('airplay-active')).toContainText('Läuft über AirPlay');
  await page.waitForTimeout(400);
  expect(await page.locator('.stage video').evaluate((v: HTMLVideoElement) => v.currentSrc)).toBe('');
  expect(await page.evaluate((sel) => document.querySelector<HTMLVideoElement>(sel)?.parentElement === document.body, engineVideo)).toBe(true);
  expect(sessions).toHaveLength(1);
  expect(deleted).toEqual([]);
  expect(infos).toBe(0);
});

test('airplay: the reopened remote offers the session\'s tracks and "change device"', async ({ page, api: _api }) => {
  await stubAirPlay(page, { pickTv: true });
  await mockPlayer(page);
  await castOn(page);
  await mockHls(page);
  await page.route('**/api/playback/info', (r) => r.fulfill({ json: {
    resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: 'ps1', roleMaxBitrate: 20_000_000, subtitles: [{ index: 3, title: 'Deutsch (SDH)', language: 'deu' }],
    audioTracks: [{ index: 1, title: 'Deutsch', language: 'deu', isDefault: true }, { index: 2, title: 'English', language: 'eng', isDefault: false }],
    hlsUrl: '/media/hls/4000000/out.m3u8', maxBitrate: 4_000_000, transcodeReason: 'network',
  } }));
  const { sessions } = await castSessions(page);
  await openWatch(page);
  await airPlayToTv(page);
  await leaveWatch(page);
  await clientNav(page, '/watch/' + MOVIE.id);
  const box = page.getByTestId('airplay-active');
  await expect(box).toContainText('Läuft über AirPlay');
  const picks0 = await picks(page);
  await box.getByRole('button', { name: 'AirPlay-Gerät wechseln' }).click();
  expect(await picks(page)).toBe(picks0 + 1); // the engine's controller opened the picker inside the tap
  await page.locator('.stage').hover();
  await page.getByRole('button', { name: 'Audio und Untertitel', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Audio und Untertitel' });
  await expect(menu.getByRole('button', { name: 'Deutsch', exact: true })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Deutsch (SDH)' })).toBeVisible();
  await menu.getByRole('button', { name: 'English' }).click();
  await expect.poll(() => sessions.length).toBe(2); // a new token with that track for the TV
  expect(sessions[1]).toMatchObject({ itemId: MOVIE.id, audioIndex: 2, via: 'airplay' });
});

test.describe('party', () => {
  test('party mode never hands off', async ({ page, api: _api }) => {
    await stubAirPlay(page, { pickTv: true });
    await mockPlayer(page);
    await castOn(page);
    const { sessions } = await castSessions(page);
    await page.routeWebSocket(/\/ws\/party\//, (ws) => {
      ws.send(JSON.stringify({ t: 'welcome', you: 'u1', hostId: 'u1', mode: 'host', itemId: items[0]!.id, title: 'Testfilm', members: [{ id: 'u1', name: 'Mia', buffering: false }], state: { playing: false, position: 0, at: Date.now(), hold: false }, serverNow: Date.now() }));
      ws.onMessage((m) => { const msg = JSON.parse(String(m)); if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now() })); });
    });
    await page.goto('/party/room1');
    await videoReady(page);
    await available(page);
    await wireless(page, true); // a route chosen in Control Center
    await page.locator('.stage').hover();
    await expect(page.locator('.ctl')).toBeVisible();
    await expect(page.getByTestId('airplay')).toHaveCount(0);
    expect(await page.locator(engineVideo).count()).toBe(0);
    expect(sessions).toHaveLength(0);
  });

  test('a party ends a running cast before it plays (one stream)', async ({ page, api: _api }) => {
    const { sdk, deleted } = await castingMovieThenLeft(page);
    await page.routeWebSocket(/\/ws\/party\//, (ws) => {
      ws.send(JSON.stringify({ t: 'welcome', you: 'u1', hostId: 'u1', mode: 'host', itemId: items[0]!.id, title: 'Testfilm', members: [{ id: 'u1', name: 'Mia', buffering: false }], state: { playing: false, position: 0, at: Date.now(), hold: false }, serverNow: Date.now() }));
      ws.onMessage((m) => { const msg = JSON.parse(String(m)); if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now() })); });
    });
    await expect(page.getByRole('region', { name: 'Jetzt auf dem Fernseher' })).toBeVisible();
    await clientNav(page, '/party/room1');
    await videoReady(page);
    await expect.poll(() => sdk.calls()).toContain('endCurrentSession');
    await expect.poll(() => deleted).toEqual(['c'.repeat(32)]);
    await clientNav(page, '/');
    await expect(page.getByRole('region', { name: 'Jetzt auf dem Fernseher' })).toHaveCount(0);
  });
});
