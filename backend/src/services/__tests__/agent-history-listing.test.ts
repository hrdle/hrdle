import { describe, expect, test } from 'bun:test';
import type { ConversationMessage } from '../../../../shared/types';
import { homeShortPath } from '../../utils/home-path';
import { ListedHistoryProvider, type ListedSession } from '../agent-history-listing';

class FakeHistory extends ListedHistoryProvider<ListedSession> {
  constructor(private readonly sessions: ListedSession[]) {
    super('kimi');
  }
  protected async listSessions(): Promise<ListedSession[]> {
    return this.sessions.map((s) => ({ ...s }));
  }
  async getConversation(): Promise<ConversationMessage[]> {
    return [];
  }
}

const SESSIONS: ListedSession[] = [
  { sessionId: 'a', cwd: '/home/me/repos/app', updatedAt: '2026-11-20T10:00:00.000Z', firstPrompt: 'Fix the login bug' },
  {
    sessionId: 'b',
    cwd: '/home/me/repos/app',
    updatedAt: '2026-11-24T10:00:00.000Z',
    createdAt: '2026-11-24T09:00:00.000Z',
    title: 'Refactor routes',
    firstPrompt: 'split sessions.ts',
  },
  { sessionId: 'c', cwd: '/Users/me/notes', updatedAt: '2026-11-22T10:00:00.000Z' },
];

const history = () => new FakeHistory(SESSIONS);

describe('ListedHistoryProvider', () => {
  test('groups sessions into one project per directory', async () => {
    const projects = await history().getProjects();
    expect(projects).toEqual([
      {
        dirName: '-home-me-repos-app',
        projectPath: '/home/me/repos/app',
        projectName: '~/repos/app',
        sessionCount: 2,
        latestModified: '2026-11-24T10:00:00.000Z',
      },
      {
        dirName: '-Users-me-notes',
        projectPath: '/Users/me/notes',
        projectName: '~/notes',
        sessionCount: 1,
        latestModified: '2026-11-22T10:00:00.000Z',
      },
    ]);
  });

  test("lists a project's sessions newest first", async () => {
    const sessions = await history().getProjectSessions('-home-me-repos-app');
    expect(sessions.map((s) => s.sessionId)).toEqual(['b', 'a']);
  });

  test('takes the newest sessions across projects', async () => {
    const sessions = await history().getRecentSessions(2);
    expect(sessions.map((s) => s.sessionId)).toEqual(['b', 'c']);
  });

  test('describes a session in the shape history renders', async () => {
    const [session] = await history().getRecentSessions(1);
    expect(session).toEqual({
      sessionId: 'b',
      projectPath: '/home/me/repos/app',
      projectName: '~/repos/app',
      firstPrompt: 'split sessions.ts',
      lastPrompt: 'split sessions.ts',
      summary: 'Refactor routes',
      modified: '2026-11-24T10:00:00.000Z',
      startTime: '2026-11-24T09:00:00.000Z',
      agent: 'kimi',
    });
  });

  describe('search', () => {
    test('matches the directory, title and first prompt, ignoring case and padding', async () => {
      const ids = async (q: string) => (await history().searchSessions(q)).map((s) => s.sessionId);
      expect(await ids('  LOGIN ')).toEqual(['a']);
      expect(await ids('refactor')).toEqual(['b']);
      expect(await ids('repos/app')).toEqual(['b', 'a']);
      expect(await ids('notes')).toEqual(['c']);
    });

    test('an empty query finds nothing', async () => {
      expect(await history().searchSessions('   ')).toEqual([]);
    });

    test('stops at the limit', async () => {
      expect(await history().searchSessions('me', 1)).toHaveLength(1);
    });
  });
});

describe('homeShortPath', () => {
  test('shortens a Linux or macOS home and nothing else', () => {
    expect(homeShortPath('/home/me/repos/x')).toBe('~/repos/x');
    expect(homeShortPath('/Users/me/repos/x')).toBe('~/repos/x');
    expect(homeShortPath('/tmp/home/me/x')).toBe('/tmp/home/me/x');
    expect(homeShortPath('/root/x')).toBe('/root/x');
  });
});
