import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SessionHistoryService } from './session-history';
import { ClaudeCodeService } from './claude-code';
import type { ConversationMessage } from '../../../shared/types';
import { claudeProjectDirName } from '../utils/claude-project-path';

type ConversationListener = (newMessages: ConversationMessage[]) => void;
type FoundListener = (ccSessionId: string) => void;

/** How often, and for how long, a transcript that does not exist yet is looked for. */
const AWAIT_TRANSCRIPT_MS = 2000;
const AWAIT_TRANSCRIPT_FOR_MS = 10 * 60_000;

const defaultProjectsDir = join(homedir(), '.claude', 'projects');
const defaultHistory = new SessionHistoryService();
const defaultClaudeCode = new ClaudeCodeService();

function pathToProjectName(path: string): string {
  return claudeProjectDirName(path);
}

export class ConversationWatcher {
  private claudeProjectsDir: string;
  private sessionHistoryService: SessionHistoryService;
  private claudeCodeService: ClaudeCodeService;

  /** `projectsDir` is for tests, which cannot redirect Bun's cached `os.homedir()`. */
  constructor(projectsDir?: string) {
    this.claudeProjectsDir = projectsDir ?? defaultProjectsDir;
    this.sessionHistoryService = projectsDir ? new SessionHistoryService(projectsDir) : defaultHistory;
    this.claudeCodeService = projectsDir ? new ClaudeCodeService(projectsDir) : defaultClaudeCode;
  }

  private watcher: FSWatcher | null = null;
  private filePath: string | null = null;
  private projectDirName: string | null = null;
  private ccSessionId: string | null = null;
  private parsedCount = 0;
  private listeners = new Set<ConversationListener>();
  private foundListeners = new Set<FoundListener>();
  private awaitTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private reparsing = false;
  private pendingReparse = false;
  private lastMtimeMs = 0;

  /**
   * Start watching a conversation jsonl.
   *
   * The pane's own Claude session id is the only thing that names the file.
   * Without one there is nothing to watch: the newest transcript under the
   * working directory belongs to whichever agent there wrote last, which with
   * two agents in one directory is a different conversation from the one on
   * screen. An id that resolves to nothing shows nothing for the same reason -
   * the lookup already searches every project, so anything else it could find
   * would be another pane's conversation presented as this one's.
   *
   * Returns the initial set of conversation messages (empty when there is no
   * id or no transcript; `getCcSessionId()` tells those apart from an empty
   * transcript).
   */
  async start(workingDir: string, agentSessionId?: string): Promise<ConversationMessage[]> {
    // Re-entrant start: close any previous fs.watch before re-initialising.
    // Otherwise the old watcher leaks and its change events trigger reparse
    // against the overwritten filePath, delivering the wrong file's
    // conversation. Listeners are kept — they belong to the subscriber.
    this.closeWatcher();

    if (!agentSessionId) return [];
    const session = await this.claudeCodeService.getSessionById(agentSessionId, workingDir);
    if (!session?.sessionId) {
      // Claude Code writes the transcript only once the first prompt goes in,
      // and a new session is announced to herdr before that. Looked up once,
      // a conversation started from the chat view stayed "not found" for good.
      this.awaitTranscript(workingDir, agentSessionId);
      return [];
    }
    return this.attach(session, workingDir);
  }

  private async attach(
    session: { sessionId: string; projectDirName?: string; projectPath?: string; filePath?: string },
    workingDir: string,
  ): Promise<ConversationMessage[]> {
    // The directory the transcript is in, not the directory it is about: a
    // project directory name is decided when the agent starts and a rename of
    // the working directory afterwards leaves the two disagreeing.
    const projectDirName =
      session.projectDirName ?? pathToProjectName(session.projectPath || workingDir);
    const filePath =
      session.filePath ?? join(this.claudeProjectsDir, projectDirName, `${session.sessionId}.jsonl`);

    this.filePath = filePath;
    this.projectDirName = projectDirName;
    this.ccSessionId = session.sessionId;

    const messages = await this.sessionHistoryService.getConversation(session.sessionId, projectDirName);
    this.parsedCount = messages.length;

    try {
      const fileStat = await stat(filePath);
      this.lastMtimeMs = fileStat.mtimeMs;
    } catch {
      this.lastMtimeMs = 0;
    }

    try {
      this.watcher = watch(filePath, { persistent: false }, () => this.onChange());
    } catch (err) {
      console.warn(`[conversation-watcher] failed to watch ${filePath}:`, err);
    }

    return messages;
  }

  private awaitTranscript(workingDir: string, agentSessionId: string): void {
    const startedAt = Date.now();
    let looking = false;
    this.awaitTimer = setInterval(async () => {
      if (looking) return;
      if (Date.now() - startedAt > AWAIT_TRANSCRIPT_FOR_MS) {
        this.stopAwaiting();
        return;
      }
      looking = true;
      try {
        // A new transcript is written where the working directory says. Only
        // once it is there is the full lookup run - that one scans every
        // project when it misses, which is too much to repeat every tick.
        try {
          await stat(join(this.claudeProjectsDir, pathToProjectName(workingDir), `${agentSessionId}.jsonl`));
        } catch {
          return;
        }
        const session = await this.claudeCodeService.getSessionById(agentSessionId, workingDir);
        if (!session?.sessionId || !this.awaitTimer) return;
        this.stopAwaiting();
        const messages = await this.attach(session, workingDir);
        for (const listener of this.foundListeners) listener(session.sessionId);
        if (messages.length > 0) {
          for (const listener of this.listeners) listener(messages);
        }
      } catch (err) {
        console.warn('[conversation-watcher] looking for a transcript failed:', err);
      } finally {
        looking = false;
      }
    }, AWAIT_TRANSCRIPT_MS);
  }

  private stopAwaiting(): void {
    if (this.awaitTimer) clearInterval(this.awaitTimer);
    this.awaitTimer = null;
  }

  /** Told when a transcript that did not exist at `start` turns up. */
  onFound(listener: FoundListener): () => void {
    this.foundListeners.add(listener);
    return () => {
      this.foundListeners.delete(listener);
    };
  }

  onUpdate(listener: ConversationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private onChange() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.reparseAndNotify();
    }, 150);
  }

  private async reparseAndNotify(): Promise<void> {
    if (!this.filePath || !this.ccSessionId || !this.projectDirName) return;
    if (this.reparsing) {
      this.pendingReparse = true;
      return;
    }
    this.reparsing = true;
    try {
      let mtimeMs = 0;
      try {
        const fileStat = await stat(this.filePath);
        mtimeMs = fileStat.mtimeMs;
      } catch {
        return;
      }
      if (mtimeMs === this.lastMtimeMs) {
        return;
      }
      this.lastMtimeMs = mtimeMs;

      const messages = await this.sessionHistoryService.getConversation(
        this.ccSessionId,
        this.projectDirName,
      );

      if (messages.length <= this.parsedCount) {
        if (messages.length < this.parsedCount) {
          this.parsedCount = messages.length;
        }
        return;
      }

      const newMessages = messages.slice(this.parsedCount);
      this.parsedCount = messages.length;
      for (const listener of this.listeners) {
        try {
          listener(newMessages);
        } catch (err) {
          console.warn('[conversation-watcher] listener error:', err);
        }
      }
    } finally {
      this.reparsing = false;
      if (this.pendingReparse) {
        this.pendingReparse = false;
        void this.reparseAndNotify();
      }
    }
  }

  private closeWatcher(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* ignore */
      }
      this.watcher = null;
    }
  }

  stop(): void {
    this.closeWatcher();
    this.stopAwaiting();
    this.listeners.clear();
    this.foundListeners.clear();
    this.filePath = null;
    this.projectDirName = null;
    this.ccSessionId = null;
    this.parsedCount = 0;
    this.lastMtimeMs = 0;
  }

  getCcSessionId(): string | null {
    return this.ccSessionId;
  }
}
