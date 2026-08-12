import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ensureDataDir, atomicWriteFile, createMutationLock } from '../utils/storage';
import type { AgentProvider, SessionTheme } from '../../../shared/types';

// The `herdr-` prefix dates from the tmux-era Hrdle, which shared one data
// dir between backends running on different ports and needed separate stores
// so tmux-era session lists didn't bleed into the herdr UI as phantom "Lost"
// entries. The prefix stays after the rename: these names are what installs
// already have on disk.
const METADATA_FILE = 'herdr-session-metadata.json';
const LAST_KNOWN_FILE = 'herdr-last-known-sessions.json';

// Serialise read-modify-write sequences per store file so concurrent theme /
// title / order updates can't clobber each other (lost update).
const withMetadataLock = createMutationLock();
const withLastKnownLock = createMutationLock();

interface SessionMeta {
  theme?: SessionTheme;
  title?: string;
  /**
   * Words this session is about, biasing its speech-to-text.
   *
   * Here rather than in `glasses-settings.json` because it belongs to the
   * session the way a theme and a title do: it is written when the work is
   * named and it dies with the workspace.
   */
  sttPrompt?: string;
  /**
   * `'off'` when this workspace declines the shared glossary.
   *
   * The glossary is the words this product is made of, and a workspace whose
   * subject is not this product never says one of them: it pays half the
   * prompt for vocabulary that cannot be spoken there. Declining it hands the
   * whole budget to the words above.
   */
  sttGlossary?: 'off';
}

export interface LastKnownSession {
  id: string;
  name: string;
  currentPath?: string;
  agent?: AgentProvider;
  theme?: SessionTheme;
  ccSessionId?: string;
  /** Codex thread id (rollout). Used to drive `codex resume <id>` after reboot. */
  agentSessionId?: string;
}

interface MetadataStore {
  sessions: Record<string, SessionMeta>;
}

async function getFilePath(): Promise<string> {
  const dataDir = await ensureDataDir();
  return join(dataDir, METADATA_FILE);
}

async function getLastKnownFilePath(): Promise<string> {
  const dataDir = await ensureDataDir();
  return join(dataDir, LAST_KNOWN_FILE);
}

async function load(): Promise<MetadataStore> {
  const filePath = await getFilePath();
  try {
    const data = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(data) as MetadataStore;
    return { sessions: parsed.sessions || {} };
  } catch {
    // Fresh store. Deliberately NO migration from the tmux-era files
    // (session-metadata.json etc.) — they belong to the tmux install and
    // reference tmux session names.
    return { sessions: {} };
  }
}

async function save(data: MetadataStore): Promise<void> {
  const filePath = await getFilePath();
  for (const [id, meta] of Object.entries(data.sessions)) {
    if (!meta.theme && !meta.title && !meta.sttPrompt && !meta.sttGlossary) {
      delete data.sessions[id];
    }
  }
  await atomicWriteFile(filePath, JSON.stringify(data, null, 2));
}

export async function getAllSessionMetadata(): Promise<Record<string, SessionMeta>> {
  const data = await load();
  return data.sessions;
}

export async function setSessionTheme(sessionId: string, theme: SessionTheme | null): Promise<void> {
  await withMetadataLock(async () => {
    const data = await load();
    if (!data.sessions[sessionId]) data.sessions[sessionId] = {};
    if (theme === null) {
      delete data.sessions[sessionId].theme;
    } else {
      data.sessions[sessionId].theme = theme;
    }
    await save(data);
  });
}

// Last known sessions: separate file to avoid race conditions with metadata writes
export async function getLastKnownSessions(): Promise<LastKnownSession[]> {
  const filePath = await getLastKnownFilePath();
  try {
    const data = await readFile(filePath, 'utf-8');
    return JSON.parse(data) as LastKnownSession[];
  } catch {
    return [];
  }
}

export async function saveLastKnownSessions(sessions: LastKnownSession[]): Promise<void> {
  await withLastKnownLock(async () => {
    const filePath = await getLastKnownFilePath();
    await atomicWriteFile(filePath, JSON.stringify(sessions, null, 2));
  });
}

export async function removeLastKnownSession(sessionId: string): Promise<void> {
  await withLastKnownLock(async () => {
    const sessions = await getLastKnownSessions();
    const filtered = sessions.filter(s => s.id !== sessionId);
    if (filtered.length !== sessions.length) {
      const filePath = await getLastKnownFilePath();
      await atomicWriteFile(filePath, JSON.stringify(filtered, null, 2));
    }
  });
}

/**
 * Move whole entries from one session id to another.
 *
 * One write for the whole plan: a rename per call would leave the file in a
 * half-migrated state if the process stopped in the middle of it.
 */
export async function rekeySessionMetadata(
  moves: { from: string; to: string }[],
): Promise<void> {
  if (moves.length === 0) return;
  await withMetadataLock(async () => {
    const data = await load();
    let changed = false;
    for (const { from, to } of moves) {
      const meta = data.sessions[from];
      if (!meta || data.sessions[to]) continue;
      data.sessions[to] = meta;
      delete data.sessions[from];
      changed = true;
    }
    if (changed) await save(data);
  });
}

export async function setSessionSttPrompt(
  sessionId: string,
  prompt: string | null,
): Promise<void> {
  await withMetadataLock(async () => {
    const data = await load();
    if (!data.sessions[sessionId]) data.sessions[sessionId] = {};
    if (prompt === null || prompt.trim() === '') {
      delete data.sessions[sessionId].sttPrompt;
    } else {
      data.sessions[sessionId].sttPrompt = prompt.trim();
    }
    await save(data);
  });
}

/**
 * Add terms to what this workspace already has.
 *
 * Adding rather than replacing is the default because a vocabulary is a list
 * that grows: a caller that meant to add one word and replaced the list
 * instead loses the rest silently, and there is nothing in a transcription to
 * show it happened. Read-modify-write inside the lock, so two agents adding at
 * once cannot drop each other's word.
 *
 * Nothing is truncated to fit. A list cut down invisibly is the failure this
 * whole area keeps producing, so an overflow is reported and the caller
 * decides what to drop.
 */
export async function addSessionSttTerms(
  sessionId: string,
  terms: string[],
  maxChars: number,
): Promise<
  | { ok: true; added: string[]; duplicate: string[]; stored: string }
  | { ok: false; reason: 'too-long'; wouldBe: number; stored: string }
> {
  return withMetadataLock(async () => {
    const data = await load();
    const existing = (data.sessions[sessionId]?.sttPrompt ?? '')
      .split(/[、,\n]/)
      .map((t) => t.trim())
      .filter(Boolean);
    const seen = new Set(existing.map((t) => t.toLowerCase()));

    const added: string[] = [];
    const duplicate: string[] = [];
    for (const raw of terms) {
      const term = raw.trim();
      if (!term) continue;
      if (seen.has(term.toLowerCase())) {
        duplicate.push(term);
        continue;
      }
      seen.add(term.toLowerCase());
      added.push(term);
    }

    const next = [...existing, ...added].join('、');
    if (next.length > maxChars) {
      return { ok: false, reason: 'too-long', wouldBe: next.length, stored: existing.join('、') };
    }

    if (added.length > 0) {
      if (!data.sessions[sessionId]) data.sessions[sessionId] = {};
      data.sessions[sessionId].sttPrompt = next;
      await save(data);
    }
    return { ok: true, added, duplicate, stored: next };
  });
}

/** Whether this workspace takes the shared glossary. */
export async function setSessionSttGlossary(
  sessionId: string,
  enabled: boolean,
): Promise<void> {
  await withMetadataLock(async () => {
    const data = await load();
    if (!data.sessions[sessionId]) data.sessions[sessionId] = {};
    if (enabled) delete data.sessions[sessionId].sttGlossary;
    else data.sessions[sessionId].sttGlossary = 'off';
    await save(data);
  });
}

