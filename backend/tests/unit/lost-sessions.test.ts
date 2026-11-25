import { describe, expect, test } from 'bun:test';
import { liveSessionMatcher } from '../../src/services/session-list';

describe('liveSessionMatcher', () => {
  const live = [
    {
      id: 'w5Q',
      currentPath: '/repo',
      agentSessionId: 'aaaa',
      panes: [{ agentSessionId: 'aaaa' }, { agentSessionId: 'bbbb' }],
    },
  ];
  const stillHere = liveSessionMatcher(live);

  test('a workspace that is still open is not lost', () => {
    expect(stillHere({ id: 'w5Q', currentPath: '/elsewhere' })).toBe(true);
  });

  test('a conversation running in any pane is not lost, under any workspace id', () => {
    expect(stillHere({ id: 'w9Z', currentPath: '/repo', agentSessionId: 'bbbb' })).toBe(true);
  });

  test('another session in the same directory does not hide one that is gone', () => {
    expect(stillHere({ id: 'w9Z', currentPath: '/repo', agentSessionId: 'cccc' })).toBe(false);
  });

  test('a session that never had a conversation id falls back to its directory', () => {
    expect(stillHere({ id: 'w9Z', currentPath: '/repo' })).toBe(true);
    expect(stillHere({ id: 'w9Z', currentPath: '/other' })).toBe(false);
  });
});
