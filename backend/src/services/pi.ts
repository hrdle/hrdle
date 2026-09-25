import { readdir, readFile, stat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentThread, AgentThreadService, AgentTokenUsage } from './agent-providers';

/**
 * pi (the terminal coding agent) keeps one file per session under
 * `~/.pi/agent/sessions/<directory>/<timestamp>_<uuid>.jsonl`, where
 * `<directory>` is the working directory with every `/` turned into `-` and
 * a `--` on either end. The first line is a `session` record carrying the id
 * and the cwd; every later line is a `message`, a settings change
 * (`model_change`, `thinking_level_change`) or an extension's own record
 * (`custom`, `custom_message`). Records form a tree through `parentId` - a
 * branch stays in the same file - and this reads them in file order, which is
 * the order they were written.
 *
 * Nothing here needs an extension installed in pi: the file is what pi writes
 * for itself. herdr's own pi integration reports the same file's path, which
 * is how a live pane is matched to its session.
 */
export interface PiSessionInfo {
  sessionId: string;
  cwd: string;
  /** Absolute path of the session file. */
  path: string;
  firstPrompt?: string;
  createdAt?: string;
  updatedAt: string;
}

export interface PiSessionRecord {
  type?: string;
  id?: string;
  timestamp?: string;
  cwd?: string;
  message?: PiMessage;
}

export interface PiContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  data?: string;
  mimeType?: string;
  mediaType?: string;
}

export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

export interface PiMessage {
  role?: string;
  content?: PiContentBlock[] | string;
  model?: string;
  provider?: string;
  usage?: PiUsage;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
}

export function piSessionsDir(): string {
  return join(homedir(), '.pi', 'agent', 'sessions');
}

/** `2026-09-05T16-37-41-978Z_01a0726e-d7d9-7217-b3f8-11a4c3fdb0cb.jsonl` -> the uuid. */
export function piSessionIdFromPath(path: string): string | undefined {
  const name = basename(path);
  if (!name.endsWith('.jsonl')) return undefined;
  const stem = name.slice(0, -'.jsonl'.length);
  const at = stem.lastIndexOf('_');
  const id = at >= 0 ? stem.slice(at + 1) : stem;
  return id.length > 0 ? id : undefined;
}

export function parsePiRecord(line: string): PiSessionRecord | undefined {
  if (!line.trim()) return undefined;
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as PiSessionRecord) : undefined;
  } catch {
    return undefined;
  }
}

export function blockText(content: PiContentBlock[] | string | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const PI_RECAP_MAX_CHARS = 500;

/**
 * The last assistant turn's usage and text. pi records the usage of every
 * assistant message with the message, so the latest one is the session's
 * current context and the model it is on; the totals are summed over the
 * lines given, which for a tail read means "recent", not "whole session".
 */
export interface PiTail {
  tokenUsage?: AgentTokenUsage;
  /** The provider of the model in `tokenUsage`: model ids repeat across
   *  providers, so a window cannot be looked up by the id alone. */
  provider?: string;
  recap?: string;
  recapAt?: string;
}

/** What pi itself counts as the context after a turn (`calculateContextTokens`). */
function contextTokensOf(usage: PiUsage): number {
  const total = numberOrUndefined(usage.totalTokens);
  if (total) return total;
  return (numberOrUndefined(usage.input) ?? 0)
    + (numberOrUndefined(usage.output) ?? 0)
    + (numberOrUndefined(usage.cacheRead) ?? 0)
    + (numberOrUndefined(usage.cacheWrite) ?? 0);
}

export function parsePiTail(lines: string[]): PiTail {
  let tokenUsage: AgentTokenUsage | undefined;
  let provider: string | undefined;
  let recap: string | undefined;
  let recapAt: string | undefined;
  let totalInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let sawUsage = false;
  for (const line of lines) {
    const record = parsePiRecord(line);
    if (record?.type === 'compaction' && tokenUsage) {
      // The usage before a compaction measures a context that no longer
      // exists; pi shows nothing either until the next answer reports the new one.
      tokenUsage = { ...tokenUsage, contextTokens: undefined };
      continue;
    }
    const message = record?.message;
    if (record?.type !== 'message' || message?.role !== 'assistant') continue;
    const usage = message.usage;
    if (usage) {
      const input = numberOrUndefined(usage.input) ?? 0;
      const cacheRead = numberOrUndefined(usage.cacheRead) ?? 0;
      const cacheWrite = numberOrUndefined(usage.cacheWrite) ?? 0;
      const output = numberOrUndefined(usage.output) ?? 0;
      totalInput += input + cacheRead + cacheWrite;
      totalCacheRead += cacheRead;
      totalOutput += output;
      sawUsage = true;
      provider = typeof message.provider === 'string' ? message.provider : undefined;
      tokenUsage = {
        model: typeof message.model === 'string' ? message.model : undefined,
        contextTokens: contextTokensOf(usage),
        totalInputTokens: totalInput,
        totalCacheReadTokens: totalCacheRead,
        totalOutputTokens: totalOutput,
        totalTokens: totalInput + totalOutput,
      };
    }
    const text = blockText(message.content).trim();
    if (text) {
      recap = text.length > PI_RECAP_MAX_CHARS ? `${text.slice(0, PI_RECAP_MAX_CHARS)}...` : text;
      recapAt = record.timestamp;
    }
  }
  return { tokenUsage: sawUsage ? tokenUsage : undefined, provider, recap, recapAt };
}

/** pi's own catalog: `~/.pi/agent/models-store.json`, provider -> models with their windows. */
export function piModelsStorePath(): string {
  return join(homedir(), '.pi', 'agent', 'models-store.json');
}

interface PiModelsFile {
  [provider: string]: { models?: { id?: string; contextWindow?: number }[] } | undefined;
}

/**
 * The context window of each model pi has resolved, read from the catalog pi
 * keeps for itself. That file is the only table consulted: hrdle carrying its
 * own would fall behind every model pi adds, and pi's built-in default for a
 * model without a declared window is a guess a percentage must not be built on.
 */
export class PiModelsStore {
  private cache: { mtimeMs: number; windows: Map<string, number> } | null = null;

  constructor(private readonly path = piModelsStorePath()) {}

  async contextWindow(provider: string, model: string): Promise<number | undefined> {
    return (await this.windows()).get(`${provider}\0${model}`);
  }

  private async windows(): Promise<Map<string, number>> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(this.path)).mtimeMs;
    } catch {
      return new Map();
    }
    if (this.cache?.mtimeMs === mtimeMs) return this.cache.windows;
    const windows = new Map<string, number>();
    try {
      const file = JSON.parse(await readFile(this.path, 'utf8')) as PiModelsFile;
      for (const [provider, entry] of Object.entries(file ?? {})) {
        for (const m of entry?.models ?? []) {
          const window = numberOrUndefined(m?.contextWindow);
          if (typeof m?.id === 'string' && window && window > 0) windows.set(`${provider}\0${m.id}`, window);
        }
      }
    } catch {
      // A file mid-write or not JSON: no windows this round, and the next
      // mtime change reads it again.
      return new Map();
    }
    this.cache = { mtimeMs, windows };
    return windows;
  }
}

/** Read the last `bytes` of a file as whole lines (the cut-off first one dropped). */
async function readTailLines(path: string, bytes = 65_536): Promise<string[]> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } finally {
    await handle.close();
  }
}

/** The header and the first user prompt, without reading a whole transcript. */
async function readHead(path: string): Promise<{ header?: PiSessionRecord; firstPrompt?: string }> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(65_536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    const header = parsePiRecord(lines[0] ?? '');
    let firstPrompt: string | undefined;
    for (const line of lines.slice(1)) {
      const record = parsePiRecord(line);
      if (record?.type === 'message' && record.message?.role === 'user') {
        const text = blockText(record.message.content).trim();
        if (text) {
          firstPrompt = text.length > 200 ? `${text.slice(0, 200)}...` : text;
          break;
        }
      }
    }
    return { header: header?.type === 'session' ? header : undefined, firstPrompt };
  } finally {
    await handle.close();
  }
}

export class PiSessionStore {
  private cache: { timestamp: number; sessions: PiSessionInfo[] } | null = null;
  private static readonly CACHE_TTL = 5000;

  constructor(private readonly sessionsDir = piSessionsDir()) {}

  async listSessions(): Promise<PiSessionInfo[]> {
    if (this.cache && Date.now() - this.cache.timestamp < PiSessionStore.CACHE_TTL) {
      return this.cache.sessions;
    }
    const sessions = await this.scan();
    this.cache = { timestamp: Date.now(), sessions };
    return sessions;
  }

  async findSession(sessionId: string): Promise<PiSessionInfo | undefined> {
    return (await this.listSessions()).find((s) => s.sessionId === sessionId);
  }

  /** The tail of one session: the current usage and the latest answer. */
  async readTail(session: PiSessionInfo): Promise<PiTail> {
    try {
      return parsePiTail(await readTailLines(session.path));
    } catch {
      return {};
    }
  }

  async readTranscript(session: PiSessionInfo): Promise<string> {
    return readFile(session.path, 'utf8');
  }

  private async scan(): Promise<PiSessionInfo[]> {
    let dirs: string[];
    try {
      dirs = await readdir(this.sessionsDir);
    } catch {
      return [];
    }
    const results: PiSessionInfo[] = [];
    await Promise.all(dirs.map(async (dir) => {
      const dirPath = join(this.sessionsDir, dir);
      let names: string[];
      try {
        names = await readdir(dirPath);
      } catch {
        return;
      }
      await Promise.all(names.filter((n) => n.endsWith('.jsonl')).map(async (name) => {
        const path = join(dirPath, name);
        try {
          const [{ header, firstPrompt }, info] = await Promise.all([readHead(path), stat(path)]);
          const sessionId = header?.id ?? piSessionIdFromPath(path);
          const cwd = header?.cwd;
          if (!sessionId || !cwd) return;
          results.push({
            sessionId,
            cwd,
            path,
            firstPrompt,
            createdAt: header?.timestamp,
            updatedAt: info.mtime.toISOString(),
          });
        } catch {
          // a file being written, or one that is not a session - not ours to report
        }
      }));
    }));
    return results;
  }
}

export class PiService implements AgentThreadService {
  constructor(
    private readonly store = new PiSessionStore(),
    private readonly models = new PiModelsStore(),
  ) {}

  /** The usage with its window and percent, when pi has recorded a window for that model. */
  private async withWindow(tail: PiTail): Promise<AgentTokenUsage | undefined> {
    const usage = tail.tokenUsage;
    if (!usage?.model || !tail.provider) return usage;
    const contextMaxTokens = await this.models.contextWindow(tail.provider, usage.model);
    if (!contextMaxTokens) return usage;
    const contextPercent = usage.contextTokens === undefined
      ? undefined
      : Math.min(100, Math.round((usage.contextTokens / contextMaxTokens) * 1000) / 10);
    return { ...usage, contextMaxTokens, contextPercent };
  }

  async getThreadsByIds(sessionIds: string[]): Promise<Map<string, AgentThread>> {
    const wanted = new Set(sessionIds.filter(Boolean));
    if (wanted.size === 0) return new Map();
    const result = new Map<string, AgentThread>();
    for (const s of await this.store.listSessions()) {
      if (!wanted.has(s.sessionId)) continue;
      const tail = await this.store.readTail(s);
      result.set(s.sessionId, {
        sessionId: s.sessionId,
        firstPrompt: s.firstPrompt,
        tokenUsage: await this.withWindow(tail),
        recap: tail.recap,
        recapAt: tail.recapAt,
        cwd: s.cwd,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      });
    }
    return result;
  }
}
