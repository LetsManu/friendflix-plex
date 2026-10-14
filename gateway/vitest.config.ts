// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // CI fails below these (reached level rounded down; OpenSSF gold asks for >= 90 % statements / >= 80 % branches).
      // Raise them when coverage goes up, never lower them to make a change pass. See CONTRIBUTING.md.
      thresholds: { statements: 93, branches: 90 },
      reporter: ['text-summary', 'json-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/generated/**', '**/*.generated.*'],
    },
  },
});
