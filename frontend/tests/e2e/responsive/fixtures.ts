import type { Page } from '@playwright/test';

/**
 * Boots the SPA with a stubbed backend.
 *
 * These specs exist to catch layout regressions across viewports, so they must
 * run anywhere — including CI, where there is no backend and no herdr. Every
 * /api call is answered from here instead, and every WebSocket is refused.
 *
 * Refusing them is not tidiness. A socket that connects replaces every stub in
 * this file with whatever that server holds: run against a dev server pointed
 * at a real backend, specs failed on live data where the fixture supplies its
 * own. Nothing was wrong with the code, and the failures were reported as if
 * something were. A suite whose data depends on where the dev server happens to
 * point is not a suite, so the dependency is cut here rather than left to
 * whoever runs it.
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
  /** What `demo`'s agent is doing, as the sessions list reports it. */
  indicatorState?: 'processing' | 'waiting_input' | 'idle' | 'completed';
  /** The tool call it is on, as `claudeActivity` reads it from the transcript. */
  activity?: { tool: string; target?: string };
  /** Give `demo` a pane with an agent in it, which is what chat mode needs.
   *  Opt-in: with panes present a row renders differently, and the specs that
   *  measure the row were written without them. */
  withAgentPane?: boolean;
  /** A second agent pane in the same workspace, which draws a tab per pane on
   *  the phone. */
  withSecondAgentPane?: boolean;
  /** What the second pane is doing, as its own row of the sessions list
   *  reports it - and it becomes the picked pane.
   *
   *  Picked here rather than by clicking its tab: a tap asks the server to
   *  focus the pane and the answer comes back on `sessions-updated`, which
   *  this harness has no socket for. What is under test is the screen reading
   *  the picked pane instead of the workspace; the round trip is the server's
   *  and is not stubbed. */
  secondPaneActivity?: { tool: string; target?: string };
  /** This spec drives the WebSocket itself, so leave its route alone.
   *
   *  Playwright matches the last-registered route first, and `bootApp` runs
   *  after the spec's own `routeWebSocket` - so without this the refusal below
   *  would shadow a socket the spec had deliberately set up. */
  ownsWebSocket?: boolean;
}

const AGENT_PANE = {
  paneId: '%1',
  isActive: true,
  agent: 'claude',
  agentSessionId: 'sess-1',
  // What the tab is labelled with. Taken from a real payload: `agentName` is
  // only set for an agent started through `herdr agent start`, so the label
  // that actually reaches the screen is this one.
  currentCommand: 'claude',
  currentPath: '/home/dev/project',
};

/** The same agent again, which is what a real two-pane workspace looks like -
 *  two rows both labelled `claude`, telling nobody which is which. */
const SECOND_AGENT_PANE = {
  paneId: '%6',
  isActive: false,
  agent: 'claude',
  // A different conversation in the same workspace: the transcript switches
  // with the pane.
  agentSessionId: 'sess-2',
  currentCommand: 'claude',
  currentPath: '/home/dev/project',
};

export async function bootApp(page: Page, options: BootOptions = {}): Promise<void> {
  // Onboarding is a full-screen overlay; skipping it exposes the real UI, which
  // is what these specs are measuring.
  await page.addInitScript(() => {
    localStorage.setItem('hrdle-onboarding-completed', 'true');
    localStorage.setItem('hrdle-onboarding-sessionlist-completed', 'true');
  });

  const first = {
    ...SESSIONS[0],
    ...(options.indicatorState ? { indicatorState: options.indicatorState } : {}),
    ...(options.activity ? { activity: options.activity } : {}),
  };
  const picksSecond = !!options.secondPaneActivity;
  const second = {
    ...SECOND_AGENT_PANE,
    ...(picksSecond
      ? { isActive: true, indicatorState: 'processing', activity: options.secondPaneActivity }
      : {}),
  };
  const firstPane = picksSecond ? { ...AGENT_PANE, isActive: false } : AGENT_PANE;
  const panes = options.withSecondAgentPane ? [firstPane, second] : [AGENT_PANE];
  const sessions =
    options.withAgentPane || options.withSecondAgentPane
      ? [{ ...first, agentSessionId: 'sess-1', panes }, ...SESSIONS.slice(1)]
      : [first, ...SESSIONS.slice(1)];
  const sessionRoutes: Array<[RegExp, unknown]> = [
    [/\/api\/workspaces$/, { sessions }],
    [/\/api\/sessions$/, { sessions }],
  ];

  // Before `goto`, or the app's first connection is made before this is in
  // place. Closing rather than hanging: the client treats a closed socket as a
  // server that is not there, which is the state these specs are written for.
  if (!options.ownsWebSocket) {
    await page.routeWebSocket('**/ws/**', (ws) => ws.close());
  }

  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const match = [...sessionRoutes, ...ROUTES].find(([pattern]) => pattern.test(url));
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
