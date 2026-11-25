import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { readFileTailSync } from '../utils/file-slice';
import { numberOrUndefined } from '../utils/number';

interface CodexTokenUsage {
  contextTokens?: number;
  contextMaxTokens?: number;
  contextPercent?: number;
  totalInputTokens?: number;
  totalCacheReadTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
  model?: string;
}

export interface CodexThread {
  sessionId: string;
  title?: string;
  firstPrompt?: string;
  tokensUsed?: number;
  tokenUsage?: CodexTokenUsage;
  gitBranch?: string;
  cwd: string;
  createdAt?: string;
  updatedAt?: string;
}

interface CodexThreadRow {
  id: string;
  title: string | null;
  first_user_message: string | null;
  tokens_used: number | null;
  rollout_path: string | null;
  git_branch: string | null;
  cwd: string;
  created_at: number | null;
  updated_at: number | null;
  created_at_ms: number | null;
  updated_at_ms: number | null;
}

function epochToIso(seconds?: number | null, millis?: number | null): string | undefined {
  const timestamp = typeof millis === 'number' && millis > 0
    ? millis
    : typeof seconds === 'number' && seconds > 0
      ? seconds * 1000
      : undefined;
  return timestamp ? new Date(timestamp).toISOString() : undefined;
}

interface CodexTokenCountEvent {
  type?: string;
  payload?: {
    type?: string;
    info?: {
      total_token_usage?: {
        input_tokens?: number;
        cached_input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
      };
      last_token_usage?: {
        input_tokens?: number;
        total_tokens?: number;
      };
      model_context_window?: number;
    };
  };
}

function tokenUsageFromLine(line: string): CodexTokenUsage | undefined {
  let event: CodexTokenCountEvent;
  try {
    event = JSON.parse(line) as CodexTokenCountEvent;
  } catch {
    return undefined;
  }

  if (event.type !== 'event_msg' || event.payload?.type !== 'token_count') return undefined;

  const info = event.payload.info;
  const contextTokens = numberOrUndefined(info?.last_token_usage?.input_tokens);
  const contextMaxTokens = numberOrUndefined(info?.model_context_window);
  const total = info?.total_token_usage;
  const contextPercent = contextTokens !== undefined && contextMaxTokens && contextMaxTokens > 0
    ? Math.min(100, Math.round((contextTokens / contextMaxTokens) * 1000) / 10)
    : undefined;

  return {
    contextTokens,
    contextMaxTokens,
    contextPercent,
    totalInputTokens: numberOrUndefined(total?.input_tokens),
    totalCacheReadTokens: numberOrUndefined(total?.cached_input_tokens),
    totalOutputTokens: numberOrUndefined(total?.output_tokens),
    totalTokens: numberOrUndefined(total?.total_tokens),
  };
}

function modelFromLine(line: string): string | undefined {
  try {
    const event = JSON.parse(line) as { type?: string; payload?: { model?: unknown } };
    if (event.type !== 'turn_context') return undefined;
    const model = event.payload?.model;
    return typeof model === 'string' && model ? model : undefined;
  } catch {
    return undefined;
  }
}

function findLatestTokenUsageInText(text: string): CodexTokenUsage | undefined {
  const lines = text.split('\n');
  let usage: CodexTokenUsage | undefined;
  let model: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    if (!usage && line.includes('"token_count"')) usage = tokenUsageFromLine(line);
    if (!model && line.includes('"turn_context"')) model = modelFromLine(line);
    if (usage && model) break;
  }
  if (!usage && !model) return undefined;
  return { ...usage, model };
}

function readLatestTokenUsage(rolloutPath?: string | null): CodexTokenUsage | undefined {
  if (!rolloutPath) return undefined;
  const text = readFileTailSync(rolloutPath, 4 * 1024 * 1024);
  return text === undefined ? undefined : findLatestTokenUsageInText(text);
}

function rowToThread(row: CodexThreadRow): CodexThread {
  return {
    sessionId: row.id,
    title: row.title || undefined,
    firstPrompt: row.first_user_message || undefined,
    tokensUsed: typeof row.tokens_used === 'number' ? row.tokens_used : undefined,
    tokenUsage: readLatestTokenUsage(row.rollout_path),
    gitBranch: row.git_branch || undefined,
    cwd: row.cwd,
    createdAt: epochToIso(row.created_at, row.created_at_ms),
    updatedAt: epochToIso(row.updated_at, row.updated_at_ms),
  };
}

export class CodexService {
  private dbPath: string;
  private cache: { timestamp: number; data: Map<string, CodexThread> } | null = null;
  private static readonly CACHE_TTL = 5000;

  constructor(dbPath = join(homedir(), '.codex', 'state_5.sqlite')) {
    this.dbPath = dbPath;
  }

  async getThreadsByIds(sessionIds: string[]): Promise<Map<string, CodexThread>> {
    const uniqueIds = [...new Set(sessionIds.filter(Boolean))];
    if (uniqueIds.length === 0) return new Map();

    if (this.cache && Date.now() - this.cache.timestamp < CodexService.CACHE_TTL) {
      return new Map(uniqueIds.flatMap(sessionId => {
        const thread = this.cache?.data.get(sessionId);
        return thread ? [[sessionId, thread] as const] : [];
      }));
    }

    const allThreads = this.loadThreadsById();
    this.cache = { timestamp: Date.now(), data: allThreads };

    return new Map(uniqueIds.flatMap(sessionId => {
      const thread = allThreads.get(sessionId);
      return thread ? [[sessionId, thread] as const] : [];
    }));
  }

  private loadThreadsById(): Map<string, CodexThread> {
    const result = new Map<string, CodexThread>();
    if (!existsSync(this.dbPath)) return result;

    let db: Database | undefined;
    try {
      db = new Database(this.dbPath, { readonly: true });
      const rows = db.query<CodexThreadRow, []>(`
        SELECT
          id,
          title,
          first_user_message,
          tokens_used,
          rollout_path,
          git_branch,
          cwd,
          created_at,
          updated_at,
          created_at_ms,
          updated_at_ms
        FROM threads
        WHERE archived = 0
      `).all();

      for (const row of rows) {
        result.set(row.id, rowToThread(row));
      }
    } catch {
      return new Map();
    } finally {
      db?.close();
    }

    return result;
  }
}
