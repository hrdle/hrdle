import type { AgentProvider, ConversationMessage, HistorySession } from '../../../shared/types';
import type { ProjectInfo } from './session-history';

/**
 * Common surface for thread-based agents (Codex, Grok, ...). Claude stays on
 * its own path (jsonl metadata + WebSocket stream); every other agent plugs in
 * through these two interfaces, and the routes iterate provider maps instead
 * of hardcoding a specific agent. Adding an agent = one registry entry in
 * shared/types.ts + one implementation of each interface here.
 */

export interface AgentTokenUsage {
  contextTokens?: number;
  contextMaxTokens?: number;
  contextPercent?: number;
  totalInputTokens?: number;
  totalCacheReadTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
  /** Latest model id the agent ran with (shown in the session list). */
  model?: string;
}

/** One exact agent thread/session, keyed by its native session id. */
export interface AgentThread {
  sessionId: string;
  title?: string;
  firstPrompt?: string;
  tokensUsed?: number;
  tokenUsage?: AgentTokenUsage;
  gitBranch?: string;
  cwd: string;
  createdAt?: string;
  updatedAt?: string;
  /** Thread agents may expose the latest assistant message as a recap
   *  substitute (they have no Claude-style away_summary). */
  recap?: string;
  recapAt?: string;
}

/** Resolves exact threads by the native session ids reported by herdr. */
export interface AgentThreadService {
  getThreadsByIds(sessionIds: string[]): Promise<Map<string, AgentThread>>;
}

/** Past-session history + conversation reader for one agent. */
export interface AgentHistoryProvider {
  getProjects(): Promise<ProjectInfo[]>;
  getProjectSessions(dirName: string): Promise<HistorySession[]>;
  getRecentSessions(limit?: number): Promise<HistorySession[]>;
  searchSessions(query: string, limit?: number): Promise<HistorySession[]>;
  getConversation(sessionId: string): Promise<ConversationMessage[]>;
}

/**
 * The native ids one thread service is asked for: the workspace's own and
 * every pane's. A pane of a multi-pane workspace is its own conversation with
 * its own id, and a lookup that stopped at the workspace left those panes
 * with no context, no model and no recap.
 */
export function threadSessionIdsOf(
  agentId: AgentProvider,
  sessions: readonly {
    agent?: string;
    currentCommand?: string;
    agentSessionId?: string;
    panes?: readonly { agent?: string; agentSessionId?: string }[];
  }[],
): string[] {
  const ids = new Set<string>();
  for (const s of sessions) {
    if ((s.agent ?? s.currentCommand) === agentId && s.agentSessionId) ids.add(s.agentSessionId);
    for (const p of s.panes ?? []) {
      if (p.agent === agentId && p.agentSessionId) ids.add(p.agentSessionId);
    }
  }
  return [...ids];
}

/** The thread's token usage laid over the pid-derived metrics, the way the
 *  workspace's own are; `totalTokens` falls back to the thread's plain count. */
export function withThreadUsage<M extends object>(
  metrics: M | undefined,
  thread: AgentThread | undefined,
): (M & AgentTokenUsage & { totalTokens?: number }) | M | undefined {
  if (!thread) return metrics;
  return {
    ...(metrics ?? ({} as M)),
    ...thread.tokenUsage,
    totalTokens: thread.tokenUsage?.totalTokens ?? thread.tokensUsed,
  };
}
