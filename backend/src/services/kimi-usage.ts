import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  KimiUsageDay,
  KimiUsageModelTotal,
  KimiUsageSummary,
  KimiUsageWindow,
} from '../../../shared/types';
import { KimiSessionStore } from './kimi';
import { KimiUsageStore, type StoredDay } from './kimi-usage-store';
import { KimiConfigService } from './kimi-config';
import { costOf, type ModelPricing, OpenRouterPricingService } from './openrouter';

interface UsageRecord {
  /** Unix ms. */
  timestamp: number;
  totalTokens: number;
  inputTokens: number;
  /** Input tokens that were neither cache reads nor cache writes. */
  inputOtherTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  model?: string;
}

/** Running cost for a window. `priced` stays false until a record actually
 *  gets a price, which is what distinguishes "$0.00" from "unknown". */
export interface CostAccumulator {
  usd: number;
  priced: boolean;
}

/** One day's running totals, before it becomes a `KimiUsageDay`. */
export interface DayAccumulator {
  turns: number;
  totalTokens: number;
  cost: CostAccumulator;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function emptyWindow(): KimiUsageWindow {
  return { turns: 0, totalTokens: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
}

function addToWindow(window: KimiUsageWindow, record: UsageRecord): void {
  window.turns++;
  window.totalTokens += record.totalTokens;
  window.inputTokens += record.inputTokens;
  window.cacheReadTokens += record.cacheReadTokens;
  window.outputTokens += record.outputTokens;
}

function addCost(acc: CostAccumulator, record: UsageRecord, pricing?: ModelPricing): void {
  if (!pricing) return;
  acc.usd += costOf(
    {
      inputOther: record.inputOtherTokens,
      cacheRead: record.cacheReadTokens,
      cacheWrite: record.cacheWriteTokens,
      output: record.outputTokens,
    },
    pricing,
  );
  acc.priced = true;
}

/** Round to cents-with-headroom: sub-cent turns are common, so keep 4 dp. */
function roundUsd(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}

/**
 * `YYYY-MM-DD` for a timestamp in the server's local time, not UTC.
 *
 * Deliberately not `toISOString().slice(0, 10)`: east of Greenwich that files
 * an evening's work under the following day, and west of it a morning's under
 * the previous one. The day meant here is the one on the wall.
 */
export function localDateKey(timestamp: number): string {
  const d = new Date(timestamp);
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Local midnight `n` days before the given time.
 *
 * Steps the date field rather than subtracting 86_400_000 per day, so a DST
 * boundary in the range does not drag every earlier bucket an hour across
 * midnight.
 */
export function startOfDayBefore(now: number, daysBack: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d.getTime();
}

/**
 * The days the log files can still be read for, oldest first, today last.
 *
 * Days with nothing in them are present with zeroes - a quiet day is a bar of
 * height zero, not a column that is not there, and a chart whose gaps close up
 * is a chart that lies about when the spending happened. Every day in this
 * range was looked at, so all of them are `observed`.
 */
export function buildLiveDays(
  days: Map<string, DayAccumulator>,
  now: number,
  dayCount: number,
): KimiUsageDay[] {
  const series: KimiUsageDay[] = [];
  for (let i = dayCount - 1; i >= 0; i--) {
    const date = localDateKey(startOfDayBefore(now, i));
    const day = days.get(date);
    series.push({
      date,
      turns: day?.turns ?? 0,
      totalTokens: day?.totalTokens ?? 0,
      // A day with no turns really did cost nothing; a day whose models had no
      // price is unknown, and the two must not look alike.
      costUsd: day ? (day.cost.priced ? roundUsd(day.cost.usd) : undefined) : 0,
      observed: true,
    });
  }
  return series;
}

/**
 * The chart's axis: the stored history and the live days as one contiguous
 * run ending today, capped at `maxDays`.
 *
 * The live days win where the two overlap - they were computed from the logs
 * just now, the stored ones from the same logs earlier, and if they disagree
 * the fresher reading is the one to trust.
 *
 * It starts at the oldest day either source knows about rather than always at
 * `maxDays` back, so a week-old install shows a week rather than three weeks
 * of invented emptiness.
 */
export function buildDailySeries(
  stored: Map<string, StoredDay>,
  live: KimiUsageDay[],
  now: number,
  maxDays: number,
): KimiUsageDay[] {
  const known = new Map<string, StoredDay>(stored);
  for (const day of live) {
    known.set(day.date, { turns: day.turns, totalTokens: day.totalTokens, costUsd: day.costUsd });
  }
  const floor = localDateKey(startOfDayBefore(now, maxDays - 1));
  const oldest = [...known.keys()].filter((d) => d >= floor).sort()[0] ?? floor;

  const series: KimiUsageDay[] = [];
  for (let i = maxDays - 1; i >= 0; i--) {
    const date = localDateKey(startOfDayBefore(now, i));
    if (date < oldest) continue;
    const day = known.get(date);
    series.push(
      day
        ? { date, turns: day.turns, totalTokens: day.totalTokens, costUsd: day.costUsd, observed: true }
        : // A hole inside the range: the server was down for the whole week
          // this day could have been read in. Not a quiet day - an unseen one.
          { date, turns: 0, totalTokens: 0, costUsd: undefined, observed: false },
    );
  }
  return series;
}

/**
 * Aggregates Kimi Code token consumption from `usage.record` records in each
 * session's `agents/<agentId>/wire.jsonl` — sub-agent wires included, their tokens
 * are real consumption. Kimi stores no rate-limit windows or plan data
 * locally, so consumption totals are all a dashboard can honestly show.
 */
export class KimiUsageService {
  private store: KimiSessionStore;
  private cache: { timestamp: number; data: KimiUsageSummary | null } | null = null;
  private static readonly CACHE_TTL = 30_000;
  private static readonly WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;
  private static readonly WINDOW_24H_MS = 24 * 60 * 60 * 1000;
  /** Days the logs can still be read for, today included. */
  private static readonly DAILY_DAYS = 7;
  /** Days the chart may show, once the history file has that many. */
  private static readonly CHART_DAYS = 30;

  constructor(
    store = new KimiSessionStore(),
    private readonly config = new KimiConfigService(),
    private readonly pricing = new OpenRouterPricingService(),
    /** Completed days, so the chart outlives the log files' seven. */
    private readonly history = new KimiUsageStore(),
  ) {
    this.store = store;
  }

  /**
   * Prices per model alias. Only OpenRouter-backed aliases resolve: anything
   * else (direct Moonshot, a local model, an alias missing from the config)
   * yields no price, so its tokens are reported without a cost instead of
   * being silently valued at zero.
   */
  private async resolvePricing(
    aliases: Iterable<string>,
  ): Promise<Map<string, { pricing: ModelPricing; modelId: string }>> {
    const { bindings } = await this.config.getConfig();
    const resolved = new Map<string, { pricing: ModelPricing; modelId: string }>();
    await Promise.all(
      [...new Set(aliases)].map(async (alias) => {
        const binding = bindings.get(alias);
        if (!binding?.isOpenRouter) return;
        const pricing = await this.pricing.getPricing(binding.model);
        if (pricing) resolved.set(alias, { pricing, modelId: binding.model });
      }),
    );
    return resolved;
  }

  async getUsageSummary(): Promise<KimiUsageSummary | null> {
    if (this.cache && Date.now() - this.cache.timestamp < KimiUsageService.CACHE_TTL) {
      return this.cache.data;
    }
    const data = await this.build();
    this.cache = { timestamp: Date.now(), data };
    return data;
  }

  private async build(): Promise<KimiUsageSummary | null> {
    const now = Date.now();
    const cutoff7d = now - KimiUsageService.WINDOW_7D_MS;
    const sessions = (await this.store.listSessions()).filter(
      (s) => new Date(s.updatedAt).getTime() >= cutoff7d,
    );
    if (sessions.length === 0) return null;

    const records: UsageRecord[] = [];
    let sessionsWithUsage = 0;
    await Promise.all(sessions.map(async (s) => {
      const sessionRecords = await this.readSessionRecords(s.dir, cutoff7d);
      if (sessionRecords.length > 0) sessionsWithUsage++;
      records.push(...sessionRecords);
    }));
    if (records.length === 0) return null;

    records.sort((a, b) => a.timestamp - b.timestamp);
    const priceByAlias = await this.resolvePricing(
      records.map((r) => r.model).filter((m): m is string => !!m),
    );

    const last24h = emptyWindow();
    const last7d = emptyWindow();
    const cost24h: CostAccumulator = { usd: 0, priced: false };
    const cost7d: CostAccumulator = { usd: 0, priced: false };
    const modelTotals = new Map<string, { totalTokens: number; cost: CostAccumulator }>();
    const cutoff24h = now - KimiUsageService.WINDOW_24H_MS;
    // Local midnight of the oldest day on the chart. It always sits inside the
    // 7-day rolling cutoff already read (midnight n days back is later than
    // n+1 days back to the second), so the daily series costs no extra I/O.
    const dailyStart = startOfDayBefore(now, KimiUsageService.DAILY_DAYS - 1);
    const days = new Map<string, DayAccumulator>();
    for (const record of records) {
      const pricing = record.model ? priceByAlias.get(record.model)?.pricing : undefined;
      addToWindow(last7d, record);
      addCost(cost7d, record, pricing);
      if (record.timestamp >= cutoff24h) {
        addToWindow(last24h, record);
        addCost(cost24h, record, pricing);
      }
      if (record.timestamp >= dailyStart) {
        const key = localDateKey(record.timestamp);
        let day = days.get(key);
        if (!day) {
          day = { turns: 0, totalTokens: 0, cost: { usd: 0, priced: false } };
          days.set(key, day);
        }
        day.turns++;
        day.totalTokens += record.totalTokens;
        addCost(day.cost, record, pricing);
      }
      if (record.model) {
        let total = modelTotals.get(record.model);
        if (!total) {
          total = { totalTokens: 0, cost: { usd: 0, priced: false } };
          modelTotals.set(record.model, total);
        }
        total.totalTokens += record.totalTokens;
        addCost(total.cost, record, pricing);
      }
    }
    if (cost24h.priced) last24h.costUsd = roundUsd(cost24h.usd);
    if (cost7d.priced) last7d.costUsd = roundUsd(cost7d.usd);

    const models: KimiUsageModelTotal[] = Array.from(modelTotals.entries())
      .map(([model, { totalTokens, cost }]) => ({
        model,
        totalTokens,
        costUsd: cost.priced ? roundUsd(cost.usd) : undefined,
        pricedAs: priceByAlias.get(model)?.modelId,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const live = buildLiveDays(days, now, KimiUsageService.DAILY_DAYS);
    // Only the finished days are written down. Today is still being added to,
    // and a partial day stored as final would freeze at whatever the clock
    // read when the dashboard was last built.
    const today = localDateKey(now);
    await this.history.record(
      new Map(
        live
          .filter((d) => d.date !== today)
          .map((d) => [d.date, { turns: d.turns, totalTokens: d.totalTokens, costUsd: d.costUsd }]),
      ),
      localDateKey(startOfDayBefore(now, KimiUsageStore.retainDays - 1)),
    );
    const daily = buildDailySeries(
      await this.history.load(),
      live,
      now,
      KimiUsageService.CHART_DAYS,
    );

    return {
      last24h,
      last7d,
      models,
      daily,
      sessions7d: sessionsWithUsage,
      lastTurnAt: new Date(records[records.length - 1].timestamp).toISOString(),
    };
  }

  /** usage.record entries across all agent wires of one session dir. */
  private async readSessionRecords(sessionDir: string, cutoffMs: number): Promise<UsageRecord[]> {
    let agentIds: string[];
    try {
      agentIds = await readdir(join(sessionDir, 'agents'));
    } catch {
      return [];
    }
    const records: UsageRecord[] = [];
    await Promise.all(agentIds.map(async (agentId) => {
      records.push(...await this.readRecords(join(sessionDir, 'agents', agentId, 'wire.jsonl'), cutoffMs));
    }));
    return records;
  }

  private async readRecords(wirePath: string, cutoffMs: number): Promise<UsageRecord[]> {
    // Skip files that clearly predate the window before reading them.
    try {
      if ((await stat(wirePath)).mtimeMs < cutoffMs) return [];
    } catch {
      return [];
    }
    let text: string;
    try {
      text = await readFile(wirePath, 'utf8');
    } catch {
      return [];
    }

    const records: UsageRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line.includes('"usage.record"')) continue;
      try {
        const record = JSON.parse(line) as {
          type?: string;
          model?: unknown;
          usage?: {
            inputOther?: unknown;
            inputCacheRead?: unknown;
            inputCacheCreation?: unknown;
            output?: unknown;
          };
          time?: unknown;
        };
        if (record.type !== 'usage.record' || !record.usage) continue;
        const timestamp = typeof record.time === 'number' ? record.time : 0;
        if (timestamp < cutoffMs) continue;
        const usage = record.usage;
        const cacheReadTokens = numberOrZero(usage.inputCacheRead);
        const cacheWriteTokens = numberOrZero(usage.inputCacheCreation);
        const inputOtherTokens = numberOrZero(usage.inputOther);
        const inputTokens = inputOtherTokens + cacheReadTokens + cacheWriteTokens;
        const outputTokens = numberOrZero(usage.output);
        records.push({
          timestamp,
          totalTokens: inputTokens + outputTokens,
          inputTokens,
          inputOtherTokens,
          cacheReadTokens,
          cacheWriteTokens,
          outputTokens,
          model: typeof record.model === 'string' ? record.model : undefined,
        });
      } catch {
        // malformed line
      }
    }
    return records;
  }
}
