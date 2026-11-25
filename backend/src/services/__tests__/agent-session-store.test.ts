import { describe, expect, test } from 'bun:test';
import type { ListedSession } from '../agent-history-listing';
import { CachedSessionStore, StoreThreadService, type ThreadDetails } from '../agent-session-store';

const SESSIONS: ListedSession[] = [
  { sessionId: 'a', cwd: '/repo/a', updatedAt: '2026-11-24T10:00:00.000Z', title: 'A', firstPrompt: 'do a' },
  { sessionId: 'b', cwd: '/repo/b', updatedAt: '2026-11-24T11:00:00.000Z', createdAt: '2026-11-24T09:00:00.000Z' },
  { sessionId: 'c', cwd: '/repo/c', updatedAt: '2026-11-24T12:00:00.000Z' },
];

class CountingStore extends CachedSessionStore<ListedSession> {
  scans = 0;
  protected scan(): ListedSession[] {
    this.scans++;
    return SESSIONS;
  }
}

class FakeThreads extends StoreThreadService<ListedSession, CountingStore> {
  described: string[][] = [];
  protected describe(sessions: ListedSession[]): ThreadDetails[] {
    this.described.push(sessions.map((s) => s.sessionId));
    return sessions.map((s) => ({ recap: `recap of ${s.sessionId}` }));
  }
}

describe('CachedSessionStore', () => {
  test('scans once for calls inside the cache window', async () => {
    const store = new CountingStore();
    await store.listSessions();
    await store.listSessions();
    await store.findSession('b');
    expect(store.scans).toBe(1);
  });

  test('finds a session by id, or undefined', async () => {
    const store = new CountingStore();
    expect((await store.findSession('b'))?.cwd).toBe('/repo/b');
    expect(await store.findSession('zzz')).toBeUndefined();
  });
});

describe('StoreThreadService', () => {
  test('returns the listing fields with the details laid over them', async () => {
    const threads = await new FakeThreads(new CountingStore()).getThreadsByIds(['a', 'b']);
    expect([...threads.keys()]).toEqual(['a', 'b']);
    expect(threads.get('a')).toEqual({
      sessionId: 'a',
      title: 'A',
      firstPrompt: 'do a',
      cwd: '/repo/a',
      createdAt: undefined,
      updatedAt: '2026-11-24T10:00:00.000Z',
      recap: 'recap of a',
    });
    expect(threads.get('b')?.createdAt).toBe('2026-11-24T09:00:00.000Z');
  });

  test('describes only the wanted sessions, in one call', async () => {
    const service = new FakeThreads(new CountingStore());
    await service.getThreadsByIds(['c', 'a', 'c', '', 'missing']);
    expect(service.described).toEqual([['a', 'c']]);
  });

  test('reads nothing when no id is asked for or none is known', async () => {
    const store = new CountingStore();
    const service = new FakeThreads(store);
    expect((await service.getThreadsByIds([''])).size).toBe(0);
    expect(store.scans).toBe(0);
    expect((await service.getThreadsByIds(['missing'])).size).toBe(0);
    expect(service.described).toEqual([]);
  });
});
