import { defineConfig, devices } from '@playwright/test';
import { IDENTITY } from '../shared/identity';

// Standalone config for the missing-agent test. Assumes the dev server is
// already running on the frontend dev port (started outside playwright).
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['missing-agent.spec.ts', 'file-viewer-selection.spec.ts', 'self-verify-channel-c.spec.ts', 'state-sync-visual.spec.ts', 'state-sync-idle-drift.spec.ts'],
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `https://localhost:${IDENTITY.frontendDevPort}`,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'mobile-chromium',
      use: {
        ...devices['Pixel 5'],
        ignoreHTTPSErrors: true,
      },
    },
    {
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        ignoreHTTPSErrors: true,
      },
    },
  ],
});
