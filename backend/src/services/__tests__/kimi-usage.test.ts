import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KimiSessionStore } from '../kimi';
import type { KimiConfigService } from '../kimi-config';
import { KimiUsageService } from '../kimi-usage';
import type { KimiUsageStore } from '../kimi-usage-store';
import type { OpenRouterPricingService } from '../openrouter';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function usageRecord(msAgo: number, model: string, inputOther: number, output: number): string {
  return JSON.stringify({
    type: 'usage.record',
    model,
    time: Date.now() - msAgo,
    usage: { inputOther, inputCacheRead: 0, inputCacheCreation: 0, output },
  });
}

/** One session, with each agent id's `wire.jsonl` lines. */
function storeWith(agents: Record<string, string[]>): KimiSessionStore {
  const root = mkdtempSync(join(tmpdir(), 'kimi-usage-'));
  dirs.push(root);
  const session = join(root, 'wd_project_abc', 'session_1');
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, 'state.json'), JSON.stringify({ cwd: '/work/project', updatedAt: Date.now() }));
  for (const [agentId, lines] of Object.entries(agents)) {
    mkdirSync(join(session, 'agents', agentId), { recursive: true });
    writeFileSync(join(session, 'agents', agentId, 'wire.jsonl'), `${lines.join('\n')}\n`);
  }
  return new KimiSessionStore(root);
}

const config = {
  getConfig: async () => ({
    bindings: new Map([
      ['k3', { alias: 'k3', model: 'moonshotai/kimi-k3', provider: 'openrouter', isOpenRouter: true }],
      ['local', { alias: 'local', model: 'local-model', provider: 'ollama', isOpenRouter: false }],
    ]),
  }),
} as unknown as KimiConfigService;
const pricing = {
  getPricing: async (id: string) => (id === 'moonshotai/kimi-k3' ? { prompt: 0.00001, completion: 0.00002 } : undefined),
} as unknown as OpenRouterPricingService;
const history = { record: async () => {}, load: async () => new Map() } as unknown as KimiUsageStore;

describe('KimiUsageService', () => {
  test('counts sub-agent wires and prices only OpenRouter-backed aliases', async () => {
    const store = storeWith({
      main: [usageRecord(60_000, 'k3', 1000, 500), usageRecord(3 * 86_400_000, 'local', 100, 100)],
      sub: [usageRecord(120_000, 'k3', 1000, 500)],
    });
    const summary = await new KimiUsageService(store, config, pricing, history).getUsageSummary();
    expect(summary?.last24h.turns).toBe(2);
    expect(summary?.last7d.turns).toBe(3);
    // 2 x (1000 x 0.00001 + 500 x 0.00002); the local model has no price and adds nothing.
    expect(summary?.last7d.costUsd).toBe(0.04);
    expect(summary?.models).toEqual([
      { model: 'k3', totalTokens: 3000, costUsd: 0.04, pricedAs: 'moonshotai/kimi-k3' },
      { model: 'local', totalTokens: 200, costUsd: undefined, pricedAs: undefined },
    ]);
    expect(summary?.sessions7d).toBe(1);
    expect(summary?.daily.reduce((n, d) => n + d.turns, 0)).toBe(3);
  });

  test('a window of unpriceable models has no cost rather than a zero one', async () => {
    const store = storeWith({ main: [usageRecord(60_000, 'local', 100, 100)] });
    const summary = await new KimiUsageService(store, config, pricing, history).getUsageSummary();
    expect(summary?.last7d.costUsd).toBeUndefined();
  });
});
