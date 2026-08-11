import type { ConversationMessage, HistorySession } from '../../../shared/types';
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
