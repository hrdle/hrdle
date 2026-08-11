import { join } from 'node:path';
import { readdir, readFile, rm, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ensureDataDir, atomicWriteFile, createMutationLock } from '../utils/storage';
import type { Session, SessionResponse } from '../../../shared/types';

const SESSIONS_DIR = 'sessions';

// Serialise read-modify-write updates against the per-session JSON files so
// concurrent updateSessionAccess calls can't drop each other's changes.
const withSessionsLock = createMutationLock();

async function getSessionsDir(): Promise<string> {
  const dataDir = await ensureDataDir();
  const sessionsDir = join(dataDir, SESSIONS_DIR);
  await mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}

function sessionToResponse(session: Session): SessionResponse {
  return {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    lastAccessedAt: session.lastAccessedAt,
    state: session.state,
  };
}

export async function createSession(name?: string): Promise<SessionResponse> {
  const sessionsDir = await getSessionsDir();
  const sessions = await listSessions();

  const id = `ses-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const sessionName = name || `Session ${sessions.length + 1}`;

  const session: Session = {
    id,
    name: sessionName,
    createdAt: now,
    lastAccessedAt: now,
    state: 'idle',
    ownerId: '', // Not used (no auth)
  };

  const filePath = join(sessionsDir, `${id}.json`);
  await atomicWriteFile(filePath, JSON.stringify(session, null, 2));

  return sessionToResponse(session);
}

export async function listSessions(): Promise<SessionResponse[]> {
  const sessionsDir = await getSessionsDir();

  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch {
    return [];
  }

  const sessions: Session[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    try {
      const filePath = join(sessionsDir, file);
      const data = await readFile(filePath, 'utf-8');
      const session = JSON.parse(data) as Session;
      sessions.push(session);
    } catch {
      // Skip invalid files
    }
  }

  // Sort by lastAccessedAt descending (most recent first)
  sessions.sort((a, b) =>
    new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime()
  );

  return sessions.map(sessionToResponse);
}

export async function getSession(id: string): Promise<SessionResponse | null> {
  const sessionsDir = await getSessionsDir();
  const filePath = join(sessionsDir, `${id}.json`);

  try {
    const data = await readFile(filePath, 'utf-8');
    const session = JSON.parse(data) as Session;
    return sessionToResponse(session);
  } catch {
    return null;
  }
}

export async function deleteSession(id: string): Promise<boolean> {
  const sessionsDir = await getSessionsDir();
  const filePath = join(sessionsDir, `${id}.json`);

  try {
    await rm(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function updateSessionAccess(id: string): Promise<boolean> {
  return withSessionsLock(async () => {
    const sessionsDir = await getSessionsDir();
    const filePath = join(sessionsDir, `${id}.json`);

    try {
      const data = await readFile(filePath, 'utf-8');
      const session = JSON.parse(data) as Session;
      session.lastAccessedAt = new Date().toISOString();
      await atomicWriteFile(filePath, JSON.stringify(session, null, 2));
      return true;
    } catch {
      return false;
    }
  });
}
