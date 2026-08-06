import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { FileChange } from '../../../shared/types';
import { claudeProjectDirName } from '../utils/claude-project-path';
import { locateSessionFile } from '../utils/locate-session-file';
import { readLastLines } from '../utils/read-last-lines';

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

  /** How many projects the relocation scan reads a transcript tail from. */
  private static readonly RELOCATION_SCAN_LIMIT = 30;

  // The argument exists for tests, as in ClaudeCodeService: Bun caches
  // os.homedir(), so a fixture cannot redirect this by setting HOME.
  constructor(projectsDir?: string) {
    this.claudeDir = projectsDir ?? join(homedir(), '.claude', 'projects');
  }

  /**
   * Convert a path to Claude Code project directory name
   * e.g., /home/m0a/cchub -> -home-m0a-cchub
   */
  private pathToProjectName(path: string): string {
    return claudeProjectDirName(path);
  }

  /**
   * Find the most recent .jsonl file in a project directory
   */
  private async findLatestJsonl(projectDir: string): Promise<string | null> {
    try {
      const files = await readdir(projectDir);
      const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

      if (jsonlFiles.length === 0) return null;

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

      const validStats = fileStats.filter((s): s is { name: string; mtime: number } => s !== null);
      const latest = validStats.reduce<{ name: string; mtime: number } | null>(
        (best, current) => (!best || current.mtime > best.mtime) ? current : best,
        null
      );

      return latest ? join(projectDir, latest.name) : null;
    } catch {
      return null;
    }
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
   * The transcript of a session that is *in* `workingDir` now, wherever its
   * project directory happens to be named after.
   *
   * A project directory name is decided when the agent starts and the
   * transcript never moves, so after a `mv` of the working directory nothing
   * is filed under the name this directory now derives. The records inside do
   * follow the agent, though - each one carries the cwd it was written at - so
   * the newest transcript whose last recorded cwd is this directory is the
   * session that is here.
   *
   * The scan is the fallback, not the first move: it reads the tail of one
   * transcript per project, and the exact-name lookup answers in every case
   * where nothing was renamed.
   */
  private async findRelocatedTranscript(workingDir: string): Promise<string | null> {
    let dirs: string[];
    try {
      dirs = await readdir(this.claudeDir);
    } catch {
      return null;
    }

    const candidates: Array<{ path: string; mtime: number }> = [];
    for (const dir of dirs) {
      const latest = await this.findLatestJsonl(join(this.claudeDir, dir));
      if (!latest) continue;
      try {
        const fileStat = await stat(latest);
        candidates.push({ path: latest, mtime: fileStat.mtimeMs });
      } catch {
        // vanished between readdir and stat
      }
    }

    candidates.sort((a, b) => b.mtime - a.mtime);
    // A rename shows up in the transcripts written since it happened, so the
    // recently-touched end of the list is where the answer is if there is one.
    for (const candidate of candidates.slice(0, FileChangeTracker.RELOCATION_SCAN_LIMIT)) {
      const tail = await readLastLines(candidate.path, 50);
      for (const line of tail.split('\n').reverse()) {
        let cwd: unknown;
        try {
          cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
        } catch {
          continue;
        }
        if (typeof cwd !== 'string') continue;
        // The last cwd this transcript recorded: where that session is now.
        if (cwd === workingDir) return candidate.path;
        break;
      }
    }

    return null;
  }

  /**
   * Get all file changes for a working directory (current Claude Code session)
   */
  async getChangesForWorkingDir(workingDir: string): Promise<FileChange[]> {
    // Only this directory's own project. Walking up to ancestors used to be
    // the fallback, and it answers with a different directory's session - the
    // edits of whatever ran in `/home/you` most recently, presented as this
    // session's. Being wrong here is worse than being empty.
    const projectDir = join(this.claudeDir, this.pathToProjectName(workingDir));
    const jsonlPath =
      (await this.findLatestJsonl(projectDir)) ??
      (await this.findRelocatedTranscript(workingDir));
    if (!jsonlPath) return [];

    const changes = await this.parseJsonlForChanges(jsonlPath);
    // Deduplicate by path, keeping the latest change per file
    const changesByPath = new Map<string, FileChange>();
    for (const change of changes) {
      changesByPath.set(change.path, change);
    }
    return Array.from(changesByPath.values())
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  /**
   * Get changes for a specific session ID (jsonl file)
   */
  async getChangesForSessionId(workingDir: string, sessionId: string): Promise<FileChange[]> {
    // Try exact path first, then parent directories
    let currentPath = workingDir;

    while (currentPath && currentPath !== '/') {
      const projectName = this.pathToProjectName(currentPath);
      const projectDir = join(this.claudeDir, projectName);
      const jsonlPath = join(projectDir, `${sessionId}.jsonl`);

      try {
        await stat(jsonlPath);
        return await this.parseJsonlForChanges(jsonlPath);
      } catch {
        // File doesn't exist, try parent
      }

      const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/'));
      if (parentPath === currentPath) break;
      currentPath = parentPath || '/';
    }

    // The id is unique across every project, so where the cwd's own directory
    // tree has nothing, a scan settles it (a working directory renamed under a
    // running agent leaves the pane naming a directory never written to).
    const located = await locateSessionFile(sessionId, this.claudeDir);
    if (located) return this.parseJsonlForChanges(located);

    return [];
  }
}
