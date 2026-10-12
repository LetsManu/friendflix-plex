import { expect, test } from '../fixtures.js';
import { boxInViewport, openPopout, row } from '../helpers.js';

// Desktop hover pop-out (portal in <body>) and the quick-view modal opened from it.
test.describe('hover pop-out (desktop)', () => {
  test('stays inside the viewport for the first and the last visible card of a row', async ({ page }) => {
    await page.goto('/');
    const r = row(page, 'Weil du „Inception“ gesehen hast');
    await r.scrollIntoViewIfNeeded();
    const cards = r.locator('article.card');
    await expect(cards.first()).toBeVisible();

    // last card that is fully inside the viewport horizontally (the row scrolls, so the DOM-last card is off-screen)
    const lastVisible = await page.evaluate(() => {
      const row = [...document.querySelectorAll('section.row')].find((s) => s.getAttribute('aria-label')?.startsWith('Weil du'))!;
      const list = [...row.querySelectorAll('article.card')];
      let idx = 0;
      list.forEach((c, i) => { const b = c.getBoundingClientRect(); if (b.left >= 0 && b.right <= window.innerWidth) idx = i; });
      return idx;
    });
    expect(lastVisible).toBeGreaterThan(2);

    for (const idx of [0, lastVisible]) {
      const hp = await openPopout(page, cards.nth(idx));
      const { ok, box, vw, vh } = await boxInViewport(page, hp);
      expect(ok, `pop-out of card ${idx} ${JSON.stringify(box)} must fit ${vw}x${vh}`).toBe(true);
      // it is anchored to the card it belongs to
      await expect(hp).toHaveAccessibleName(/^Vorschau: /);
      await page.mouse.move(2, 2);
      await expect(page.locator('.hp')).toHaveCount(0);
    }
  });

  test('pop-out actions: Meine Liste toggles through the API', async ({ page, api }) => {
    await page.goto('/');
    const card = row(page, 'Weil du „Inception“ gesehen hast').locator('article.card').nth(1); // The Dark Knight: not on the list yet
    const hp = await openPopout(page, card);
    await hp.getByRole('button', { name: 'Zu Meine Liste hinzufügen' }).click();
    await expect(hp.getByRole('button', { name: 'Von Meine Liste entfernen' })).toBeVisible();
    expect(api.log.some((l) => l.startsWith('POST /api/items/') && l.includes('/watchlist'))).toBe(true);
  });
});

test.describe('quick-view modal (desktop)', () => {
  test('opens from the pop-out, closes with Escape and restores the URL', async ({ page }) => {
    await page.goto('/');
    const card = row(page, 'Weil du „Inception“ gesehen hast').locator('article.card').first();
    const hp = await openPopout(page, card);
    await hp.getByRole('link', { name: /^Mehr Infos zu / }).click();

    const modal = page.getByRole('dialog', { name: /Interstellar/ });
    await expect(modal).toBeVisible();
    await expect(page).toHaveURL(/\/item\/0{31}2$/);
    await expect(modal.locator('#modal-title')).toHaveText('Interstellar');
    await expect(page.locator('.hp')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).not.toHaveAttribute('inert', /.*/);
  });
});
