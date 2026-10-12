import { items } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

const IDS = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-0000000000b${i}`);

test.describe('brand hubs (phone 390x844)', () => {
  test('tiles scroll sideways inside the strip, the page does not', async ({ page }) => {
    await page.route('**/api/hubs', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hubs: IDS.map((id, i) => ({ id, name: `Marke ${i + 1}`, source: 'tag' })) }) }));
    await page.route(/\/api\/hubs\/[^/]+$/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hub: { id: IDS[0], name: 'Marke 1', source: 'tag' }, total: 8, featured: items[0], rows: [{ key: 'new', items: items.slice(0, 6) }] }) }));
    await page.route(/\/api\/hubs\/[^/]+\/items/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: items.slice(0, 4), total: 4 }) }));
    await page.goto('/');
    const strip = page.getByRole('region', { name: 'Marken und Sammlungen' });
    await expect(strip.getByRole('link')).toHaveCount(6);
    const ul = strip.locator('ul');
    expect(await ul.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    // 16:9 tile, tap target >= 44px
    const box = await strip.getByRole('link').first().boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await strip.getByRole('link').first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Marke 1' })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
