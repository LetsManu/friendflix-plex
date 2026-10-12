import { LIST_A, LIST_C, MOVIE2 } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';
import { openPopout } from '../helpers.js';

test.describe('lists (desktop)', () => {
  test('overview lists the lists with item counts', async ({ page }) => {
    await page.goto('/lists');
    await expect(page.locator('a.list')).toHaveCount(3);
    await expect(page.locator('main').getByRole('link', { name: /Filmabend/ })).toBeVisible(); // (the footer links to the Filmabend vote page too)
    await expect(page.getByRole('link', { name: /Annas Klassiker/ })).toBeVisible();
  });

  test('ListMenu on the item page adds the title to a list', async ({ page, api }) => {
    await page.goto('/item/' + MOVIE2.id);
    await expect(page.getByRole('heading', { level: 1, name: 'Interlace' })).toBeVisible();
    await page.getByRole('button', { name: 'Mehr', exact: true }).click(); // the list menu lives in "⋯ Mehr" on the detail view
    await page.getByRole('button', { name: 'Zu Liste hinzufügen', exact: true }).click();
    const pop = page.getByRole('dialog', { name: 'Zu Liste hinzufügen' });
    // only lists the viewer can edit are offered (the viewer-only list is hidden)
    await expect(pop.getByRole('listitem')).toHaveCount(2);
    const leer = pop.getByRole('checkbox', { name: 'Leer' });
    await expect(leer).not.toBeChecked();
    await leer.check();
    await expect(leer).toBeChecked();
    await expect.poll(() => api.lists.find((l) => l.id === LIST_C)!.items).toEqual([MOVIE2.id]);

    // the change is visible on the list page
    await page.keyboard.press('Escape');
    await expect(pop).toBeHidden();
    await page.goto('/lists/' + LIST_C);
    await expect(page.getByRole('heading', { level: 1, name: 'Leer' })).toBeVisible();
    await expect(page.locator('.slot')).toHaveCount(1);
  });

  test('ListMenu in the card pop-out removes a title from the list page', async ({ page, api }) => {
    await page.goto('/lists/' + LIST_A);
    await expect(page.getByRole('heading', { level: 1, name: 'Filmabend' })).toBeVisible();
    const slots = page.locator('.slot');
    await expect(slots).toHaveCount(2);

    const hp = await openPopout(page, slots.first().locator('article.card'));
    // the list picker lives in the "⋯ Mehr" menu of the pop-out
    await hp.getByRole('button', { name: /^Mehr Aktionen für / }).click();
    await page.locator('.ma-pop').getByRole('button', { name: 'Zu Liste hinzufügen', exact: true }).click();
    const pop = page.getByRole('dialog', { name: 'Zu Liste hinzufügen' });
    const entry = pop.getByRole('checkbox', { name: 'Filmabend' });
    await expect(entry).toBeChecked();
    await entry.uncheck();

    await expect(slots).toHaveCount(1);
    expect(api.lists.find((l) => l.id === LIST_A)!.items).toHaveLength(1);
    expect(api.log.some((l) => l.startsWith(`DELETE /api/lists/${LIST_A}/items/`))).toBe(true);
  });
});
