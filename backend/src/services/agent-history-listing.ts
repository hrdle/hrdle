import type { AgentProvider, ConversationMessage, HistorySession } from '../../../shared/types';
import { claudeProjectDirName } from '../utils/claude-project-path';
import { homeShortPath } from '../utils/home-path';
import type { AgentHistoryProvider } from './agent-providers';
import type { ProjectInfo } from './session-history';

/** What a session store has to say about one session for history to list it. */
export interface ListedSession {
  sessionId: string;
  cwd: string;
  /** ISO 8601. */
  updatedAt: string;
  createdAt?: string;
  title?: string;
  firstPrompt?: string;
}

function newestFirst(a: { modified: string }, b: { modified: string }): number {
  return Date.parse(b.modified) - Date.parse(a.modified);
}

/**
 * History for an agent whose sessions can all be listed at once. Projects,
 * listing and search are the same for every such agent; each one supplies only
 * how to list its sessions and how to read one conversation.
 */
export abstract class ListedHistoryProvider<S extends ListedSession> implements AgentHistoryProvider {
  constructor(private readonly agent: AgentProvider) {}

  protected abstract listSessions(): Promise<S[]>;
  abstract getConversation(sessionId: string): Promise<ConversationMessage[]>;

  async getProjects(): Promise<ProjectInfo[]> {
    const byDir = new Map<string, ProjectInfo>();
    for (const s of await this.listSessions()) {
      const dirName = claudeProjectDirName(s.cwd);
      const existing = byDir.get(dirName);
      if (existing) {
        existing.sessionCount++;
        if (!existing.latestModified || s.updatedAt > existing.latestModified) {
          existing.latestModified = s.updatedAt;
        }
      } else {
        byDir.set(dirName, {
          dirName,
          projectPath: s.cwd,
          projectName: homeShortPath(s.cwd),
          sessionCount: 1,
          latestModified: s.updatedAt,
        });
      }
    }
    return Array.from(byDir.values());
  }

  async getProjectSessions(dirName: string): Promise<HistorySession[]> {
    return (await this.listSessions())
      .filter((s) => claudeProjectDirName(s.cwd) === dirName)
      .map((s) => this.toHistorySession(s))
      .sort(newestFirst);
  }

  async getRecentSessions(limit = 30): Promise<HistorySession[]> {
    return (await this.listSessions())
      .map((s) => this.toHistorySession(s))
      .sort(newestFirst)
      .slice(0, limit);
  }

  /** Matches the directory, title and first prompt, case-insensitively. */
  async searchSessions(query: string, limit = 50): Promise<HistorySession[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const matches: HistorySession[] = [];
    for (const s of await this.listSessions()) {
      const haystack = `${s.cwd} ${s.title ?? ''} ${s.firstPrompt ?? ''}`.toLowerCase();
      if (haystack.includes(needle)) {
        matches.push(this.toHistorySession(s));
        if (matches.length >= limit) break;
      }
    }
    return matches.sort(newestFirst);
  }

  private toHistorySession(s: S): HistorySession {
    return {
      sessionId: s.sessionId,
      projectPath: s.cwd,
      projectName: homeShortPath(s.cwd),
      firstPrompt: s.firstPrompt,
      lastPrompt: s.firstPrompt,
      summary: s.title,
      modified: s.updatedAt,
      startTime: s.createdAt,
      agent: this.agent,
    };
  }
}
