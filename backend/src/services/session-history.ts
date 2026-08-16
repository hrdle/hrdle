import { readFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  ConversationMessage,
  HistorySession,
  ToolResultImage,
} from '../../../shared/types';
import { readLastLines } from '../utils/read-last-lines';
import { scanLastRecap } from '../utils/recap-scanner';

export type { HistorySession };

/**
 * A Claude/Codex project dir name and session id are always single flat path
 * segments (no separators). Client-supplied values are joined under
 * ~/.claude/projects, so anything containing a separator or `..` could escape
 * that base and enumerate/read arbitrary host files. Reject those.
 */
export function isFlatSegment(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}

interface SessionMetadata {
  startTime?: string;
  endTime?: string;
  messageCount: number;
  gitBranch?: string;
  firstMessageUuid?: string;  // For session matching
}

/**
 * Recaps are used as a one-line preview in the history list, so the full
 * (often multi-paragraph) text doesn't need to ship in list responses. Cap it
 * to keep `/history/projects/:dir` payloads small even for big projects.
 */
const RECAP_PREVIEW_MAX = 300;
function truncateRecap(content: string): string {
  return content.length > RECAP_PREVIEW_MAX
    ? `${content.slice(0, RECAP_PREVIEW_MAX)}…`
    : content;
}

export interface ProjectInfo {
  dirName: string;  // Directory name for API calls (e.g., "-home-m0a-hrdle")
  projectPath: string;
  projectName: string;
  sessionCount: number;
  latestModified?: string;
}

interface SessionsIndex {
  version: number;
  entries: Array<{
    sessionId: string;
    fullPath?: string;
    firstPrompt?: string;
    summary?: string;
    modified?: string;
    projectPath?: string;
  }>;
}

export class SessionHistoryService {
  private projectsDir: string;

  constructor() {
    this.projectsDir = join(homedir(), '.claude', 'projects');
  }

  /**
   * Read last user message from file tail (efficient for large files)
   */
  private async readLastUserMessage(filePath: string): Promise<string | null> {
    try {
      // readLastLines (no subprocess, split-UTF-8 safe) replaces the old
      // `tail -n 500` spawn — same window, shell-independent.
      const text = await readLastLines(filePath, 500);
      if (!text) return null;

      const lines = text.trim().split('\n').reverse();
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'user' && entry.message?.content) {
            const content = entry.message.content;

            // Skip array content (tool_result etc.)
            if (Array.isArray(content)) continue;
            if (typeof content !== 'string' || content.length === 0) continue;

            // Skip system/tool messages
            if (content.startsWith('[Request interrupted')) continue;
            if (content.startsWith('Implement the following plan:')) continue;
            if (content.startsWith('<task-notification>')) continue;
            if (content.startsWith('<system-reminder>')) continue;
            if (content.trim().startsWith('<')) continue;

            return content.slice(0, 100) + (content.length > 100 ? '...' : '');
          }
        } catch {
          // Skip invalid JSON
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Search for a query string within all user messages in a session file
   * Returns the matching message snippet if found, otherwise null
   */
  private async searchInSessionFile(filePath: string, query: string): Promise<string | null> {
    // Stream line-by-line instead of readFile: session JSONL files can be
    // tens to hundreds of MB, and a search request touches many of them
    const fileStream = createReadStream(filePath);
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'user' && entry.message?.content) {
            let content = entry.message.content;
            // Handle array content (tool results, etc.)
            if (Array.isArray(content)) {
              content = content
                .filter((c: { type: string }) => c.type === 'text')
                .map((c: { text: string }) => c.text)
                .join(' ');
            }
            if (typeof content === 'string' && content.toLowerCase().includes(query)) {
              // Return a snippet of the matching content
              const idx = content.toLowerCase().indexOf(query);
              const start = Math.max(0, idx - 20);
              const end = Math.min(content.length, idx + query.length + 60);
              let snippet = content.substring(start, end).replace(/\n/g, ' ').trim();
              if (start > 0) snippet = `...${snippet}`;
              if (end < content.length) snippet = `${snippet}...`;
              return snippet;
            }
          }
        } catch {
          // Skip invalid lines
        }
      }
      return null;
    } catch {
      return null;
    } finally {
      rl.close();
      fileStream.destroy();
    }
  }

  /**
   * Scan a JSONL file to extract basic session info
   * Simplified: reads header for IDs, tail for last prompt
   */
  private async scanJsonlForBasicInfo(filePath: string): Promise<{
    sessionId: string;
    projectPath: string;
    lastPrompt?: string;
    modified: string;
    firstUserUuid?: string;
    gitBranch?: string;
  } | null> {
    try {
      const fileStat = await stat(filePath);
      const modified = fileStat.mtime.toISOString();

      const fileStream = createReadStream(filePath);
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      let sessionId: string | undefined;
      let projectPath: string | undefined;
      let firstUserUuid: string | undefined;
      let gitBranch: string | undefined;
      let linesRead = 0;
      const maxLines = 30; // Only need header info

      for await (const line of rl) {
        linesRead++;
        if (linesRead > maxLines) break;

        try {
          const entry = JSON.parse(line);

          if (!sessionId && entry.sessionId) {
            sessionId = entry.sessionId;
          }

          if (!projectPath && entry.cwd) {
            projectPath = entry.cwd;
          }

          // gitBranch is written into the header entries — capture it cheaply
          // here (no extra read) so the Branch facet has data.
          if (!gitBranch && typeof entry.gitBranch === 'string' && entry.gitBranch) {
            gitBranch = entry.gitBranch;
          }

          // Get first user UUID for active session matching
          if (!firstUserUuid && entry.type === 'user' && entry.uuid) {
            firstUserUuid = entry.uuid;
          }

          // gitBranch is captured opportunistically above but excluded from the
          // break: many sessions never emit it, so requiring it would defeat the
          // early short-circuit and scan all 30 lines every time.
          if (sessionId && projectPath && firstUserUuid) break;
        } catch {
          // Skip invalid JSON lines
        }
      }

      rl.close();
      fileStream.destroy();

      // Fallbacks
      if (!sessionId) {
        const filename = filePath.split('/').pop();
        sessionId = filename?.replace('.jsonl', '') || '';
      }

      if (!projectPath) {
        const dirName = filePath.split('/').slice(-2, -1)[0];
        projectPath = dirName?.replace(/^-/, '/').replace(/-/g, '/') || '/unknown';
      }

      // Get last prompt from tail (efficient)
      const lastPrompt = await this.readLastUserMessage(filePath);

      return {
        sessionId,
        projectPath,
        lastPrompt: lastPrompt || undefined,
        modified,
        firstUserUuid,
        gitBranch,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get list of projects (directories) with session counts - fast, no file content reading
   */
  async getProjects(): Promise<ProjectInfo[]> {
    const projects: ProjectInfo[] = [];

    try {
      const projectDirs = await readdir(this.projectsDir);

      await Promise.all(projectDirs.map(async (dir) => {
        const projectDir = join(this.projectsDir, dir);

        try {
          const dirStat = await stat(projectDir);
          if (!dirStat.isDirectory()) return;

          const files = await readdir(projectDir);
          const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

          if (jsonlFiles.length === 0) return;

          // Read projectPath from session files (try multiple files until cwd is found)
          let projectPath: string | null = null;

          // Prefer non-agent files first (they have cwd earlier in the file)
          const sortedFiles = [...jsonlFiles].sort((a, b) => {
            const aIsAgent = a.startsWith('agent-');
            const bIsAgent = b.startsWith('agent-');
            if (aIsAgent && !bIsAgent) return 1;
            if (!aIsAgent && bIsAgent) return -1;
            return 0;
          });

          for (const file of sortedFiles) { // Try all files until cwd is found
            if (projectPath) break;
            const filePath = join(projectDir, file);

            try {
              const fileStream = createReadStream(filePath);
              const rl = createInterface({ input: fileStream, crlfDelay: Infinity });
              let linesRead = 0;

              for await (const line of rl) {
                linesRead++;
                if (linesRead > 30) break;
                try {
                  const entry = JSON.parse(line);
                  if (entry.cwd) {
                    projectPath = entry.cwd;
                    break;
                  }
                } catch { /* skip */ }
              }
              rl.close();
              fileStream.destroy();
            } catch { /* try next file */ }
          }

          // Fallback: parse from directory name (may be inaccurate for paths with hyphens)
          if (!projectPath) {
            projectPath = dir.replace(/^-/, '/').replace(/-/g, '/');
          }

          const projectName = projectPath.replace(/^\/home\/[^/]+\//, '~/');
          const latestModified = dirStat.mtime.toISOString();

          projects.push({
            dirName: dir,
            projectPath,
            projectName,
            sessionCount: jsonlFiles.length,
            latestModified,
          });
        } catch {
          // Skip directories that can't be read
        }
      }));

      // Sort alphabetically by project name
      projects.sort((a, b) => a.projectName.localeCompare(b.projectName));

      return projects;
    } catch {
      return [];
    }
  }

  /**
   * Get sessions for a specific project directory
   */
  async getProjectSessions(projectDirName: string): Promise<HistorySession[]> {
    const sessions: HistorySession[] = [];
    if (!isFlatSegment(projectDirName)) return sessions;
    const projectDir = join(this.projectsDir, projectDirName);

    try {
      const files = await readdir(projectDir);
      const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

      // Process files concurrently: each does a header scan + a recap tail read.
      // Serial awaits here blocked the request for ~2 reads × N sessions.
      const built = await Promise.all(
        jsonlFiles.map(async (file): Promise<HistorySession | null> => {
          const jsonlPath = join(projectDir, file);
          const basicInfo = await this.scanJsonlForBasicInfo(jsonlPath);

          // Skip sessions with no user messages
          if (!basicInfo?.lastPrompt) return null;

          const projectName = basicInfo.projectPath.replace(/^\/home\/[^/]+\//, '~/');
          const recap = await scanLastRecap(jsonlPath);

          return {
            sessionId: basicInfo.sessionId,
            projectPath: basicInfo.projectPath,
            projectName,
            firstPrompt: basicInfo.lastPrompt,
            lastPrompt: basicInfo.lastPrompt,
            recap: recap ? truncateRecap(recap.content) : undefined,
            recapAt: recap?.timestamp,
            gitBranch: basicInfo.gitBranch,
            modified: basicInfo.modified,
          };
        }),
      );
      for (const s of built) {
        if (s) sessions.push(s);
      }

      // Sort by modified date (newest first)
      sessions.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
      return sessions;
    } catch {
      return [];
    }
  }

  async getRecentSessions(limit: number = 20, includeMetadata: boolean = false): Promise<HistorySession[]> {
    const sessions: HistorySession[] = [];
    const seenSessionIds = new Set<string>();
    // Track each session's jsonl path so recap can be fetched only for the
    // final sliced set (avoids a second tail read across every scanned file).
    const sessionPaths = new Map<string, string>();

    try {
      const projectDirs = await readdir(this.projectsDir);

      for (const dir of projectDirs) {
        const projectDir = join(this.projectsDir, dir);

        try {
          const files = await readdir(projectDir);
          const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

          for (const file of jsonlFiles) {
            const jsonlPath = join(projectDir, file);
            const basicInfo = await this.scanJsonlForBasicInfo(jsonlPath);

            // Skip sessions with no user messages (empty/abandoned sessions)
            if (basicInfo?.lastPrompt && !seenSessionIds.has(basicInfo.sessionId)) {
              seenSessionIds.add(basicInfo.sessionId);
              sessionPaths.set(basicInfo.sessionId, jsonlPath);

              const projectName = basicInfo.projectPath.replace(/^\/home\/[^/]+\//, '~/');

              const session: HistorySession = {
                sessionId: basicInfo.sessionId,
                projectPath: basicInfo.projectPath,
                projectName,
                firstPrompt: basicInfo.lastPrompt,
                lastPrompt: basicInfo.lastPrompt,
                gitBranch: basicInfo.gitBranch,
                modified: basicInfo.modified,
              };

              if (includeMetadata) {
                const metadata = await this.getSessionMetadata(jsonlPath);
                if (metadata) {
                  session.startTime = metadata.startTime;
                  session.endTime = metadata.endTime;
                  session.messageCount = metadata.messageCount;
                  session.gitBranch = metadata.gitBranch;
                  session.firstMessageUuid = metadata.firstMessageUuid;

                  if (metadata.startTime && metadata.endTime) {
                    const start = new Date(metadata.startTime).getTime();
                    const end = new Date(metadata.endTime).getTime();
                    session.durationMinutes = Math.round((end - start) / 60000);
                  }
                }
              }

              sessions.push(session);
            }
          }
        } catch {
          // Skip directories that can't be read
        }
      }

      sessions.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
      const top = sessions.slice(0, limit);

      // Attach recap only to the returned set, in parallel.
      await Promise.all(
        top.map(async (session) => {
          const path = sessionPaths.get(session.sessionId);
          if (!path) return;
          const recap = await scanLastRecap(path);
          if (recap) {
            session.recap = truncateRecap(recap.content);
            session.recapAt = recap.timestamp;
          }
        }),
      );

      return top;
    } catch {
      return [];
    }
  }

  async getConversation(sessionId: string, projectDirName?: string): Promise<ConversationMessage[]> {
    // sessionId is interpolated into `${sessionId}.jsonl` under projectsDir;
    // reject anything that isn't a flat segment so it can't traverse.
    if (!isFlatSegment(sessionId)) return [];
    try {
      // If projectDirName is provided, look directly in that directory
      if (projectDirName && isFlatSegment(projectDirName)) {
        const projectDir = join(this.projectsDir, projectDirName);
        const directPath = join(projectDir, `${sessionId}.jsonl`);
        const messages = await this.parseJsonlFile(directPath);
        if (messages.length > 0) {
          return messages;
        }
        // Fallback: check sessions-index.json for fullPath
        const indexPath = join(projectDir, 'sessions-index.json');
        try {
          const content = await readFile(indexPath, 'utf-8');
          const index: SessionsIndex = JSON.parse(content);
          const entry = index.entries.find(e => e.sessionId === sessionId);
          if (entry?.fullPath) {
            return await this.parseJsonlFile(entry.fullPath);
          }
        } catch {
          // Index not found or parse error
        }
      }

      // Fallback: search all project directories (legacy behavior)
      const projectDirs = await readdir(this.projectsDir);

      for (const dir of projectDirs) {
        // First, try to find in sessions-index.json
        const indexPath = join(this.projectsDir, dir, 'sessions-index.json');

        try {
          const content = await readFile(indexPath, 'utf-8');
          const index: SessionsIndex = JSON.parse(content);

          const entry = index.entries.find(e => e.sessionId === sessionId);
          if (entry) {
            const jsonlPath = entry.fullPath || join(this.projectsDir, dir, `${sessionId}.jsonl`);
            return await this.parseJsonlFile(jsonlPath);
          }
        } catch {
          // Continue searching
        }

        // Also check for direct jsonl file (for active sessions not yet in index)
        const directPath = join(this.projectsDir, dir, `${sessionId}.jsonl`);
        const messages = await this.parseJsonlFile(directPath);
        if (messages.length > 0) {
          return messages;
        }
      }
    } catch {
      // Return empty
    }

    return [];
  }

  // Lazy load metadata for specific sessions (Phase 2 optimization)
  async getSessionsMetadata(sessionIds: string[]): Promise<Record<string, SessionMetadata>> {
    const result: Record<string, SessionMetadata> = {};

    try {
      const projectDirs = await readdir(this.projectsDir);

      for (const sessionId of sessionIds) {
        // sessionId is interpolated into `${sessionId}.jsonl`; skip any that
        // isn't a flat segment so it can't traverse out of projectsDir.
        if (!isFlatSegment(sessionId)) continue;
        // Find the session file
        for (const dir of projectDirs) {
          const indexPath = join(this.projectsDir, dir, 'sessions-index.json');

          try {
            const content = await readFile(indexPath, 'utf-8');
            const index: SessionsIndex = JSON.parse(content);
            const entry = index.entries.find(e => e.sessionId === sessionId);

            if (entry) {
              const jsonlPath = entry.fullPath || join(this.projectsDir, dir, `${sessionId}.jsonl`);
              const metadata = await this.getSessionMetadata(jsonlPath);
              if (metadata) {
                result[sessionId] = metadata;
              }
              break;
            }
          } catch {
            // Continue searching
          }

          // Also check direct path
          const directPath = join(this.projectsDir, dir, `${sessionId}.jsonl`);
          const metadata = await this.getSessionMetadata(directPath);
          if (metadata && metadata.messageCount > 0) {
            result[sessionId] = metadata;
            break;
          }
        }
      }
    } catch {
      // Return what we have
    }

    return result;
  }

  private async parseJsonlFile(filePath: string): Promise<ConversationMessage[]> {
    const messages: ConversationMessage[] = [];
    // Track tool names by tool_use id for tool_result display
    const toolNameMap = new Map<string, string>();

    try {
      const fileStream = createReadStream(filePath);
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        try {
          const entry = JSON.parse(line);

          // Skip non-message entries
          if (entry.type !== 'user' && entry.type !== 'assistant') continue;
          if (!entry.message) continue;

          const role = entry.type as 'user' | 'assistant';
          let content = '';
          let thinking: string | undefined;
          const toolUse: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
          const toolResult: Array<{ toolUseId: string; toolName?: string; output: string; isError?: boolean }> = [];

          // Extract content from message
          if (typeof entry.message === 'string') {
            content = entry.message;
          } else if (entry.message.content) {
            if (typeof entry.message.content === 'string') {
              content = entry.message.content;
            } else if (Array.isArray(entry.message.content)) {
              // Handle array of content blocks - extract all types
              const textParts: string[] = [];
              const thinkingParts: string[] = [];

              for (const block of entry.message.content) {
                if (block.type === 'text') {
                  textParts.push(block.text);
                } else if (block.type === 'thinking') {
                  thinkingParts.push(block.thinking);
                } else if (block.type === 'tool_use') {
                  // Store tool name for later reference
                  toolNameMap.set(block.id, block.name);
                  toolUse.push({
                    id: block.id,
                    name: block.name,
                    input: block.input || {},
                  });
                } else if (block.type === 'tool_result') {
                  // Extract tool result content
                  let output = '';
                  const images: ToolResultImage[] = [];
                  if (typeof block.content === 'string') {
                    output = block.content;
                  } else if (Array.isArray(block.content)) {
                    const textParts: string[] = [];
                    for (const c of block.content as Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }>) {
                      if (c.type === 'text' && c.text) {
                        textParts.push(c.text);
                      } else if (c.type === 'image' && c.source?.type === 'base64') {
                        images.push({ mediaType: c.source.media_type, data: c.source.data });
                      }
                    }
                    output = textParts.join('\n');
                  }
                  toolResult.push({
                    toolUseId: block.tool_use_id,
                    toolName: toolNameMap.get(block.tool_use_id),
                    output,
                    ...(images.length > 0 ? { images } : {}),
                    isError: block.is_error,
                  });
                }
              }

              content = textParts.join('\n');
              if (thinkingParts.length > 0) {
                thinking = thinkingParts.join('\n\n');
              }
            } else if (entry.message.content.type === 'text') {
              content = entry.message.content.text;
            } else if (entry.message.content.type === 'tool_use') {
              toolNameMap.set(entry.message.content.id, entry.message.content.name);
              toolUse.push({
                id: entry.message.content.id,
                name: entry.message.content.name,
                input: entry.message.content.input || {},
              });
            }
          }

          // Skip messages with no meaningful content
          const hasContent = content || thinking || toolUse.length > 0 || toolResult.length > 0;
          if (!hasContent) continue;

          // Skip internal meta messages
          if (content.startsWith('<system-reminder>')) continue;
          if (content.startsWith('<local-command-caveat>')) continue;

          // Format command-related messages for readability
          if (content) {
            content = content
              .replace(/<command-name>([^<]*)<\/command-name>/g, 'Command: $1')
              .replace(/<command-message>([^<]*)<\/command-message>/g, '$1')
              .replace(/<command-args>([^<]*)<\/command-args>/g, '')
              .replace(/<local-command-stdout>([^<]*)<\/local-command-stdout>/g, '$1')
              .replace(/<task-notification>.*?<status>([^<]*)<\/status>.*?<summary>([^<]*)<\/summary>.*?<\/task-notification>.*/gs, 'Task ($1): $2')
              .replace(/<bash-notification>.*?<status>([^<]*)<\/status>.*?<summary>([^<]*)<\/summary>.*/gs, 'Background ($1): $2')
              .replace(/<bash-input>([^<]*)<\/bash-input>/g, 'Input: $1')
              // Handle incomplete notification fragments
              .replace(/<status>([^<]*)<\/status>/g, '[$1]')
              .replace(/<summary>([^<]*)<\/summary>/g, '$1')
              .replace(/<task-id>[^<]*<\/task-id>/g, '')
              .replace(/<output-file>[^<]*<\/output-file>/g, '')
              .replace(/<shell-id>[^<]*<\/shell-id>/g, '')
              // biome-ignore lint/suspicious/noControlCharactersInRegex: removing terminal escape sequences requires matching ESC char
              .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
              .replace(/\[\?[0-9]+[hl]/g, '');

            // Clean up long content
            if (content.length > 5000) {
              content = `${content.substring(0, 2000)}\n...(truncated)...`;
            }
          }

          messages.push({
            // The record's own uuid, present on both roles. `message.id` exists
            // too but only on assistant turns, so it cannot address half a
            // conversation.
            id: entry.uuid,
            role,
            content,
            timestamp: entry.timestamp,
            thinking,
            toolUse: toolUse.length > 0 ? toolUse : undefined,
            toolResult: toolResult.length > 0 ? toolResult : undefined,
          });
        } catch {
          // Skip invalid lines
        }
      }
    } catch {
      // File not found or read error
    }

    return messages;
  }

  // Get session metadata from jsonl file (Phase 2)
  private async getSessionMetadata(filePath: string): Promise<SessionMetadata | null> {
    try {
      const fileStream = createReadStream(filePath);
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      let startTime: string | undefined;
      let endTime: string | undefined;
      let messageCount = 0;
      let gitBranch: string | undefined;
      let firstMessageUuid: string | undefined;

      for await (const line of rl) {
        try {
          const entry = JSON.parse(line);

          // Get timestamp for start/end time
          if (entry.timestamp) {
            if (!startTime) {
              startTime = entry.timestamp;
            }
            endTime = entry.timestamp;
          }

          // Count user and assistant messages
          if (entry.type === 'user' || entry.type === 'assistant') {
            messageCount++;
          }

          // Get first user message uuid (for session matching)
          if (entry.type === 'user' && entry.uuid && !firstMessageUuid) {
            firstMessageUuid = entry.uuid;
          }

          // Get git branch from init or summary entries
          if (entry.type === 'init' && entry.gitBranch) {
            gitBranch = entry.gitBranch;
          }
          if (entry.type === 'summary' && entry.gitBranch) {
            gitBranch = entry.gitBranch;
          }
        } catch {
          // Skip invalid lines
        }
      }

      return {
        startTime,
        endTime,
        messageCount,
        gitBranch,
        firstMessageUuid,
      };
    } catch {
      return null;
    }
  }

  /**
   * Search sessions across all projects
   */
  async searchSessions(query: string, limit: number = 50): Promise<HistorySession[]> {
    // Delegate to the serial generator: the old Promise.all fan-out kicked off
    // a scan of every project directory at once, so the `limit` early-exit
    // never stopped work already in flight and a single request could saturate
    // I/O across all JSONL files. The generator walks newest-first and
    // stops as soon as `limit` matches are found.
    const results: HistorySession[] = [];
    for await (const session of this.searchSessionsStream(query, limit)) {
      results.push(session);
    }

    // Sort by modified date (newest first) to keep the old response contract
    results.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    return results;
  }

  /**
   * Search sessions with streaming results (generator)
   * Yields results as they are found for incremental display
   */
  async *searchSessionsStream(query: string, limit: number = 50): AsyncGenerator<HistorySession> {
    if (!query || query.trim().length === 0) {
      return;
    }

    const normalizedQuery = query.toLowerCase().trim();
    let count = 0;

    try {
      const projectDirs = await readdir(this.projectsDir);

      // Sort by modification time (process newest first)
      const dirStats = await Promise.all(
        projectDirs.map(async (dir) => {
          try {
            const dirPath = join(this.projectsDir, dir);
            const dirStat = await stat(dirPath);
            return { dir, mtime: dirStat.mtime.getTime(), isDir: dirStat.isDirectory() };
          } catch {
            return { dir, mtime: 0, isDir: false };
          }
        })
      );

      dirStats.sort((a, b) => b.mtime - a.mtime);

      for (const { dir, isDir } of dirStats) {
        if (!isDir || count >= limit) continue;

        const projectDir = join(this.projectsDir, dir);

        try {
          const files = await readdir(projectDir);
          const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

          // Get file stats and sort by modification time
          const fileStats = await Promise.all(
            jsonlFiles.map(async (file) => {
              try {
                const filePath = join(projectDir, file);
                const fileStat = await stat(filePath);
                return { file, mtime: fileStat.mtime.getTime() };
              } catch {
                return { file, mtime: 0 };
              }
            })
          );

          fileStats.sort((a, b) => b.mtime - a.mtime);

          for (const { file } of fileStats) {
            if (count >= limit) break;

            const jsonlPath = join(projectDir, file);
            const basicInfo = await this.scanJsonlForBasicInfo(jsonlPath);

            if (basicInfo) {
              const projectName = basicInfo.projectPath.replace(/^\/home\/[^/]+\//, '~/');

              // Quick search: check project name and last prompt first
              const quickSearchText = `${projectName} ${basicInfo.lastPrompt || ''}`.toLowerCase();
              let matchSnippet: string | null = null;

              if (quickSearchText.includes(normalizedQuery)) {
                matchSnippet = basicInfo.lastPrompt || projectName;
              } else {
                // Full-text search: search through all user messages
                matchSnippet = await this.searchInSessionFile(jsonlPath, normalizedQuery);
              }

              if (matchSnippet) {
                count++;
                yield {
                  sessionId: basicInfo.sessionId,
                  projectPath: basicInfo.projectPath,
                  projectName,
                  firstPrompt: matchSnippet,
                  lastPrompt: matchSnippet,
                  gitBranch: basicInfo.gitBranch,
                  modified: basicInfo.modified,
                };
              }
            }
          }
        } catch {
          // Skip directories that can't be read
        }
      }
    } catch {
      // Error reading projects directory
    }
  }

}
