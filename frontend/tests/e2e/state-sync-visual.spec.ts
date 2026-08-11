import { test, expect, type APIRequestContext } from '@playwright/test';
import { IDENTITY } from '../../../shared/identity';

// Verify the state-sync transport renders pane content into xterm by reading
// terminal text back from the DOM.

const FRONTEND_URL = `https://localhost:${IDENTITY.frontendDevPort}`;
const BACKEND_URL = `https://localhost:${IDENTITY.devPort}`;

test.use({ ignoreHTTPSErrors: true, baseURL: FRONTEND_URL });

async function pickClaudeSession(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${BACKEND_URL}/api/sessions`);
  const data = await res.json();
  const target = data.sessions.find(
    (s: { agent?: string }) => s.agent === 'claude',
  );
  if (!target) throw new Error('no claude session');
  return target.id as string;
}

test('xterm receives non-empty content via state-sync', async ({ page, request }) => {
  const sessionId = await pickClaudeSession(request);

  await page.addInitScript(([id]) => {
    localStorage.setItem('hrdle-open-sessions', JSON.stringify([id]));
    localStorage.setItem('hrdle-last-session-id', id);
    localStorage.setItem('hrdle-onboarding-completed', 'true');
    localStorage.setItem('hrdle-onboarding-sessionlist-completed', 'true');
  }, [sessionId]);

  // Capture browser console messages for diagnosis.
  page.on('console', msg => {
    if (msg.type() === 'log' || msg.type() === 'warn' || msg.type() === 'error') {
      console.log(`[browser:${msg.type()}]`, msg.text());
    }
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // Wait for the connection + initial resize + initial snapshot to drain.
  await page.waitForTimeout(4000);

  const info = await page.evaluate(() => {
    const xtermEl = document.querySelector('.xterm');
    const rowsEl = document.querySelector('.xterm-rows');
    const screenEl = document.querySelector('.xterm-screen');
    const buffer = (window as any).term?.buffer?.active;
    return {
      hasXterm: !!xtermEl,
      hasRows: !!rowsEl,
      hasScreen: !!screenEl,
      rowsText: rowsEl ? (rowsEl as HTMLElement).innerText : '',
      rowsHtmlLen: rowsEl ? (rowsEl as HTMLElement).innerHTML.length : 0,
      bufferLength: buffer?.length ?? null,
    };
  });

  console.log('[diagnostic]', JSON.stringify(info, null, 2));

  await page.screenshot({ path: 'test-results/state-sync-visual.png', fullPage: false });

  expect(info.hasXterm).toBe(true);
  expect(info.rowsHtmlLen).toBeGreaterThan(50);
});
