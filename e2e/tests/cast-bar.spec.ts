// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { episodes, ME, MOVIE, MOVIE2 } from '../mocks/fixtures.js';
import { PROFILES } from '../mocks/api.js';
import { available, castOn, castSessions, fakeCastSdk, mockHls, stubAirPlay } from '../mocks/cast.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';
import type { Page } from '@playwright/test';

/** The cast bar: shown on every page except /watch/*, /party/* and TV mode while a title plays on a TV (desktop here, phone in cast-bar.mobile). */

/** a client-side navigation by a link click (a full page load would fire pagehide and end the cast) */
const clientNav = (page: Page, path: string) => page.evaluate((path) => { const a = document.createElement('a'); a.href = path; document.body.appendChild(a); a.click(); a.remove(); }, path);
async function leaveWatch(page: Page) {
  await page.locator('.stage').hover();
  await page.getByRole('button', { name: 'Zurück', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}
/**
 * a Chromecast cast started on the watch page (client-side navigation); the page stays open as the TV's remote.
 * `next`: episode 2 follows episode 1 from the start (`nextAfterFirst` before the cast, so the engine's receiver-queue request at
 * the first position update always sees it; installed after the cast, whether it does depends on which round trip wins).
 */
async function castOnWatch(page: Page, o: { id?: string; fail?: () => boolean; next?: boolean } = {}) {
  await mockPlayer(page);
  if (o.next) await nextAfterFirst(page); // after mockPlayer, whose `/next` answers null (the newest route wins)
  await castOn(page);
  const sdk = await fakeCastSdk(page);
  const { sessions, deleted } = await castSessions(page, { fail: o.fail });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await clientNav(page, '/watch/' + (o.id ?? MOVIE.id));
  await expect(page).toHaveURL(/\/watch\//);
  await videoReady(page);
  await sdk.start();
  await expect(page.locator('.castov')).toContainText('Wird auf Wohnzimmer-TV abgespielt');
  return { sdk, sessions, deleted };
}
/** `castOnWatch`, then back to the home page; `fail()` -> 429 on a token request */
async function castAndLeave(page: Page, o: { id?: string; fail?: () => boolean } = {}) {
  const r = await castOnWatch(page, o);
  await leaveWatch(page);
  return r;
}
/** GET /api/items/{id}/next: episode 2 follows episode 1 */
const nextAfterFirst = (page: Page) => page.route('**/api/items/*/next', (r) => r.fulfill({ json: { item: r.request().url().includes(episodes[0]!.id) ? episodes[1] : null } }));
const castBar = (page: Page) => page.getByRole('region', { name: 'Jetzt auf dem Fernseher' });

test('bar appears after leaving the watch page and pauses the TV', async ({ page, api: _api }) => {
  const { sdk } = await castAndLeave(page);
  const bar = page.getByRole('region', { name: 'Jetzt auf dem Fernseher' });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(async () => (await sdk.calls()).filter((c) => c === 'playOrPause')).toHaveLength(1);
});

test('tapping the bar reopens the remote without a new session', async ({ page, api: _api }) => {
  const { sessions } = await castAndLeave(page);
  const bar = page.getByRole('region', { name: 'Jetzt auf dem Fernseher' });
  await bar.getByRole('button', { name: 'Fernbedienung öffnen' }).click();
  await expect(page).toHaveURL(new RegExp('/watch/' + MOVIE.id));
  await expect(page.locator('.castov')).toContainText('Wird auf Wohnzimmer-TV abgespielt');
  await expect(page.getByRole('region', { name: 'Jetzt auf dem Fernseher' })).toHaveCount(0);
  expect(sessions).toHaveLength(1);
});

test.describe('token failure', () => {
  test.use({ allowedConsole: /status of 429/ });
  test('a failed token request on a switch shows the reconnect hint; a tap retries once', async ({ page, api: _api }) => {
    let fail = false;
    const { sessions } = await castAndLeave(page, { fail: () => fail });
    // the switch's token request is held until the watch page is left again (there the Player would play on locally)
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await page.route('**/api/cast/session', async (r) => { if (fail) await gate; return r.fallback(); });
    fail = true;
    await clientNav(page, '/watch/' + MOVIE2.id);
    await expect(page.locator('.castov')).toBeVisible();
    await leaveWatch(page);
    release();
    const bar = castBar(page);
    await expect(bar).toContainText('Verbindung verloren – tippen, um am Fernseher fortzusetzen');
    await expect.poll(() => sessions.length).toBe(2);
    await expect(bar.getByRole('button', { name: /^(Pause|Abspielen)$/ })).toHaveCount(0); // the whole bar reconnects
    fail = false;
    await bar.getByRole('button', { name: /Verbindung verloren/ }).click();
    await expect(page).toHaveURL(/\/$/); // a reconnect, not the remote
    await expect.poll(() => sessions.length).toBe(3);
    await page.waitForTimeout(400);
    expect(sessions).toHaveLength(3); // exactly one retry
    expect(sessions[2]!.itemId).toBe(MOVIE2.id);
    await expect(bar).not.toContainText('Verbindung verloren');
  });
});

test('switching episodes of one series changes the visible bar text', async ({ page, api: _api }) => {
  await castAndLeave(page, { id: episodes[0]!.id });
  const bar = castBar(page);
  await expect(bar).toContainText(episodes[0]!.name);
  await clientNav(page, '/watch/' + episodes[1]!.id);
  await expect(page).toHaveURL(/\/watch\//);
  await expect(page.locator('.castov')).toBeVisible();
  await leaveWatch(page);
  await expect(bar).toContainText(episodes[1]!.name);
  await expect(bar).not.toContainText(episodes[0]!.name);
});

test('episode end on the TV shows "Als Nächstes" and switches after the countdown', async ({ page, api: _api }) => {
  test.setTimeout(45_000);
  const { sdk, sessions } = await castAndLeave(page, { id: episodes[0]!.id });
  await nextAfterFirst(page);
  const bar = castBar(page);
  await expect(bar).toContainText(episodes[0]!.name);
  await sdk.nearEnd();
  await expect(bar.getByRole('progressbar')).toHaveAttribute('aria-valuenow', /^(99|100)$/); // the engine mirrors the receiver's position
  await sdk.finish();
  await expect(bar).toContainText(`Als Nächstes: S1:E2 · ${episodes[1]!.name}`);
  await expect(bar).toContainText(/in \d+ s/);
  expect(sessions).toHaveLength(1);
  await expect.poll(() => sessions.length, { timeout: 15_000 }).toBe(2);
  expect(sessions[1]!.itemId).toBe(episodes[1]!.id);
  expect(sessions[1]!.startTicks).toBeUndefined(); // the server's resume position
  await expect(bar).not.toContainText('Als Nächstes');
});

test('credits on the TV: the bar counts down to the next episode while the TV plays; Cancel stops it', async ({ page, api: _api }) => {
  test.setTimeout(45_000);
  const { sdk, sessions } = await castAndLeave(page, { id: episodes[0]!.id });
  await nextAfterFirst(page);
  const bar = castBar(page);
  await expect(bar.getByRole('button', { name: 'Nächste Folge' })).toBeVisible(); // next episode at any time
  await sdk.nearEnd(); // the last seconds: the credits (no segments: the last 25 s)
  await expect(bar).toContainText(`Als Nächstes: S1:E2 · ${episodes[1]!.name}`);
  await expect(bar).toContainText(/in \d+ s/);
  await bar.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(bar).not.toContainText(/in \d+ s/);
  await page.waitForTimeout(11_000);
  expect(sessions.filter((b) => !b.next)).toHaveLength(1);
});

test('episode end on the TV while the watch page is open: its next card counts down, then the page follows the TV', async ({ page, api: _api }) => {
  test.setTimeout(45_000);
  const { sdk, sessions } = await castOnWatch(page, { id: episodes[0]!.id, next: true });
  let infos = 0;
  page.on('request', (r) => { if (r.url().endsWith('/api/playback/info')) infos++; });
  // the engine asks for the receiver-queue token of episode 2 at the first position update (the fake SDK refuses the queue)
  await expect.poll(() => sessions.filter((b) => b.next).map((b) => b.itemId)).toEqual([episodes[1]!.id]);
  await sdk.nearEnd();
  await expect.poll(() => page.locator('.track[role=slider]').evaluate((el) => Number(el.getAttribute('aria-valuemax')) - Number(el.getAttribute('aria-valuenow')))).toBeLessThan(10);
  await sdk.finish();
  const card = page.getByRole('group', { name: 'Nächste Folge' });
  await expect(card).toContainText(`S1:E2 · ${episodes[1]!.name}`);
  await expect(card).toContainText(/in \d+ s/);
  await expect(page).toHaveURL(new RegExp('/watch/' + episodes[1]!.id), { timeout: 15_000 });
  await expect(page.locator('.castov')).toContainText('Wird auf Wohnzimmer-TV abgespielt');
  await expect(card).toHaveCount(0);
  await page.waitForTimeout(500);
  // one token per episode for playback: episode 1's, then the countdown's switch to episode 2 (plus the refused queue token)
  expect(sessions.filter((b) => !b.next).map((b) => b.itemId)).toEqual([episodes[0]!.id, episodes[1]!.id]);
  expect(sessions.filter((b) => b.next)).toHaveLength(1);
  expect(infos).toBe(0);
});

test('closing the next card on the watch page stops the TV countdown', async ({ page, api: _api }) => {
  const { sdk, sessions } = await castOnWatch(page, { id: episodes[0]!.id });
  await nextAfterFirst(page);
  await sdk.nearEnd();
  await expect.poll(() => page.locator('.track[role=slider]').evaluate((el) => Number(el.getAttribute('aria-valuemax')) - Number(el.getAttribute('aria-valuenow')))).toBeLessThan(10);
  await sdk.finish();
  const card = page.getByRole('group', { name: 'Nächste Folge' });
  await page.locator('.stage').hover();
  await card.getByRole('button', { name: 'Abbrechen' }).click();
  // the countdown stops; the episode stays offered (Play now), nothing starts by itself
  await expect(card).not.toContainText(/in \d+ s/);
  await expect(card.getByRole('button', { name: 'Jetzt abspielen' })).toBeVisible();
  await page.waitForTimeout(11_000);
  expect(sessions.filter((b) => !b.next)).toHaveLength(1); // a `next` one is the receiver queue's (refused by the fake SDK, revoked)
  await expect(page).toHaveURL(new RegExp('/watch/' + episodes[0]!.id));
});

/**
 * scrolled to the bottom: the last focusable element of the page content (main, and on desktop the footer after it) lies fully
 * above the bar. A button flush with the end of main stands for a page whose content ends without a margin.
 */
async function lastFocusableAboveBar(page: Page) {
  await page.evaluate(() => {
    if (document.querySelector('main > .e2e-last')) return;
    const b = Object.assign(document.createElement('button'), { className: 'e2e-last', textContent: 'last' });
    b.style.display = 'block';
    document.querySelector('main')!.appendChild(b);
  });
  for (let i = 0; i < 3; i++) { // rows may load more content while scrolling
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(250);
  }
  await page.evaluate(() => {
    const sel = 'a[href], button:not([disabled]), input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])';
    const all = [...document.querySelectorAll<HTMLElement>(`main :is(${sel}), footer.foot :is(${sel})`)]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; });
    document.querySelectorAll('[data-last-focusable]').forEach((el) => el.removeAttribute('data-last-focusable'));
    all.at(-1)?.setAttribute('data-last-focusable', '');
  });
  const last = await page.locator('[data-last-focusable]').boundingBox();
  const bar = await castBar(page).boundingBox();
  expect(last).not.toBeNull();
  expect(bar).not.toBeNull();
  expect(last!.y + last!.height).toBeLessThanOrEqual(bar!.y);
}

test('the page content ends above the bar on desktop and phone', async ({ page, api: _api }) => {
  await castAndLeave(page);
  await expect(castBar(page)).toBeVisible();
  await lastFocusableAboveBar(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('nav.tabbar')).toBeVisible();
  await expect(page.locator('footer.foot')).toHaveCount(0);
  await lastFocusableAboveBar(page);
});

test('bar shows title, device and progress', async ({ page, api: _api }) => {
  await castAndLeave(page);
  const bar = castBar(page);
  await expect(bar).toContainText(MOVIE.name);
  await expect(bar).toContainText('auf Wohnzimmer-TV');
  const progress = bar.getByRole('progressbar', { name: 'Fortschritt' });
  await expect(progress).toHaveAttribute('aria-valuemin', '0');
  await expect(progress).toHaveAttribute('aria-valuemax', '100');
  await expect.poll(async () => Number(await progress.getAttribute('aria-valuenow')), { timeout: 10_000 }).toBeGreaterThan(0);
});

test('stop asks first and ends the session', async ({ page, api: _api }) => {
  const { sdk, deleted } = await castAndLeave(page);
  const bar = castBar(page);
  await bar.getByRole('button', { name: 'Wiedergabe auf Wohnzimmer-TV beenden', exact: true }).click();
  const dlg = page.getByRole('alertdialog', { name: 'Wiedergabe auf Wohnzimmer-TV beenden?' });
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(bar).toBeVisible();
  expect(deleted).toEqual([]);
  await bar.getByRole('button', { name: 'Wiedergabe auf Wohnzimmer-TV beenden', exact: true }).click();
  await dlg.getByRole('button', { name: 'Wiedergabe auf Wohnzimmer-TV beenden', exact: true }).click();
  await expect(bar).toHaveCount(0);
  await expect.poll(() => deleted).toEqual(['c'.repeat(32)]);
  expect(await sdk.calls()).toContain('endCurrentSession');
});

test('buttons have names', async ({ page, api: _api }) => {
  await castAndLeave(page);
  const bar = castBar(page);
  for (const name of ['Pause', 'Wiedergabe auf Wohnzimmer-TV beenden', 'Fernbedienung öffnen']) await expect(bar.getByRole('button', { name, exact: true })).toBeVisible();
  // keyboard: remote, play / pause, stop in DOM order
  await bar.getByRole('button', { name: 'Fernbedienung öffnen' }).focus();
  await page.keyboard.press('Tab');
  await expect(bar.getByRole('button', { name: 'Pause', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(bar.getByRole('button', { name: 'Wiedergabe auf Wohnzimmer-TV beenden', exact: true })).toBeFocused();
});

test('no bar in TV mode', async ({ page, api: _api }) => {
  // the TV-mode preview in a browser: Chromecast is off there, AirPlay is not
  await stubAirPlay(page, { pickTv: true });
  await mockPlayer(page);
  await castOn(page);
  await mockHls(page);
  await castSessions(page);
  await page.goto('/?tv=1');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('html.tv')).toHaveCount(1);
  await clientNav(page, '/watch/' + MOVIE.id);
  await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await available(page);
  await page.locator('.stage').hover();
  await page.getByRole('button', { name: 'Auf AirPlay-Gerät abspielen' }).click();
  await expect(page.getByTestId('airplay-active')).toContainText('Läuft über AirPlay');
  await clientNav(page, '/');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('video[data-cast-engine]')).toHaveCount(1); // the cast runs on
  await page.waitForTimeout(300);
  await expect(castBar(page)).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--castbar-h').trim())).toBe('0px');
});

test.describe('receiver failure', () => {
  test('failed switch shows Play here', async ({ page, api: _api }) => {
    const { sdk } = await castAndLeave(page);
    // the switch's token request waits until the watch page is left (there the Player would play on locally)
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held = false;
    await page.route('**/api/cast/session', async (r) => { if (!held) { held = true; await gate; } return r.fallback(); });
    await sdk.failLoads();
    await clientNav(page, '/watch/' + MOVIE2.id);
    await expect(page.locator('.castov')).toBeVisible();
    await leaveWatch(page);
    let infos = 0;
    page.on('request', (r) => { if (r.url().endsWith('/api/playback/info')) infos++; });
    release();
    const bar = castBar(page);
    const here = bar.getByRole('button', { name: 'Hier abspielen' });
    await expect(here).toBeVisible();
    await expect(bar.getByRole('button')).toHaveCount(2); // Hier abspielen + Stop: no "Fernbedienung öffnen" that would play here
    await expect(bar.getByRole('button', { name: 'Fernbedienung öffnen' })).toHaveCount(0);
    expect(infos).toBe(0);
    await here.click();
    await expect(page).toHaveURL(new RegExp('/watch/' + MOVIE2.id));
    await expect.poll(() => infos).toBeGreaterThan(0);
  });
});

test('the remote button names its action and is described by the title and line', async ({ page, api: _api }) => {
  await castAndLeave(page);
  const open = castBar(page).getByRole('button', { name: 'Fernbedienung öffnen' });
  await expect(open).toHaveAccessibleDescription(new RegExp(`${MOVIE.name}.*auf Wohnzimmer-TV`));
});

test('public pages get no room for a bar they do not show', async ({ page, api: _api }) => {
  await castAndLeave(page);
  const h = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--castbar-h').trim());
  expect(await h()).toBe('64px');
  await clientNav(page, '/offline');
  await expect(page).toHaveURL(/\/offline$/);
  await expect(castBar(page)).toHaveCount(0);
  await expect.poll(h).toBe('0px');
});

test('switching profile ends the cast', async ({ page, api: _api }) => {
  await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, profileCount: 3, profileChosen: true } }));
  await page.addInitScript(() => sessionStorage.setItem('ff-profile-picked', '1'));
  const order: string[] = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (r.method() !== 'GET' && /^\/api\/(cast\/session\/|playback\/stop|profiles\/[^/]+\/select)/.test(u.pathname)) order.push(`${r.method()} ${u.pathname}`); });
  const { deleted } = await castAndLeave(page);
  await expect(castBar(page)).toBeVisible();
  await clientNav(page, '/profiles?pick=p2&next=%2F');
  await expect.poll(() => order.at(-1)).toBe('POST /api/profiles/p2/select');
  expect(deleted).toEqual(['c'.repeat(32)]);
  const sel = order.indexOf('POST /api/profiles/p2/select');
  expect(order.indexOf('DELETE /api/cast/session/' + 'c'.repeat(32))).toBeLessThan(sel);
  expect(order.indexOf('POST /api/playback/stop')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('POST /api/playback/stop')).toBeLessThan(sel);
});

test('the /match "start vote" bar sits above the cast bar on desktop and phone', async ({ page, api: _api }) => {
  await page.route('**/api/friends', (r) => r.fulfill({ json: { friends: [{ id: 'u2', name: 'Alex', sharesHistory: true }] } }));
  await page.route('**/api/library/genres', (r) => r.fulfill({ json: { genres: [] } }));
  await page.route('**/api/match', (r) => r.fulfill({ json: { participants: ['Alex'], total: 2, items: [MOVIE, MOVIE2] } }));
  await castAndLeave(page);
  await clientNav(page, '/match');
  await expect(page).toHaveURL(/\/match$/);
  await page.getByRole('checkbox', { name: /Alex/ }).check();
  await page.getByRole('button', { name: 'Abgleichen' }).click();
  const marks = page.getByRole('button', { name: 'Für Abstimmung vormerken' });
  await marks.nth(0).click();
  await marks.nth(1).click();
  const vote = page.getByRole('button', { name: 'Abstimmung starten' });
  for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await expect(vote).toBeVisible();
    const v = (await vote.boundingBox())!, b = (await castBar(page).boundingBox())!;
    expect(v.y + v.height).toBeLessThanOrEqual(b.y);
  }
});

test('keyboard focus stays in the bar when the focused button is replaced', async ({ page, api: _api }) => {
  const { sdk } = await castAndLeave(page, { id: episodes[0]!.id });
  await nextAfterFirst(page);
  const bar = castBar(page);
  await sdk.nearEnd();
  await sdk.finish();
  const next = bar.getByRole('button', { name: `Als Nächstes: S1:E2 · ${episodes[1]!.name}` });
  await next.focus();
  await page.keyboard.press('Enter'); // the button gives way to the spinner, then to Pause
  await expect(next).toHaveCount(0);
  await expect(bar.getByRole('button', { name: 'Fernbedienung öffnen' })).toBeFocused();
  await expect(bar).toContainText(episodes[1]!.name);
  expect(await bar.evaluate((el) => el.contains(document.activeElement))).toBe(true);
});

test('the profile PIN overlay covers the cast bar', async ({ page, api: _api }) => {
  await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, profileCount: 3, profileChosen: true } }));
  await page.route('**/api/profiles', (r) => r.fulfill({ json: { profiles: PROFILES.map((p) => (p.id === 'p2' ? { ...p, hasPin: true } : p)), max: 5, activeId: 'p1' } }));
  await page.addInitScript(() => sessionStorage.setItem('ff-profile-picked', '1'));
  await castAndLeave(page);
  await clientNav(page, '/profiles');
  await expect(page).toHaveURL(/\/profiles$/);
  await expect(castBar(page)).toBeVisible();
  await page.getByRole('button', { name: 'Anna, mit PIN geschützt' }).click();
  const dlg = page.getByRole('dialog', { name: /Anna/ });
  await expect(dlg).toBeVisible();
  const b = (await castBar(page).boundingBox())!;
  const onTop = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.ov') !== null, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
  expect(onTop).toBe(true);
});
