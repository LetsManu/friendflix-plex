import { expect, test } from '../fixtures.js';

// Intentionally thrown errors show up as pageerror; they are the point of these tests.
test.describe('browser error reporting', () => {
  test.use({ allowedConsole: /e2e-(boom|rejected|extension)/ });

  test('reports uncaught errors and rejections once, with the path only', async ({ page, api }) => {
    await page.goto('/search?q=geheim');
    await expect(page.locator('#hq')).toHaveValue('geheim');

    await page.evaluate(() => {
      setTimeout(() => { throw new Error('e2e-boom'); });
      setTimeout(() => { throw new Error('e2e-boom'); }); // identical: deduped
      void Promise.reject(new Error('e2e-rejected'));
    });
    await expect.poll(() => api.clientErrors.length).toBe(2);

    const reports = api.clientErrors as Array<Record<string, string>>;
    const boom = reports.find((r) => r.message === 'e2e-boom')!;
    expect(boom.kind).toBe('error');
    expect(boom.url).toBe('/search'); // no ?q=geheim
    expect(boom.stack).toContain('e2e-boom');
    expect(boom.userAgent).toContain('Chrome');
    expect(boom.release).toBeTruthy();
    expect(reports.find((r) => r.message === 'e2e-rejected')!.kind).toBe('unhandledrejection');
  });

  test('ignores errors thrown by browser extensions', async ({ page, api }) => {
    await page.goto('/search');
    await expect(page.locator('#hq')).toBeVisible();
    await page.evaluate(() => {
      const ext = new Error('e2e-extension');
      ext.stack = 'Error: e2e-extension\n    at chrome-extension://abcdef/content.js:1:1';
      setTimeout(() => { throw ext; });
      setTimeout(() => { throw new Error('e2e-boom'); }); // fires after the ignored one
    });
    await expect.poll(() => api.clientErrors.length).toBe(1);
    expect((api.clientErrors as Array<Record<string, string>>)[0]!.message).toBe('e2e-boom');
  });
});
