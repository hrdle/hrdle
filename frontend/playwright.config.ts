import { defineConfig, devices } from '@playwright/test';
import { IDENTITY } from '../shared/identity';

// The dev server serves over HTTPS when a Tailscale cert is present (see
// vite.config.ts), which is the normal local setup but never the case in CI.
//
// The port is identity's: webServer waits on this URL before running anything,
// so a number that disagrees with vite's does not fail a test — it hangs until
// the 120s timeout and reports the server as never having come up (#459).
const BASE_URL =
  process.env.E2E_BASE_URL ?? `http://localhost:${IDENTITY.frontendDevPort}`;

const RESPONSIVE = /responsive\/.*\.spec\.ts/;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    ignoreHTTPSErrors: true,
  },
  projects: [
    // Existing specs drive a live backend with real herdr sessions, so they
    // stay desktop-only and local-only.
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: RESPONSIVE,
    },
    // The responsive specs stub the backend, so they run anywhere — including
    // CI. Mobile renders a different component tree from desktop and tablet,
    // and until these existed no width other than desktop was ever exercised.
    {
      name: 'responsive-desktop',
      use: { ...devices['Desktop Chrome'] },
      testMatch: RESPONSIVE,
    },
    {
      name: 'responsive-tablet',
      // Chromium rather than the descriptor's WebKit: this is a layout check,
      // not an engine-compatibility one, and CI only installs chromium.
      use: { ...devices['iPad (gen 7)'], browserName: 'chromium' },
      testMatch: RESPONSIVE,
    },
    {
      name: 'responsive-mobile',
      use: { ...devices['Pixel 5'] },
      testMatch: RESPONSIVE,
    },
  ],
  webServer: {
    command: 'bun run dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    // The local dev server presents a Tailscale cert for a different hostname.
    ignoreHTTPSErrors: true,
    timeout: 120_000,
  },
});
