// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow, row } from '../helpers.js';
import { ME, MOVIE } from '../mocks/fixtures.js';
import { endTitle, toCredits } from '../mocks/postplay.js';
import { V2_POSTPLAY_HERO, V2_POSTPLAY_KIDS, mockV2Home } from '../mocks/reco.js';
import { mockPlayer } from '../mocks/scenes.js';

// R4 (RECO_ENGINE=v2) on a phone: the reason caption and "Why am I seeing this?" by tap, the reset setting, post-play with the
// transition row, and a kids profile.

type Ev = { row: string; engine: string; impressions: number; clicks: number; plays: number; dismisses: number };
const total = (reco: unknown[], rowName: string, engine: string, k: 'impressions' | 'clicks' | 'plays' | 'dismisses') =>
  (reco as Array<{ events: Ev[] }>).flatMap((b) => b.events).filter((e) => e.row === rowName && e.engine === engine).reduce((n, e) => n + (e[k] ?? 0), 0);
const KID = { ...ME, profileCount: 3, kids: true, onboarded: true, profile: { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };
const noIntro = () => { for (const id of ['p1', 'p2', 'p3']) localStorage.setItem(`ff-intro:${id}`, JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); };

test.describe('engine v2 (phone)', () => {
  test('home: the caption fits the screen, a tap opens "Why am I seeing this?" inline, a play is counted for the row', async ({ page, api }) => {
    await mockPlayer(page, { chapters: [] });
    await mockV2Home(page);
    await page.goto('/');
    const because = row(page, 'Weil du „Inkwell“ gesehen hast');
    await because.scrollIntoViewIfNeeded();
    const cap = because.getByTestId('reason-toggle');
    await expect(cap).toHaveText('Weil du „Inkwell“ gesehen hast · gleiche Regie (Ava Nolan) · Genre Krimi');
    expect((await cap.boundingBox())!.width).toBeLessThanOrEqual(390);
    await cap.tap();
    const why = because.getByRole('region', { name: 'Warum diese Titel?' });
    await expect(why.getByRole('listitem')).toHaveCount(5);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await why.getByRole('button', { name: 'Ausblenden' }).tap();
    await expect(why).toHaveCount(0);
    const first = because.locator('a[href^="/item/"]').first();
    const href = (await first.getAttribute('href'))!;
    await first.tap();
    await expect.poll(() => total(api.reco, 'because', 'v2', 'clicks'), { timeout: 12_000 }).toBe(1);
    await page.goto(href.replace('/item/', '/watch/'));
    await expect.poll(() => total(api.reco, 'because', 'v2', 'plays'), { timeout: 12_000 }).toBe(1);
  });

  test('settings: "Reset my recommendations" with inline confirmation', async ({ page, api }) => {
    await page.goto('/settings');
    const sec = page.getByTestId('reco-settings');
    await sec.scrollIntoViewIfNeeded();
    const btn = sec.getByRole('button', { name: 'Meine Empfehlungen zurücksetzen' });
    expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    await btn.tap();
    await expect(sec.getByRole('status')).toHaveText('Zurückgesetzt. Die Empfehlungen werden neu berechnet.');
    expect((await sec.boundingBox())!.x + (await sec.boundingBox())!.width).toBeLessThanOrEqual(390); // the new section fits (the older form above is not part of this check)
    expect(api.log.filter((l) => l.startsWith('POST /api/prefs/reco/reset'))).toHaveLength(1);
  });

  test('post-play: transition row first, captions, no sideways scrolling, "Not interested" counts a dismissal', async ({ page, api }) => {
    await page.route(`**/api/items/${MOVIE.id}/postplay`, (r) => r.fulfill({ json: V2_POSTPLAY_HERO }));
    await page.goto('/postplay/' + MOVIE.id);
    const pp = page.getByTestId('postplay');
    await expect(pp.locator('section.prow h2').first()).toHaveText('Was andere nach „Inkwell“ schauen');
    await expect(pp.locator('section.prow[data-kind="transition"]').getByTestId('reason-toggle')).toContainText('wird oft danach geschaut');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await expect.poll(() => total(api.reco, 'transition', 'v2', 'impressions'), { timeout: 12_000 }).toBe(1);
    await pp.getByRole('article').getByRole('button', { name: 'Kein Interesse' }).tap();
    await expect.poll(() => total(api.reco, 'postplay', 'v2', 'dismisses'), { timeout: 12_000 }).toBe(1);
  });

  test('kids profile: the post-play overlay has no friends or transition row; the reset is available', async ({ page, api }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
    await page.addInitScript(noIntro);
    await mockPlayer(page, { chapters: [] });
    await page.route(`**/api/items/${MOVIE.id}/postplay`, (r) => r.fulfill({ json: V2_POSTPLAY_KIDS }));
    await page.goto('/watch/' + MOVIE.id);
    await toCredits(page);
    await endTitle(page);
    const pp = page.getByTestId('postplay');
    await expect(pp.locator('section.prow h2')).toHaveText(['Weil du „Inkwell“ gesehen hast', 'Passt zu deinem Geschmack']);
    await expect(pp.getByText('Was andere nach')).toHaveCount(0);
    await pp.getByRole('button', { name: 'Zurück zum Titel' }).tap();
    await page.goto('/settings');
    await page.getByTestId('reco-settings').getByRole('button', { name: 'Meine Empfehlungen zurücksetzen' }).tap();
    await expect(page.getByTestId('reco-settings').getByRole('status')).toHaveText('Zurückgesetzt. Die Empfehlungen werden neu berechnet.');
    expect(api.log.filter((l) => l.startsWith('POST /api/prefs/reco/reset'))).toHaveLength(1);
  });
});
