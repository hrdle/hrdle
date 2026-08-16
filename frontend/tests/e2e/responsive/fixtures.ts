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

export interface BootOptions {
  /** What `/api/steward/enabled` answers. Off by default, which is what a
   *  server without the flag reports and what every other spec expects. */
  steward?: {
    enabled: boolean;
    thread?: unknown[];
    lines?: unknown[];
    /** What `demo` has written about it. */
    turns?: unknown[];
    /** Questions still waiting, as `GET /asks` answers them. */
    asks?: unknown[];
    /** Set the localStorage view switch before the app boots. */
    view?: boolean;
  };
  /** Give `demo` a pane with an agent in it, which is what chat mode needs.
   *  Opt-in: with panes present a row renders differently, and the specs that
   *  measure the row were written without them. */
  withAgentPane?: boolean;
}

const AGENT_PANE = {
  paneId: '%1',
  isActive: true,
  agent: 'claude',
  agentSessionId: 'sess-1',
  currentPath: '/home/dev/project',
};

export async function bootApp(page: Page, options: BootOptions = {}): Promise<void> {
  // Onboarding is a full-screen overlay; skipping it exposes the real UI, which
  // is what these specs are measuring.
  const view = options.steward?.view === true;
  await page.addInitScript((stewardView: boolean) => {
    localStorage.setItem('hrdle-onboarding-completed', 'true');
    localStorage.setItem('hrdle-onboarding-sessionlist-completed', 'true');
    if (stewardView) localStorage.setItem('hrdle-steward-view', 'true');
  }, view);

  const steward = options.steward ?? { enabled: false };
  const sessions = options.withAgentPane
    ? [{ ...SESSIONS[0], agentSessionId: 'sess-1', panes: [AGENT_PANE] }, ...SESSIONS.slice(1)]
    : SESSIONS;
  const stewardRoutes: Array<[RegExp, unknown]> = [
    [/\/api\/steward\/enabled$/, { enabled: steward.enabled }],
    [/\/api\/steward$/, { thread: steward.thread ?? [], lines: steward.lines ?? [] }],
    [/\/api\/steward\/sessions\/[^/]+\/turns$/, { turns: steward.turns ?? [] }],
    [/\/api\/steward\/asks/, { asks: steward.asks ?? [] }],
    [/\/api\/steward\/observer$/, { present: true, status: 'idle' }],
    [/\/api\/workspaces$/, { sessions }],
    [/\/api\/sessions$/, { sessions }],
  ];

  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const match = [...stewardRoutes, ...ROUTES].find(([pattern]) => pattern.test(url));
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
