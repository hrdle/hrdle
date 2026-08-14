import { Hono } from 'hono';
import { StatsService } from '../services/stats-service';
import { AnthropicUsageService } from '../services/anthropic-usage';
import { CodexUsageService } from '../services/codex-usage';
import { GrokUsageService } from '../services/grok-usage';
import { KimiUsageService } from '../services/kimi-usage';
import { KimiConfigService } from '../services/kimi-config';
import { OpenCodeUsageService } from '../services/opencode-usage';
import { OpenRouterAccountService } from '../services/openrouter';
import { sttUsageService } from '../services/stt-usage';
import { UsageHistoryService } from '../services/usage-history';
import { SystemMetricsService } from '../services/system-metrics';
import { HerdrUpdateService } from '../services/herdr-update';
import { hrdleUpdateService } from '../services/hrdle-update';
import { getConnectedClientCount } from './terminal-mux';
import { staleWhileRevalidate } from '../utils/stale-while-revalidate';
import { VERSION } from '../cli';
import type { DashboardResponse } from '../../../shared/types';

const statsService = new StatsService();
const anthropicUsageService = new AnthropicUsageService();
const codexUsageService = new CodexUsageService();
const grokUsageService = new GrokUsageService();
const kimiConfigService = new KimiConfigService();
const kimiUsageService = new KimiUsageService(undefined, kimiConfigService);
const opencodeUsageService = new OpenCodeUsageService();
// Kimi is the only OpenRouter consumer here, so its config supplies the key.
const openRouterAccountService = new OpenRouterAccountService(() =>
  kimiConfigService.getOpenRouterApiKey(),
);
const usageHistoryService = new UsageHistoryService();
const systemMetricsService = new SystemMetricsService();
// Shared with the /api/herdr apply route so an apply invalidates this cache.
export const herdrUpdateService = new HerdrUpdateService();

async function getDiskUsage(): Promise<{ total: number; used: number; available: number; mountpoint: string } | null> {
  try {
    const result = Bun.spawnSync(['df', '-B1', '--output=size,used,avail,target', '/']);
    const lines = result.stdout.toString().trim().split('\n');
    if (lines.length < 2) return null;
    const parts = lines[1].trim().split(/\s+/);
    if (parts.length < 4) return null;
    return {
      total: parseInt(parts[0], 10),
      used: parseInt(parts[1], 10),
      available: parseInt(parts[2], 10),
      mountpoint: parts[3],
    };
  } catch {
    return null;
  }
}

/**
 * One leg of the dashboard build, isolated from the others.
 *
 * The panel is a dozen independent readings gathered with `Promise.all`, and
 * that combinator rejects on the first member to reject. The cache in front of
 * this does not save it: `staleWhileRevalidate` serves a stale value only when
 * it has one, so the *first* build after a restart has nothing to fall back on
 * and the whole of `GET /api/dashboard` fails — every agent's panel dark
 * because one provider could not read one file. It then keeps failing, because
 * a failed build caches nothing.
 *
 * Each reading is already a best-effort thing that reports null or empty when
 * its source is missing; that a source can also be *malformed* had to be
 * remembered separately in every service, and any new provider inherits the
 * obligation without being told. So the isolation lives here, once: a leg that
 * throws degrades to its own fallback and the rest of the panel still renders.
 *
 * Takes a thunk rather than a promise so a synchronous throw inside the call is
 * caught too — that one would otherwise escape before `Promise.all` is even
 * formed.
 */
export async function leg<T>(label: string, work: () => T | Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    console.error(`dashboard: ${label} failed, serving fallback`, error);
    return fallback;
  }
}

export async function buildDashboard(): Promise<DashboardResponse> {
  // The herdr skew check rides on this poll instead of its own timer;
  // it is cached, so the extra spawn is far rarer than the request rate.
  const [usageLimits, codexUsageLimits, grokUsage, kimiUsage, opencodeUsage, openRouterUsage, sttUsage, dailyActivity, modelUsage, hourlyActivity, usageHistory, systemMetrics, diskUsage, herdrUpdate, hrdleUpdate] = await Promise.all([
    leg('anthropic usage', () => anthropicUsageService.getUsageLimits(), null),
    leg('codex usage', () => codexUsageService.getUsageLimits(), null),
    leg('grok usage', () => grokUsageService.getUsageSummary(), null),
    leg('kimi usage', () => kimiUsageService.getUsageSummary(), null),
    leg('opencode usage', () => opencodeUsageService.getUsageSummary(), null),
    leg('openrouter usage', () => openRouterAccountService.getUsage(), null),
    leg('stt usage', () => sttUsageService.getUsageSummary(), null),
    leg('daily activity', () => statsService.getDailyActivity(14), []),
    leg('model usage', () => statsService.getModelUsage(), []),
    leg('hourly activity', () => statsService.getHourlyActivity(), {}),
    leg('usage history', () => usageHistoryService.getHistory(), []),
    leg('system metrics', () => systemMetricsService.getMetrics(), undefined),
    leg('disk usage', () => getDiskUsage(), null),
    leg('herdr update', () => herdrUpdateService.getStatus(), undefined),
    leg('hrdle update', () => hrdleUpdateService.getStatus(), undefined),
  ]);

  // Record snapshot for history
  if (usageLimits) {
    usageHistoryService.recordSnapshot(
      { utilization: usageLimits.fiveHour.utilization, resetsAt: usageLimits.fiveHour.resetsAt },
      { utilization: usageLimits.sevenDay.utilization, resetsAt: usageLimits.sevenDay.resetsAt },
      usageLimits.scopedLimits,
    );
  }

  return {
    limits: null, // Deprecated
    usageLimits,
    usageLimitsStatus: anthropicUsageService.getStatus(),
    codexUsageLimits,
    grokUsage,
    kimiUsage,
    opencodeUsage,
    openRouterUsage,
    sttUsage,
    usageHistory,
    dailyActivity,
    modelUsage,
    hourlyActivity,
    version: VERSION,
    systemMetrics,
    diskUsage: diskUsage || undefined,
    connectedClients: getConnectedClientCount(),
    herdrUpdate,
    hrdleUpdate,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * The payload is served stale-while-revalidate.
 *
 * Every leg of `buildDashboard` is a cache that *blocks* on expiry: the
 * Anthropic call alone is 60s-TTL'd and ~1.2s cold, and `Promise.all` makes the
 * slowest leg the response time. Nothing polls while the panel is closed, so
 * the TTL had always lapsed by the time it was reopened — the common case was
 * the worst case, on every single open. See `stale-while-revalidate.ts`.
 */
const FRESH_MS = 15_000;
const cache = staleWhileRevalidate(buildDashboard, FRESH_MS);

export async function getDashboard(): Promise<DashboardResponse> {
  const { value, stale } = await cache.get();
  // System metrics and the client count are synchronous reads, so a cached
  // payload can carry current ones. Without this the CPU line and client count
  // would sit at whatever the last build saw, which reads as a hung panel
  // rather than a fast one.
  const payload: DashboardResponse = {
    ...value,
    systemMetrics: systemMetricsService.getMetrics(),
    connectedClients: getConnectedClientCount(),
  };
  return stale ? { ...payload, stale: true } : payload;
}

/**
 * Force the next `getDashboard` to rebuild and wait.
 *
 * For the one case where a user action changes the payload and then asks for it
 * back: applying a herdr update clears that service's own cache, but the
 * assembled payload here would still carry `restartNeeded: true` and put the
 * warning banner back on screen right after the button that dismissed it.
 */
export function invalidateDashboardCache(): void {
  cache.invalidate();
}

export const dashboard = new Hono();

// GET /dashboard - Get dashboard data
dashboard.get('/', async (c) => {
  return c.json(await getDashboard());
});
