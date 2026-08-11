import { test, expect, type APIRequestContext } from '@playwright/test';
import { IDENTITY } from '../../../shared/identity';

// Regression test for the v0.1.106 / v0.1.107 "会話を表示できません" bug.
// ChatView must not render the missing-agent error when /api/sessions
// returns a session with `agent` set.
//
// Requires the dev server (frontend + backend, ports per identity.json) with at
// least one tmux session that has a claude (or codex) process attached.

const FRONTEND_URL = `https://localhost:${IDENTITY.frontendDevPort}`;
const BACKEND_URL = `https://localhost:${IDENTITY.devPort}`;

test.use({
  ignoreHTTPSErrors: true,
  baseURL: FRONTEND_URL,
});

const ERROR_TITLE = '会話を表示できません';
const ERROR_BODY = 'セッションのエージェント情報が取得できませんでした';

async function pickFirstClaudeSession(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${BACKEND_URL}/api/sessions`);
  const data = await res.json();
  const target = data.sessions.find(
    (s: { agent?: string; state?: string }) =>
      s.agent === 'claude' && (s.state === 'idle' || s.state === 'working'),
  );
  if (!target) throw new Error('no claude session available — start `claude` in a tmux session');
  return target.id as string;
}

test('ChatView does not show missing-agent error after initial load', async ({ page, request }) => {
  const sessionId = await pickFirstClaudeSession(request);

  // Seed localStorage before React boots so fetchAndOpenSession follows the
  // restore-saved-sessions path *and* chat mode is on (otherwise ChatView
  // never mounts and the bug is unreachable).
  await page.addInitScript(([id]) => {
    localStorage.setItem('hrdle-open-sessions', JSON.stringify([id]));
    localStorage.setItem('hrdle-last-session-id', id);
    localStorage.setItem('hrdle-conversation-mode-sessions', JSON.stringify([id]));
  }, [sessionId]);

  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // Chat overlay's back-to-terminal button is rendered only after the active
  // session resolves — a deterministic signal that the page has finished its
  // initial fetch / state hydration.
  await page.locator('[aria-label="Switch to Terminal"]').first().waitFor({ timeout: 15000 });

  await expect(page.getByText(ERROR_TITLE)).toHaveCount(0);
  await expect(page.getByText(ERROR_BODY)).toHaveCount(0);
});
