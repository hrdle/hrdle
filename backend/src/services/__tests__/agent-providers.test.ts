import { describe, expect, test } from 'bun:test';
import { threadSessionIdsOf, withThreadUsage } from '../agent-providers';

describe('the ids a thread service is asked for', () => {
  test('are the workspace\'s own and every pane\'s, once each', () => {
    const ids = threadSessionIdsOf('pi', [
      { agent: 'pi', agentSessionId: 'a', panes: [{ agent: 'pi', agentSessionId: 'a' }, { agent: 'pi', agentSessionId: 'b' }] },
      { agent: 'claude', agentSessionId: 'c', panes: [{ agent: 'claude', agentSessionId: 'c' }, { agent: 'pi', agentSessionId: 'd' }] },
    ]);
    expect(ids).toEqual(['a', 'b', 'd']);
  });
  test('fall back to the command when herdr names no agent', () => {
    expect(threadSessionIdsOf('codex', [{ currentCommand: 'codex', agentSessionId: 'x' }])).toEqual(['x']);
  });
});

describe('a pane\'s metrics with its thread\'s usage', () => {
  test('lay the thread over the pid-derived figures', () => {
    const merged = withThreadUsage({ memoryMB: 12 }, { sessionId: 'a', cwd: '/x', tokensUsed: 9, tokenUsage: { model: 'gpt-6-astra', contextPercent: 35.9, contextTokens: 101_141, contextMaxTokens: 272_000 } });
    expect(merged).toMatchObject({ memoryMB: 12, model: 'gpt-6-astra', contextPercent: 35.9 });
  });
  test('leave the figures alone with no thread', () => {
    expect(withThreadUsage({ memoryMB: 12 }, undefined)).toEqual({ memoryMB: 12 });
  });
});
