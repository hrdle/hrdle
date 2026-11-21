import { describe, expect, test } from 'bun:test';
import { generateAgentName, startAgent, waitForAgentReady, type Rpc } from '../agent-launch';
import { HerdrRpcError } from '../herdr-client';

function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function scriptedRpc(handler: (method: string, params: Record<string, unknown>, call: number) => unknown): {
  rpc: Rpc;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const rpc = (async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    const out = handler(method, params, calls.length);
    if (out instanceof Error) throw out;
    return out;
  }) as Rpc;
  return { rpc, calls };
}

describe('generateAgentName', () => {
  test('fits the name rule herdr enforces', () => {
    for (const kind of ['claude', 'codex', 'grok', 'kimi', 'opencode', 'pi'] as const) {
      expect(generateAgentName(kind)).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    }
  });
});

describe('startAgent', () => {
  test('sends kind, pane and a generated name, and returns the terminal', async () => {
    const { rpc, calls } = scriptedRpc(() => ({ agent: { terminal_id: 't1' } }));
    const started = await startAgent({ paneId: 'w1:p1', kind: 'claude', rpc });
    expect(started.terminalId).toBe('t1');
    expect(calls[0].method).toBe('agent.start');
    expect(calls[0].params).toMatchObject({ kind: 'claude', pane_id: 'w1:p1', name: started.name });
  });

  test('retries while the new pane is still busy with its rc files', async () => {
    const c = clock();
    const { rpc, calls } = scriptedRpc((_m, _p, n) =>
      n < 3 ? new HerdrRpcError('busy', 'agent_pane_busy') : { agent: { terminal_id: 't1' } },
    );
    await startAgent({ paneId: 'w1:p1', kind: 'codex', rpc, ...c });
    expect(calls).toHaveLength(3);
  });

  test('gives up on a busy pane after the busy window', async () => {
    const c = clock();
    const { rpc } = scriptedRpc(() => new HerdrRpcError('busy', 'agent_pane_busy'));
    await expect(startAgent({ paneId: 'w1:p1', kind: 'codex', busyWaitMs: 1000, rpc, ...c })).rejects.toThrow('busy');
  });

  test('does not retry other errors', async () => {
    const { rpc, calls } = scriptedRpc(() => new HerdrRpcError('nope', 'unsupported_agent_kind'));
    await expect(startAgent({ paneId: 'w1:p1', kind: 'pi', rpc })).rejects.toThrow('nope');
    expect(calls).toHaveLength(1);
  });
});

describe('waitForAgentReady', () => {
  const agent = { name: 'claude-0001', terminalId: 't1', kind: 'claude' as const };

  test('is ready only once herdr reports interactive_ready', async () => {
    const c = clock();
    const { rpc, calls } = scriptedRpc((_m, _p, n) => ({
      agent: {
        terminal_id: 't1',
        name: 'claude-0001',
        // An idle status alone is not readiness: herdr still has the launch pending.
        agent: n > 1 ? 'claude' : undefined,
        launch_pending: n < 4,
        interactive_ready: n >= 4,
      },
    }));
    expect(await waitForAgentReady(agent, { rpc, ...c })).toEqual({ ready: true });
    expect(calls).toHaveLength(4);
  });

  test('a launch that stops pending without becoming ready has exited', async () => {
    const { rpc } = scriptedRpc(() => ({
      agent: { terminal_id: 't1', name: 'claude-0001', launch_pending: false, interactive_ready: false },
    }));
    const r = await waitForAgentReady(agent, { rpc, ...clock() });
    expect(r.ready).toBe(false);
    expect(!r.ready && r.code).toBe('exited');
  });

  test('a name herdr has cleared means the launch failed', async () => {
    const { rpc } = scriptedRpc(() => new HerdrRpcError('gone', 'agent_not_found'));
    const r = await waitForAgentReady(agent, { rpc, ...clock() });
    expect(!r.ready && r.code).toBe('exited');
  });

  test('another agent detected in the pane is a kind mismatch', async () => {
    const { rpc } = scriptedRpc(() => ({
      agent: { terminal_id: 't1', name: 'claude-0001', agent: 'codex', launch_pending: true },
    }));
    const r = await waitForAgentReady(agent, { rpc, ...clock() });
    expect(!r.ready && r.code).toBe('kind_mismatch');
  });

  test('the name moving to another terminal is reported', async () => {
    const { rpc } = scriptedRpc(() => ({ agent: { terminal_id: 't9', name: 'claude-0001', launch_pending: true } }));
    const r = await waitForAgentReady(agent, { rpc, ...clock() });
    expect(!r.ready && r.code).toBe('name_lost');
  });

  test('times out while the launch stays pending', async () => {
    const { rpc } = scriptedRpc(() => ({ agent: { terminal_id: 't1', name: 'claude-0001', launch_pending: true } }));
    const r = await waitForAgentReady(agent, { rpc, timeoutMs: 1000, ...clock() });
    expect(!r.ready && r.code).toBe('timeout');
  });

  test('a transient socket error is polled through', async () => {
    const { rpc } = scriptedRpc((_m, _p, n) =>
      n === 1
        ? new Error('ECONNRESET')
        : { agent: { terminal_id: 't1', name: 'claude-0001', agent: 'claude', interactive_ready: true } },
    );
    expect(await waitForAgentReady(agent, { rpc, ...clock() })).toEqual({ ready: true });
  });
});
