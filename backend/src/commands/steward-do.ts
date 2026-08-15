/**
 * `hrdle steward-do <verb> [target] [text]` - the only way the steward touches
 * a session. Two jobs.
 *
 * It points at the watched server, from the target file hrdle writes: inside
 * the observer's pane a bare `herdr agent list` returns the observer alone.
 *
 * And it is the boundary. The steward is a Claude session, so a prohibition in
 * a prompt can be broken; its permission config forbids raw `herdr` and allows
 * this, which has no verb for what it must not do.
 *
 * Actions are journalled as they run - `pane.agent_status_changed` carries no
 * cause, so this is the steward's only way to tell its doing from its owner's.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { herdrBinaryPath } from '../services/herdr-client';
import { stewardHomeDir, TARGET_FILE, type StewardTarget } from '../services/steward-runtime';

const JOURNAL_FILE = 'journal.jsonl';

export interface StewardDoCliOptions {
  stewardDoVerb?: string;
  stewardDoArgs?: string[];
}

/**
 * Verbs that reach a pane. Answering a permission prompt is the owner's call,
 * a shell pane has nobody in between, and Ctrl+C kills rather than interrupts -
 * so adding one here decides what the steward is allowed to be.
 */
export const ACTIONS = {
  /** Not reversible; when it is right belongs in the observer's prompt. */
  clear: { keys: null, text: '/clear' },
  say: { keys: null, text: null },
  stop: { keys: 'Escape', text: null },
} as const;

type ActionVerb = keyof typeof ACTIONS;

function isAction(verb: string): verb is ActionVerb {
  return verb in ACTIONS;
}

async function readTarget(): Promise<StewardTarget | null> {
  try {
    const raw = await readFile(join(stewardHomeDir(), TARGET_FILE), 'utf-8');
    return JSON.parse(raw) as StewardTarget;
  } catch {
    return null;
  }
}

interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function herdr(target: StewardTarget, args: string[]): Promise<CliResult> {
  const bin = herdrBinaryPath();
  if (!bin) return { ok: false, stdout: '', stderr: 'herdr is not installed' };

  // The pane's own socket is the steward's session, so the watched one is
  // stated rather than inherited.
  const proc = Bun.spawn([bin, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HERDR_SOCKET_PATH: target.socketPath },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { ok: (await proc.exited) === 0, stdout, stderr };
}

interface AgentRow {
  name?: string;
  pane_id?: string;
  agent_status?: string;
  cwd?: string;
  state_change_seq?: number;
  agent_session?: { value?: string };
  workspace_id?: string;
}

async function listAgents(target: StewardTarget): Promise<AgentRow[]> {
  const res = await herdr(target, ['agent', 'list']);
  if (!res.ok) return [];
  try {
    return (JSON.parse(res.stdout) as { result?: { agents?: AgentRow[] } }).result?.agents ?? [];
  } catch {
    return [];
  }
}

/** Only panes `agent list` returns are addressable, which is what keeps a shell
 *  pane out of reach. */
async function resolveAgent(target: StewardTarget, name: string): Promise<AgentRow | null> {
  const agents = await listAgents(target);
  return agents.find((a) => a.name === name || a.pane_id === name || a.workspace_id === name) ?? null;
}

async function journal(entry: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(stewardHomeDir(), { recursive: true });
    await appendFile(join(stewardHomeDir(), JOURNAL_FILE), `${JSON.stringify(entry)}\n`);
  } catch {
    // Losing one line costs an explanation for one transition, which is not
    // worth failing the action it was recording.
  }
}

function emit(value: unknown): void {
  console.log(JSON.stringify(value));
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export async function runStewardDo(options: StewardDoCliOptions): Promise<void> {
  const verb = options.stewardDoVerb;
  const args = options.stewardDoArgs ?? [];

  const target = await readTarget();
  if (!target) {
    fail(
      `no steward target at ${join(stewardHomeDir(), TARGET_FILE)}. ` +
        'The server writes it while the steward is enabled; this command is meant to run inside the steward session.',
    );
  }

  switch (verb) {
    case 'watch': {
      // `state_change_seq` is what a wake-up diffs against its last reading.
      const agents = await listAgents(target);
      emit({
        watching: target.session ?? 'default',
        agents: agents.map((a) => ({
          name: a.name,
          pane: a.pane_id,
          workspace: a.workspace_id,
          status: a.agent_status,
          cwd: a.cwd,
          seq: a.state_change_seq,
          agentSessionId: a.agent_session?.value,
        })),
      });
      return;
    }

    case 'read': {
      const name = args[0];
      if (!name) fail('usage: hrdle steward-do read <agent>');
      const agent = await resolveAgent(target, name);
      if (!agent?.name) fail(`no agent pane called ${name}`);
      const res = await herdr(target, ['agent', 'read', agent.name]);
      if (!res.ok) fail(res.stderr.trim() || 'read failed');
      // Terminal output, not JSON - a person reads this one too.
      console.log(res.stdout);
      return;
    }

    case 'clear':
    case 'say':
    case 'stop': {
      const name = args[0];
      if (!name) fail(`usage: hrdle steward-do ${verb} <agent>${verb === 'say' ? ' <text>' : ''}`);
      const agent = await resolveAgent(target, name);
      if (!agent?.name) fail(`no agent pane called ${name}`);

      if (!isAction(verb)) fail(`unknown verb ${verb}`);
      const action = ACTIONS[verb];

      let res: CliResult;
      let sent: string;
      if (action.keys) {
        sent = action.keys;
        res = await herdr(target, ['agent', 'send-keys', agent.name, action.keys]);
      } else {
        const text = action.text ?? args.slice(1).join(' ');
        if (!text) fail(`usage: hrdle steward-do ${verb} <agent> <text>`);
        sent = text;
        res = await herdr(target, ['agent', 'prompt', agent.name, text]);
      }

      await journal({
        at: new Date().toISOString(),
        verb,
        agent: agent.name,
        pane: agent.pane_id,
        workspace: agent.workspace_id,
        sent,
        ok: res.ok,
      });

      if (!res.ok) fail(res.stderr.trim() || `${verb} failed`);
      emit({ verb, agent: agent.name, pane: agent.pane_id, sent });
      return;
    }

    case 'journal': {
      const path = join(stewardHomeDir(), JOURNAL_FILE);
      try {
        const raw = await readFile(path, 'utf-8');
        const lines = raw.split('\n').filter(Boolean);
        const limit = Number(args[0]) || 20;
        console.log(lines.slice(-limit).join('\n'));
      } catch {
        console.log('');
      }
      return;
    }

    default:
      fail('usage: hrdle steward-do <watch|read|clear|say|stop|journal> [agent] [text]');
  }
}
