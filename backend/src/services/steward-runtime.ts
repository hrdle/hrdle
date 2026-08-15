/**
 * Starting the steward, keeping it up, and waking it.
 *
 * The steward lives in its own herdr session, which is what makes it invisible
 * to itself: it watches the default server's `agent list`, and it is not on
 * that server, so there is no exclusion list to write and keep correct.
 *
 * That separation is also why nothing here goes through `herdrRpc` - this
 * process resolves exactly one socket, and it is the wrong one. Reaching the
 * steward's session means the herdr CLI with an explicit `--session`.
 *
 * A Claude Code session does not run on its own: turns end, and a polling loop
 * in bash would pile context up on every tick. So the loop lives here - hrdle
 * already watches herdr's events, and wakes the observer when something moved.
 * Between events this costs nothing.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { addAgentStatusListener } from './herdr-agent-status';
import { herdrBinaryPath, herdrSessionName } from './herdr-client';
import { getStewardSettings, isStewardEnabled } from './steward-config';
import { getDataDir } from '../utils/storage';

const OBSERVER = 'observer';

/**
 * The steward's session name, derived from ours.
 *
 * A dev build runs against its own named server, and a fixed name here would
 * put its steward in the same session as the installed one - two hrdles
 * driving one observer.
 */
export function stewardSessionName(): string {
  const base = herdrSessionName();
  return base ? `${base}-steward` : 'steward';
}

/** Where the observer runs, and where its own notes live. */
export function stewardHomeDir(): string {
  return join(getDataDir(), 'steward');
}

const SUPERVISE_INTERVAL_MS = 30_000;
/**
 * Pane transitions arrive in bursts - one agent finishing a turn moves several
 * panes - and each wake-up costs the observer a re-read of its own context.
 * Collapsing a burst into one wake-up is the difference between the observer
 * being cheap and being the most expensive thing running.
 */
const WAKE_DEBOUNCE_MS = 3_000;

let superviseTimer: ReturnType<typeof setInterval> | null = null;
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

/**
 * `herdr status server` exits 0 whether or not the server is up - a missing one
 * is "status: not_running" on stdout, not a failure - so the exit code alone
 * reports every session as running and the first real command then fails with
 * `server_not_running`.
 */
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
  const created = await herdrCli(['workspace', 'create', '--cwd', home, '--label', OBSERVER, '--no-focus']);
  if (!created.ok) {
    console.error(`[steward] could not create the observer workspace: ${created.stderr.trim()}`);
    return null;
  }
  const after = parseResult<{ panes?: PaneRow[] }>(await herdrCli(['pane', 'list']));
  return after?.panes?.[0]?.pane_id ?? null;
}

/**
 * Bring the session, the workspace and the observer up to where they should be.
 *
 * Written to be run repeatedly: each step checks before it acts, so this is
 * both the start-up path and the supervisor tick.
 */
export async function ensureSteward(): Promise<boolean> {
  if (!isStewardEnabled()) return false;
  if (starting) return false;
  if (Date.now() < backoffUntil) return false;

  starting = true;
  try {
    if (!herdrBinaryPath()) return false;

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
 * Measured on herdr 0.8.0: a prompt submitted while the agent is working is
 * queued and runs when that turn finishes, so a wake-up arriving mid-turn is
 * not lost. It is dropped, though, when the pane is showing a modal - the text
 * lands in the input field unsubmitted - which is one more reason the observer
 * must never be in a position to be asked for permission.
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

/**
 * Wake the observer with a message that is the point of waking it.
 *
 * A human's answer travels this way rather than through a tool the observer
 * has to call: waking it and delivering the answer are the same act, so there
 * is nothing to poll and nothing to miss.
 */
export function wakeObserverWith(text: string): void {
  if (!isStewardEnabled()) return;
  void deliver(text);
}

async function deliver(text: string): Promise<void> {
  const observer = await findObserver();
  if (!observer) {
    // Nothing to wake. The supervisor tick will notice and rebuild it.
    void ensureSteward();
    return;
  }
  const res = await herdrCli(['agent', 'prompt', OBSERVER, text]);
  if (!res.ok) console.error(`[steward] wake failed: ${res.stderr.trim()}`);
}

export function startStewardRuntime(): void {
  if (!isStewardEnabled()) return;
  if (superviseTimer) return;

  void ensureSteward();
  superviseTimer = setInterval(() => void ensureSteward(), SUPERVISE_INTERVAL_MS);
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
  pendingReasons = new Set();
  backoffUntil = 0;
}
