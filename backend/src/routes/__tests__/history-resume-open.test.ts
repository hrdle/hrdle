import { describe, expect, test } from 'bun:test';
import { findWorkspaceRunningConversation } from '../session-history';

describe('findWorkspaceRunningConversation', () => {
  const sessions = [
    { id: 'w1', agentSessionId: 'aaa' },
    { id: 'w2', panes: [{ agentSessionId: 'bbb' }, { agentSessionId: 'ccc' }] },
    { id: 'w3' },
  ];

  test('finds the workspace whose own agent runs the conversation', () => {
    expect(findWorkspaceRunningConversation(sessions, 'aaa')?.id).toBe('w1');
  });

  test('finds it through any pane, not only the first', () => {
    expect(findWorkspaceRunningConversation(sessions, 'ccc')?.id).toBe('w2');
  });

  test('a conversation open nowhere finds nothing', () => {
    expect(findWorkspaceRunningConversation(sessions, 'zzz')).toBeUndefined();
  });
});
