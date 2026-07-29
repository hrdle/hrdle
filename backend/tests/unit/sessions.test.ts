import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  listSessions,
  getSession,
  createSession,
  deleteSession,
  updateSessionAccess,
} from '../../src/services/sessions';
import { IDENTITY } from '../../../shared/identity';

const TEST_DATA_DIR = join(tmpdir(), `${IDENTITY.tmpPrefix}-test-sessions-` + Date.now());

// Read from identity rather than written out: a rename that changes the
// variable leaves a hardcoded one setting something nothing reads, and these
// tests then create their fixture sessions in the real data directory. #459
const DATA_DIR_ENV = IDENTITY.dataDirEnv;

describe('Sessions Service', () => {
  beforeEach(async () => {
    process.env[DATA_DIR_ENV] = TEST_DATA_DIR;
    await mkdir(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
    delete process.env[DATA_DIR_ENV];
  });

  describe('createSession', () => {
    test('creates a session with auto-generated name', async () => {
      const session = await createSession();

      expect(session.id).toBeDefined();
      expect(session.name).toMatch(/^Session \d+$/);
      expect(session.createdAt).toBeDefined();
      expect(session.lastAccessedAt).toBeDefined();
      expect(session.state).toBe('idle');
    });

    test('creates a session with custom name', async () => {
      const session = await createSession('My Project');

      expect(session.name).toBe('My Project');
    });

    test('creates sessions with unique IDs', async () => {
      const session1 = await createSession();
      const session2 = await createSession();

      expect(session1.id).not.toBe(session2.id);
    });
  });

  describe('listSessions', () => {
    test('returns empty array when no sessions exist', async () => {
      const sessions = await listSessions();

      expect(sessions).toEqual([]);
    });

    test('returns all created sessions', async () => {
      await createSession('Session A');
      await createSession('Session B');

      const sessions = await listSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.name)).toContain('Session A');
      expect(sessions.map(s => s.name)).toContain('Session B');
    });

    test('returns sessions sorted by lastAccessedAt descending', async () => {
      const session1 = await createSession('First');
      await new Promise(r => setTimeout(r, 50));
      await createSession('Second');
      await new Promise(r => setTimeout(r, 50));

      // Access first session again - this makes it the most recent
      await updateSessionAccess(session1.id);

      const sessions = await listSessions();

      // First should be at top because we just updated its access time
      expect(sessions[0].name).toBe('First');
      expect(sessions[1].name).toBe('Second');
    });
  });

  describe('getSession', () => {
    test('returns session by ID', async () => {
      const created = await createSession('Test Session');

      const session = await getSession(created.id);

      expect(session).toBeDefined();
      expect(session!.id).toBe(created.id);
      expect(session!.name).toBe('Test Session');
    });

    test('returns null for non-existent session', async () => {
      const session = await getSession('non-existent-id');

      expect(session).toBeNull();
    });
  });

  describe('deleteSession', () => {
    test('deletes existing session', async () => {
      const created = await createSession('To Delete');

      const result = await deleteSession(created.id);
      const session = await getSession(created.id);

      expect(result).toBe(true);
      expect(session).toBeNull();
    });

    test('returns false for non-existent session', async () => {
      const result = await deleteSession('non-existent-id');

      expect(result).toBe(false);
    });
  });

  describe('updateSessionAccess', () => {
    test('updates lastAccessedAt timestamp', async () => {
      const created = await createSession();
      const originalAccessTime = created.lastAccessedAt;

      await new Promise(r => setTimeout(r, 10));
      await updateSessionAccess(created.id);

      const updated = await getSession(created.id);

      expect(updated!.lastAccessedAt).not.toBe(originalAccessTime);
      expect(new Date(updated!.lastAccessedAt).getTime())
        .toBeGreaterThan(new Date(originalAccessTime).getTime());
    });

    test('returns false for non-existent session', async () => {
      const result = await updateSessionAccess('non-existent-id');

      expect(result).toBe(false);
    });
  });
});
