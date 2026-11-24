import type { AgentUsageSummary } from '../../../shared/types';
import { aggregateUsage, CachedUsage, USAGE_WINDOW_7D_MS } from './agent-usage';
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
  private readonly cached = new CachedUsage('opencode', () => this.build());

  constructor(private readonly store = new OpenCodeSessionStore()) {}

  getUsageSummary(): Promise<AgentUsageSummary | null> {
    return this.cached.get();
  }

  private build(): AgentUsageSummary | null {
    const now = Date.now();
    const turns = this.store.listAssistantTurns(now - USAGE_WINDOW_7D_MS).map((turn) => ({
      at: turn.timeCreated,
      sessionId: turn.sessionId,
      models: turn.model ? [turn.model] : [],
      totalTokens: totalTokensOf(turn.tokens),
      inputTokens: turn.tokens.input ?? 0,
      cacheReadTokens: turn.tokens.cacheRead ?? 0,
      outputTokens: turn.tokens.output ?? 0,
      reasoningTokens: turn.tokens.reasoning ?? 0,
      costUsd: turn.cost,
    }));
    return aggregateUsage(turns, now);
  }
}

/** Input + cache reads + output. Reasoning is counted inside output upstream. */
function totalTokensOf(tokens: OpenCodeMessageTokens): number {
  return (tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.output ?? 0);
}
