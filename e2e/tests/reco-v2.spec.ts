// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { row } from '../helpers.js';
import { ME, MOVIE } from '../mocks/fixtures.js';
import { mockPlayer } from '../mocks/scenes.js';
import { endTitle, toCredits } from '../mocks/postplay.js';
import { BECAUSE_ITEMS, V2_POSTPLAY, V2_POSTPLAY_HERO, V2_POSTPLAY_KIDS, mockV2Home } from '../mocks/reco.js';

// R4 (RECO_ENGINE=v2) on desktop: the reason caption under a row and "Why am I seeing this?", plays counted per row and engine, the
// profile setting "Reset my recommendations", the post-play screen with the transition row, kids profiles and the admin card.

type Ev = { row: string; engine: string; impressions: number; clicks: number; plays: number; dismisses: number };
const sent = (reco: unknown[]) => (reco as Array<{ events: Ev[] }>).flatMap((b) => b.events);
const total = (reco: unknown[], rowName: string, engine: string, k: 'impressions' | 'clicks' | 'plays' | 'dismisses') =>
  sent(reco).filter((e) => e.row === rowName && e.engine === engine).reduce((n, e) => n + (e[k] ?? 0), 0);
const BECAUSE = 'Weil du „Inkwell“ gesehen hast';
const KID = { ...ME, profileCount: 3, kids: true, onboarded: true, profile: { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };
const noIntro = () => { for (const id of ['p1', 'p2', 'p3']) localStorage.setItem(`ff-intro:${id}`, JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); };

test.describe('engine v2: home rows (desktop)', () => {
  test('the top pick\'s reason is the caption; a tap lists why the first titles are there; no dialog', async ({ page }) => {
    await mockV2Home(page);
    await page.goto('/');
    const because = row(page, BECAUSE);
    await because.scrollIntoViewIfNeeded();
    const cap = because.getByTestId('reason-toggle');
    await expect(cap).toHaveText('Weil du „Inkwell“ gesehen hast · gleiche Regie (Ava Nolan) · Genre Krimi');
    await expect(cap).toHaveAttribute('aria-expanded', 'false');
    await cap.click();
    await expect(cap).toHaveAttribute('aria-expanded', 'true');
    const why = because.getByRole('region', { name: 'Warum diese Titel?' });
    await expect(why.getByRole('listitem')).toHaveCount(5);
    await expect(why.getByRole('listitem').first()).toHaveText(`${BECAUSE_ITEMS[0]!.name}: Weil du „Inkwell“ gesehen hast · gleiche Regie (Ava Nolan) · Genre Krimi`);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await why.getByRole('button', { name: 'Ausblenden' }).click();
    await expect(why).toHaveCount(0);
    // the extra row keeps its own caption (a "together" trait), in the ranker's order after the first row
    const more = row(page, /Weil du „.+“ geschaut hast|Weil du/).filter({ hasText: 'wird oft zusammen geschaut' });
    await expect(more.first().getByTestId('reason-caption')).toContainText('wird oft zusammen geschaut');
  });

  test('impressions and clicks carry engine v2; a play is counted when playback starts on a title opened from the row', async ({ page, api }) => {
    await mockPlayer(page, { chapters: [] });
    await mockV2Home(page);
    await page.goto('/');
    const because = row(page, BECAUSE);
    await because.scrollIntoViewIfNeeded();
    const first = because.locator('a[href^="/item/"]').first();
    const href = (await first.getAttribute('href'))!;
    await first.click();
    await expect.poll(() => total(api.reco, 'because', 'v2', 'clicks'), { timeout: 12_000 }).toBe(1);
    expect(total(api.reco, 'because', 'v2', 'impressions')).toBe(1);
    expect(total(api.reco, 'because', 'v2', 'plays')).toBe(0); // a click is not a play
    await page.goto(href.replace('/item/', '/watch/'));
    await expect.poll(() => total(api.reco, 'because', 'v2', 'plays'), { timeout: 12_000 }).toBe(1);
    expect(sent(api.reco).every((e) => e.engine === 'v2')).toBe(true);
    expect(JSON.stringify(api.reco)).not.toMatch(/Inkwell|[0-9a-f]{32}/); // counts only
  });

  test('v1 (the default): no caption, nothing about reasons', async ({ page }) => {
    await page.goto('/');
    const because = row(page, BECAUSE);
    await because.scrollIntoViewIfNeeded();
    await expect(because.locator('a[href]').first()).toBeVisible();
    await expect(page.getByTestId('reason-caption')).toHaveCount(0);
  });
});

test.describe('engine v2: profile settings (desktop)', () => {
  test('"Reset my recommendations" calls the server once and confirms inline', async ({ page, api }) => {
    await page.goto('/settings');
    const sec = page.getByTestId('reco-settings');
    await expect(sec.getByRole('heading', { name: 'Empfehlungen' })).toBeVisible();
    await expect(sec.getByText('Tippe auf die Zeile unter einer Empfehlung')).toBeVisible(); // "Why am I seeing this?"
    await sec.getByRole('button', { name: 'Meine Empfehlungen zurücksetzen' }).click();
    await expect(sec.getByRole('status')).toHaveText('Zurückgesetzt. Die Empfehlungen werden neu berechnet.');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(api.log.filter((l) => l.startsWith('POST /api/prefs/reco/reset'))).toHaveLength(1);
  });

  test.describe('failing reset', () => {
    test.use({ allowedConsole: /status of 500/ });
    test('a failing reset says so and keeps the button usable', async ({ page }) => {
      await page.route('**/api/prefs/reco/reset', (r) => r.fulfill({ status: 500, json: { error: 'internal' } }));
      await page.goto('/settings');
      const sec = page.getByTestId('reco-settings');
      await sec.getByRole('button', { name: 'Meine Empfehlungen zurücksetzen' }).click();
      await expect(sec.getByRole('status')).toHaveText('Das Zurücksetzen hat nicht geklappt.');
      await expect(sec.getByRole('button', { name: 'Meine Empfehlungen zurücksetzen' })).toBeEnabled();
    });
  });
});

test.describe('engine v2: post-play (desktop)', () => {
  test.use({ allowedConsole: /status of 5\d\d/ });
  test('transition row "What people watch after X", reasons on the rows, ranker order, counters tagged with row and engine', async ({ page, api }) => {
    await page.route(`**/api/items/${MOVIE.id}/postplay`, (r) => r.fulfill({ json: V2_POSTPLAY_HERO }));
    await page.goto('/postplay/' + MOVIE.id);
    const pp = page.getByTestId('postplay');
    const headings = pp.locator('section.prow h2');
    await expect(headings).toHaveText(['Was andere nach „Inkwell“ schauen', 'Weil du „Inkwell“ gesehen hast', 'Passt zu deinem Geschmack']);
    const tr = pp.locator('section.prow[data-kind="transition"]');
    await expect(tr.getByTestId('reason-toggle')).toHaveText('Weil du „Inkwell“ gesehen hast · wird oft danach geschaut');
    await expect(pp.locator('section.prow[data-kind="taste"]').getByTestId('reason-caption')).toContainText('Für dich ausgewählt · Genre Drama');
    await tr.getByTestId('reason-toggle').click();
    await expect(tr.getByRole('region', { name: 'Warum diese Titel?' }).getByRole('listitem')).toHaveCount(5);
    // impressions per row, tagged with the engine that built the row
    await expect.poll(() => total(api.reco, 'transition', 'v2', 'impressions'), { timeout: 12_000 }).toBe(1);
    expect(total(api.reco, 'postplay', 'v2', 'impressions')).toBe(1);
    expect(total(api.reco, 'top_picks', 'v2', 'impressions')).toBe(1);
    expect(sent(api.reco).some((e) => e.row === 'continue')).toBe(false); // the continuation is not a recommendation
    // a click on a title of the transition row
    await tr.locator('a[href^="/item/"]').first().click();
    await expect.poll(() => total(api.reco, 'transition', 'v2', 'clicks'), { timeout: 12_000 }).toBe(1);
    expect(api.postplayEvents).toContainEqual({ type: 'click', row: 'transition' });
  });

  test('"Not interested" counts one dismissal for the hero\'s row and engine', async ({ page, api }) => {
    await page.route(`**/api/items/${MOVIE.id}/postplay`, (r) => r.fulfill({ json: V2_POSTPLAY_HERO }));
    await page.goto('/postplay/' + MOVIE.id);
    const hero = page.getByTestId('postplay').getByRole('article');
    await hero.getByRole('button', { name: 'Kein Interesse' }).click();
    await expect(page.getByTestId('postplay').getByText(/Verstanden/)).toBeVisible();
    await expect.poll(() => total(api.reco, 'postplay', 'v2', 'dismisses'), { timeout: 12_000 }).toBe(1);
    expect(total(api.reco, 'transition', 'v2', 'dismisses')).toBe(0);
  });

  test('a v1 server: the same screen without captions; nothing is tagged v2', async ({ page, api }) => {
    const v1 = { ...V2_POSTPLAY, engine: 'v1', hero: null, rows: V2_POSTPLAY.rows.slice(1, 2).map(({ engine: _e, recoRow: _r, items, ...r }) => ({ ...r, items: items.map(({ reason: _x, ...i }) => i) })) };
    await page.route(`**/api/items/${MOVIE.id}/postplay`, (r) => r.fulfill({ json: v1 }));
    await page.goto('/postplay/' + MOVIE.id);
    await expect(page.getByTestId('postplay').locator('section.prow h2')).toHaveText(['Weil du „Inkwell“ gesehen hast']);
    await expect(page.getByTestId('reason-caption')).toHaveCount(0);
    await expect.poll(() => total(api.reco, 'postplay', 'v1', 'impressions'), { timeout: 12_000 }).toBe(1);
    expect(sent(api.reco).some((e) => e.engine === 'v2')).toBe(false);
  });
});

test.describe('engine v2: kids profile (desktop)', () => {
  test('post-play in the player: no friends or transition row, never a request to a social endpoint; the reset works', async ({ page, api }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
    await page.addInitScript(noIntro);
    const social: string[] = [];
    page.on('request', (r) => { if (/\/api\/(friends|match|recommend|recommendations|library\/friends-rated|library\/trending)/.test(new URL(r.url()).pathname)) social.push(new URL(r.url()).pathname); });
    await mockPlayer(page, { chapters: [] });
    await page.route(`**/api/items/${MOVIE.id}/postplay`, (r) => r.fulfill({ json: V2_POSTPLAY_KIDS }));
    await page.goto('/watch/' + MOVIE.id);
    await toCredits(page);
    await endTitle(page);
    const pp = page.getByTestId('postplay');
    await expect(pp.locator('section.prow h2')).toHaveText(['Weil du „Inkwell“ gesehen hast', 'Passt zu deinem Geschmack']);
    await expect(pp.getByTestId('reason-caption')).toHaveCount(2);
    await expect(pp.getByText('Was andere nach')).toHaveCount(0);
    await expect(pp.getByText(/Freunden/)).toHaveCount(0);
    await expect(pp.getByRole('button', { name: /Erinnere mich|Fehlende Staffel/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(pp).toHaveCount(0);
    // the reset is available on a kids profile, too
    await page.goto('/settings');
    const sec = page.getByTestId('reco-settings');
    await sec.getByRole('button', { name: 'Meine Empfehlungen zurücksetzen' }).click();
    await expect(sec.getByRole('status')).toHaveText('Zurückgesetzt. Die Empfehlungen werden neu berechnet.');
    expect(api.log.filter((l) => l.startsWith('POST /api/prefs/reco/reset'))).toHaveLength(1);
    expect(social).toEqual([]);
  });

  test('the grown-up routes stay closed to a kids profile (unchanged)', async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
    await page.addInitScript(noIntro);
    for (const p of ['/admin', '/requests', '/stats']) {
      await page.goto(p);
      await expect(page, p).toHaveURL(/\/kids$/);
    }
  });
});

test.describe('engine v2: admin card (desktop)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });
  test('click rate and play rate per engine, numbers only', async ({ page }) => {
    await page.goto('/admin');
    const card = page.getByTestId('reco-card');
    await expect(card.getByRole('heading', { name: 'Empfehlungs-Engine' })).toBeVisible();
    await expect(card.getByText('Aktiv: Shadow (v2 läuft nebenher)')).toBeVisible();
    const v1 = card.locator('tr[data-engine="v1"]');
    await expect(v1.getByRole('rowheader')).toHaveText('v1 (Jellyfin)');
    await expect(v1.locator('td').nth(0)).toHaveText('400');
    await expect(v1.locator('td.ctr')).toHaveText('10 %');
    await expect(v1.locator('td.pr')).toHaveText('5 %');
    const v2 = card.locator('tr[data-engine="v2"]');
    await expect(v2.locator('td.ctr')).toHaveText('–'); // no impressions yet: no rate, not NaN
    await expect(card.getByText(/Rückfälle auf v1: 3/)).toBeVisible();
    await expect(card).not.toContainText('NaN');
  });
});
