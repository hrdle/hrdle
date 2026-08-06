import type { OpenCodeUsageSummary, OpenCodeUsageWindow } from '../../../shared/types';
import { OpenCodeSessionStore, type OpenCodeMessageTokens } from './opencode';

/**
 * Aggregates OpenCode token consumption from the assistant message rows in its
 * SQLite store. OpenCode exposes no rate-limit windows locally, so consumption
 * totals are all a dashboard can honestly show.
 *
 * The cost is OpenCode's own per-turn figure rather than a price-list estimate
 * of ours, so `costUsd` is reported only when at least one turn in the window
 * carried one. A window of free-model turns reports 0 because that is what the
 * turns say, which is a different statement from "unknown".
 */
export class OpenCodeUsageService {
  private store: OpenCodeSessionStore;
  private cache: { timestamp: number; data: OpenCodeUsageSummary | null } | null = null;
  private static readonly CACHE_TTL = 30_000;
  private static readonly WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;
  private static readonly WINDOW_24H_MS = 24 * 60 * 60 * 1000;

  constructor(store = new OpenCodeSessionStore()) {
    this.store = store;
  }

  /**
   * Never rejects. The dashboard's own `leg()` wrapper would catch it now, but
   * a caller should not have to know that to use this safely, and this method
   * has one honest answer for "the store could not be read": no summary. The
   * store's reads already degrade to empty; this covers the aggregation.
   */
  async getUsageSummary(): Promise<OpenCodeUsageSummary | null> {
    if (this.cache && Date.now() - this.cache.timestamp < OpenCodeUsageService.CACHE_TTL) {
      return this.cache.data;
    }
    let data: OpenCodeUsageSummary | null;
    try {
      data = this.build();
    } catch (error) {
      console.error('opencode usage: failed to build summary', error);
      data = null;
    }
    this.cache = { timestamp: Date.now(), data };
    return data;
  }

  private build(): OpenCodeUsageSummary | null {
    const now = Date.now();
    const cutoff7d = now - OpenCodeUsageService.WINDOW_7D_MS;
    const cutoff24h = now - OpenCodeUsageService.WINDOW_24H_MS;

    const turns = this.store.listAssistantTurns(cutoff7d);
    if (turns.length === 0) return null;

    const last7d = emptyWindow();
    const last24h = emptyWindow();
    const modelTotals = new Map<string, { totalTokens: number; costUsd?: number }>();
    const sessions = new Set<string>();
    let lastTurnAt = 0;

    for (const turn of turns) {
      addToWindow(last7d, turn.tokens, turn.cost);
      if (turn.timeCreated >= cutoff24h) addToWindow(last24h, turn.tokens, turn.cost);
      sessions.add(turn.sessionId);
      if (turn.timeCreated > lastTurnAt) lastTurnAt = turn.timeCreated;

      if (!turn.model) continue;
      const total = modelTotals.get(turn.model) ?? { totalTokens: 0 };
      total.totalTokens += totalTokensOf(turn.tokens);
      if (turn.cost !== undefined) total.costUsd = (total.costUsd ?? 0) + turn.cost;
      modelTotals.set(turn.model, total);
    }

    return {
      last24h,
      last7d,
      models: Array.from(modelTotals.entries())
        .map(([model, total]) => ({ model, totalTokens: total.totalTokens, costUsd: total.costUsd }))
        .sort((a, b) => b.totalTokens - a.totalTokens),
      sessions7d: sessions.size,
      lastTurnAt: lastTurnAt > 0 ? new Date(lastTurnAt).toISOString() : undefined,
    };
  }
}

function emptyWindow(): OpenCodeUsageWindow {
  return {
    turns: 0,
    totalTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

/** Input + cache reads + output. Reasoning is counted inside output upstream. */
export function totalTokensOf(tokens: OpenCodeMessageTokens): number {
  return (tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.output ?? 0);
}

function addToWindow(window: OpenCodeUsageWindow, tokens: OpenCodeMessageTokens, cost?: number): void {
  window.turns++;
  window.totalTokens += totalTokensOf(tokens);
  window.inputTokens += tokens.input ?? 0;
  window.cacheReadTokens += tokens.cacheRead ?? 0;
  window.outputTokens += tokens.output ?? 0;
  window.reasoningTokens += tokens.reasoning ?? 0;
  if (cost !== undefined) window.costUsd = (window.costUsd ?? 0) + cost;
}
