import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { FileChange } from '../../../shared/types';
import { claudeProjectDirName } from '../utils/claude-project-path';
import { locateSessionFile } from '../utils/locate-session-file';

interface ToolUseBlock {
  type: 'tool_use';
  name: string;
  input: {
    file_path?: string;
    content?: string;
    old_string?: string;
    new_string?: string;
  };
}

interface AssistantMessage {
  type: 'assistant';
  timestamp?: string;
  message?: {
    content?: Array<ToolUseBlock | { type: string }>;
  };
}

export class FileChangeTracker {
  private claudeDir: string;

  // The argument exists for tests, as in ClaudeCodeService: Bun caches
  // os.homedir(), so a fixture cannot redirect this by setting HOME.
  constructor(projectsDir?: string) {
    this.claudeDir = projectsDir ?? join(homedir(), '.claude', 'projects');
  }

  /**
   * Convert a path to Claude Code project directory name
   * e.g., /home/m0a/hrdle -> -home-m0a-hrdle
   */
  private pathToProjectName(path: string): string {
    return claudeProjectDirName(path);
  }

  /**
   * Parse a .jsonl file and extract Write/Edit tool calls
   */
  private async parseJsonlForChanges(filePath: string): Promise<FileChange[]> {
    const changes: FileChange[] = [];

    return new Promise((resolve) => {
      try {
        const stream = createReadStream(filePath, { encoding: 'utf-8' });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });

        rl.on('line', (line) => {
          try {
            const entry = JSON.parse(line) as AssistantMessage;

            if (entry.type !== 'assistant' || !entry.message?.content) {
              return;
            }

            const timestamp = entry.timestamp || new Date().toISOString();

            for (const block of entry.message.content) {
              if (block.type !== 'tool_use') continue;

              const toolBlock = block as ToolUseBlock;

              if (toolBlock.name === 'Write' && toolBlock.input?.file_path) {
                changes.push({
                  path: toolBlock.input.file_path,
                  toolName: 'Write',
                  timestamp,
                  newContent: toolBlock.input.content,
                });
              } else if (toolBlock.name === 'Edit' && toolBlock.input?.file_path) {
                changes.push({
                  path: toolBlock.input.file_path,
                  toolName: 'Edit',
                  timestamp,
                  oldContent: toolBlock.input.old_string,
                  newContent: toolBlock.input.new_string,
                });
              }
            }
          } catch {
            // Skip invalid JSON lines
          }
        });

        rl.on('close', () => resolve(changes));
        rl.on('error', () => resolve(changes));
      } catch {
        resolve(changes);
      }
    });
  }

  /**
   * File changes a Claude session made, newest first, one entry per file.
   *
   * The session id is the only key. A working directory can hold several
   * sessions, and the newest transcript filed under it belongs to whichever
   * wrote last - showing that as this pane's edits is worse than showing none.
   */
  async getChangesForSessionId(workingDir: string, sessionId: string): Promise<FileChange[]> {
    const jsonlPath = await this.findSessionTranscript(workingDir, sessionId);
    if (!jsonlPath) return [];
    const changesByPath = new Map<string, FileChange>();
    for (const change of await this.parseJsonlForChanges(jsonlPath)) {
      changesByPath.set(change.path, change);
    }
    return Array.from(changesByPath.values())
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  private async findSessionTranscript(workingDir: string, sessionId: string): Promise<string | null> {
    // The cwd's own project, then its ancestors: an id names one file, so a
    // match anywhere up the tree is this session's.
    let currentPath = workingDir;
    while (currentPath && currentPath !== '/') {
      const jsonlPath = join(this.claudeDir, this.pathToProjectName(currentPath), `${sessionId}.jsonl`);
      try {
        await stat(jsonlPath);
        return jsonlPath;
      } catch {
        // not filed here
      }
      const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/'));
      if (parentPath === currentPath) break;
      currentPath = parentPath || '/';
    }
    // A working directory renamed under a running agent leaves the pane naming
    // a directory never written to; the id still finds the file.
    return locateSessionFile(sessionId, this.claudeDir);
  }
}
