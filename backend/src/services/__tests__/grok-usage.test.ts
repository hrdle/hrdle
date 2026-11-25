import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrokSessionStore } from '../grok';
import { GrokUsageService } from '../grok-usage';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function turnCompleted(secondsAgo: number, totalTokens: number, models: string[]): string {
  return JSON.stringify({
    timestamp: Math.floor(Date.now() / 1000) - secondsAgo,
    params: {
      update: {
        sessionUpdate: 'turn_completed',
        usage: {
          inputTokens: totalTokens - 10,
          outputTokens: 10,
          totalTokens,
          modelUsage: Object.fromEntries(models.map((m) => [m, {}])),
        },
      },
    },
  });
}

/** A sessions dir with one project and the given sessions' `updates.jsonl` lines. */
function storeWith(sessions: Record<string, string[]>): GrokSessionStore {
  const root = mkdtempSync(join(tmpdir(), 'grok-usage-'));
  dirs.push(root);
  const project = join(root, encodeURIComponent('/work/project'));
  for (const [id, lines] of Object.entries(sessions)) {
    const dir = join(project, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ info: { id }, last_active_at: new Date().toISOString() }));
    writeFileSync(join(dir, 'updates.jsonl'), `${lines.join('\n')}\n`);
  }
  return new GrokSessionStore(root);
}

describe('GrokUsageService', () => {
  test('aggregates turn_completed records into the two windows', async () => {
    const store = storeWith({
      a: [turnCompleted(60, 100, ['grok-5']), turnCompleted(3 * 24 * 3600, 300, ['grok-5'])],
      b: [JSON.stringify({ params: { update: { sessionUpdate: 'other' } } })],
    });
    const summary = await new GrokUsageService(store).getUsageSummary();
    expect(summary?.last24h).toEqual({ turns: 1, totalTokens: 100, inputTokens: 90, outputTokens: 10 });
    expect(summary?.last7d.totalTokens).toBe(400);
    expect(summary?.models).toEqual([{ model: 'grok-5', totalTokens: 400 }]);
    // Session b was active but produced no turn, so it is not counted.
    expect(summary?.sessions7d).toBe(1);
    expect(summary?.planType).toBeUndefined();
  });

  test('the latest turn on a free model marks the plan Free', async () => {
    const store = storeWith({
      a: [turnCompleted(3600, 50, ['grok-5']), turnCompleted(60, 50, ['grok-code-free'])],
    });
    expect((await new GrokUsageService(store).getUsageSummary())?.planType).toBe('Free');
  });

  test('no turns at all is null', async () => {
    const store = storeWith({ a: [] });
    expect(await new GrokUsageService(store).getUsageSummary()).toBeNull();
  });
});
