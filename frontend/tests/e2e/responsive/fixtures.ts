import type { Page } from '@playwright/test';

/**
 * Boots the SPA with a stubbed backend.
 *
 * These specs exist to catch layout regressions across viewports, so they must
 * run anywhere — including CI, where there is no backend and no herdr. Every
 * /api call is answered from here instead; the terminal WebSocket is left to
 * fail, which the app already tolerates.
 */

const SESSIONS = [
  {
    id: 'demo',
    name: 'demo',
    instanceId: 'demo-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastAccessedAt: '2026-01-01T00:00:00.000Z',
    state: 'idle',
    currentPath: '/home/dev/project',
    agent: 'claude',
    theme: 'default',
  },
  {
    id: 'notes',
    name: 'notes',
    instanceId: 'notes-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastAccessedAt: '2026-01-01T00:00:00.000Z',
    state: 'idle',
    currentPath: '/home/dev/notes',
    agent: 'codex',
    theme: 'ocean',
  },
];

/** Endpoint suffix -> JSON body. Anything unmatched falls back to `{}`. */
const ROUTES: Array<[RegExp, unknown]> = [
  [/\/api\/auth\/required$/, { required: false }],
  [/\/api\/auth\/me$/, { authenticated: true }],
  [/\/api\/workspaces$/, { sessions: SESSIONS }],
  [/\/api\/sessions$/, { sessions: SESSIONS }],
  [/\/api\/peers$/, { peers: [] }],
  [/\/api\/notify\/hook-status$/, { missing: [] }],
];

export async function bootApp(page: Page): Promise<void> {
  // Onboarding is a full-screen overlay; skipping it exposes the real UI, which
  // is what these specs are measuring.
  await page.addInitScript(() => {
    localStorage.setItem('cchub-onboarding-completed', 'true');
    localStorage.setItem('cchub-onboarding-sessionlist-completed', 'true');
  });

  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const match = ROUTES.find(([pattern]) => pattern.test(url));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(match ? match[1] : {}),
    });
  });

  await page.goto('/');
  // The bundle is large; wait for React to have painted something real.
  await page.locator('#root > *').first().waitFor({ state: 'attached' });
}
