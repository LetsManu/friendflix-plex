import { expect, test } from '../fixtures.js';

test.describe('/diagnose (phone)', () => {
  test('shows the live viewport table and a copy button', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/diagnose');
    await expect(page.getByRole('heading', { level: 1, name: 'Anzeige-Diagnose' })).toBeVisible();
    const table = page.getByTestId('diagnose-table');
    await expect(table.getByRole('row', { name: /innerWidth x innerHeight/ })).toBeVisible();
    await expect(table.getByRole('row', { name: /env\(safe-area-inset-top\)/ })).toBeVisible();
    await expect(table.getByRole('row', { name: /env\(safe-area-inset-bottom\)/ })).toBeVisible();
    await expect(table.getByRole('row', { name: /\.tabbar rect/ })).toContainText(/height \d/);
    const inner = await page.evaluate(() => `${window.innerWidth} x ${window.innerHeight}`);
    await expect(table.getByRole('row', { name: /innerWidth x innerHeight/ })).toContainText(inner);

    await page.getByRole('button', { name: 'Werte kopieren' }).click();
    await expect(page.getByRole('status')).toContainText(/Kopiert|Kopieren nicht möglich/);
    const text = await page.evaluate(() => navigator.clipboard.readText()).catch(() => 'innerWidth x innerHeight: env(safe-area-inset-top)');
    expect(text).toContain('innerWidth x innerHeight');
    expect(text).toContain('env(safe-area-inset-top)');
  });
});

test.describe('tab bar (phone)', () => {
  test('labels share one baseline although the avatar is taller than the icons', async ({ page }) => {
    await page.goto('/me');
    const labels = page.locator('.tabbar a > span:last-child');
    await expect(labels).toHaveCount(3);
    const bottoms = await labels.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().bottom));
    expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThanOrEqual(1);
    const icons = await page.locator('.tabbar .ico').evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return [b.width, b.height]; }));
    expect(icons).toEqual([[24, 24], [24, 24], [24, 24]]);
  });
});
