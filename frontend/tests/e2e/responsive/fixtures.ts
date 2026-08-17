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
  /** What `demo`'s agent is doing, as the sessions list reports it. */
  indicatorState?: 'processing' | 'waiting_input' | 'idle' | 'completed';
  /** The tool call it is on, as `claudeActivity` reads it from the transcript. */
  activity?: { tool: string; target?: string };
  /** Give `demo` a pane with an agent in it, which is what chat mode needs.
   *  Opt-in: with panes present a row renders differently, and the specs that
   *  measure the row were written without them. */
  withAgentPane?: boolean;
  /** A second agent pane in the same workspace. The phone draws a tab per pane
   *  then, which is the case the steward's chat has to answer for: it writes
   *  one history per workspace, so the tabs cannot switch it. */
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
  // A different conversation in the same workspace, which is the whole point:
  // the raw transcript switches with the pane and the steward's history does
  // not, because it is written per workspace.
  agentSessionId: 'sess-2',
  currentCommand: 'claude',
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
