import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.E2E_PORT ?? 4173);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CI = Boolean(process.env.CI);
// Local escape hatch: the Playwright version may want a Chromium build that is not installed (offline sandboxes).
const executablePath = process.env.PW_CHROMIUM || undefined;

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 7_500 },
  reporter: CI ? [['list'], ['html', { open: 'never', outputFolder: './playwright-report' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    serviceWorkers: 'block', // page.route() cannot see requests answered by the app's service worker
    reducedMotion: 'reduce',
    locale: 'de-DE',
    launchOptions: { executablePath, args: executablePath ? ['--no-sandbox'] : [] },
  },
  projects: [
    { name: 'desktop', testMatch: /.*\.spec\.ts/, testIgnore: /.*\.mobile\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    {
      name: 'mobile',
      testMatch: /.*\.mobile\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
    },
  ],
  webServer: {
    // CI builds in a separate step and sets E2E_SKIP_BUILD=1; locally the build is part of the run so tests never hit a stale bundle.
    command: `${process.env.E2E_SKIP_BUILD ? '' : 'npm run build -w web && '}node web/build`,
    cwd: ROOT,
    env: { PORT: String(PORT), HOST: '127.0.0.1' },
    url: `http://127.0.0.1:${PORT}/offline`,
    reuseExistingServer: !CI,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
