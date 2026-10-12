import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow, row } from '../helpers.js';
import { ME, hex, items, SERIES } from '../mocks/fixtures.js';

// Block 17 D1 (discovery): fresh labels, removal dates ("Nur noch N Tage"), quality chips, story so far, 4K / HDR filter, admin page.
const SHOTS = '/tmp/claude-0/-home-user-friendflix/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/block17/d1';
const ADMIN = { ...ME, isAdmin: true, profile: { id: 'p1', name: 'Tester', avatar: 'a1', isOwner: true } };
const day = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const inception = items[0]!, interstellar = items[1]!, darkKnight = items[2]!, breaking = SERIES;

/** badges the server would send: Inkwell leaves in 3 days, Interlace is new, Bright Valley has a finale */
async function mockBadges(page: Page, extra: Record<string, unknown> = {}) {
  await page.route('**/api/discover/badges', (r) => r.fulfill({ json: { badges: { [inception.id]: { fresh: 'new', daysLeft: 3 }, [interstellar.id]: { fresh: 'new' }, [breaking.id]: { fresh: 'finale' }, [darkKnight.id]: { fresh: 'newSeason' }, ...extra } } }));
}

test.describe('fresh labels and leaving soon (desktop)', () => {
  test('cards carry one tag; a removal date wins over a fresh label; the leaving row lists only what the server sends', async ({ page }) => {
    await mockBadges(page, { [interstellar.id]: { fresh: 'new', daysLeft: 11 } });
    await page.route('**/api/library/leaving', (r) => r.fulfill({ json: { items: [{ ...inception, daysLeft: 3 }, { ...interstellar, daysLeft: 11 }] } }));
    await page.goto('/');
    const leaving = row(page, 'Bald nicht mehr verfügbar');
    await expect(leaving).toBeAttached();
    await leaving.scrollIntoViewIfNeeded();
    await expect(leaving.locator('article.card')).toHaveCount(2);
    // exactly one tag per card
    const first = leaving.locator('article.card').first();
    await expect(first.getByText('Nur noch 3 Tage')).toBeVisible();
    await expect(first.locator('.newep, .brand')).toHaveCount(1);
    await expect(leaving.locator('article.card').nth(1).getByText('Nur noch 11 Tage')).toBeVisible();
    // the trending row: Dawn Keeper "Neue Staffel" (no removal date), Bright Valley "Staffelfinale"
    const trending = row(page, 'Diese Woche bei uns');
    await trending.scrollIntoViewIfNeeded();
    await expect(trending.locator('article.card').filter({ hasText: 'Inkwell' }).getByText('Nur noch 3 Tage')).toBeVisible();
    await expect(trending.getByText('Staffelfinale')).toBeVisible();
    await expect(trending.getByText('Neue Folgen')).toHaveCount(0); // the old client-side hint is gone once the server answered
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await page.screenshot({ path: `${SHOTS}/home-desktop.png` });
  });

  test('the leaving row stays away while empty (kids profile and nothing visible)', async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, kids: true, profile: { id: 'p2', name: 'Kind', avatar: 'a2', isOwner: false, kids: true, maxRating: 6 } } }));
    await mockBadges(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Weiterschauen' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Bald nicht mehr verfügbar' })).toHaveCount(0);
  });

  test('without server badges the old client-side hints still show', async ({ page }) => {
    await page.goto('/');
    await expect(row(page, 'Diese Woche bei uns').getByText('Neue Folgen')).toHaveCount(1);
  });

  test('hover card shows the quality chips', async ({ page }) => {
    await mockBadges(page);
    await page.route(`**/api/items/${interstellar.id}/facts`, (r) => r.fulfill({ json: { fresh: 'new', leaving: { leavesAt: day(3), days: 3 }, traits: { resolution: '4k', hdr: 'dolbyvision', audio: 'atmos' } } }));
    await page.goto('/');
    const card = row(page, 'Weil du „Inkwell“ gesehen hast').locator('article.card').first(); // Interlace
    await card.scrollIntoViewIfNeeded();
    await card.hover();
    const hp = page.locator('.hp.ready');
    await expect(hp).toBeVisible();
    const chips = hp.getByRole('list', { name: 'Bild und Ton' });
    await expect(chips.getByText('4K', { exact: true })).toBeVisible();
    await expect(chips.getByText('Dolby Vision')).toBeVisible();
    await expect(chips.getByText('Dolby Atmos')).toBeVisible();
  });
});

test.describe('detail view (desktop)', () => {
  test('label, removal date, quality chips and the story card; the story can be dismissed for good', async ({ page }) => {
    await page.route(`**/api/items/${breaking.id}/facts`, (r) => r.fulfill({ json: { fresh: 'newSeason', leaving: { leavesAt: day(6), days: 6 }, traits: { resolution: '4k', hdr: 'hdr10', audio: 'surround' } } }));
    await page.route(`**/api/items/${breaking.id}/story`, (r) => r.fulfill({ json: { story: {
      reason: 'newSeason', season: { number: 1, name: 'Staffel 1', overview: 'Ein Chemielehrer steigt in die Drogenwelt ein.' },
      episode: { id: hex(500), name: 'Das Ende', season: 1, index: 7, overview: 'Walter trifft eine folgenschwere Entscheidung.' }, next: { id: hex(501), season: 2, index: 1 },
    } } }));
    await page.goto('/item/' + breaking.id);
    await expect(page.getByRole('heading', { level: 1, name: 'Bright Valley' })).toBeVisible();
    const facts = page.locator('.tf');
    await expect(facts.getByText('Neue Staffel')).toBeVisible();
    await expect(facts.getByText('Nur noch 6 Tage')).toBeVisible();
    await expect(facts.getByText(/Verfügbar bis/)).toBeVisible();
    for (const c of ['4K', 'HDR', '5.1 Surround']) await expect(facts.getByRole('list', { name: 'Bild und Ton' }).getByText(c, { exact: true })).toBeVisible();
    const story = page.getByRole('region', { name: 'Die Geschichte bisher' });
    await expect(story).toBeVisible();
    await expect(story).toContainText('Staffel 2 beginnt');
    await expect(story).toContainText('Ein Chemielehrer steigt in die Drogenwelt ein.');
    await expect(story).toContainText('S1:E7 „Das Ende“');
    await expect(story).toContainText('Walter trifft eine folgenschwere Entscheidung.');
    await page.screenshot({ path: `${SHOTS}/detail-desktop.png` });
    await story.getByRole('button', { name: 'Karte ausblenden' }).click();
    await expect(story).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Bright Valley' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Die Geschichte bisher' })).toHaveCount(0);
  });

  test('a movie shows no story card and a viewer sees no admin entry', async ({ page }) => {
    await page.goto('/item/' + inception.id);
    await expect(page.getByRole('heading', { level: 1, name: 'Inkwell' })).toBeVisible();
    await page.getByRole('button', { name: 'Mehr', exact: true }).click();
    await expect(page.getByRole('button', { name: /Entfernungsdatum/ })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Die Geschichte bisher' })).toHaveCount(0);
  });

  test('admin sets and clears the removal date from the ⋯ menu', async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: ADMIN }));
    let leaving: { leavesAt: string; days: number; note?: string } | null = null;
    const calls: string[] = [];
    await page.route(`**/api/items/${inception.id}/facts`, (r) => r.fulfill({ json: { fresh: null, leaving, traits: null, admin: true } }));
    await page.route(`**/api/admin/leaving/${inception.id}`, async (r) => {
      const req = r.request();
      calls.push(`${req.method()} ${req.postData() ?? ''}`);
      leaving = req.method() === 'PUT' ? { leavesAt: JSON.parse(req.postData()!).leavesAt, days: 4, note: 'Lizenz' } : null;
      await r.fulfill({ json: { ok: true } });
    });
    await page.goto('/item/' + inception.id);
    await expect(page.getByRole('heading', { level: 1, name: 'Inkwell' })).toBeVisible();
    await page.getByRole('button', { name: 'Mehr', exact: true }).click();
    await page.getByRole('button', { name: /Entfernungsdatum setzen/ }).click();
    const dlg = page.getByRole('dialog', { name: 'Nicht mehr verfügbar ab' });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Datum entfernen' })).toHaveCount(0); // nothing to clear yet
    await dlg.getByLabel('Verlässt uns am').fill(day(4));
    await dlg.getByLabel('Notiz (nur für Admins)').fill('Lizenz');
    await page.screenshot({ path: `${SHOTS}/admin-dialog-desktop.png` });
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg).toHaveCount(0);
    expect(calls[0]).toBe(`PUT ${JSON.stringify({ leavesAt: day(4), note: 'Lizenz' })}`);
    await expect(page.locator('.tf').getByText('Nur noch 4 Tage')).toBeVisible();
    // clear again
    await page.getByRole('button', { name: 'Mehr', exact: true }).click();
    await page.getByRole('button', { name: /Entfernungsdatum setzen/ }).click();
    const dlg2 = page.getByRole('dialog', { name: 'Nicht mehr verfügbar ab' });
    await expect(dlg2.getByLabel('Verlässt uns am')).toHaveValue(day(4));
    await dlg2.getByRole('button', { name: 'Datum entfernen' }).click();
    await expect(dlg2).toHaveCount(0);
    expect(calls[1]).toBe('DELETE ');
    await expect(page.locator('.tf')).toHaveCount(0);
  });
});

test.describe('browse filter 4K / HDR (desktop)', () => {
  test('chips switch to the quality endpoint, combine with other filters and can be removed', async ({ page }) => {
    const seen: string[] = [];
    await page.route('**/api/library/quality**', async (r) => {
      seen.push(new URL(r.request().url()).search);
      await r.fulfill({ json: { items: [inception, interstellar], total: 2 } });
    });
    await page.goto('/browse/movies');
    const g = page.getByRole('group', { name: 'Bildqualität' });
    await expect(g.getByRole('button', { name: '4K' })).toHaveAttribute('aria-pressed', 'false');
    await g.getByRole('button', { name: '4K' }).click();
    await expect(page).toHaveURL(/quality=4k/);
    await expect(g.getByRole('button', { name: '4K' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.tiles article.card')).toHaveCount(2);
    await expect.poll(() => seen.at(-1)).toMatch(/quality=4k/);
    await g.getByRole('button', { name: 'HDR' }).click();
    await expect(page).toHaveURL(/quality=4k(%2C|,)hdr/);
    await expect.poll(() => seen.at(-1)).toMatch(/quality=4k%2Chdr/);
    const chips = page.getByRole('list', { name: 'Aktive Filter' });
    await expect(chips.getByRole('button', { name: /Filter 4K entfernen/ })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/browse-desktop.png` });
    await chips.getByRole('button', { name: /Filter 4K entfernen/ }).click();
    await expect(page).toHaveURL(/quality=hdr/);
    await chips.getByRole('button', { name: /Filter HDR entfernen/ }).click();
    await expect(page).not.toHaveURL(/quality=/);
    await expect(page.getByRole('list', { name: 'Aktive Filter' })).toHaveCount(0);
  });

  test('a link with ?quality= and a genre asks for both', async ({ page }) => {
    let q = '';
    await page.route('**/api/library/quality**', async (r) => { q = new URL(r.request().url()).search; await r.fulfill({ json: { items: [], total: 0 } }); });
    await page.goto('/browse/series?quality=hdr&genre=Drama&junk=1');
    await expect(page.locator('.state')).toBeVisible();
    expect(q).toMatch(/types=Series/);
    expect(q).toMatch(/genre=Drama/);
    expect(q).toMatch(/quality=hdr/);
    expect(q).not.toMatch(/junk/);
  });
});

// the admin page /admin/leaving is covered by admin-leaving.spec.ts

test.describe('language', () => {
  test('labels follow the UI language', async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, language: 'en', languageChosen: true } }));
    await mockBadges(page, { [inception.id]: { fresh: 'new', daysLeft: 1 } });
    await page.route('**/api/library/leaving', (r) => r.fulfill({ json: { items: [{ ...inception, daysLeft: 1 }] } }));
    await page.goto('/');
    const leaving = row(page, 'Leaving soon');
    await expect(leaving).toBeAttached();
    await leaving.scrollIntoViewIfNeeded();
    await expect(leaving.getByText('Only 1 day left')).toBeVisible();
    await expect(page.getByText('Season finale').first()).toBeAttached();
  });
});
