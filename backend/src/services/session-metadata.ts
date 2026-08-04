import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ensureDataDir, atomicWriteFile, createMutationLock } from '../utils/storage';
import type { AgentProvider, SessionTheme } from '../../../shared/types';

// The `herdr-` prefix dates from the tmux-era CC Hub, which shared one data
// dir between backends running on different ports and needed separate stores
// so tmux-era session lists didn't bleed into the herdr UI as phantom "Lost"
// entries. The prefix stays after the rename: these names are what installs
// already have on disk.
const METADATA_FILE = 'herdr-session-metadata.json';
const LAST_KNOWN_FILE = 'herdr-last-known-sessions.json';

// Serialise read-modify-write sequences per store file so concurrent theme /
// title / order updates can't clobber each other (lost update). #333
const withMetadataLock = createMutationLock();
const withLastKnownLock = createMutationLock();

interface SessionMeta {
  theme?: SessionTheme;
  title?: string;
  /**
   * Words this session is about, biasing its speech-to-text (#166).
   *
   * Here rather than in `glasses-settings.json` because it belongs to the
   * session the way a theme and a title do: it is written when the work is
   * named and it dies with the workspace.
   */
  sttPrompt?: string;
}

export interface LastKnownSession {
  id: string;
  name: string;
  currentPath?: string;
  agent?: AgentProvider;
  theme?: SessionTheme;
  customTitle?: string;
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
    if (!meta.theme && !meta.title && !meta.sttPrompt) {
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

export async function setSessionTitle(sessionId: string, title: string | null): Promise<void> {
  await withMetadataLock(async () => {
    const data = await load();
    if (!data.sessions[sessionId]) data.sessions[sessionId] = {};
    if (title === null || title === '') {
      delete data.sessions[sessionId].title;
    } else {
      data.sessions[sessionId].title = title;
    }
    await save(data);
  });
}
