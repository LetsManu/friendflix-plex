// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';

// Unit tests run in Node without the SvelteKit plugin (tsconfig extends a generated file, so it is not read here);
// browser APIs are replaced by small doubles in the tests (see src/test-utils).
export default defineConfig({
  oxc: { tsconfig: false } as any,
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Every TypeScript module under src counts, also ones no test imports (coverage.include lists them all).
      // Svelte components (.svelte) are not part of this metric: Playwright covers them end to end (e2e/).
      // CI fails below these (reached level rounded down; OpenSSF gold asks for >= 90 % statements / >= 80 % branches).
      // Raise them when coverage goes up, never lower them to make a change pass. See CONTRIBUTING.md.
      thresholds: { statements: 94, branches: 89 },
      reporter: ['text-summary', 'json-summary', 'lcov'],
      include: ['src/**/*.ts'],
      // src/test-utils: fakes of browser APIs (OPFS, IndexedDB) used by the unit tests, not application code
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/generated/**', '**/*.generated.*', 'src/test-utils/**'],
    },
  },
});
