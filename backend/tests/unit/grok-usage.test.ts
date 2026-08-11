import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GrokSessionStore } from '../../src/services/grok';
import { GrokUsageService } from '../../src/services/grok-usage';

const TEST_DIR = join(tmpdir(), `hrdle-grok-usage-${Date.now()}`);
const SESSIONS_DIR = join(TEST_DIR, 'sessions');
const CWD = '/home/user/proj';
const SESSION_ID = '019f0000-0000-7000-8000-000000000001';

function turnCompleted(unixSeconds: number, totalTokens: number, model: string): string {
  return JSON.stringify({
    timestamp: unixSeconds,
    method: 'session/update',
    params: {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'turn_completed',
        stop_reason: 'end_turn',
        usage: {
          inputTokens: totalTokens - 100,
          outputTokens: 100,
          totalTokens,
          cachedReadTokens: 0,
          modelUsage: { [model]: { totalTokens } },
        },
      },
    },
  });
}

beforeEach(async () => {
  const sessionDir = join(SESSIONS_DIR, encodeURIComponent(CWD), SESSION_ID);
  await mkdir(sessionDir, { recursive: true });
  const nowIso = new Date().toISOString();
  await writeFile(join(sessionDir, 'summary.json'), JSON.stringify({
    info: { id: SESSION_ID, cwd: CWD },
    session_summary: 'test',
    created_at: nowIso,
    last_active_at: nowIso,
  }));
  const nowSec = Math.floor(Date.now() / 1000);
  await writeFile(join(sessionDir, 'updates.jsonl'), [
    turnCompleted(nowSec - 6 * 24 * 3600, 10_000, 'grok-4.5-build-free'), // 6 days ago → 7d only
    turnCompleted(nowSec - 2 * 3600, 5_000, 'grok-4.5-build-free'),       // 2h ago → both windows
    turnCompleted(nowSec - 30 * 24 * 3600, 99_999, 'grok-4.5'),           // 30 days ago → excluded
  ].join('\n'));
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe('GrokUsageService', () => {
  test('aggregates 24h / 7d windows from turn_completed records', async () => {
    const service = new GrokUsageService(new GrokSessionStore(SESSIONS_DIR));
    const summary = await service.getUsageSummary();
    expect(summary).not.toBeNull();
    expect(summary?.last7d).toEqual({
      turns: 2,
      totalTokens: 15_000,
      inputTokens: 14_800,
      outputTokens: 200,
    });
    expect(summary?.last24h.turns).toBe(1);
    expect(summary?.last24h.totalTokens).toBe(5_000);
    expect(summary?.models).toEqual([{ model: 'grok-4.5-build-free', totalTokens: 15_000 }]);
    expect(summary?.sessions7d).toBe(1);
    expect(summary?.planType).toBe('Free');
  });

  test('returns null when there are no recent sessions', async () => {
    const service = new GrokUsageService(new GrokSessionStore(join(TEST_DIR, 'missing')));
    expect(await service.getUsageSummary()).toBeNull();
  });
});
