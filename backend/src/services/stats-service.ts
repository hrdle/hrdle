import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import type { DailyActivity, ModelUsage } from '../../../shared/types';

// Model Usage panel covers a rolling recent window. stats-cache.json only
// holds a date-less cumulative total, so the per-model breakdown for a window
// is aggregated directly from the Claude Code transcripts (#: model-usage-30d).
const MODEL_USAGE_WINDOW_DAYS = 30;
// Full jsonl scans are not free; the dashboard polls every 60s. Cache the
// aggregate so repeated polls within this window reuse one scan.
const MODEL_USAGE_CACHE_TTL_MS = 5 * 60_000;

interface ModelTokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

interface StatsCache {
  version: number;
  lastComputedDate: string;
  dailyActivity: Array<{
    date: string;
    messageCount: number;
    sessionCount: number;
    toolCallCount: number;
  }>;
  modelUsage: {
    [model: string]: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
    };
  };
  hourCounts?: Record<string, number>;
}

export class StatsService {
  private claudeDir: string;
  // Cached result of the last jsonl scan, shared across requests.
  private modelUsageCache: { computedAt: number; data: ModelUsage[] } | null = null;

  /** The directory is a parameter so tests can point at a fixture cache. */
  constructor(claudeDir = join(homedir(), '.claude')) {
    this.claudeDir = claudeDir;
  }

  private async readStatsCache(): Promise<StatsCache | null> {
    try {
      const content = await readFile(join(this.claudeDir, 'stats-cache.json'), 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async getDailyActivity(days: number = 14): Promise<DailyActivity[]> {
    const stats = await this.readStatsCache();
    // Shape-checked, not just truthy: the cache is written by another program
    // and parsed without validation, so `dailyActivity` being present says
    // nothing about it being a list. A half-written or reformatted file used to
    // reach `.slice` on a non-array and throw.
    if (!Array.isArray(stats?.dailyActivity)) {
      return [];
    }

    // Get last N days of activity
    const activities = stats.dailyActivity.slice(-days);

    return activities.map(a => ({
      date: a.date,
      messageCount: a.messageCount,
      sessionCount: a.sessionCount,
      tokensIn: 0, // Not available in stats-cache
      tokensOut: 0,
    }));
  }

  async getModelUsage(): Promise<ModelUsage[]> {
    const now = Date.now();
    if (this.modelUsageCache && now - this.modelUsageCache.computedAt < MODEL_USAGE_CACHE_TTL_MS) {
      return this.modelUsageCache.data;
    }

    const cutoff = now - MODEL_USAGE_WINDOW_DAYS * 24 * 60 * 60_000;
    const totals = await this.aggregateModelUsageSince(cutoff);

    const data: ModelUsage[] = Array.from(totals.entries()).map(([model, t]) => ({
      model: this.getModelDisplayName(model),
      totalTokensIn: t.inputTokens,
      totalTokensOut: t.outputTokens,
      totalCacheRead: t.cacheReadInputTokens,
      totalCacheWrite: t.cacheCreationInputTokens,
    }));

    this.modelUsageCache = { computedAt: now, data };
    return data;
  }

  /**
   * Aggregate per-model token usage from Claude Code transcripts for entries
   * whose timestamp is >= cutoff. Files last modified before the cutoff are
   * skipped wholesale (they cannot contain in-window entries), bounding the
   * scan to recently-active sessions.
   */
  private async aggregateModelUsageSince(cutoffMs: number): Promise<Map<string, ModelTokenTotals>> {
    const totals = new Map<string, ModelTokenTotals>();
    const files = await this.listTranscriptFiles();

    for (const filePath of files) {
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(filePath)).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < cutoffMs) continue;

      try {
        const rl = createInterface({
          input: createReadStream(filePath, { encoding: 'utf-8' }),
          crlfDelay: Number.POSITIVE_INFINITY,
        });
        for await (const line of rl) {
          if (!line) continue;
          let obj: Record<string, unknown>;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }
          const ts = Date.parse(obj.timestamp as string);
          if (!Number.isFinite(ts) || ts < cutoffMs) continue;

          const message = obj.message as { model?: unknown; usage?: Record<string, unknown> } | undefined;
          const usage = message?.usage;
          const model = message?.model;
          if (!usage || typeof usage !== 'object') continue;
          if (typeof model !== 'string' || !model || model === '<synthetic>') continue;

          const entry = totals.get(model) ?? {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          };
          entry.inputTokens += Number(usage.input_tokens) || 0;
          entry.outputTokens += Number(usage.output_tokens) || 0;
          entry.cacheReadInputTokens += Number(usage.cache_read_input_tokens) || 0;
          entry.cacheCreationInputTokens += Number(usage.cache_creation_input_tokens) || 0;
          totals.set(model, entry);
        }
      } catch {
        // Unreadable file — skip.
      }
    }

    return totals;
  }

  /** Collect all transcript .jsonl paths under ~/.claude/projects. */
  private async listTranscriptFiles(): Promise<string[]> {
    const projectsDir = join(this.claudeDir, 'projects');
    try {
      const entries = await readdir(projectsDir, { withFileTypes: true, recursive: true });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => join(e.parentPath ?? projectsDir, e.name));
    } catch {
      return [];
    }
  }

  private getModelDisplayName(modelId: string): string {
    // Extract family and version from model ID for any family
    // (e.g., "claude-opus-4-5-20251101" -> "Opus 4.5", "claude-haiku-4-5-20251001" -> "Haiku 4.5",
    //  "claude-fable-5" -> "Fable 5")
    const match = modelId.match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?:-|$))?/);
    if (match) {
      const [, family, major, minor] = match;
      const name = family.charAt(0).toUpperCase() + family.slice(1);
      return minor !== undefined ? `${name} ${major}.${minor}` : `${name} ${major}`;
    }
    return modelId;
  }

  // Phase 3: Get hourly activity for heatmap
  async getHourlyActivity(): Promise<Record<number, number>> {
    const stats = await this.readStatsCache();
    if (!stats?.hourCounts) {
      return {};
    }

    // Convert string keys to numbers and ensure all 24 hours are present
    const result: Record<number, number> = {};
    for (let i = 0; i < 24; i++) {
      result[i] = stats.hourCounts[String(i)] || 0;
    }

    return result;
  }
}
