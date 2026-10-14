// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow, row } from '../helpers.js';
import { items, SERIES } from '../mocks/fixtures.js';

// Block 17 D1 on the phone (390x844): poster tags, detail facts, story card, quality chips in the filter row.
const SHOTS = '/tmp/claude-0/-home-user-friendflix/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/block17/d1';
const day = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const inception = items[0]!, interstellar = items[1]!, breaking = SERIES;

test.describe('discovery (phone)', () => {
  test('poster cards carry the tag, the leaving row shows up, nothing overflows', async ({ page }) => {
    await page.route('**/api/discover/badges', (r) => r.fulfill({ json: { badges: { [inception.id]: { daysLeft: 2 }, [interstellar.id]: { fresh: 'new' }, [breaking.id]: { fresh: 'finale' } } } }));
    await page.route('**/api/library/leaving', (r) => r.fulfill({ json: { items: [{ ...inception, daysLeft: 2 }] } }));
    await page.goto('/');
    const leaving = row(page, 'Bald nicht mehr verfügbar');
    await expect(leaving).toBeAttached();
    await leaving.scrollIntoViewIfNeeded();
    await expect(leaving.locator('.pc').first().getByText('Nur noch 2 Tage')).toBeVisible();
    const because = row(page, 'Weil du „Inkwell“ gesehen hast');
    await because.scrollIntoViewIfNeeded();
    await expect(because.locator('.pc .newep').first()).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await page.screenshot({ path: `${SHOTS}/home-phone.png` });
  });

  test('detail page: tag, chips and the story card fit the phone layout', async ({ page }) => {
    await page.route(`**/api/items/${breaking.id}/facts`, (r) => r.fulfill({ json: { fresh: 'finale', leaving: { leavesAt: day(5), days: 5 }, traits: { resolution: '4k', hdr: 'dolbyvision', audio: 'atmos' } } }));
    await page.route(`**/api/items/${breaking.id}/story`, (r) => r.fulfill({ json: { story: { reason: 'longBreak', weeks: 8, episode: { id: 'e'.repeat(32), name: 'Das Ende', season: 1, index: 7, overview: 'Walter trifft eine folgenschwere Entscheidung.' }, next: { id: 'f'.repeat(32), season: 1, index: 8 } } } }));
    await page.goto('/item/' + breaking.id);
    await expect(page.getByRole('heading', { level: 1, name: 'Bright Valley' })).toBeVisible();
    await expect(page.locator('.tf').getByText('Staffelfinale')).toBeVisible();
    await expect(page.locator('.tf').getByText('Nur noch 5 Tage')).toBeVisible();
    await expect(page.locator('.tf').getByRole('list', { name: 'Bild und Ton' }).getByText('Dolby Atmos')).toBeVisible();
    const story = page.getByRole('region', { name: 'Die Geschichte bisher' });
    await expect(story).toContainText('Du hast seit 8 Wochen nicht weitergeschaut');
    await expect(story.getByRole('button', { name: 'Karte ausblenden' })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await page.screenshot({ path: `${SHOTS}/detail-phone.png`, fullPage: false });
  });

  test('browse: the 4K / HDR chips are reachable and count as active filters', async ({ page }) => {
    await page.route('**/api/library/quality**', (r) => r.fulfill({ json: { items: [inception], total: 1 } }));
    await page.goto('/browse/movies');
    const g = page.getByRole('group', { name: 'Bildqualität' });
    await g.getByRole('button', { name: 'HDR' }).click();
    await expect(page).toHaveURL(/quality=hdr/);
    await expect(page.locator('.fbtn .cnt')).toHaveText('1');
    await expect(page.locator('.tiles article.card')).toHaveCount(1);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await page.screenshot({ path: `${SHOTS}/browse-phone.png` });
  });

});
