// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { ME } from '../mocks/fixtures.js';

const SHOTS = process.env.I18N_SHOTS; // optional: directory for review screenshots

test.describe('UI language', () => {
  test('switching to English in the settings translates the shell without a reload', async ({ page, api }) => {
    await page.goto('/settings');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    await expect(nav.getByRole('link')).toHaveText(['Start', 'Serien', 'Filme', 'Neu & demnächst', 'Merkliste']);
    await page.locator('#ui-lang').selectOption('en');
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link')).toHaveText(['Home', 'TV Shows', 'Movies', 'New & Upcoming', 'Watchlist']);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1, name: 'Playback settings' })).toBeVisible();
    expect(api.log.some((l) => l.startsWith('PUT /api/prefs/language {"language":"en"}'))).toBe(true);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings-en.png`, fullPage: false });

    // the avatar menu and the footer follow, and the footer can switch back
    await page.getByRole('button', { name: /Profile menu/ }).click();
    await expect(page.getByRole('menu', { name: 'Profile menu' }).getByRole('menuitem', { name: 'Sign out of FriendFlix' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'Watchlist', exact: true }).first().click();
    await expect(page).toHaveURL(/\/watchlist$/);
    const footer = page.getByRole('contentinfo');
    await expect(footer.getByRole('link', { name: 'Watch party' })).toBeAttached();
    if (SHOTS) { await footer.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${SHOTS}/footer-en.png` }); }
    await footer.getByRole('combobox', { name: 'Language' }).selectOption('de');
    await expect(page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link').first()).toHaveText('Start');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  });

  test('first login: the language picker appears once, preselects the browser language and saves it', async ({ page, api }) => {
    let chosen = false;
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, language: chosen ? 'en' : 'de', languageChosen: chosen, defaultLanguage: 'de', defaultLanguageSet: true, suggestedLanguage: 'en' } }));
    page.on('request', (req) => { if (req.url().endsWith('/api/prefs/language') && req.method() === 'PUT') chosen = true; });
    await page.goto('/');
    const dlg = page.getByRole('dialog', { name: 'Choose your language' });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole('radio', { name: /English/ })).toHaveAttribute('aria-checked', 'true');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/first-login-picker.png` });
    // arrow keys move the choice, the picker previews the highlighted language
    await dlg.getByRole('radio', { name: /Deutsch/ }).click();
    await expect(page.getByRole('dialog', { name: 'Sprache wählen' })).toBeVisible();
    await page.getByRole('dialog', { name: 'Sprache wählen' }).getByRole('radio', { name: /English/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(dlg).toHaveCount(0);
    expect(api.log.some((l) => l.startsWith('PUT /api/prefs/language {"language":"en"}'))).toBe(true);
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link').first()).toHaveText('Home');
    await page.goto('/new'); // a full reload: the server now reports the stored choice
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: /language|Sprache/ })).toHaveCount(0);
  });

  test('first login: "Später" keeps the instance default and stores it', async ({ page, api }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, language: 'de', languageChosen: false, defaultLanguage: 'de', defaultLanguageSet: true, suggestedLanguage: null } }));
    await page.goto('/');
    const dlg = page.getByRole('dialog', { name: 'Sprache wählen' });
    await expect(dlg.getByRole('radio', { name: /Deutsch/ })).toHaveAttribute('aria-checked', 'true');
    await dlg.getByRole('button', { name: 'Später' }).click();
    await expect(dlg).toHaveCount(0);
    expect(api.log.some((l) => l.startsWith('PUT /api/prefs/language {"language":"de"}'))).toBe(true);
  });

  test('first admin visit: the instance language is asked once (German preselected)', async ({ page, api }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, isAdmin: true, role: 'admin', language: 'de', languageChosen: true, defaultLanguage: 'de', defaultLanguageSet: false } }));
    await page.goto('/');
    const dlg = page.getByRole('dialog', { name: /Sprache der Instanz/ });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole('radio', { name: /Deutsch/ })).toHaveAttribute('aria-checked', 'true');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/admin-instance-language.png` });
    await dlg.getByRole('button', { name: 'Als Standard speichern' }).click();
    await expect(dlg).toHaveCount(0);
    expect(api.log.some((l) => l.startsWith('PUT /api/admin/settings/language {"language":"de"}'))).toBe(true);
    expect(api.log.some((l) => l.startsWith('PUT /api/prefs/language'))).toBe(false); // the admin had a language already
  });

  test('/me links to the language setting', async ({ page }) => {
    await page.goto('/me');
    await page.getByRole('link', { name: 'Sprache: Deutsch' }).click();
    await expect(page).toHaveURL(/\/settings#language$/);
    await expect(page.locator('#ui-lang')).toHaveValue('de');
  });
});
