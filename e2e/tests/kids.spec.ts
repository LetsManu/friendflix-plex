import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { ME } from '../mocks/fixtures.js';
import { LOCKED_ID, PROFILES } from '../mocks/api.js';

/** Block 15 K1: kids profiles (kids home, route guard, PIN-gated switch) and the /welcome onboarding. */
const KID = { ...ME, profileCount: 3, kids: true, onboarded: true, profile: { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };
const noIntro = () => { for (const id of ['p1', 'p2', 'p3']) localStorage.setItem(`ff-intro:${id}`, JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); };

async function asKid(page: Page) {
  await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
  await page.addInitScript(noIntro);
}

test.describe('kids profile', () => {
  test.use({ allowedConsole: /status of 403/ }); // the wrong PIN is a mocked 403
  test('kids home instead of the grown-up start page: kids header, big rows, no social links', async ({ page }) => {
    await asKid(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/kids$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Was schauen wir heute?' })).toBeVisible();
    await expect(page.getByText('Hallo Mia!')).toBeVisible();
    const head = page.locator('header.kidsnav');
    await expect(head.getByText('Kids', { exact: true })).toBeVisible();
    await expect(head.getByRole('link', { name: 'Suchen' })).toHaveAttribute('href', '/kids/search');
    await expect(head.getByRole('link', { name: /Profil wechseln \(gerade: Mia\)/ })).toHaveAttribute('href', '/profiles');
    for (const name of ['Weiterschauen', 'Lieblinge', 'Filme', 'Serien']) await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
    // the grown-up navigation, bell and footer links are gone
    await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Benachrichtigungen/ })).toHaveCount(0);
    await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Watch-Party' })).toHaveCount(0);
  });

  test('every grown-up route sends a kids profile back to the kids home', async ({ page }) => {
    await asKid(page);
    for (const path of ['/lists', '/party', '/stats', '/requests', '/admin', '/me']) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/kids$/);
    }
    // client-side navigation too
    await page.evaluate(() => { const a = document.createElement('a'); a.href = '/watchlist'; document.body.appendChild(a); a.click(); });
    await expect(page).toHaveURL(/\/kids$/);
  });

  test('kids search: big field, title tiles only', async ({ page }) => {
    await asKid(page);
    await page.goto('/kids/search');
    const field = page.getByRole('searchbox', { name: 'Titel suchen' });
    await expect(field).toBeFocused();
    await expect(page.getByText('Tippe mindestens zwei Buchstaben.')).toBeVisible();
    await field.fill('inc');
    await expect(page).toHaveURL(/\/kids\/search\?q=inc$/);
    await expect(page.locator('.grid .tile').first()).toBeVisible();
    await field.fill('zzzz');
    await expect(page.getByText('Dazu haben wir leider nichts gefunden.')).toBeVisible();
  });

  test('detail page and settings: no social entry points, only language and playback languages', async ({ page }) => {
    await asKid(page);
    const social: string[] = [];
    page.on('request', (r) => { if (/\/api\/(friends|party|notifications|items\/[^/]+\/(ratings|reactions|friends))/.test(r.url())) social.push(r.url()); });
    await page.goto('/item/' + LOCKED_ID);
    await expect(page.getByRole('heading', { level: 1, name: 'Inception' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Bewerten', exact: true }).first()).toBeVisible(); // own thumbs stay (recommendations)
    await expect(page.getByRole('heading', { name: /^Bewertungen/ })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Deine Reaktion' })).toHaveCount(0);
    await expect(page.getByText('Anna Beispiel')).toHaveCount(0); // friends strip
    await page.getByRole('button', { name: 'Mehr', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Favorit', exact: true })).toBeVisible();
    for (const name of ['Empfehlen', 'Teilen', 'Gemeinsam schauen']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Zu Liste hinzufügen/ })).toHaveCount(0);
    expect(social).toEqual([]); // not even asked for (the server would answer 403 kids_profile)

    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Sprache', exact: true })).toBeVisible();
    await expect(page.getByLabel('Bevorzugte Tonspur')).toBeVisible();
    await expect(page.getByLabel('Untertitel standardmäßig')).toBeVisible();
    await expect(page.getByText('Anime: Originalton mit Untertiteln')).toBeVisible();
    await expect(page.getByText(/Gruppen-Matcher/)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Benachrichtigungen' })).toHaveCount(0);
  });

  test('leaving the kids profile asks for the owner PIN when the target has none', async ({ page }) => {
    let me: object = KID;
    await page.route('**/api/me', (r) => r.fulfill({ json: me }));
    await page.addInitScript(noIntro);
    const list = PROFILES.map((p) => ({ ...p, active: p.id === 'p3', ...(p.id === 'p3' ? { kids: true, maxRating: 6 } : {}), ...(p.id === 'p2' ? { unlock: 'owner' } : {}), ...(p.id === 'p1' ? { hasPin: true } : {}) }));
    await page.route('**/api/profiles', (r) => r.fulfill({ json: { profiles: list, max: 5, activeId: 'p3', kidsLock: 'p3', kidsUnguarded: false } }));
    let tries = 0;
    await page.route('**/api/profiles/p2/select', (r) => {
      const pin = (r.request().postDataJSON() ?? {}).pin;
      tries++;
      if (pin === '1111') { me = { ...ME, profileCount: 3, onboarded: true, profile: { id: 'p2', name: 'Anna', avatar: 'a2', isOwner: false } }; return r.fulfill({ json: { ok: true } }); }
      return r.fulfill({ status: 403, json: { error: pin ? 'pin_wrong' : 'pin_required', pinOf: 'owner' } });
    });
    await page.goto('/profiles?next=%2Fsearch');
    await expect(page.getByRole('button', { name: /Ben \(Kinderprofil\)/ })).toBeVisible();
    await page.getByRole('button', { name: /Anna/ }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByRole('heading', { name: 'PIN von Tester eingeben' })).toBeVisible();
    await expect(dlg.getByText('Zum Verlassen des Kinderprofils ist die PIN des Hauptprofils nötig.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'PIN vergessen?' })).toHaveCount(0); // no reset from a kids profile
    await page.keyboard.type('2222');
    await expect(dlg.getByRole('alert')).toHaveText('Falsche PIN. Bitte noch einmal versuchen.');
    await page.keyboard.type('1111');
    await expect(page).toHaveURL(/\/search$/);
    expect(tries).toBe(2);
  });

  test('a refused PIN reset is explained on the profile picker', async ({ page }) => {
    await page.addInitScript(noIntro);
    await page.goto('/profiles?pinReset=kids');
    await expect(page.getByRole('alert')).toContainText('an ein Kinderprofil gebunden');
    await page.goto('/profiles?pinReset=stale');
    await expect(page.getByRole('alert')).toContainText('nicht frisch genug');
  });

  test('owner creates a kids profile with an age rating; hint when no PIN guards it', async ({ page, api }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, profileCount: 3, onboarded: true } }));
    await page.addInitScript(noIntro);
    const list = PROFILES.map((p) => (p.id === 'p3' ? { ...p, kids: true, maxRating: 12 } : p));
    await page.route('**/api/profiles', (r) => (r.request().method() === 'POST'
      ? r.fulfill({ status: 201, json: { profile: { id: 'p4', name: 'Lea', avatar: 'red', isOwner: false, kids: true, maxRating: 6, hasPin: false, active: false } } })
      : r.fulfill({ json: { profiles: list, max: 5, activeId: 'p1', kidsLock: null, kidsUnguarded: true } })));
    const posted: unknown[] = [];
    page.on('request', (q) => { if (q.method() === 'POST' && q.url().endsWith('/api/profiles')) posted.push(q.postDataJSON()); });
    await page.goto('/profiles?manage=1');
    await expect(page.getByRole('note')).toContainText('Lege für dein Profil eine PIN fest');
    await page.getByRole('button', { name: 'Profil hinzufügen' }).first().click();
    const ed = page.getByRole('dialog');
    await ed.getByLabel('Name').fill('Lea');
    await ed.getByRole('checkbox', { name: 'Kinderprofil' }).check();
    await ed.getByLabel('Altersfreigabe').selectOption({ label: 'ab 6 Jahren' });
    await ed.getByRole('button', { name: 'Speichern' }).click();
    await expect(ed).toHaveCount(0);
    expect(posted).toEqual([expect.objectContaining({ name: 'Lea', kids: true, maxRating: 6 })]);
    void api;
  });
});

test.describe('onboarding (/welcome)', () => {
  test('new profile: name + colour, three liked titles (thumbs), done → back where it wanted to go', async ({ page, api }) => {
    let onboarded = false;
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, onboarded } }));
    await page.route('**/api/prefs/onboarded', (r) => { onboarded = true; return r.fulfill({ json: { onboarded: true } }); });
    await page.route('**/api/profiles/p1', (r) => r.fulfill({ json: { profile: { id: 'p1', name: 'Toni', avatar: 'blue', isOwner: true, hasPin: false, active: true } } }));
    await page.addInitScript(noIntro);
    await page.goto('/browse/movies');
    await expect(page).toHaveURL(/\/welcome\?next=%2Fbrowse%2Fmovies$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Willkommen, Tester!' })).toBeVisible();
    await expect(page.getByText('Schritt 1 von 3')).toBeVisible();
    await page.getByLabel('Name').fill('Toni');
    await page.getByRole('button', { name: 'Blau' }).click();
    await page.getByRole('button', { name: 'Weiter' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'Wähle 3 Titel, die dir gefallen' })).toBeVisible();
    const next = page.getByRole('button', { name: 'Weiter' });
    await expect(next).toBeDisabled();
    const picks = page.locator('.grid .pick');
    for (let i = 0; i < 3; i++) await picks.nth(i).click();
    await expect(picks.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Ausgewählt: 3')).toBeVisible();
    await next.click();

    await expect(page.getByRole('heading', { level: 1, name: 'Alles bereit!' })).toBeVisible();
    await page.getByRole('button', { name: "Los geht's" }).click();
    await expect(page).toHaveURL(/\/browse\/movies$/);
    expect(onboarded).toBe(true);
    expect(api.log.filter((l) => /^PUT \/api\/items\/[^/]+\/thumb \{"value":1\}/.test(l))).toHaveLength(3);
  });

  test('kids onboarding: colour only, favourites become Jellyfin favourites; skipping is allowed', async ({ page, api }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...KID, onboarded: false } }));
    await page.route('**/api/prefs/onboarded', (r) => r.fulfill({ json: { onboarded: true } }));
    await page.addInitScript(noIntro);
    await page.goto('/');
    await expect(page).toHaveURL(/\/welcome\?next=%2Fkids$/);
    await expect(page.getByText('Such dir deine Farbe aus.')).toBeVisible();
    await expect(page.getByLabel('Name')).toHaveCount(0);
    await page.getByRole('button', { name: 'Weiter' }).click(); // nothing changed: no PATCH
    await expect(page.getByRole('heading', { level: 1, name: 'Was magst du am liebsten?' })).toBeVisible();
    await page.getByRole('button', { name: 'Überspringen' }).click();
    await page.getByRole('button', { name: "Los geht's" }).click();
    await expect(page).toHaveURL(/\/kids$/);
    expect(api.log.some((l) => l.includes('/favorite'))).toBe(false);
  });
});
