import type { AgentUsageSummary } from '../../../shared/types';
import { aggregateUsage, CachedUsage, USAGE_WINDOW_7D_MS, type UsageTurn } from './agent-usage';
import { parsePiRecord, type PiUsage, PiSessionStore } from './pi';

/**
 * pi token consumption for the dashboard, from the usage every assistant
 * message carries. pi exposes no rate-limit windows, so totals are what can
 * be shown; and the cost is pi's own per-turn figure (it prices each turn from
 * its model list), so `costUsd` appears only when a turn in the window carried
 * one. A free or local model records 0, which is a figure and not an absence.
 */
export class PiUsageService {
  private readonly cached = new CachedUsage('pi', () => this.build());

  constructor(private readonly store = new PiSessionStore()) {}

  getUsageSummary(): Promise<AgentUsageSummary | null> {
    return this.cached.get();
  }

  private async build(): Promise<AgentUsageSummary | null> {
    const now = Date.now();
    const cutoff7d = now - USAGE_WINDOW_7D_MS;
    const sessions = (await this.store.listSessions()).filter(
      (s) => new Date(s.updatedAt).getTime() >= cutoff7d,
    );
    const turns: UsageTurn[] = [];
    for (const session of sessions) {
      let text: string;
      try {
        text = await this.store.readTranscript(session);
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        const record = parsePiRecord(line);
        const message = record?.message;
        if (record?.type !== 'message' || message?.role !== 'assistant' || !message.usage) continue;
        const at = record.timestamp ? Date.parse(record.timestamp) : Number.NaN;
        if (!Number.isFinite(at)) continue;
        const usage = message.usage;
        turns.push({
          at,
          sessionId: session.sessionId,
          models: typeof message.model === 'string' && message.model ? [message.model] : [],
          totalTokens: totalTokensOf(usage),
          inputTokens: (usage.input ?? 0) + (usage.cacheWrite ?? 0),
          cacheReadTokens: usage.cacheRead ?? 0,
          outputTokens: usage.output ?? 0,
          reasoningTokens: usage.reasoning ?? 0,
          costUsd: typeof usage.cost?.total === 'number' ? usage.cost.total : undefined,
        });
      }
    }
    return aggregateUsage(turns, now);
  }
}

/** Input, cache reads and output; reasoning is inside output already. */
function totalTokensOf(usage: PiUsage): number {
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0);
}
