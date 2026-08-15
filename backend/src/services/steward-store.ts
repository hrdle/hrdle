/**
 * What the steward has written: its thread, one overview line per session, and
 * a per-session history of turns.
 *
 * On disk, not in memory. The thread is promised to outlive the steward, and
 * the server restarts on every release, so memory would lose it weekly.
 *
 * Three files because the write rates differ by orders of magnitude - a line
 * moves on every state change, a thread item only when a person is addressed.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  StewardAskAnswer,
  StewardSessionLine,
  StewardThreadItem,
  StewardTurn,
} from '../../../shared/types';
import { atomicWriteFile, createMutationLock, ensureDataDir } from '../utils/storage';

const THREAD_FILE = 'steward-thread.json';
const LINES_FILE = 'steward-lines.json';
const SESSIONS_FILE = 'steward-sessions.json';

/** Trimming drops the oldest exchanges, unanswered asks included - which is
 *  the right reading of a question 500 items into the past. */
const THREAD_MAX = 500;
const TURNS_PER_SESSION_MAX = 60;
/** Above the ~14 workspaces seen in practice, so it bites only on stale ones. */
const SESSIONS_MAX = 30;

const withThreadLock = createMutationLock();
const withLinesLock = createMutationLock();
const withSessionsLock = createMutationLock();

interface SessionsFile {
  /** sessionId -> turns, most recently written last. */
  sessions: Record<string, StewardTurn[]>;
}

async function filePath(name: string): Promise<string> {
  const dataDir = await ensureDataDir();
  return join(dataDir, name);
}

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(await filePath(name), 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await atomicWriteFile(await filePath(name), JSON.stringify(value, null, 2));
}

// ── thread ──

export async function getThread(): Promise<StewardThreadItem[]> {
  const items = await readJson<StewardThreadItem[]>(THREAD_FILE, []);
  return Array.isArray(items) ? items : [];
}

/** Distributed by hand: a plain `Omit` on a union collapses to the shared
 *  properties, silently dropping `ask` and `rows`. */
type OmitFromEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewThreadItem = OmitFromEach<StewardThreadItem, 'id' | 'at'> & { id?: string; at?: number };

export async function appendThreadItem(input: NewThreadItem): Promise<StewardThreadItem> {
  return withThreadLock(async () => {
    const items = await getThread();
    const item = {
      ...input,
      id: input.id ?? randomUUID(),
      at: input.at ?? Date.now(),
    } as StewardThreadItem;
    items.push(item);
    await writeJson(THREAD_FILE, items.slice(-THREAD_MAX));
    return item;
  });
}

/** Null when the ask is gone - trimmed, or never issued. Answering twice is
 *  allowed and the last one wins: a wearer correcting themselves is likelier
 *  than a forged reply, and the alternative is an unchangeable mistake. */
export async function answerAsk(
  askId: string,
  answer: StewardAskAnswer,
): Promise<StewardThreadItem | null> {
  return withThreadLock(async () => {
    const items = await getThread();
    const index = items.findIndex((i) => i.kind === 'ask' && i.ask.id === askId);
    if (index === -1) return null;
    const item = items[index];
    if (item.kind !== 'ask') return null;
    const updated: StewardThreadItem = {
      ...item,
      ask: { ...item.ask, answer, answeredAt: Date.now() },
    };
    items[index] = updated;
    await writeJson(THREAD_FILE, items);
    return updated;
  });
}

export async function findAsk(askId: string): Promise<StewardThreadItem | null> {
  const items = await getThread();
  return items.find((i) => i.kind === 'ask' && i.ask.id === askId) ?? null;
}

// ── overview lines ──

export async function getLines(): Promise<StewardSessionLine[]> {
  const lines = await readJson<StewardSessionLine[]>(LINES_FILE, []);
  return Array.isArray(lines) ? lines : [];
}

export async function setLine(sessionId: string, text: string): Promise<StewardSessionLine> {
  return withLinesLock(async () => {
    const lines = await getLines();
    const line: StewardSessionLine = { sessionId, text, at: Date.now() };
    const index = lines.findIndex((l) => l.sessionId === sessionId);
    if (index === -1) lines.push(line);
    else lines[index] = line;
    await writeJson(LINES_FILE, lines);
    return line;
  });
}

// ── per-session turns ──

export async function getSessionTurns(sessionId: string): Promise<StewardTurn[]> {
  const file = await readJson<SessionsFile>(SESSIONS_FILE, { sessions: {} });
  return file.sessions?.[sessionId] ?? [];
}

/** Upsert by id rather than replace-all: the steward writes only the
 *  difference, and rewrites a recent turn once it knows how something ended.
 *  Rebuilding the history each time would cost it a re-read of all of it. */
export async function appendSessionTurns(
  sessionId: string,
  turns: StewardTurn[],
): Promise<StewardTurn[]> {
  return withSessionsLock(async () => {
    const file = await readJson<SessionsFile>(SESSIONS_FILE, { sessions: {} });
    const sessions = file.sessions ?? {};
    const existing = sessions[sessionId] ?? [];

    for (const turn of turns) {
      const index = existing.findIndex((t) => t.id === turn.id);
      if (index === -1) existing.push(turn);
      else existing[index] = turn;
    }
    const trimmed = existing.slice(-TURNS_PER_SESSION_MAX);

    // Re-inserted at the end so insertion order tracks recency, which is what
    // the session cap below evicts by.
    delete sessions[sessionId];
    sessions[sessionId] = trimmed;

    const ids = Object.keys(sessions);
    for (const stale of ids.slice(0, Math.max(0, ids.length - SESSIONS_MAX))) {
      delete sessions[stale];
    }

    await writeJson(SESSIONS_FILE, { sessions });
    return trimmed;
  });
}

// ── cleanup ──

/** Everything written about one workspace, when the workspace is gone. */
export async function removeSession(sessionId: string): Promise<boolean> {
  let removed = false;

  await withLinesLock(async () => {
    const lines = await getLines();
    const kept = lines.filter((l) => l.sessionId !== sessionId);
    if (kept.length !== lines.length) {
      removed = true;
      await writeJson(LINES_FILE, kept);
    }
  });

  await withSessionsLock(async () => {
    const file = await readJson<SessionsFile>(SESSIONS_FILE, { sessions: {} });
    const sessions = file.sessions ?? {};
    if (sessions[sessionId]) {
      delete sessions[sessionId];
      removed = true;
      await writeJson(SESSIONS_FILE, { sessions });
    }
  });

  return removed;
}

/** Takes the live set rather than reacting to a delete event: a workspace can
 *  also go away while this server is down, and nothing replays that. */
export async function pruneToSessions(liveSessionIds: string[]): Promise<string[]> {
  const live = new Set(liveSessionIds);
  const lines = await getLines();
  const file = await readJson<SessionsFile>(SESSIONS_FILE, { sessions: {} });

  const stale = new Set<string>();
  for (const line of lines) if (!live.has(line.sessionId)) stale.add(line.sessionId);
  for (const id of Object.keys(file.sessions ?? {})) if (!live.has(id)) stale.add(id);

  for (const id of stale) await removeSession(id);
  return [...stale];
}
