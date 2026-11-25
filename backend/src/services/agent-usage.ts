import type { AgentUsageModelTotal, AgentUsageSummary, AgentUsageWindow } from '../../../shared/types';

export const USAGE_WINDOW_24H_MS = 24 * 60 * 60 * 1000;
export const USAGE_WINDOW_7D_MS = 7 * USAGE_WINDOW_24H_MS;
const CACHE_TTL_MS = 30_000;

/**
 * One turn of an agent that exposes no rate-limit windows, already reduced to
 * the numbers the dashboard aggregates. Each agent reads its own store into
 * this shape; everything after that is shared.
 *
 * `cacheReadTokens` and `reasoningTokens` are left undefined by an agent that
 * does not record them, so a window does not claim a zero it never measured.
 * `costUsd` likewise: undefined is "unknown", 0 is a free turn.
 */
export interface UsageTurn {
  /** Unix ms. */
  at: number;
  sessionId: string;
  /** Usually one; a Grok turn can span several and counts toward each. */
  models: string[];
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
}

function emptyWindow(): AgentUsageWindow {
  return { turns: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0 };
}

function addToWindow(window: AgentUsageWindow, turn: UsageTurn): void {
  window.turns++;
  window.totalTokens += turn.totalTokens;
  window.inputTokens += turn.inputTokens;
  window.outputTokens += turn.outputTokens;
  if (turn.cacheReadTokens !== undefined) {
    window.cacheReadTokens = (window.cacheReadTokens ?? 0) + turn.cacheReadTokens;
  }
  if (turn.reasoningTokens !== undefined) {
    window.reasoningTokens = (window.reasoningTokens ?? 0) + turn.reasoningTokens;
  }
  if (turn.costUsd !== undefined) window.costUsd = (window.costUsd ?? 0) + turn.costUsd;
}

/**
 * The 24h and 7d windows, per-model totals and session count over `turns`.
 * Turns older than seven days are ignored; no turns at all is `null`, not a
 * zeroed summary, so the dashboard hides the agent's tab.
 */
export function aggregateUsage(turns: UsageTurn[], now = Date.now()): AgentUsageSummary | null {
  const cutoff7d = now - USAGE_WINDOW_7D_MS;
  const cutoff24h = now - USAGE_WINDOW_24H_MS;
  const last24h = emptyWindow();
  const last7d = emptyWindow();
  const modelTotals = new Map<string, AgentUsageModelTotal>();
  const sessions = new Set<string>();
  let lastTurnAt = 0;

  for (const turn of turns) {
    if (turn.at < cutoff7d) continue;
    addToWindow(last7d, turn);
    if (turn.at >= cutoff24h) addToWindow(last24h, turn);
    sessions.add(turn.sessionId);
    if (turn.at > lastTurnAt) lastTurnAt = turn.at;
    for (const model of turn.models) {
      const total = modelTotals.get(model) ?? { model, totalTokens: 0 };
      total.totalTokens += turn.totalTokens;
      if (turn.costUsd !== undefined) total.costUsd = (total.costUsd ?? 0) + turn.costUsd;
      modelTotals.set(model, total);
    }
  }
  if (last7d.turns === 0) return null;

  return {
    last24h,
    last7d,
    models: [...modelTotals.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    sessions7d: sessions.size,
    lastTurnAt: new Date(lastTurnAt).toISOString(),
  };
}

/**
 * A 30-second cache over a summary build that never rejects: an unreadable
 * store is "no summary", not a failed dashboard.
 */
export class CachedUsage<T> {
  private cache: { timestamp: number; data: T | null } | null = null;

  constructor(
    private readonly label: string,
    private readonly build: () => Promise<T | null> | T | null,
  ) {}

  async get(): Promise<T | null> {
    if (this.cache && Date.now() - this.cache.timestamp < CACHE_TTL_MS) return this.cache.data;
    let data: T | null;
    try {
      data = await this.build();
    } catch (error) {
      console.error(`${this.label} usage: failed to build summary`, error);
      data = null;
    }
    this.cache = { timestamp: Date.now(), data };
    return data;
  }
}
