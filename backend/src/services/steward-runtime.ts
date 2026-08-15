/**
 * Starting the steward, keeping it up, and waking it.
 *
 * Its own herdr session is what makes it invisible to itself: it watches the
 * default server's `agent list` and is not on that server, so there is no
 * exclusion list to maintain. Two servers are therefore in play - the steward's
 * own, reached by the herdr CLI with an explicit `--session` because this
 * process resolves only one socket, and the watched one, which is that socket
 * and so reachable through `herdrRpc`.
 *
 * A Claude Code session does not run on its own (turns end; a bash poll loop
 * accumulates context every tick), so the loop lives here.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { addAgentStatusListener } from './herdr-agent-status';
import { herdrBinaryPath, herdrRpc, herdrSessionName, herdrSocketPath } from './herdr-client';
import { getStewardSettings, isStewardEnabled } from './steward-config';
import { stewardPrompt } from './steward-prompt';
import { pruneToSessions } from './steward-store';
import { broadcastSteward } from '../routes/terminal-mux';
import { atomicWriteFile, getDataDir } from '../utils/storage';
import { IDENTITY } from '../../../shared/identity';

const OBSERVER = 'observer';

/** Derived from ours: a fixed name would put a dev build's steward in the same
 *  session as the installed one, and two hrdles would drive one observer. */
export function stewardSessionName(): string {
  const base = herdrSessionName();
  return base ? `${base}-steward` : 'steward';
}

/** Where the observer runs, and where its own notes live. */
export function stewardHomeDir(): string {
  return join(getDataDir(), 'steward');
}

/**
 * What the observer should be looking at, written where its tools can read it.
 *
 * herdr exports `HERDR_SOCKET_PATH` into every pane, so a bare `herdr agent
 * list` inside the observer's pane enumerates the observer and nothing else
 * (measured). Pointing the workspace at the default socket instead is worse:
 * the agent integration hook then reports the observer's pane id to the very
 * server it is watching.
 */
export const TARGET_FILE = 'target.json';

export interface StewardTarget {
  /** The herdr server the steward observes - the default one, i.e. the user's. */
  socketPath: string;
  session: string | null;
  /** Where `hrdle steward` should deliver, so the observer never passes `-p`. */
  port: number;
}

async function writeHome(port: number): Promise<void> {
  const target: StewardTarget = {
    socketPath: herdrSocketPath(),
    session: herdrSessionName(),
    port,
  };
  await mkdir(stewardHomeDir(), { recursive: true });
  await atomicWriteFile(join(stewardHomeDir(), TARGET_FILE), JSON.stringify(target, null, 2));
  // The prompt ships with the code it describes, so it is rewritten rather
  // than left to drift. An edit made in place does not survive.
  await atomicWriteFile(join(stewardHomeDir(), 'CLAUDE.md'), await stewardPrompt());
}

const SUPERVISE_INTERVAL_MS = 30_000;
/** Transitions arrive in bursts and each wake-up costs the observer a re-read
 *  of its context, so a burst has to collapse into one. */
const WAKE_DEBOUNCE_MS = 3_000;

let superviseTimer: ReturnType<typeof setInterval> | null = null;
/** This server's port, so a wake-up can rebuild the observer before delivering. */
let runtimePort: number | null = null;
let removeStatusListener: (() => void) | null = null;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingReasons = new Set<string>();
let starting = false;
/** Set after a failed start, so a broken setup is not retried every 30s. */
let backoffUntil = 0;

interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function herdrCli(args: string[], timeoutMs = 15_000): Promise<CliResult> {
  const bin = herdrBinaryPath();
  if (!bin) return { ok: false, stdout: '', stderr: 'herdr is not installed' };

  // The inherited socket points at the server we watch, and it wins over
  // `--session` inside herdr itself - so it has to go, or every command here
  // lands on the user's own session.
  const { HERDR_SOCKET_PATH: _dropped, HERDR_SESSION: _also, ...env } = process.env;

  const proc = Bun.spawn([bin, '--session', stewardSessionName(), ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });

  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { ok: code === 0, stdout, stderr };
  } catch (err) {
    return { ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** herdr answers one JSON object per CLI call; anything else is a failure. */
function parseResult<T>(res: CliResult): T | null {
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout) as { result?: T };
    return parsed.result ?? null;
  } catch {
    return null;
  }
}

interface AgentRow {
  name?: string;
  agent_status?: string;
  pane_id?: string;
}

interface PaneRow {
  pane_id?: string;
}

/** `herdr status server` exits 0 either way, so the exit code alone reports
 *  every session as running and the next command fails with server_not_running. */
async function serverIsUp(): Promise<boolean> {
  const res = await herdrCli(['status', 'server', '--json'], 5_000);
  if (!res.ok) return false;
  try {
    return (JSON.parse(res.stdout) as { running?: boolean }).running === true;
  } catch {
    return false;
  }
}

async function startServer(): Promise<boolean> {
  const bin = herdrBinaryPath();
  if (!bin) return false;

  const { HERDR_SOCKET_PATH: _dropped, HERDR_SESSION: _also, ...env } = process.env;
  Bun.spawn([bin, '--session', stewardSessionName(), 'server'], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    env,
  }).unref();

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await serverIsUp()) return true;
  }
  return false;
}

async function findObserver(): Promise<AgentRow | null> {
  const result = parseResult<{ agents?: AgentRow[] }>(await herdrCli(['agent', 'list']));
  return result?.agents?.find((a) => a.name === OBSERVER) ?? null;
}

async function ensureWorkspace(): Promise<string | null> {
  const panes = parseResult<{ panes?: PaneRow[] }>(await herdrCli(['pane', 'list']));
  const existing = panes?.panes?.[0]?.pane_id;
  if (existing) return existing;

  const home = stewardHomeDir();
  await mkdir(home, { recursive: true });
  // The data directory has to be stated: `hrdle steward-do` inside the pane
  // reads the target file from it, and a dev server's observer would otherwise
  // resolve the installed server's directory and drive the wrong machine.
  // Only this one variable - pointing the workspace at another herdr socket
  // would make the agent hook report this pane to the watched server.
  const created = await herdrCli([
    'workspace',
    'create',
    '--cwd',
    home,
    '--label',
    OBSERVER,
    '--no-focus',
    '--env',
    `${IDENTITY.dataDirEnv}=${getDataDir()}`,
  ]);
  if (!created.ok) {
    console.error(`[steward] could not create the observer workspace: ${created.stderr.trim()}`);
    return null;
  }
  const after = parseResult<{ panes?: PaneRow[] }>(await herdrCli(['pane', 'list']));
  return after?.panes?.[0]?.pane_id ?? null;
}

/**
 * Forget what the steward wrote about workspaces that no longer exist.
 *
 * Driven off the live set rather than a delete event, because a workspace can
 * also go away while this server is down. Reads the *watched* server, which is
 * the default socket - the one `herdrRpc` already resolves.
 */
async function pruneDeadSessions(): Promise<void> {
  try {
    const result = await herdrRpc<{ workspaces?: { workspace_id?: string }[] }>('workspace.list', {});
    const live = (result.workspaces ?? []).map((w) => w.workspace_id).filter((id): id is string => !!id);
    // An empty answer is more likely a bad read than every workspace vanishing,
    // and acting on it would erase the whole store.
    if (live.length === 0) return;
    for (const id of await pruneToSessions(live)) {
      broadcastSteward({ type: 'steward-session-removed', sessionId: id });
    }
  } catch {
    // The watched server is unreachable; the next tick tries again.
  }
}

/** Each step checks before it acts, so this is both the start-up path and the
 *  supervisor tick. */
export async function ensureSteward(port: number): Promise<boolean> {
  if (!isStewardEnabled()) return false;
  if (starting) return false;
  if (Date.now() < backoffUntil) return false;

  starting = true;
  try {
    if (!herdrBinaryPath()) return false;
    // Rewritten every tick: the port and the watched socket are this server's,
    // and a stale file would send the observer at the wrong one after a restart
    // on a different port.
    await writeHome(port);

    if (!(await serverIsUp()) && !(await startServer())) {
      console.error('[steward] could not start its herdr session');
      backoffUntil = Date.now() + 5 * 60_000;
      return false;
    }

    if (await findObserver()) return true;

    const paneId = await ensureWorkspace();
    if (!paneId) {
      backoffUntil = Date.now() + 5 * 60_000;
      return false;
    }

    const { observerModel } = await getStewardSettings();
    const started = await herdrCli([
      'agent',
      'start',
      OBSERVER,
      '--kind',
      'claude',
      '--pane',
      paneId,
      '--',
      '--model',
      observerModel,
    ]);
    if (!started.ok) {
      console.error(`[steward] could not start the observer: ${started.stderr.trim()}`);
      backoffUntil = Date.now() + 5 * 60_000;
      return false;
    }
    console.log(`[steward] observer started in session ${stewardSessionName()} (${observerModel})`);
    return true;
  } finally {
    starting = false;
  }
}

/**
 * Wake the observer, collapsing a burst of reasons into one prompt.
 *
 * Measured on herdr 0.8.0: a prompt sent while the agent is working is queued
 * and runs when that turn ends. It is dropped when the pane shows a modal (the
 * text sits in the input field unsubmitted), which is one more reason the
 * observer must never be in a position to be asked for permission.
 */
export function wakeObserver(reason: string): void {
  if (!isStewardEnabled()) return;
  pendingReasons.add(reason);
  if (wakeTimer) return;

  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    const reasons = [...pendingReasons];
    pendingReasons = new Set();
    void deliver(`Something changed: ${reasons.join('; ')}. Enumerate what moved and decide what to do.`);
  }, WAKE_DEBOUNCE_MS);
}

/** A human's answer travels this way rather than through something the observer
 *  has to call: waking and delivering are one act, so there is nothing to poll. */
export function wakeObserverWith(text: string): void {
  if (!isStewardEnabled()) return;
  void deliver(text);
}

async function deliver(text: string): Promise<void> {
  if (!(await findObserver())) {
    // Rebuild now rather than waiting for the tick. Waking IS the delivery, so
    // a wake-up dropped here is an answer the owner gave and nobody ever reads
    // - which is what happened after a herdr restart: the workspace came back
    // and the agent did not, and the reply that arrived in between was lost.
    if (runtimePort === null) return;
    if (!(await ensureSteward(runtimePort))) return;
    if (!(await findObserver())) return;
  }
  const res = await herdrCli(['agent', 'prompt', OBSERVER, text]);
  if (!res.ok) console.error(`[steward] wake failed: ${res.stderr.trim()}`);
}

export function startStewardRuntime(port: number): void {
  if (!isStewardEnabled()) return;
  if (superviseTimer) return;

  runtimePort = port;

  void ensureSteward(port);
  superviseTimer = setInterval(() => {
    void ensureSteward(port);
    void pruneDeadSessions();
  }, SUPERVISE_INTERVAL_MS);
  superviseTimer.unref?.();

  // Its own listener rather than riding the session push: that one stops when
  // the last browser disconnects, and an unwatched machine is exactly when the
  // steward has to keep working.
  removeStatusListener = addAgentStatusListener(() => wakeObserver('a pane changed state'));
}

export function stopStewardRuntime(): void {
  if (superviseTimer) clearInterval(superviseTimer);
  if (wakeTimer) clearTimeout(wakeTimer);
  removeStatusListener?.();
  removeStatusListener = null;
  superviseTimer = null;
  wakeTimer = null;
  runtimePort = null;
  pendingReasons = new Set();
  backoffUntil = 0;
}
