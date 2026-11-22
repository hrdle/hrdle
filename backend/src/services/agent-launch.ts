/**
 * Starting an agent in a pane and knowing when it can take input.
 *
 * Readiness is herdr's call, not ours. `agent.start` puts the pane into a
 * managed launch and herdr flips `interactive_ready` only once at least three
 * seconds have passed, the expected agent kind is detected in the pane and its
 * state is idle or blocked (`reconcile_managed_agent_at` in herdr). A status of
 * `idle` on its own is not that: herdr's settle delay exists because the first
 * idle after launch comes before the TUI is drawn. This polls the same fields
 * herdr's own `herdr agent start` CLI waits on.
 *
 * Only agents started through `agent.start` ever become `interactive_ready`;
 * one typed into a shell never does, so this cannot judge those.
 */
import { randomBytes } from 'node:crypto';
import type { AgentProvider } from '../../../shared/types';
import { herdrRpc } from './herdr-client';

export type Rpc = <T>(method: string, params: Record<string, unknown>) => Promise<T>;

interface HerdrAgentInfo {
  terminal_id?: string;
  name?: string;
  agent?: string;
  launch_pending?: boolean;
  interactive_ready?: boolean;
  agent_status?: string;
}

export type AgentLaunchFailure =
  | 'start_failed'
  | 'exited'
  | 'kind_mismatch'
  | 'name_lost'
  | 'timeout';

export type AgentReadyResult =
  /**
   * `blocked`: the agent is up but asking something first (a folder trust
   * check, an update offer). A prompt typed then answers that question with
   * its Enter, so it is not sent.
   */
  | { ready: true; blocked: boolean }
  | { ready: false; code: AgentLaunchFailure; message: string };

export const DEFAULT_AGENT_START_TIMEOUT_MS = 30_000;

/** herdr's error code on a failed RPC (`HerdrRpcError.code`), read structurally. */
function herdrErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** herdr's rule: a lowercase letter, then lowercase letters, digits, `-` or `_`, 32 at most. */
export function generateAgentName(kind: AgentProvider): string {
  return `${kind}-${randomBytes(4).toString('hex')}`;
}

export interface StartedAgent {
  name: string;
  terminalId: string;
}

/**
 * `agent.start` into an existing shell pane. Returns as soon as herdr has
 * typed the command; readiness is `waitForAgentReady`.
 */
export async function startAgent(
  opts: {
    paneId: string;
    kind: AgentProvider;
    timeoutMs?: number;
    /** How long a pane that is not yet a bare shell is retried. */
    busyWaitMs?: number;
    rpc?: Rpc;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<StartedAgent> {
  const rpc = opts.rpc ?? herdrRpc;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // herdr only starts an agent in a pane whose foreground job is the shell
  // alone. A pane created a moment ago is still running its rc files, and any
  // command in them (a prompt plugin, direnv, compinit) makes it busy.
  const busyDeadline = now() + (opts.busyWaitMs ?? 10_000);
  let nameRetries = 0;
  for (;;) {
    const name = generateAgentName(opts.kind);
    try {
      const res = await rpc<{ agent?: HerdrAgentInfo }>('agent.start', {
        name,
        kind: opts.kind,
        pane_id: opts.paneId,
        timeout_ms: opts.timeoutMs ?? DEFAULT_AGENT_START_TIMEOUT_MS,
      });
      const terminalId = res?.agent?.terminal_id;
      if (!terminalId) throw new Error('herdr agent.start: response carried no terminal_id');
      return { name, terminalId };
    } catch (err) {
      const code = herdrErrorCode(err);
      // A generated name colliding is a few in four billion, but a retry is
      // cheaper than an explanation.
      if (code === 'agent_name_taken' && nameRetries++ < 2) continue;
      if (
        (code === 'agent_pane_busy' || code === 'agent_pane_unavailable') &&
        now() < busyDeadline
      ) {
        await sleep(250);
        continue;
      }
      throw err;
    }
  }
}

export async function waitForAgentReady(
  agent: StartedAgent & { kind: AgentProvider },
  opts: {
    timeoutMs?: number;
    pollMs?: number;
    rpc?: Rpc;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<AgentReadyResult> {
  const rpc = opts.rpc ?? herdrRpc;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 200;
  const deadline = now() + (opts.timeoutMs ?? DEFAULT_AGENT_START_TIMEOUT_MS);

  while (now() < deadline) {
    let info: HerdrAgentInfo | undefined;
    try {
      info = (await rpc<{ agent?: HerdrAgentInfo }>('agent.get', { target: agent.name }))?.agent;
    } catch (err) {
      // herdr clears the name when the launch fails or times out, so a name
      // that no longer resolves after the start succeeded is a failed launch.
      if (herdrErrorCode(err) === 'agent_not_found') {
        return { ready: false, code: 'exited', message: 'agent exited before becoming interactive' };
      }
      await sleep(pollMs);
      continue;
    }
    if (info) {
      if (info.terminal_id !== agent.terminalId || info.name !== agent.name) {
        return { ready: false, code: 'name_lost', message: `agent ${agent.name} no longer owns its pane` };
      }
      if (info.agent && info.agent !== agent.kind) {
        return { ready: false, code: 'kind_mismatch', message: `expected ${agent.kind}, detected ${info.agent}` };
      }
      // herdr leaves an agent that came up asking something (codex's update
      // offer) launch-pending until someone answers, so waiting for
      // `interactive_ready` there only runs the clock out.
      if (info.agent === agent.kind && info.agent_status === 'blocked') return { ready: true, blocked: true };
      if (info.interactive_ready) return { ready: true, blocked: false };
      if (!info.launch_pending) {
        return { ready: false, code: 'exited', message: 'agent exited before becoming interactive' };
      }
    }
    await sleep(pollMs);
  }
  return { ready: false, code: 'timeout', message: 'timed out waiting for the agent to accept input' };
}

/** Submit a prompt the way herdr does it, honouring the pane's live bracketed-paste mode. */
export async function promptAgent(name: string, text: string, rpc: Rpc = herdrRpc): Promise<void> {
  await rpc('agent.prompt', { target: name, text });
}
