import { test as base, expect } from '@playwright/test';
import { freshState, installApi, type MockState } from './mocks/api.js';

/** Console messages that are expected in a specific test (intentionally mocked failures). Opt in per test via `test.use({ allowedConsole: /re/ })`. */
interface Opts { allowedConsole: RegExp | null }
interface Fx { api: MockState; consoleGuard: void }

export const test = base.extend<Fx & Opts>({
  allowedConsole: [null, { option: true }],
  api: async ({ context }, use) => {
    const st = freshState();
    await installApi(context, st);
    await use(st);
    // every API call the app makes must be covered by a deliberate mock
    expect([...st.unmocked], 'unmocked API calls').toEqual([]);
  },
  consoleGuard: [
    async ({ page, allowedConsole, api: _api }, use) => {
      const seen: string[] = [];
      page.on('console', (m) => { if (m.type() === 'error') seen.push(`[console.error] ${m.text()}`); });
      page.on('pageerror', (e) => seen.push(`[pageerror] ${e.message}`));
      await use();
      const bad = seen.filter((s) => !allowedConsole?.test(s));
      expect(bad, 'console errors').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };
export type { MockState };
