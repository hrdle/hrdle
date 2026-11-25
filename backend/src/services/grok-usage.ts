import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentUsageSummary } from '../../../shared/types';
import { aggregateUsage, CachedUsage, USAGE_WINDOW_7D_MS, type UsageTurn } from './agent-usage';
import { GrokSessionStore } from './grok';

/**
 * Aggregates Grok Build token consumption from `turn_completed` records in
 * each session's `updates.jsonl`. xAI stores no rate-limit windows locally
 * (nothing like Codex's rate_limits events), so consumption totals are all
 * a dashboard can honestly show.
 */
export class GrokUsageService {
  private readonly cached = new CachedUsage('grok', () => this.build());

  constructor(private readonly store = new GrokSessionStore()) {}

  getUsageSummary(): Promise<AgentUsageSummary | null> {
    return this.cached.get();
  }

  private async build(): Promise<AgentUsageSummary | null> {
    const now = Date.now();
    const cutoff7d = now - USAGE_WINDOW_7D_MS;
    const sessions = (await this.store.listSessions()).filter(
      (s) => new Date(s.updatedAt).getTime() >= cutoff7d,
    );
    const turns = (
      await Promise.all(sessions.map((s) => this.readTurns(s.dir, join(s.dir, 'updates.jsonl'), cutoff7d)))
    ).flat();
    const summary = aggregateUsage(turns, now);
    if (!summary) return null;
    const lastTurn = turns.reduce((a, b) => (b.at > a.at ? b : a));
    if (lastTurn.models.some((m) => m.endsWith('-free'))) summary.planType = 'Free';
    return summary;
  }

  private async readTurns(sessionId: string, updatesPath: string, cutoffMs: number): Promise<UsageTurn[]> {
    // Skip files that clearly predate the window before reading them.
    try {
      if ((await stat(updatesPath)).mtimeMs < cutoffMs) return [];
    } catch {
      return [];
    }
    let text: string;
    try {
      text = await readFile(updatesPath, 'utf8');
    } catch {
      return [];
    }

    const turns: UsageTurn[] = [];
    for (const line of text.split('\n')) {
      if (!line.includes('"turn_completed"')) continue;
      try {
        const record = JSON.parse(line) as {
          timestamp?: number;
          params?: {
            update?: {
              sessionUpdate?: string;
              usage?: {
                inputTokens?: number;
                outputTokens?: number;
                totalTokens?: number;
                modelUsage?: Record<string, unknown>;
              };
            };
          };
        };
        const update = record.params?.update;
        if (update?.sessionUpdate !== 'turn_completed' || !update.usage) continue;
        const timestamp = typeof record.timestamp === 'number' ? record.timestamp : 0;
        if (timestamp * 1000 < cutoffMs) continue;
        turns.push({
          at: timestamp * 1000,
          sessionId,
          totalTokens: update.usage.totalTokens ?? 0,
          inputTokens: update.usage.inputTokens ?? 0,
          outputTokens: update.usage.outputTokens ?? 0,
          models: Object.keys(update.usage.modelUsage ?? {}),
        });
      } catch {
        // malformed line
      }
    }
    return turns;
  }
}
