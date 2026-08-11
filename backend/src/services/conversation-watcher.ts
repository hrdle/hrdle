import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SessionHistoryService } from './session-history';
import { ClaudeCodeService } from './claude-code';
import type { ConversationMessage } from '../../../shared/types';
import { claudeProjectDirName } from '../utils/claude-project-path';

type ConversationListener = (newMessages: ConversationMessage[]) => void;

const sessionHistoryService = new SessionHistoryService();
const claudeCodeService = new ClaudeCodeService();
const claudeProjectsDir = join(homedir(), '.claude', 'projects');

function pathToProjectName(path: string): string {
  return claudeProjectDirName(path);
}

export class ConversationWatcher {
  private watcher: FSWatcher | null = null;
  private filePath: string | null = null;
  private projectDirName: string | null = null;
  private ccSessionId: string | null = null;
  private parsedCount = 0;
  private listeners = new Set<ConversationListener>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private reparsing = false;
  private pendingReparse = false;
  private lastMtimeMs = 0;

  /**
   * Start watching a conversation jsonl.
   *
   * `agentSessionId` is the pane's own Claude session, and when it is given it
   * decides the file. Resolving by directory alone picks the newest transcript
   * under that path, which is the right answer only while a workspace has one
   * agent in it — with two panes it showed whichever had written last, and
   * that is a different conversation from the one on screen.
   *
   * A session id that resolves to nothing (a transcript not written yet, an id
   * herdr reports for an agent that never started one) shows nothing. It used
   * to fall back to the directory on the theory that a conversation from the
   * right directory beats an empty screen — but the lookup already searches
   * every project for the id, so what is left to fall back to is another
   * pane's conversation presented as this one's. An empty screen is honest.
   *
   * Returns the initial set of conversation messages (may be empty if no
   * session exists yet).
   */
  async start(workingDir: string, agentSessionId?: string): Promise<ConversationMessage[]> {
    // Re-entrant start: close any previous fs.watch before re-initialising.
    // Otherwise the old watcher leaks and its change events trigger reparse
    // against the overwritten filePath, delivering the wrong file's
    // conversation. Listeners are kept — they belong to the subscriber.
    this.closeWatcher();

    const session = agentSessionId
      ? await claudeCodeService.getSessionById(agentSessionId, workingDir)
      : await claudeCodeService.getSessionForPath(workingDir);
    if (!session?.sessionId) {
      return [];
    }

    // The directory the transcript is in, not the directory it is about: a
    // project directory name is decided when the agent starts and a rename of
    // the working directory afterwards leaves the two disagreeing.
    const projectDirName =
      session.projectDirName ?? pathToProjectName(session.projectPath || workingDir);
    const filePath =
      session.filePath ?? join(claudeProjectsDir, projectDirName, `${session.sessionId}.jsonl`);

    this.filePath = filePath;
    this.projectDirName = projectDirName;
    this.ccSessionId = session.sessionId;

    const messages = await sessionHistoryService.getConversation(session.sessionId, projectDirName);
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

      const messages = await sessionHistoryService.getConversation(
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
    this.listeners.clear();
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
