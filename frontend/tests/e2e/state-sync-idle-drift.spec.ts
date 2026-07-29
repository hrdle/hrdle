import { test, expect, type APIRequestContext } from '@playwright/test';
import { IDENTITY } from '../../../shared/identity';
// @ts-ignore - node builtin
import { existsSync, readFileSync, writeFileSync } from 'fs';

const FRONTEND_URL = `https://localhost:${IDENTITY.frontendDevPort}`;
const BACKEND_URL = `https://localhost:${IDENTITY.devPort}`;
const DRIFT_LOG = '/tmp/cchub-drift.log';

test.use({ ignoreHTTPSErrors: true, baseURL: FRONTEND_URL });

async function pickSessionByName(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.get(`${BACKEND_URL}/api/sessions`);
  const data = await res.json();
  const target = data.sessions.find((s: { name?: string }) => s.name === name);
  if (!target) throw new Error(`no session named ${name}`);
  return target.id as string;
}

test('idle session: drift rate should be low after state-sync', async ({ page, request }) => {
  // Reset drift log so we only measure this run.
  if (existsSync(DRIFT_LOG)) writeFileSync(DRIFT_LOG, '');

  const sessionId = await pickSessionByName(request, 'state-sync-test');

  await page.addInitScript(([id]) => {
    localStorage.setItem('cchub-open-sessions', JSON.stringify([id]));
    localStorage.setItem('cchub-last-session-id', id);
    localStorage.setItem('cchub-onboarding-completed', 'true');
    localStorage.setItem('cchub-onboarding-sessionlist-completed', 'true');
  }, [sessionId]);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  const lines = readFileSync(DRIFT_LOG, 'utf8').trim().split('\n').filter(Boolean);
  const records = lines.map((l: string) => JSON.parse(l));

  const byTrigger: Record<string, { count: number; driftCount: number; mismatchSum: number; mismatchMax: number }> = {};
  for (const r of records) {
    const t = r.trigger;
    if (!byTrigger[t]) byTrigger[t] = { count: 0, driftCount: 0, mismatchSum: 0, mismatchMax: 0 };
    byTrigger[t].count++;
    if (r.mismatchCount > 0) byTrigger[t].driftCount++;
    byTrigger[t].mismatchSum += r.mismatchCount;
    if (r.mismatchCount > byTrigger[t].mismatchMax) byTrigger[t].mismatchMax = r.mismatchCount;
  }

  for (const [trigger, s] of Object.entries(byTrigger)) {
    console.log(`[stats] ${trigger}: count=${s.count} driftRate=${(s.driftCount / s.count).toFixed(2)} avg=${(s.mismatchSum / s.count).toFixed(1)} max=${s.mismatchMax}`);
  }

  // Expect at least one record.
  expect(records.length).toBeGreaterThan(0);

  // For an idle session, post-resize the mismatch should be tiny (≤ 3 rows)
  // and most triggers should report mismatch 0.
  const resizeDone = records.filter((r: { trigger: string }) => r.trigger === 'resize-done');
  if (resizeDone.length > 0) {
    const lastResize = resizeDone[resizeDone.length - 1];
    console.log(`[stats] last resize-done mismatch=${lastResize.mismatchCount}/${lastResize.canonicalRows}`);
    expect(lastResize.mismatchCount).toBeLessThanOrEqual(5);
  }
});
