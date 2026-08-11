import { test, expect, type APIRequestContext } from '@playwright/test';
import { IDENTITY } from '../../../shared/identity';
import { readFileSync, existsSync } from 'node:fs';

// Channel C smoke test. Requires the dev server to be started with
// HRDLE_SELF_VERIFY=1. Drives a brief session and asserts the server wrote
// drift records to /tmp/hrdle-drift.log.

const FRONTEND_URL = `https://localhost:${IDENTITY.frontendDevPort}`;
const BACKEND_URL = `https://localhost:${IDENTITY.devPort}`;
const DRIFT_LOG = '/tmp/hrdle-drift.log';

test.use({
  ignoreHTTPSErrors: true,
  baseURL: FRONTEND_URL,
});

async function pickFirstClaudeSession(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${BACKEND_URL}/api/sessions`);
  const data = await res.json();
  const target = data.sessions.find(
    (s: { agent?: string; state?: string }) =>
      s.agent === 'claude' && (s.state === 'idle' || s.state === 'working'),
  );
  if (!target) throw new Error('no claude session — start `claude` in a tmux session');
  return target.id as string;
}

test('Channel C writes drift records to log under HRDLE_SELF_VERIFY=1', async ({ page, request }) => {
  const sessionId = await pickFirstClaudeSession(request);

  await page.addInitScript(([id]) => {
    localStorage.setItem('hrdle-open-sessions', JSON.stringify([id]));
    localStorage.setItem('hrdle-last-session-id', id);
    localStorage.setItem('hrdle-onboarding-completed', 'true');
    localStorage.setItem('hrdle-onboarding-sessionlist-completed', 'true');
  }, [sessionId]);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // Wait long enough for the reconnect-done trigger (500ms) + a periodic-ish
  // round trip. Output-idle also fires after any startup chatter.
  await page.waitForTimeout(2500);

  expect(existsSync(DRIFT_LOG), `${DRIFT_LOG} should exist`).toBe(true);
  const lines = readFileSync(DRIFT_LOG, 'utf8').trim().split('\n').filter(Boolean);
  expect(lines.length, 'at least one drift record should be appended').toBeGreaterThan(0);

  const records = lines.map(l => JSON.parse(l));
  console.log(`[diagnostic] drift records: ${records.length}, sample:`, JSON.stringify(records[0]).slice(0, 200));

  // Every record must have the expected shape.
  for (const r of records) {
    expect(typeof r.ts).toBe('number');
    expect(typeof r.paneId).toBe('string');
    expect(['resize-done', 'reconnect-done', 'output-idle', 'periodic', 'user']).toContain(r.trigger);
    expect(typeof r.mismatchCount).toBe('number');
    expect(typeof r.clientRows).toBe('number');
    expect(typeof r.canonicalRows).toBe('number');
  }
});
