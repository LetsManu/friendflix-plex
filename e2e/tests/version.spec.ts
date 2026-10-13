import { readFileSync } from 'node:fs';
import { expect, test } from '../fixtures.js';

const { version, codename } = JSON.parse(readFileSync(new URL('../../version.json', import.meta.url), 'utf8')) as { version: string; codename: string };
const short = version.split('.').slice(0, 2).join('.');
const LINES: Record<string, string> = { Arancini: 'Frittierte Reisbällchen mit Käseherz' };

test.describe('version + codename easter egg (desktop)', () => {
  test('footer shows the version; hint from the 4th click; 7 clicks open the card; Esc closes and focus returns', async ({ page }) => {
    await page.goto('/');
    const footer = page.getByRole('contentinfo');
    const ver = footer.getByRole('button', { name: `FriendFlix ${version} · ${codename}` });
    await expect(ver).toBeVisible();
    for (let i = 1; i <= 3; i++) await ver.click();
    await expect(footer.getByText(/Noch \d…/)).toHaveCount(0);
    await ver.click();
    await expect(footer.getByText('Noch 3…')).toBeVisible();
    await ver.click();
    await expect(footer.getByText('Noch 2…')).toBeVisible();
    await ver.click();
    await expect(footer.getByText('Noch 1…')).toBeVisible();
    await ver.click();

    const card = page.getByRole('dialog', { name: `${short} ${codename}` });
    await expect(card).toBeVisible();
    if (LINES[codename]) await expect(card).toContainText(LINES[codename]);
    await expect(page.locator('[data-egg-rain]')).toHaveCount(0); // the suite runs with prefers-reduced-motion: reduce
    const close = card.getByRole('button', { name: 'Schließen' });
    await expect(close).toBeFocused();
    await page.keyboard.press('Tab'); // focus stays in the card
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await expect(ver).toBeFocused();
  });

  test('TV remote: 7× OK on the focused version, Back closes', async ({ page }) => {
    await page.goto('/');
    const ver = page.getByRole('contentinfo').getByRole('button', { name: `FriendFlix ${version} · ${codename}` });
    await ver.focus();
    for (let i = 0; i < 7; i++) await page.keyboard.press('Enter');
    const card = page.getByRole('dialog', { name: `${short} ${codename}` });
    await expect(card).toBeVisible();
    await page.keyboard.press('Backspace'); // a "Back" key outside text fields
    await expect(card).toHaveCount(0);
    await expect(ver).toBeFocused();
    await expect(page).toHaveURL(/\/$/);
  });

  test.describe('with motion', () => {
    test.use({ reducedMotion: 'no-preference' });
    test('popcorn rain falls over the card and a click closes it', async ({ page }) => {
      await page.goto('/');
      const ver = page.getByRole('contentinfo').getByRole('button', { name: `FriendFlix ${version} · ${codename}` });
      for (let i = 0; i < 7; i++) await ver.click();
      const rain = page.locator('[data-egg-rain]');
      await expect(rain).toHaveCount(1);
      await expect(rain).toHaveCSS('pointer-events', 'none');
      await expect(rain).toHaveCount(0, { timeout: 5000 }); // gone after ~2.5 s, the card stays
      const card = page.getByRole('dialog', { name: `${short} ${codename}` });
      await expect(card).toBeVisible();
      await page.mouse.click(10, 10);
      await expect(card).toHaveCount(0);
    });
  });

  test('admin version page: codename, update available, notes as plain text, egg on the version', async ({ page, api }) => {
    api.asAdmin = true;
    await page.goto('/admin/update');
    const ver = page.getByRole('region', { name: 'Version' });
    await expect(ver.getByRole('button', { name: '1.0.0 · Arancini' })).toBeVisible();
    await expect(ver).toContainText('Build c0be6c5');
    await expect(ver).toContainText('Neueste:');
    await expect(ver).toContainText('1.1.0 · Arancini');
    await expect(ver).toContainText('Update verfügbar');
    await expect(ver.getByRole('link', { name: 'Release auf GitHub' })).toHaveAttribute('href', 'https://example.org/releases/v1.1.0');

    const notes = ver.getByText('Was ist neu in 1.1.0 · Arancini');
    await expect(ver.getByText('Adaptive quality for every connection')).toBeHidden();
    await notes.click();
    await expect(ver.getByRole('heading', { name: 'Streaming' })).toBeVisible();
    await expect(ver.getByRole('listitem').filter({ hasText: 'Adaptive quality for every connection' })).toBeVisible();
    await expect(ver.getByRole('listitem').filter({ hasText: 'Night mode' })).toBeVisible();
    await expect(ver.locator('img')).toHaveCount(0); // markup in the notes is never rendered
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();

    const btn = ver.getByRole('button', { name: '1.0.0 · Arancini' });
    for (let i = 0; i < 7; i++) await btn.click();
    await expect(page.getByRole('dialog', { name: '1.0 Arancini' })).toContainText('Frittierte Reisbällchen');
  });
});
