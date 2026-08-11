import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KimiSessionStore } from '../../src/services/kimi';
import { KimiConfigService } from '../../src/services/kimi-config';
import { KimiUsageService } from '../../src/services/kimi-usage';
import { OpenRouterPricingService } from '../../src/services/openrouter';

const TEST_DIR = join(tmpdir(), `hrdle-kimi-usage-${Date.now()}`);
const SESSIONS_DIR = join(TEST_DIR, 'sessions');
const CONFIG_PATH = join(TEST_DIR, 'config.toml');

/** Config + price list under test control: the defaults would read the
 *  developer's real ~/.kimi-code/config.toml and hit OpenRouter over the
 *  network, making costs depend on the machine running the tests. */
async function serviceWithConfig(configToml: string): Promise<KimiUsageService> {
  await writeFile(CONFIG_PATH, configToml);
  const prices = {
    data: [
      {
        id: 'moonshotai/kimi-k3',
        pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' },
      },
    ],
  };
  return new KimiUsageService(
    new KimiSessionStore(SESSIONS_DIR),
    new KimiConfigService(CONFIG_PATH),
    new OpenRouterPricingService(
      `data:application/json,${encodeURIComponent(JSON.stringify(prices))}`,
    ),
  );
}

/** k3 → OpenRouter (priceable); k2 → direct Moonshot (not priceable here). */
const CONFIG_TOML = `
[providers.openrouter]
base_url = "https://openrouter.ai/api/v1"
api_key = "sk-or-v1-test"

[providers.moonshot]
base_url = "https://api.moonshot.ai/v1"

[models.k3]
provider = "openrouter"
model = "moonshotai/kimi-k3"

[models.k2]
provider = "moonshot"
model = "kimi-k2"
`;
const CWD = '/home/user/proj';
const WD_DIR = 'wd_proj_58f1d424d923';
const SESSION_ID = 'session_019f0000-0000-7000-8000-000000000001';

function usageRecord(timeMs: number, model: string, usage: Record<string, number>): string {
  return JSON.stringify({ type: 'usage.record', model, usage, usageScope: 'turn', time: timeMs });
}

function stateJson(): string {
  const nowIso = new Date().toISOString();
  return JSON.stringify({
    createdAt: nowIso,
    updatedAt: nowIso,
    title: 'test',
    workDir: CWD,
  });
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
let latestMs = 0;

beforeEach(async () => {
  const now = Date.now();
  latestMs = now - 30 * 60_000;

  const sessionDir = join(SESSIONS_DIR, WD_DIR, SESSION_ID);
  await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
  await mkdir(join(sessionDir, 'agents', 'agent-0'), { recursive: true });
  await writeFile(join(sessionDir, 'state.json'), stateJson());
  await writeFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), [
    JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: now - 2 * DAY_MS }),
    // 2 days ago → 7d only. input = 1000 + 2000 + 0 = 3000, total = 3100
    usageRecord(now - 2 * DAY_MS, 'k2', { inputOther: 1000, output: 100, inputCacheRead: 2000, inputCacheCreation: 0 }),
    // 1h ago → both windows. input = 500 + 0 + 250 = 750, total = 800
    usageRecord(now - HOUR_MS, 'k3', { inputOther: 500, output: 50, inputCacheRead: 0, inputCacheCreation: 250 }),
    // 10 days ago → excluded from the 7d window
    usageRecord(now - 10 * DAY_MS, 'k2', { inputOther: 99_999, output: 1, inputCacheRead: 0, inputCacheCreation: 0 }),
  ].join('\n'));
  // Sub-agent wire: real consumption, must be summed in. input = 100 + 375 + 0 = 475, total = 500
  await writeFile(join(sessionDir, 'agents', 'agent-0', 'wire.jsonl'), [
    usageRecord(latestMs, 'k3', { inputOther: 100, output: 25, inputCacheRead: 375, inputCacheCreation: 0 }),
  ].join('\n'));

  // A second session with no usage records must not count towards sessions7d.
  const idleDir = join(SESSIONS_DIR, WD_DIR, 'session_019f0000-0000-7000-8000-000000000002');
  await mkdir(join(idleDir, 'agents', 'main'), { recursive: true });
  await writeFile(join(idleDir, 'state.json'), stateJson());
  await writeFile(join(idleDir, 'agents', 'main', 'wire.jsonl'), `${JSON.stringify({ type: 'metadata' })}\n`);
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe('KimiUsageService', () => {
  test('aggregates 24h / 7d windows from usage.record records, sub-agents included', async () => {
    // No config → nothing priceable, so the token aggregation is asserted alone.
    const service = await serviceWithConfig('');
    const summary = await service.getUsageSummary();
    expect(summary).not.toBeNull();
    expect(summary?.last7d).toEqual({
      turns: 3,
      totalTokens: 4400,
      inputTokens: 4225,
      cacheReadTokens: 2375,
      outputTokens: 175,
    });
    expect(summary?.last24h).toEqual({
      turns: 2,
      totalTokens: 1300,
      inputTokens: 1225,
      cacheReadTokens: 375,
      outputTokens: 75,
    });
    expect(summary?.models).toEqual([
      { model: 'k2', totalTokens: 3100, costUsd: undefined, pricedAs: undefined },
      { model: 'k3', totalTokens: 1300, costUsd: undefined, pricedAs: undefined },
    ]);
    expect(summary?.sessions7d).toBe(1);
    expect(summary?.lastTurnAt).toBe(new Date(latestMs).toISOString());
  });

  test('prices OpenRouter-backed models per token kind', async () => {
    const service = await serviceWithConfig(CONFIG_TOML);
    const summary = await service.getUsageSummary();
    // k3 in the 24h window: (500 + 250 cache-write, both at prompt price)
    // × 0.000003 + 375 cache-read × 0.0000003 + 50 output × 0.000015.
    const k3In24h = 750 * 0.000003 + 375 * 0.0000003 + 50 * 0.000015;
    // Plus the sub-agent turn's own 100 input / 25 output.
    const subAgent = 100 * 0.000003 + 0 * 0.0000003 + 25 * 0.000015;
    // Reported costs are rounded to 4 dp, so sub-cent amounts stay visible.
    const expected = Math.round((k3In24h + subAgent) * 10_000) / 10_000;
    expect(summary?.last24h.costUsd).toBe(expected);

    const byModel = new Map(summary?.models.map((m) => [m.model, m]));
    expect(byModel.get('k3')?.pricedAs).toBe('moonshotai/kimi-k3');
    // k3's only records are the two 24h ones, so its 7d total matches.
    expect(byModel.get('k3')?.costUsd).toBe(expected);
  });

  test('a non-OpenRouter model reports tokens but no cost', async () => {
    const service = await serviceWithConfig(CONFIG_TOML);
    const summary = await service.getUsageSummary();
    const k2 = summary?.models.find((m) => m.model === 'k2');
    // Direct-Moonshot billing differs from OpenRouter's list price, so an
    // absent cost ("unknown") is the honest answer — not 0.
    expect(k2?.totalTokens).toBe(3100);
    expect(k2?.costUsd).toBeUndefined();
    expect(k2?.pricedAs).toBeUndefined();
    // The 7d window still carries a cost, because k3's turns in it are priced.
    expect(summary?.last7d.costUsd).toBeGreaterThan(0);
  });

  test('omits cost entirely when the price list is unreachable', async () => {
    await writeFile(CONFIG_PATH, CONFIG_TOML);
    const service = new KimiUsageService(
      new KimiSessionStore(SESSIONS_DIR),
      new KimiConfigService(CONFIG_PATH),
      new OpenRouterPricingService('http://127.0.0.1:1/models'),
    );
    const summary = await service.getUsageSummary();
    expect(summary?.last7d.totalTokens).toBe(4400);
    expect(summary?.last7d.costUsd).toBeUndefined();
    expect(summary?.last24h.costUsd).toBeUndefined();
  });

  test('returns null when there are no sessions', async () => {
    const service = new KimiUsageService(new KimiSessionStore(join(TEST_DIR, 'missing')));
    expect(await service.getUsageSummary()).toBeNull();
  });
});
