import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { AgentThread, AgentThreadService, AgentTokenUsage } from './agent-providers';

/**
 * OpenCode keeps everything in one SQLite database rather than a tree of JSON
 * files: sessions, messages and their parts are rows in `~/.local/share/
 * opencode/opencode.db` (WAL). Reading it follows the Codex precedent in
 * `codex.ts` — open readonly per query, close in a finally, and degrade to an
 * empty result rather than throwing, because the file belongs to another
 * process that may be mid-migration.
 *
 * Shelling out to `opencode db --format json` was the alternative and is worse
 * here: it loads external plugins on every invocation (herdr's own agent-state
 * plugin among them) unless `--pure` is passed, and the sessions list is pushed
 * every 5s, so a spawn per poll is far too expensive.
 *
 * The `project` table is deliberately never read. Its `global` row is a
 * catch-all for directories OpenCode does not treat as a project root, and its
 * `worktree` column mutates as other directories are visited. `session.
 * directory` is the absolute cwd and is stable.
 */

/** One OpenCode session as recorded in `session`. */
export interface OpenCodeSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string;
  firstPrompt?: string;
  model?: string;
  cost?: number;
  tokensInput?: number;
  tokensOutput?: number;
  tokensCacheRead?: number;
  createdAt?: string;
  updatedAt: string;
}

interface OpenCodeSessionRow {
  id: string;
  directory: string;
  title: string | null;
  model: string | null;
  cost: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  time_created: number | null;
  time_updated: number | null;
}

interface TextBySessionRow {
  session_id: string;
  text: string | null;
}

interface MessageDataRow {
  session_id: string;
  data: string;
}

/** `session.model` is JSON: `{"id":"...","providerID":"...","variant":"..."}`. */
export function parseSessionModel(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const model = JSON.parse(raw) as { id?: unknown; providerID?: unknown };
    if (typeof model.id !== 'string' || !model.id) return undefined;
    return typeof model.providerID === 'string' && model.providerID
      ? `${model.providerID}/${model.id}`
      : model.id;
  } catch {
    return undefined;
  }
}

/** Per-turn token block carried on an assistant `message.data`. */
export interface OpenCodeMessageTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface AssistantMessageData {
  role?: unknown;
  modelID?: unknown;
  providerID?: unknown;
  tokens?: {
    input?: unknown;
    output?: unknown;
    reasoning?: unknown;
    cache?: { read?: unknown; write?: unknown };
  };
  cost?: unknown;
  time?: { created?: unknown; completed?: unknown };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseMessageTokens(data: string): OpenCodeMessageTokens | undefined {
  let message: AssistantMessageData;
  try {
    message = JSON.parse(data) as AssistantMessageData;
  } catch {
    return undefined;
  }
  const tokens = message.tokens;
  if (!tokens) return undefined;
  return {
    input: numberOrUndefined(tokens.input),
    output: numberOrUndefined(tokens.output),
    reasoning: numberOrUndefined(tokens.reasoning),
    cacheRead: numberOrUndefined(tokens.cache?.read),
    cacheWrite: numberOrUndefined(tokens.cache?.write),
  };
}

function epochToIso(millis?: number | null): string | undefined {
  return typeof millis === 'number' && millis > 0 ? new Date(millis).toISOString() : undefined;
}

/** Recaps are capped so a long final response doesn't flood the session card. */
const RECAP_MAX_CHARS = 500;

/**
 * Default database path. `OPENCODE_DATA_DIR` overrides the data directory
 * outright; otherwise the XDG data home applies, defaulting to
 * `~/.local/share`.
 */
export function defaultOpenCodeDbPath(): string {
  const dataDir = process.env.OPENCODE_DATA_DIR
    ?? join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode');
  return join(dataDir, 'opencode.db');
}

/** Placeholder list for an `IN (...)` clause. */
function placeholders(count: number): string {
  return new Array(count).fill('?').join(',');
}

/**
 * SQL predicate keeping only text parts with something in them. OpenCode writes
 * a `"\n\n"` text part immediately before a tool call as a matter of course, and
 * picking it as the newest assistant text would blank the recap of a session
 * that is mid-tool — exactly when its card is worth reading. Discarding it in JS
 * is not enough: max() would still have chosen that row, hiding a real recap one
 * turn back.
 *
 * The character set is spelled out because SQLite's bare `trim(X)` strips
 * **spaces only** — `trim(char(10))` is still one character long, so the default
 * form would let the very part this exists to exclude straight through.
 *
 * Assumes the part table is aliased `p`, as both queries below do.
 */
const NON_BLANK_TEXT = `length(trim(json_extract(p.data, '$.text'), ' ' || char(10) || char(9) || char(13))) > 0`;

/**
 * Reads OpenCode's SQLite store. Every method opens the database, queries and
 * closes it; an unreadable or missing file yields an empty result.
 */
export class OpenCodeSessionStore {
  private dbPath: string;
  private cache: { timestamp: number; sessions: OpenCodeSessionInfo[] } | null = null;
  private static readonly CACHE_TTL = 5000;

  constructor(dbPath = defaultOpenCodeDbPath()) {
    this.dbPath = dbPath;
  }

  /** Runs `fn` against a readonly connection, or returns `fallback`. */
  private read<T>(fn: (db: Database) => T, fallback: T): T {
    if (!existsSync(this.dbPath)) return fallback;
    let db: Database | undefined;
    try {
      db = new Database(this.dbPath, { readonly: true });
      return fn(db);
    } catch {
      return fallback;
    } finally {
      db?.close();
    }
  }

  async listSessions(): Promise<OpenCodeSessionInfo[]> {
    if (this.cache && Date.now() - this.cache.timestamp < OpenCodeSessionStore.CACHE_TTL) {
      return this.cache.sessions;
    }
    const sessions = this.loadSessions();
    this.cache = { timestamp: Date.now(), sessions };
    return sessions;
  }

  async findSession(sessionId: string): Promise<OpenCodeSessionInfo | undefined> {
    const sessions = await this.listSessions();
    return sessions.find((s) => s.sessionId === sessionId);
  }

  private loadSessions(): OpenCodeSessionInfo[] {
    return this.read((db) => {
      // Subagent sessions (task tool) carry a parent_id; they are turns of their
      // parent, not sessions a user opened, so they never appear on their own.
      const rows = db.query<OpenCodeSessionRow, []>(`
        SELECT
          id,
          directory,
          title,
          model,
          cost,
          tokens_input,
          tokens_output,
          tokens_cache_read,
          time_created,
          time_updated
        FROM session
        WHERE parent_id IS NULL AND time_archived IS NULL
        ORDER BY time_updated DESC
      `).all();
      if (rows.length === 0) return [];

      const firstPrompts = this.queryFirstPrompts(db, rows.map((r) => r.id));

      return rows.map((row) => ({
        sessionId: row.id,
        cwd: row.directory,
        title: row.title || undefined,
        firstPrompt: firstPrompts.get(row.id),
        model: parseSessionModel(row.model),
        cost: numberOrUndefined(row.cost),
        tokensInput: numberOrUndefined(row.tokens_input),
        tokensOutput: numberOrUndefined(row.tokens_output),
        tokensCacheRead: numberOrUndefined(row.tokens_cache_read),
        createdAt: epochToIso(row.time_created),
        // A session always has time_updated (NOT NULL); fall back to created so
        // sorting never sees an empty string.
        updatedAt: epochToIso(row.time_updated) ?? epochToIso(row.time_created) ?? new Date(0).toISOString(),
      }));
    }, []);
  }

  /**
   * First user-authored text of each session. `session_input` has a `prompt`
   * column that looks like the natural source, but on 1.18.13 that table is
   * never written: zero rows across sessions started both ways, the interactive
   * TUI included. So the first `text` part of the first user message is used
   * instead.
   *
   * SQLite's documented min/max extension applies: with a single `min()`
   * aggregate the other result columns come from the matching row (verified to
   * hold for a `json_extract` expression across the join, not only for a bare
   * column). Two parts written in the same millisecond are a tie SQLite breaks
   * arbitrarily — either is a defensible answer, so it is not worth a window
   * function to order.
   */
  private queryFirstPrompts(db: Database, sessionIds: string[]): Map<string, string> {
    const result = new Map<string, string>();
    if (sessionIds.length === 0) return result;
    const rows = db.query<TextBySessionRow, string[]>(`
      SELECT p.session_id AS session_id, json_extract(p.data, '$.text') AS text, min(p.time_created)
      FROM part p
      JOIN message m ON m.id = p.message_id
      WHERE p.session_id IN (${placeholders(sessionIds.length)})
        AND json_extract(p.data, '$.type') = 'text'
        AND json_extract(m.data, '$.role') = 'user'
        AND ${NON_BLANK_TEXT}
      GROUP BY p.session_id
    `).all(...sessionIds);
    for (const row of rows) {
      if (row.text) result.set(row.session_id, row.text);
    }
    return result;
  }

  /**
   * Last assistant text of each session — the recap substitute shown on
   * workspace cards, as Kimi does. `reasoning` parts are internal and excluded
   * by the `text` type filter.
   */
  private queryRecaps(db: Database, sessionIds: string[]): Map<string, { recap: string; recapAt?: string }> {
    const result = new Map<string, { recap: string; recapAt?: string }>();
    if (sessionIds.length === 0) return result;
    const rows = db.query<TextBySessionRow & { time_created: number | null }, string[]>(`
      SELECT p.session_id AS session_id, json_extract(p.data, '$.text') AS text, max(p.time_created) AS time_created
      FROM part p
      JOIN message m ON m.id = p.message_id
      WHERE p.session_id IN (${placeholders(sessionIds.length)})
        AND json_extract(p.data, '$.type') = 'text'
        AND json_extract(m.data, '$.role') = 'assistant'
        AND ${NON_BLANK_TEXT}
      GROUP BY p.session_id
    `).all(...sessionIds);
    for (const row of rows) {
      const text = row.text?.trim();
      if (!text) continue;
      result.set(row.session_id, {
        recap: text.length > RECAP_MAX_CHARS ? `${text.slice(0, RECAP_MAX_CHARS)}…` : text,
        recapAt: epochToIso(row.time_created),
      });
    }
    return result;
  }

  /** Token block of each session's most recent assistant message. */
  private queryLatestTokens(db: Database, sessionIds: string[]): Map<string, OpenCodeMessageTokens> {
    const result = new Map<string, OpenCodeMessageTokens>();
    if (sessionIds.length === 0) return result;
    const rows = db.query<MessageDataRow, string[]>(`
      SELECT session_id, data, max(time_created)
      FROM message
      WHERE session_id IN (${placeholders(sessionIds.length)})
        AND json_extract(data, '$.role') = 'assistant'
      GROUP BY session_id
    `).all(...sessionIds);
    for (const row of rows) {
      const tokens = parseMessageTokens(row.data);
      if (tokens) result.set(row.session_id, tokens);
    }
    return result;
  }

  /** Recap and latest token usage for the given sessions, in one connection. */
  getThreadExtras(sessionIds: string[]): Map<string, { recap?: string; recapAt?: string; tokens?: OpenCodeMessageTokens }> {
    if (sessionIds.length === 0) return new Map();
    return this.read((db) => {
      const recaps = this.queryRecaps(db, sessionIds);
      const tokens = this.queryLatestTokens(db, sessionIds);
      const result = new Map<string, { recap?: string; recapAt?: string; tokens?: OpenCodeMessageTokens }>();
      for (const sessionId of sessionIds) {
        const recap = recaps.get(sessionId);
        result.set(sessionId, { recap: recap?.recap, recapAt: recap?.recapAt, tokens: tokens.get(sessionId) });
      }
      return result;
    }, new Map());
  }

  /** Messages of one session, oldest first, each with its parts in order. */
  getSessionParts(sessionId: string): Array<{ role: string; parts: string[] }> {
    return this.read((db) => {
      const messages = db.query<{ id: string; data: string }, [string]>(`
        SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id
      `).all(sessionId);
      if (messages.length === 0) return [];

      const parts = db.query<{ message_id: string; data: string }, [string]>(`
        SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id
      `).all(sessionId);

      const byMessage = new Map<string, string[]>();
      for (const part of parts) {
        const list = byMessage.get(part.message_id);
        if (list) list.push(part.data);
        else byMessage.set(part.message_id, [part.data]);
      }

      return messages.map((message) => {
        let role = 'assistant';
        try {
          const parsed = JSON.parse(message.data) as { role?: unknown };
          if (typeof parsed.role === 'string') role = parsed.role;
        } catch {
          // keep the default; a message with unreadable data still owns its parts
        }
        return { role, parts: byMessage.get(message.id) ?? [] };
      });
    }, []);
  }

  /**
   * Assistant messages across all sessions, for usage aggregation. Each row is
   * one turn: its timestamp, model and token block.
   */
  listAssistantTurns(since = 0): Array<{ sessionId: string; timeCreated: number; model?: string; tokens: OpenCodeMessageTokens; cost?: number }> {
    return this.read((db) => {
      // Bounded in SQL rather than by filtering everything in JS: the dashboard
      // polls this, and the message table only grows.
      const rows = db.query<{ session_id: string; time_created: number; data: string }, [number]>(`
        SELECT session_id, time_created, data
        FROM message
        WHERE json_extract(data, '$.role') = 'assistant'
          AND time_created >= ?
        ORDER BY time_created
      `).all(since);

      const turns: Array<{ sessionId: string; timeCreated: number; model?: string; tokens: OpenCodeMessageTokens; cost?: number }> = [];
      for (const row of rows) {
        const tokens = parseMessageTokens(row.data);
        if (!tokens) continue;
        let model: string | undefined;
        let cost: number | undefined;
        try {
          const parsed = JSON.parse(row.data) as AssistantMessageData;
          const modelId = typeof parsed.modelID === 'string' ? parsed.modelID : undefined;
          const providerId = typeof parsed.providerID === 'string' ? parsed.providerID : undefined;
          model = modelId && providerId ? `${providerId}/${modelId}` : modelId;
          cost = numberOrUndefined(parsed.cost);
        } catch {
          // tokens already parsed; a model-less turn still counts
        }
        turns.push({ sessionId: row.session_id, timeCreated: row.time_created, model, tokens, cost });
      }
      return turns;
    }, []);
  }
}

/** Total context carried into the latest turn: fresh input plus cache reads. */
export function contextTokensOf(tokens: OpenCodeMessageTokens | undefined): number | undefined {
  if (!tokens) return undefined;
  if (tokens.input === undefined && tokens.cacheRead === undefined) return undefined;
  return (tokens.input ?? 0) + (tokens.cacheRead ?? 0);
}

function tokenUsageOf(session: OpenCodeSessionInfo, latest: OpenCodeMessageTokens | undefined): AgentTokenUsage | undefined {
  const contextTokens = contextTokensOf(latest);
  const totalInputTokens = session.tokensInput;
  const totalOutputTokens = session.tokensOutput;
  if (
    contextTokens === undefined
    && totalInputTokens === undefined
    && totalOutputTokens === undefined
    && !session.model
  ) return undefined;

  return {
    contextTokens,
    // OpenCode records no context window locally, so there is no percentage to
    // show — leaving both out is better than inventing a denominator.
    contextMaxTokens: undefined,
    contextPercent: undefined,
    totalInputTokens,
    totalCacheReadTokens: session.tokensCacheRead,
    totalOutputTokens,
    totalTokens: totalInputTokens !== undefined || totalOutputTokens !== undefined
      ? (totalInputTokens ?? 0) + (totalOutputTokens ?? 0)
      : undefined,
    model: session.model,
  };
}

/** Exact OpenCode sessions by native session id, for the active-sessions list. */
export class OpenCodeService implements AgentThreadService {
  private store: OpenCodeSessionStore;

  constructor(store = new OpenCodeSessionStore()) {
    this.store = store;
  }

  async getThreadsByIds(sessionIds: string[]): Promise<Map<string, AgentThread>> {
    const uniqueIds = [...new Set(sessionIds.filter(Boolean))];
    if (uniqueIds.length === 0) return new Map();

    const sessions = await this.store.listSessions();
    const wanted = sessions.filter((s) => uniqueIds.includes(s.sessionId));
    if (wanted.length === 0) return new Map();

    const extras = this.store.getThreadExtras(wanted.map((s) => s.sessionId));

    const result = new Map<string, AgentThread>();
    for (const session of wanted) {
      const extra = extras.get(session.sessionId);
      result.set(session.sessionId, {
        sessionId: session.sessionId,
        title: session.title,
        firstPrompt: session.firstPrompt,
        tokenUsage: tokenUsageOf(session, extra?.tokens),
        recap: extra?.recap,
        recapAt: extra?.recapAt,
        cwd: session.cwd,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    }
    return result;
  }
}
