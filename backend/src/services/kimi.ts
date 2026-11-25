import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileHeadSync, readFileTailSync } from '../utils/file-slice';
import { numberOrUndefined } from '../utils/number';
import type { AgentTokenUsage } from './agent-providers';
import { CachedSessionStore, StoreThreadService, type ThreadDetails } from './agent-session-store';

/** One Kimi Code session as recorded under `~/.kimi-code/sessions`. */
export interface KimiSessionInfo {
  sessionId: string;
  cwd: string;
  /** Absolute session directory (holds state.json + agents/). */
  dir: string;
  title?: string;
  firstPrompt?: string;
  createdAt?: string;
  updatedAt: string;
}

/**
 * `state.json` as Kimi Code writes it, in both schemas it has used.
 *
 * 0.34 renamed `workDir` to `cwd` and turned the timestamps from ISO strings
 * into epoch milliseconds, announcing it with `version: 2`. The guard in
 * `scan()` required `workDir`, so every session written by the new version was
 * skipped: no conversation, no history row, no usage, no recap - a Chat view
 * that said "no messages" about a session with a full transcript on disk.
 *
 * Read duck-typed rather than switched on `version`, so a `version: 3` that
 * only adds fields keeps working, and the sessions already on disk in the old
 * schema keep being read.
 */
interface KimiStateJson {
  version?: number;
  createdAt?: string | number;
  updatedAt?: string | number;
  title?: string;
  /** v1. Superseded by `cwd`. */
  workDir?: string;
  /** v2 (Kimi 0.34+). */
  cwd?: string;
}

/**
 * A `state.json` timestamp as an ISO string, whichever way it was written.
 *
 * Normalised here, at the one place both schemas meet, because everything
 * downstream sorts and dates these as strings (`localeCompare` in
 * `kimi-history.ts`, `new Date()` in `kimi-usage.ts`, `HistorySession.modified`).
 * A number reaching any of them is a silent wrong answer rather than an error.
 */
function isoTimestamp(value: string | number | undefined): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Minimal shape of a wire.jsonl `turn.prompt` record. */
interface KimiTurnPromptRecord {
  input?: unknown;
  origin?: { kind?: unknown };
}

/** Path of the main agent's wire log inside a session directory. */
export function kimiWirePath(sessionDir: string): string {
  return join(sessionDir, 'agents', 'main', 'wire.jsonl');
}

/** Joined text of a `turn.prompt` record's text parts (user-origin only). */
export function turnPromptText(record: KimiTurnPromptRecord): string {
  if (record.origin?.kind !== 'user') return '';
  if (!Array.isArray(record.input)) return '';
  return record.input
    .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
      ? (part as { text: string }).text
      : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Kimi Code stores each session under
 * `~/.kimi-code/sessions/wd_<name>_<hash>/session_<uuid>/` with a `state.json`
 * (title / working directory / timestamps, in either schema - see
 * `KimiStateJson`) and the main agent's wire log in
 * `agents/main/wire.jsonl`, whose `turn.prompt` records carry the user prompts
 * and whose `usage.record` records carry per-turn token usage. Sub-agent wires
 * (`agents/agent-N/`) are ignored.
 */
export class KimiSessionStore extends CachedSessionStore<KimiSessionInfo> {
  constructor(private readonly sessionsDir = join(homedir(), '.kimi-code', 'sessions')) {
    super();
  }

  protected async scan(): Promise<KimiSessionInfo[]> {
    let projectDirs: string[];
    try {
      projectDirs = await readdir(this.sessionsDir);
    } catch {
      return [];
    }

    const results: KimiSessionInfo[] = [];
    await Promise.all(projectDirs.map(async (wdDir) => {
      if (!wdDir.startsWith('wd_')) return; // stray files next to the project dirs
      const projectDir = join(this.sessionsDir, wdDir);

      let entries: string[];
      try {
        entries = await readdir(projectDir);
      } catch {
        return;
      }

      await Promise.all(entries.map(async (name) => {
        const sessionDir = join(projectDir, name);
        const state = await this.readState(join(sessionDir, 'state.json'));
        const cwd = state?.cwd ?? state?.workDir;
        const updatedAt = isoTimestamp(state?.updatedAt);
        if (!updatedAt || !cwd) return;
        results.push({
          sessionId: name,
          cwd,
          dir: sessionDir,
          title: state?.title,
          firstPrompt: readFirstKimiPrompt(sessionDir),
          createdAt: isoTimestamp(state?.createdAt),
          updatedAt,
        });
      }));
    }));
    return results;
  }

  private async readState(path: string): Promise<KimiStateJson | null> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as KimiStateJson;
    } catch {
      return null;
    }
  }
}

/** First real user prompt: the first `turn.prompt` record in the main wire. */
function readFirstKimiPrompt(sessionDir: string): string | undefined {
  // The first prompt sits near the top, but config.update records with the
  // full system prompt can push it back tens of KB.
  const text = readFileHeadSync(kimiWirePath(sessionDir), 1024 * 1024);
  if (text === undefined) return undefined;

  for (const line of text.split('\n')) {
    if (!line.includes('"turn.prompt"')) continue;
    try {
      const prompt = turnPromptText(JSON.parse(line) as KimiTurnPromptRecord);
      if (prompt) return prompt;
    } catch {
      // partial last line of the head slice, or a malformed record
    }
  }
  return undefined;
}

function tailReadKimiWire(sessionDir: string): string | undefined {
  return readFileTailSync(kimiWirePath(sessionDir), 1024 * 1024);
}

/** Usage block of the last `usage.record` in the given wire lines. */
export function parseKimiTokenUsage(lines: string[]): AgentTokenUsage | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line?.includes('"usage.record"')) continue;
    try {
      const record = JSON.parse(line) as {
        type?: string;
        model?: unknown;
        usage?: {
          inputOther?: unknown;
          inputCacheRead?: unknown;
          inputCacheCreation?: unknown;
          output?: unknown;
        };
      };
      if (record.type !== 'usage.record' || !record.usage) continue;
      const usage = record.usage;
      const cacheRead = numberOrUndefined(usage.inputCacheRead);
      const inputParts = [usage.inputOther, usage.inputCacheRead, usage.inputCacheCreation]
        .map(numberOrUndefined)
        .filter((n): n is number => n !== undefined);
      const totalInputTokens = inputParts.length > 0 ? inputParts.reduce((a, b) => a + b, 0) : undefined;
      const output = numberOrUndefined(usage.output);
      return {
        model: typeof record.model === 'string' ? record.model : undefined,
        totalInputTokens,
        totalCacheReadTokens: cacheRead,
        totalOutputTokens: output,
        totalTokens: totalInputTokens !== undefined || output !== undefined
          ? (totalInputTokens ?? 0) + (output ?? 0)
          : undefined,
      };
    } catch {
      // partial first line of the tail slice, or a malformed record
    }
  }
  return undefined;
}

/** Recaps are capped so a long final response doesn't flood the session card. */
const KIMI_RECAP_MAX_CHARS = 500;

/**
 * Last visible assistant message in the given wire lines: the LAST
 * `content.part` loop event with `part.type === 'text'` (`think` parts are
 * internal reasoning and ignored). Serves as the recap substitute — Kimi has
 * no Claude-style away_summary.
 */
export function parseKimiRecap(lines: string[]): { recap?: string; recapAt?: string } {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line?.includes('"content.part"')) continue;
    try {
      const record = JSON.parse(line) as {
        type?: string;
        event?: { type?: string; part?: { type?: unknown; text?: unknown } };
        time?: unknown;
      };
      if (record.type !== 'context.append_loop_event' || record.event?.type !== 'content.part') continue;
      const part = record.event.part;
      if (part?.type !== 'text' || typeof part.text !== 'string' || !part.text) continue;
      return {
        recap: part.text.length > KIMI_RECAP_MAX_CHARS
          ? `${part.text.slice(0, KIMI_RECAP_MAX_CHARS)}…`
          : part.text,
        recapAt: typeof record.time === 'number' ? new Date(record.time).toISOString() : undefined,
      };
    } catch {
      // partial first line of the tail slice, or a malformed record
    }
  }
  return {};
}

/** Latest token usage + last assistant message from ONE tail read of the main wire. */
function readKimiWireTail(sessionDir: string): { tokenUsage?: AgentTokenUsage; recap?: string; recapAt?: string } {
  const text = tailReadKimiWire(sessionDir);
  if (text === undefined) return {};
  const lines = text.split('\n');
  return { tokenUsage: parseKimiTokenUsage(lines), ...parseKimiRecap(lines) };
}

/**
 * Tail-read the main wire.jsonl and return the usage block of the last
 * `usage.record` record.
 */
export function readLatestKimiTokenUsage(sessionDir: string): AgentTokenUsage | undefined {
  const text = tailReadKimiWire(sessionDir);
  if (text === undefined) return undefined;
  return parseKimiTokenUsage(text.split('\n'));
}

/** Exact Kimi Code sessions by native session id, for the active-sessions list. */
export class KimiService extends StoreThreadService<KimiSessionInfo> {
  constructor(store = new KimiSessionStore()) {
    super(store);
  }

  protected describe(sessions: KimiSessionInfo[]): ThreadDetails[] {
    return sessions.map((s) => readKimiWireTail(s.dir));
  }
}
