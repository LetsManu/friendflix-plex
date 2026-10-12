import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow, row } from '../helpers.js';

test.describe('home (desktop)', () => {
  test('renders the main navigation and the content rows', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    await expect(nav.getByRole('link', { name: 'Start' })).toHaveAttribute('aria-current', 'page');
    for (const name of ['Serien', 'Filme', 'Neu & beliebt', 'Meine Liste']) await expect(nav.getByRole('link', { name })).toBeVisible();

    for (const title of ['Weiterschauen', 'Weil du „Inception“ gesehen hast', 'Diese Woche bei uns', 'Top 10 nach Bewertung']) {
      await expect(row(page, title)).toBeAttached();
    }
    await expect(row(page, 'Weiterschauen').locator('article.card')).toHaveCount(2);
    await expect(row(page, 'Weiterschauen').locator('article.card').first()).toBeVisible();
    // desktop uses 16:9 cards, never the phone poster cards or the tab bar
    await expect(page.locator('.pc')).toHaveCount(0);
    await expect(page.locator('.tabbar')).toBeHidden();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('trending row has five cards and one new-episodes badge', async ({ page }) => {
    await page.goto('/');
    const trending = row(page, 'Diese Woche bei uns');
    await trending.scrollIntoViewIfNeeded();
    await expect(trending.locator('article.card')).toHaveCount(5);
    await expect(trending.getByText('Neue Folgen')).toHaveCount(1);
  });
});
