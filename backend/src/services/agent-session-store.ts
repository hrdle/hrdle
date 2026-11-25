import type { AgentThread, AgentThreadService } from './agent-providers';
import type { ListedSession } from './agent-history-listing';

const CACHE_TTL_MS = 5000;

/**
 * One agent's sessions as its own store records them, scanned at most once
 * every five seconds: the session list, the history routes and the usage card
 * all ask, and a scan walks every session the agent has ever written.
 */
export abstract class CachedSessionStore<S extends ListedSession> {
  private cache: { timestamp: number; sessions: S[] } | null = null;

  protected abstract scan(): Promise<S[]> | S[];

  async listSessions(): Promise<S[]> {
    if (this.cache && Date.now() - this.cache.timestamp < CACHE_TTL_MS) return this.cache.sessions;
    const sessions = await this.scan();
    this.cache = { timestamp: Date.now(), sessions };
    return sessions;
  }

  async findSession(sessionId: string): Promise<S | undefined> {
    return (await this.listSessions()).find((s) => s.sessionId === sessionId);
  }
}

/** What a thread carries beyond the listing, read from the session's own records. */
export type ThreadDetails = Pick<AgentThread, 'tokenUsage' | 'recap' | 'recapAt'>;

/**
 * `AgentThreadService` for an agent whose sessions come from a listing store.
 * The agent supplies only the details; `describe` gets every wanted session at
 * once so a store that can batch (one query for all of them) does.
 */
export abstract class StoreThreadService<
  S extends ListedSession,
  Store extends { listSessions(): Promise<S[]> } = { listSessions(): Promise<S[]> },
> implements AgentThreadService {
  constructor(protected readonly store: Store) {}

  /** Details for each of `sessions`, in the same order. */
  protected abstract describe(sessions: S[]): Promise<ThreadDetails[]> | ThreadDetails[];

  async getThreadsByIds(sessionIds: string[]): Promise<Map<string, AgentThread>> {
    const ids = new Set(sessionIds.filter(Boolean));
    if (ids.size === 0) return new Map();
    const wanted = (await this.store.listSessions()).filter((s) => ids.has(s.sessionId));
    if (wanted.length === 0) return new Map();

    const details = await this.describe(wanted);
    const result = new Map<string, AgentThread>();
    wanted.forEach((s, i) => {
      result.set(s.sessionId, {
        sessionId: s.sessionId,
        title: s.title,
        firstPrompt: s.firstPrompt,
        cwd: s.cwd,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        ...details[i],
      });
    });
    return result;
  }
}
