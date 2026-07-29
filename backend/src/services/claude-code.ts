import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { claudeProjectDirName } from '../utils/claude-project-path';
import { readLastLines } from '../utils/read-last-lines';
import { type RecapEntry, scanLastRecap } from '../utils/recap-scanner';

interface ClaudeCodeSession {
  sessionId: string;
  summary?: string;
  firstPrompt?: string;
  messageCount?: number;
  modified?: string;
  gitBranch?: string;
  projectPath?: string;
  waitingToolName?: string;
  firstMessageId?: string;  // For session matching with history
  lastRecap?: RecapEntry;
}

interface SessionsIndex {
  version: number;
  entries: Array<{
    sessionId: string;
    fullPath: string;
    fileMtime: number;
    firstPrompt?: string;
    summary?: string;
    messageCount?: number;
    created?: string;
    modified?: string;
    gitBranch?: string;
    projectPath?: string;
    isSidechain?: boolean;
  }>;
  originalPath?: string;
}

/** Cached session data with mtime for staleness check */
interface CachedSessionData {
  data: ClaudeCodeSession;
  fileMtime: number;
  timestamp: number;
}

export class ClaudeCodeService {
  private claudeDir: string;


  // Cache for session data keyed by file path (avoids re-reading JSONL files).
  // Longer than the 5s sessions-push interval so back-to-back pushes stay on the
  // mtime-checked cache instead of re-reading every JSONL each cycle.
  private sessionDataCache = new Map<string, CachedSessionData>();
  private static readonly SESSION_DATA_CACHE_TTL = 30_000; // 30 seconds

  // Cache for getSessionForPath / getRecentSessionsForPath / getSessionByTtyStartTime
  // results keyed by composite cache key. Avoids re-running readdir + stat over
  // every JSONL on every sessions-push tick.
  private pathResultCache = new Map<string, { data: unknown; timestamp: number }>();
  private static readonly PATH_RESULT_CACHE_TTL = 3_000; // 3 seconds

  // Hard cap on each cache: long-lived ClaudeCodeService singletons used to leak
  // an entry per ever-seen JSONL/path/tty — every distinct session a self-hosted
  // server ever saw would stay resident forever. Evict on insert by sweeping
  // expired entries first, then dropping the oldest (Map insertion order) until
  // size <= cap. #249
  private static readonly CACHE_MAX_ENTRIES = 1000;

  private static evictAndCap<V extends { timestamp: number }>(
    cache: Map<string, V>,
    ttlMs: number,
  ): void {
    const now = Date.now();
    for (const [key, value] of cache) {
      if (now - value.timestamp >= ttlMs) cache.delete(key);
    }
    while (cache.size > ClaudeCodeService.CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  constructor() {
    this.claudeDir = join(homedir(), '.claude', 'projects');
  }

  /**
   * Read `~/.claude/sessions/<pid>.json` state files and build a map from the
   * Claude Code session id (the `.jsonl` UUID) to its Remote Control
   * `bridgeSessionId` (`session_…`). Only sessions with Remote Control active
   * carry a non-null `bridgeSessionId`; others are skipped. Used to surface an
   * "Open in Claude app" deep link (`https://claude.ai/code/<bridgeSessionId>`).
   */
  async getBridgeSessionIds(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const dir = join(homedir(), '.claude', 'sessions');
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return map; // dir may not exist (Remote Control never used)
    }
    await Promise.all(
      files
        .filter((f) => f.endsWith('.json'))
        .map(async (f) => {
          try {
            const raw = await readFile(join(dir, f), 'utf-8');
            const data = JSON.parse(raw) as { sessionId?: unknown; bridgeSessionId?: unknown };
            if (
              typeof data.sessionId === 'string' &&
              typeof data.bridgeSessionId === 'string' &&
              data.bridgeSessionId.length > 0
            ) {
              map.set(data.sessionId, data.bridgeSessionId);
            }
          } catch {
            // ignore unreadable / malformed individual files
          }
        }),
    );
    return map;
  }

  /**
   * Convert a path to Claude Code project directory name
   * e.g., /home/m0a/cchub -> -home-m0a-cchub
   */
  private pathToProjectName(path: string): string {
    return claudeProjectDirName(path);
  }


  /**
   * Read the last user message from a session jsonl file (for current conversation)
   */
  private async readLastUserMessage(filePath: string): Promise<string | null> {
    try {
      const text = await readLastLines(filePath, 100);
      if (!text) return null;

      const lines = text.trim().split('\n').reverse();
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'user' && entry.message?.content) {
            let content = entry.message.content;
            // Handle array content (extract first text block)
            if (Array.isArray(content)) {
              const textBlock = content.find((block: { type: string; text?: string }) =>
                block.type === 'text' && typeof block.text === 'string'
              );
              if (!textBlock?.text) continue;
              content = textBlock.text;
            }
            if (typeof content !== 'string' || content.length === 0) continue;
            if (content.startsWith('[Request interrupted')) continue;
            if (content.startsWith('Implement the following plan:')) continue;
            // Skip system-generated messages
            if (content.startsWith('<task-notification>')) continue;
            if (content.startsWith('<system-reminder>')) continue;
            if (content.trim().startsWith('<')) continue; // Skip any XML-like content
            if (content.startsWith('[Image:')) continue; // Skip image references
            if (content.startsWith('{')) continue; // Skip JSON-like content
            // Return truncated message
            return content.slice(0, 100) + (content.length > 100 ? '...' : '');
          }
        } catch {
          // Skip invalid JSON lines
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Check if the session is waiting for user input by reading the jsonl file
   * Returns the tool name if waiting, null otherwise
   */
  private async checkWaitingState(filePath: string): Promise<string | null> {
    try {
      const text = await readLastLines(filePath, 50);
      if (!text) return null;

      const lines = text.trim().split('\n');
      interface JsonlEntry {
        type: string;
        message?: {
          content?: Array<{ type: string; name?: string; id?: string; tool_use_id?: string }>;
          stop_reason?: string | null;
        };
        toolUseResult?: unknown;
      }
      const entries: JsonlEntry[] = [];

      for (const line of lines) {
        try {
          entries.push(JSON.parse(line));
        } catch {
          // Skip invalid JSON
        }
      }

      // Filter to only user/assistant messages (ignore system, progress, etc.)
      const conversationEntries = entries.filter(e =>
        e.type === 'user' || e.type === 'assistant'
      );

      if (conversationEntries.length === 0) {
        return null;
      }

      // Step 1: Find the last assistant message (searching backwards)
      let lastToolUse: { name: string; id: string } | null = null;
      let lastAssistantEntry: JsonlEntry | null = null;
      let lastAssistantIndex = -1;

      for (let i = conversationEntries.length - 1; i >= 0; i--) {
        const entry = conversationEntries[i];
        if (entry.type === 'assistant' && entry.message?.content) {
          lastAssistantEntry = entry;
          lastAssistantIndex = i;
          for (const block of entry.message.content) {
            if (block.type === 'tool_use' && block.name && block.id) {
              lastToolUse = { name: block.name, id: block.id };
              break;
            }
          }
          break;
        }
      }

      // If no assistant message found, not waiting
      if (lastAssistantIndex === -1 || !lastAssistantEntry) {
        return null;
      }

      // Step 2: If assistant message has tool_use, check for tool_result
      if (lastToolUse) {
        // Check if tool_result exists after this tool_use
        let hasResult = false;
        for (let i = lastAssistantIndex + 1; i < conversationEntries.length; i++) {
          const entry = conversationEntries[i];
          if (entry.type === 'user' && entry.message?.content) {
            for (const block of entry.message.content) {
              if (block.type === 'tool_result' && block.tool_use_id === lastToolUse.id) {
                hasResult = true;
                break;
              }
            }
          }
          if (hasResult) break;
        }
        if (!hasResult) {
          // Tool use is pending - waiting for permission or execution
          return lastToolUse.name;
        }
      }

      // Step 3: Check if conversation ended with end_turn (waiting for next user input)
      const stopReason = lastAssistantEntry.message?.stop_reason;
      if (stopReason === 'end_turn') {
        // Assistant finished speaking, waiting for user input
        // Check if there's a user message after this
        const hasUserAfter = conversationEntries.slice(lastAssistantIndex + 1).some(
          e => e.type === 'user' && e.message?.content?.some(
            (b: { type: string }) => b.type === 'text'
          )
        );
        if (!hasUserAfter) {
          return 'UserInput'; // Special marker for text input waiting
        }
      }

      // Step 4: If the last entry is a tool_result (all tool_uses resolved)
      // but no new assistant message followed, check stop_reason to determine state.
      // stop_reason=tool_use means Claude intended to continue → likely waiting for permission on next tool.
      // stop_reason=end_turn would have been caught in Step 3.
      const lastEntry = conversationEntries[conversationEntries.length - 1];
      if (lastEntry.type === 'user' && lastEntry.message?.content?.some(
        (b: { type: string }) => b.type === 'tool_result'
      )) {
        const stopReason2 = lastAssistantEntry.message?.stop_reason;
        if (stopReason2 === 'tool_use') {
          // Claude was mid-turn with more tools to use → likely waiting for permission
          return 'PendingTool';
        }
        return 'UserInput';
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Read the first prompt from a session jsonl file
   */
  private async readFirstPromptFromFile(filePath: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const stream = createReadStream(filePath, { encoding: 'utf-8' });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        let linesRead = 0;
        const maxLines = 50;
        let resolved = false;

        const done = (value: string | null) => {
          if (resolved) return;
          resolved = true;
          rl.close();
          stream.destroy();
          resolve(value);
        };

        rl.on('line', (line) => {
          if (resolved) return;
          linesRead++;
          if (linesRead > maxLines) {
            done(null);
            return;
          }

          try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' && entry.message?.content) {
              let content = entry.message.content;
              // Handle array content (extract first text block)
              if (Array.isArray(content)) {
                const textBlock = content.find((block: { type: string; text?: string }) =>
                  block.type === 'text' && typeof block.text === 'string'
                );
                if (!textBlock?.text) return;
                content = textBlock.text;
              }
              if (typeof content !== 'string' || content.length === 0) return;
              if (content.startsWith('[Request interrupted')) return;
              if (content.startsWith('Implement the following plan:')) {
                done('(resumed session)');
                return;
              }
              // Skip system-generated messages
              if (content.trim().startsWith('<')) return;
              if (content.startsWith('[Image:')) return;
              if (content.startsWith('{')) return;
              done(content.slice(0, 100) + (content.length > 100 ? '...' : ''));
              return;
            }
          } catch {
            // Skip invalid JSON lines
          }
        });

        rl.on('close', () => done(null));
        rl.on('error', () => done(null));
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * Read the first user message UUID (for session matching with history)
   */
  private async readFirstMessageId(filePath: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const stream = createReadStream(filePath, { encoding: 'utf-8' });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        let resolved = false;

        const done = (value: string | null) => {
          if (resolved) return;
          resolved = true;
          rl.close();
          stream.destroy();
          resolve(value);
        };

        rl.on('line', (line) => {
          if (resolved) return;
          try {
            const entry = JSON.parse(line);
            // Use first user message uuid (same as session-history.ts)
            if (entry.type === 'user' && entry.uuid) {
              done(entry.uuid);
              return;
            }
          } catch {
            // Skip invalid JSON lines
          }
        });

        rl.on('close', () => done(null));
        rl.on('error', () => done(null));
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * Read session data from a JSONL file with mtime-based caching.
   * Returns cached data if file mtime hasn't changed and cache is within TTL.
   */
  private async readSessionDataCached(filePath: string, sessionId: string, projectPath: string): Promise<ClaudeCodeSession | null> {
    try {
      const fileStat = await stat(filePath);

      // Check cache: if mtime unchanged and within TTL, return cached
      const cached = this.sessionDataCache.get(filePath);
      if (
        cached &&
        cached.fileMtime === fileStat.mtimeMs &&
        Date.now() - cached.timestamp < ClaudeCodeService.SESSION_DATA_CACHE_TTL
      ) {
        return cached.data;
      }

      const [firstPrompt, lastUserMessage, waitingToolName, firstMessageId, lastRecap] = await Promise.all([
        this.readFirstPromptFromFile(filePath),
        this.readLastUserMessage(filePath),
        this.checkWaitingState(filePath),
        this.readFirstMessageId(filePath),
        scanLastRecap(filePath),
      ]);

      const data: ClaudeCodeSession = {
        sessionId,
        summary: lastUserMessage || undefined,
        firstPrompt: firstPrompt || undefined,
        modified: new Date(fileStat.mtimeMs).toISOString(),
        projectPath,

        waitingToolName: waitingToolName || undefined,
        firstMessageId: firstMessageId || undefined,
        lastRecap: lastRecap || undefined,
      };

      ClaudeCodeService.evictAndCap(this.sessionDataCache, ClaudeCodeService.SESSION_DATA_CACHE_TTL);
      this.sessionDataCache.set(filePath, {
        data,
        fileMtime: fileStat.mtimeMs,
        timestamp: Date.now(),
      });

      return data;
    } catch {
      return null;
    }
  }

  /**
   * Locate the conversation `.jsonl` for a session id across ALL projects
   * and return the `cwd` recorded inside it. Resume flows need this because
   * the caller's projectPath can be stale — e.g. a lost session recorded
   * after the agent exited, when the pane cwd had fallen back to the shell's
   * home — and `claude -r` only finds conversations from the project
   * directory they belong to.
   */
  async resolveSessionCwd(sessionId: string): Promise<string | null> {
    // Defense: sessionId is interpolated into a path.
    if (!/^[0-9a-f-]{16,64}$/i.test(sessionId)) return null;
    try {
      const dirs = await readdir(this.claudeDir);
      for (const dir of dirs) {
        const filePath = join(this.claudeDir, dir, `${sessionId}.jsonl`);
        try {
          await stat(filePath);
        } catch {
          continue;
        }
        // cwd appears within the first few records; scan the head only.
        const rl = createInterface({
          input: createReadStream(filePath, { start: 0, end: 262_144 }),
        });
        try {
          let scanned = 0;
          for await (const line of rl) {
            if (++scanned > 200) break;
            try {
              const d = JSON.parse(line) as { cwd?: string };
              if (typeof d.cwd === 'string' && d.cwd.startsWith('/')) {
                return d.cwd;
              }
            } catch {
              // truncated / malformed line
            }
          }
        } finally {
          rl.close();
        }
        return null; // file found but no cwd recorded
      }
    } catch {
      // projects dir unreadable
    }
    return null;
  }

  /**
   * Get Claude Code session info by session ID
   */
  async getSessionById(sessionId: string, workingDir: string): Promise<ClaudeCodeSession | null> {
    try {
      const projectName = this.pathToProjectName(workingDir);
      const projectDir = join(this.claudeDir, projectName);
      const filePath = join(projectDir, `${sessionId}.jsonl`);

      const result = await this.readSessionDataCached(filePath, sessionId, workingDir);
      if (result) return result;

      // Try parent directories
      let currentPath = workingDir;
      while (currentPath && currentPath !== '/') {
        const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/'));
        if (parentPath === currentPath) break;
        currentPath = parentPath || '/';

        const parentProjectName = this.pathToProjectName(currentPath);
        const parentProjectDir = join(this.claudeDir, parentProjectName);
        const parentFilePath = join(parentProjectDir, `${sessionId}.jsonl`);

        const parentResult = await this.readSessionDataCached(parentFilePath, sessionId, currentPath);
        if (parentResult) return parentResult;
      }

      return null;
    } catch {
      return null;
    }
  }

  private getPathCached<T>(key: string): T | undefined {
    const entry = this.pathResultCache.get(key);
    if (entry && Date.now() - entry.timestamp < ClaudeCodeService.PATH_RESULT_CACHE_TTL) {
      return entry.data as T;
    }
    return undefined;
  }

  private setPathCached(key: string, data: unknown): void {
    ClaudeCodeService.evictAndCap(this.pathResultCache, ClaudeCodeService.PATH_RESULT_CACHE_TTL);
    this.pathResultCache.set(key, { data, timestamp: Date.now() });
  }

  /**
   * Get the latest Claude Code session info for a given working directory
   */
  async getSessionForPath(workingDir: string): Promise<ClaudeCodeSession | null> {
    const cacheKey = `path:${workingDir}`;
    const cached = this.getPathCached<ClaudeCodeSession | null>(cacheKey);
    if (cached !== undefined) return cached;

    const result = await this.getSessionForPathUncached(workingDir);
    this.setPathCached(cacheKey, result);
    return result;
  }

  private async getSessionForPathUncached(workingDir: string): Promise<ClaudeCodeSession | null> {
    try {
      // Try exact path first, then parent directories. The parent-dir fallback
      // is needed so that a pane whose project dir has no jsonl (e.g. a
      // freshly-started `claude` whose tty-start-time match also fails) still
      // gets a ccSessionId for hook events to bind to. The route handler
      // gates user-visible fields (recap / firstPrompt / summary) by an
      // exact-path-match check on projectPath to keep ancestor content from
      // leaking into deeper panes.
      let currentPath = workingDir;

      while (currentPath && currentPath !== '/') {
        const projectName = this.pathToProjectName(currentPath);
        const projectDir = join(this.claudeDir, projectName);
        const indexPath = join(projectDir, 'sessions-index.json');

        try {
          // First, find the most recently modified .jsonl file
          const files = await readdir(projectDir);
          const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

          // Get stats for all files in parallel
          const fileStats = await Promise.all(
            jsonlFiles.map(async (file) => {
              try {
                const fileStat = await stat(join(projectDir, file));
                return { name: file, mtime: fileStat.mtimeMs };
              } catch {
                return null;
              }
            })
          );

          // Find the most recent file
          const validStats = fileStats.filter((s): s is { name: string; mtime: number } => s !== null);
          const latestFile = validStats.reduce<{ name: string; mtime: number } | null>(
            (latest, current) => (!latest || current.mtime > latest.mtime) ? current : latest,
            null
          );

          // Read the index to get cached info
          let index: SessionsIndex | null = null;
          try {
            const content = await readFile(indexPath, 'utf-8');
            index = JSON.parse(content);
          } catch {
            // Index doesn't exist or is invalid
          }

          // Check if the latest file is newer than what's in the index
          if (latestFile) {
            const sessionId = latestFile.name.replace('.jsonl', '');
            const indexEntry = index?.entries?.find(e => e.sessionId === sessionId);

            // If this file is in the index and not much newer, use cached data
            // But always check waiting state for accuracy
            if (indexEntry && (latestFile.mtime - (indexEntry.fileMtime || 0)) < 60000) {
              const filePath = join(projectDir, latestFile.name);
              const [waitingToolName, lastUserMessage, firstMessageId, lastRecap] = await Promise.all([
                this.checkWaitingState(filePath),
                this.readLastUserMessage(filePath),
                this.readFirstMessageId(filePath),
                scanLastRecap(filePath),
              ]);

              return {
                sessionId: indexEntry.sessionId,
                summary: lastUserMessage || indexEntry.summary,
                firstPrompt: indexEntry.firstPrompt,
                messageCount: indexEntry.messageCount,
                modified: indexEntry.modified,
                gitBranch: indexEntry.gitBranch,
                projectPath: indexEntry.projectPath ?? currentPath,

                waitingToolName: waitingToolName || undefined,
                firstMessageId: firstMessageId || undefined,
                lastRecap: lastRecap || undefined,
              };
            }

            // For active sessions (not in index or much newer), read directly
            const filePath = join(projectDir, latestFile.name);
            const [firstPrompt, lastUserMessage, waitingToolName, firstMessageId, lastRecap] = await Promise.all([
              this.readFirstPromptFromFile(filePath),
              this.readLastUserMessage(filePath),
              this.checkWaitingState(filePath),
              this.readFirstMessageId(filePath),
              scanLastRecap(filePath),
            ]);

            return {
              sessionId,
              summary: lastUserMessage || indexEntry?.summary,
              firstPrompt: firstPrompt || indexEntry?.firstPrompt,
              messageCount: indexEntry?.messageCount,
              modified: new Date(latestFile.mtime).toISOString(),
              gitBranch: indexEntry?.gitBranch,
              projectPath: indexEntry?.projectPath ?? currentPath,

              waitingToolName: waitingToolName || undefined,
              firstMessageId: firstMessageId || undefined,
              lastRecap: lastRecap || undefined,
            };
          }

          // Fallback to index-only data
          if (index?.entries && index.entries.length > 0) {
            const sortedEntries = [...index.entries].sort((a, b) => {
              const aTime = a.fileMtime || 0;
              const bTime = b.fileMtime || 0;
              return bTime - aTime;
            });

            const latest = sortedEntries[0];
            return {
              sessionId: latest.sessionId,
              summary: latest.summary,
              firstPrompt: latest.firstPrompt,
              messageCount: latest.messageCount,
              modified: latest.modified,
              gitBranch: latest.gitBranch,
              projectPath: latest.projectPath ?? currentPath,
            };
          }
        } catch {
          // Index doesn't exist for this path, try parent
        }

        // Move to parent directory
        const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/'));
        if (parentPath === currentPath) break;
        currentPath = parentPath || '/';
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get Claude Code session summaries for multiple paths
   */
  async getSessionsForPaths(paths: string[]): Promise<Map<string, ClaudeCodeSession>> {
    const results = new Map<string, ClaudeCodeSession>();

    await Promise.all(
      paths.map(async (path) => {
        const session = await this.getSessionForPath(path);
        if (session) {
          results.set(path, session);
        }
      })
    );

    return results;
  }

  /**
   * Get multiple recent Claude Code sessions for a path
   * Used when multiple sessions (herdr workspaces) share the same working directory
   */
  async getRecentSessionsForPath(workingDir: string, count: number): Promise<ClaudeCodeSession[]> {
    const cacheKey = `recent:${workingDir}:${count}`;
    const cached = this.getPathCached<ClaudeCodeSession[]>(cacheKey);
    if (cached !== undefined) return cached;

    const result = await this.getRecentSessionsForPathUncached(workingDir, count);
    this.setPathCached(cacheKey, result);
    return result;
  }

  private async getRecentSessionsForPathUncached(workingDir: string, count: number): Promise<ClaudeCodeSession[]> {
    const sessions: ClaudeCodeSession[] = [];

    try {
      // Parent-dir traversal mirrors getSessionForPathUncached; user-visible
      // fields are gated by exact-path-match in the route handler.
      let currentPath = workingDir;

      while (currentPath && currentPath !== '/') {
        const projectName = this.pathToProjectName(currentPath);
        const projectDir = join(this.claudeDir, projectName);

        try {
          const files = await readdir(projectDir);
          const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

          // Get stats for all files
          const fileStats = await Promise.all(
            jsonlFiles.map(async (file) => {
              try {
                const fileStat = await stat(join(projectDir, file));
                return { name: file, mtime: fileStat.mtimeMs };
              } catch {
                return null;
              }
            })
          );

          // Sort by mtime descending and take top N
          const validStats = fileStats
            .filter((s): s is { name: string; mtime: number } => s !== null)
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, count);

          // Read session info for each file (in parallel)
          const projectPathForResults = currentPath;
          const sessionResults = await Promise.all(
            validStats.map(async (fileStat) => {
              const sessionId = fileStat.name.replace('.jsonl', '');
              const filePath = join(projectDir, fileStat.name);

              const [firstPrompt, lastUserMessage, waitingToolName, firstMessageId, lastRecap] = await Promise.all([
                this.readFirstPromptFromFile(filePath),
                this.readLastUserMessage(filePath),
                this.checkWaitingState(filePath),
                this.readFirstMessageId(filePath),
                scanLastRecap(filePath),
              ]);

              return {
                sessionId,
                summary: lastUserMessage || undefined,
                firstPrompt: firstPrompt || undefined,
                modified: new Date(fileStat.mtime).toISOString(),
                projectPath: projectPathForResults,

                waitingToolName: waitingToolName || undefined,
                firstMessageId: firstMessageId || undefined,
                lastRecap: lastRecap || undefined,
              };
            })
          );
          sessions.push(...sessionResults);

          if (sessions.length >= count) {
            return sessions.slice(0, count);
          }
        } catch {
          // Try parent directory
        }

        const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/'));
        if (parentPath === currentPath) break;
        currentPath = parentPath || '/';
      }

      return sessions;
    } catch {
      return sessions;
    }
  }
}
