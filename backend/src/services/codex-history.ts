import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ConversationMessage, HistorySession } from '../../../shared/types';
import { claudeProjectDirName } from '../utils/claude-project-path';
import { CodexConversationService } from './codex-conversation';
import { agentSessionCwd } from './herdr-client';
import type { ProjectInfo } from './session-history';

/** Resolves the working directory herdr reports for an agent session id.
 *  Injected so the id-less fallback can be tested without a herdr server. */
export type CwdResolver = (agentSessionId: string) => Promise<string | undefined>;

interface RolloutInfo {
  rolloutPath: string;
  sessionId: string;
  cwd: string;
  firstPrompt?: string;
  modified: string;
}

/**
 * Encode an absolute path into the same dirName key that Claude uses
 * (`~/.claude/projects/-home-m0a-hrdle/...`), so Claude and Codex
 * sessions for the same project bucket share one ProjectInfo entry.
 */
function encodeCwd(cwd: string): string {
  return claudeProjectDirName(cwd);
}

/**
 * Reads session history from Codex rollout JSONL files.
 *
 * Rollouts live under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
 * The first event in a rollout is `session_meta` with `id` / `cwd`;
 * subsequent `event_msg/user_message` events carry the prompt text.
 *
 * We avoid parsing the whole file for the listing flow — only the
 * first ~50 lines are scanned to extract metadata + first prompt.
 */
export class CodexHistoryService {
  private sessionsDir: string;
  private conversationService: CodexConversationService;
  private cache = new Map<string, { mtimeMs: number; info: RolloutInfo | null }>();

  private readonly resolveCwd: CwdResolver;

  constructor(
    sessionsDir = join(homedir(), '.codex', 'sessions'),
    conversationService = new CodexConversationService(),
    resolveCwd: CwdResolver = agentSessionCwd,
  ) {
    this.sessionsDir = sessionsDir;
    this.conversationService = conversationService;
    this.resolveCwd = resolveCwd;
  }

  /** Walk the date-partitioned tree and return absolute paths of all rollout files. */
  private async listRolloutPaths(): Promise<string[]> {
    const results: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }
      await Promise.all(entries.map(async (name) => {
        const full = join(dir, name);
        try {
          const s = await stat(full);
          if (s.isDirectory() && depth < 3) {
            await walk(full, depth + 1);
          } else if (s.isFile() && name.endsWith('.jsonl') && name.startsWith('rollout-')) {
            results.push(full);
          }
        } catch {
          // ignore unreadable entries
        }
      }));
    };
    await walk(this.sessionsDir, 0);
    return results;
  }

  private async readRolloutInfo(rolloutPath: string): Promise<RolloutInfo | null> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(rolloutPath)).mtimeMs;
    } catch {
      return null;
    }
    const cached = this.cache.get(rolloutPath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.info;

    let sessionId: string | undefined;
    let cwd: string | undefined;
    let firstPrompt: string | undefined;
    let linesRead = 0;
    const maxLines = 200; // first prompt often appears within the first dozens of events

    try {
      const fileStream = createReadStream(rolloutPath);
      const rl = createInterface({ input: fileStream, crlfDelay: Infinity });
      for await (const line of rl) {
        linesRead++;
        if (linesRead > maxLines && firstPrompt) break;
        if (!line.trim()) continue;
        let event: {
          type?: string;
          payload?: {
            id?: string;
            cwd?: string;
            type?: string;
            message?: string;
          };
        };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const payload = event.payload;
        if (!payload) continue;
        if (event.type === 'session_meta') {
          if (typeof payload.id === 'string') sessionId = payload.id;
          if (typeof payload.cwd === 'string') cwd = payload.cwd;
        } else if (event.type === 'event_msg' && payload.type === 'user_message') {
          if (!firstPrompt && typeof payload.message === 'string' && payload.message.trim()) {
            const content = payload.message.trim();
            firstPrompt = content.length > 100 ? `${content.slice(0, 100)}...` : content;
          }
        }
        if (sessionId && cwd && firstPrompt) break;
      }
      rl.close();
      fileStream.destroy();
    } catch {
      // fall through; partial info still usable
    }

    // Fallback: id encoded in the filename (`rollout-<ts>-<uuid>.jsonl`)
    if (!sessionId) {
      const m = rolloutPath.match(/rollout-[\d-T]+-([0-9a-f-]+)\.jsonl$/);
      if (m) sessionId = m[1];
    }

    const info: RolloutInfo | null = sessionId && cwd
      ? { rolloutPath, sessionId, cwd, firstPrompt, modified: new Date(mtimeMs).toISOString() }
      : null;
    this.cache.set(rolloutPath, { mtimeMs, info });
    return info;
  }

  private async listRollouts(): Promise<RolloutInfo[]> {
    const paths = await this.listRolloutPaths();
    const infos = await Promise.all(paths.map((p) => this.readRolloutInfo(p)));
    return infos.filter((x): x is RolloutInfo => x !== null);
  }

  /** Group rollouts by cwd → ProjectInfo. dirName matches Claude's encoding. */
  async getProjects(): Promise<ProjectInfo[]> {
    const rollouts = await this.listRollouts();
    const byDir = new Map<string, ProjectInfo>();
    for (const r of rollouts) {
      const dirName = encodeCwd(r.cwd);
      const projectName = r.cwd.replace(/^\/home\/[^/]+\//, '~/');
      const existing = byDir.get(dirName);
      if (existing) {
        existing.sessionCount++;
        if (!existing.latestModified || r.modified > existing.latestModified) {
          existing.latestModified = r.modified;
        }
      } else {
        byDir.set(dirName, {
          dirName,
          projectPath: r.cwd,
          projectName,
          sessionCount: 1,
          latestModified: r.modified,
        });
      }
    }
    return Array.from(byDir.values());
  }

  async getProjectSessions(dirName: string): Promise<HistorySession[]> {
    const rollouts = await this.listRollouts();
    const sessions: HistorySession[] = [];
    for (const r of rollouts) {
      if (encodeCwd(r.cwd) !== dirName) continue;
      sessions.push(this.toHistorySession(r));
    }
    sessions.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    return sessions;
  }

  async getRecentSessions(limit = 30): Promise<HistorySession[]> {
    const rollouts = await this.listRollouts();
    rollouts.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    return rollouts.slice(0, limit).map((r) => this.toHistorySession(r));
  }

  async searchSessions(query: string, limit = 50): Promise<HistorySession[]> {
    if (!query.trim()) return [];
    const needle = query.toLowerCase();
    const rollouts = await this.listRollouts();
    const matches: HistorySession[] = [];
    for (const r of rollouts) {
      const haystack = `${r.cwd} ${r.firstPrompt ?? ''}`.toLowerCase();
      if (haystack.includes(needle)) {
        matches.push(this.toHistorySession(r));
        if (matches.length >= limit) break;
      }
    }
    matches.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    return matches;
  }

  /**
   * The conversation for a session id, by whichever route can still find it.
   *
   * Three, because the first two both trust the id and the id is not always
   * Codex's. herdr forwards the `SessionStart` hook's `session_id`, and a
   * second Codex process emitting its own `SessionStart` takes the pane's
   * saved id with it (ogulcancelik/herdr#1789 — fixed on the preview channel,
   * not in 0.7.4). Observed here as a pane holding `019fae87-b417…` while its
   * TUI was writing a rollout under `019fae5d-dd9c…`: absent from the threads
   * table, absent from every rollout filename, so both id routes returned
   * nothing and the pane's conversation read as empty.
   *
   * The cwd is the thing both sides still agree on, so it is the third route.
   * It is last because it is the least precise: two Codex sessions in one
   * directory make "the most recent" a guess. A guess beats a blank screen,
   * and only after the two exact answers have already failed.
   *
   * TODO(herdr#1789): delete the third route once the fix is in a stable herdr
   * release. It is compensating for someone else's bug and guesses to do it,
   * so it should not outlive the bug. Check with `herdr --version` against the
   * release notes for herdr#1789 (fixed on master, shipped to the preview channel
   * as preview-2026-07-29-44b3adb12552, absent from 0.7.4). When it lands:
   * remove this branch, `resolveCwd`/`CwdResolver`, `agentSessionCwd` in
   * herdr-client.ts, and tests/unit/codex-history-cwd-fallback.test.ts. The
   * signal that it is safe is the first two routes answering on their own —
   * if they do, this one is already never reached.
   */
  async getConversation(sessionId: string): Promise<ConversationMessage[]> {
    // First try the active-thread path (state_5.sqlite → rollout_path).
    const viaDb = await this.conversationService.getConversation(sessionId);
    if (viaDb.length > 0) return viaDb;
    // Fallback for archived rollouts that aren't in the active threads table:
    // locate the rollout file by id and parse directly.
    const rollouts = await this.listRollouts();
    const hit = rollouts.find((r) => r.sessionId === sessionId);
    if (hit) return this.conversationService.parseRollout(hit.rolloutPath);
    // Neither route knew the id. Ask herdr where that session is working and
    // take the newest rollout from the same directory.
    const cwd = await this.resolveCwd(sessionId);
    if (!cwd) return [];
    const sameDir = rollouts
      .filter((r) => r.cwd === cwd)
      .sort((a, b) => b.modified.localeCompare(a.modified));
    if (sameDir.length === 0) return [];
    return this.conversationService.parseRollout(sameDir[0].rolloutPath);
  }

  private toHistorySession(r: RolloutInfo): HistorySession {
    return {
      sessionId: r.sessionId,
      projectPath: r.cwd,
      projectName: r.cwd.replace(/^\/home\/[^/]+\//, '~/'),
      firstPrompt: r.firstPrompt,
      lastPrompt: r.firstPrompt,
      // Codex transcripts have no recap (Claude-only feature).
      recap: undefined,
      modified: r.modified,
      agent: 'codex',
    };
  }
}
