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

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { addAgentStatusListener } from './herdr-agent-status';
import { herdrBinaryPath, herdrRpc, herdrSessionName, herdrSocketPath } from './herdr-client';
import { getStewardSettings, isStewardEnabled } from './steward-config';
import { stewardPrompt } from './steward-prompt';
import { stewardHomeDir, TARGET_FILE, type StewardTarget } from './steward-paths';
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
  workspace_id?: string;
}

interface WorkspaceRow {
  workspace_id?: string;
  label?: string;
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

/**
 * Whether the steward is thinking, for a screen that has just been spoken to.
 *
 * Somebody who has said something and sees nothing cannot tell "it is working"
 * from "it did not arrive" - and the wake-up is asynchronous by design, so
 * there is nothing else on screen to say which.
 *
 * Cached briefly because answering costs a herdr CLI spawn, and the caller
 * polls while it waits.
 */
let statusCache: { at: number; value: StewardObserverStatus } | null = null;
const STATUS_TTL_MS = 1_500;

export interface StewardObserverStatus {
  present: boolean;
  /** herdr's own word: idle, working, blocked, done, unknown. */
  status?: string;
}

export async function observerStatus(): Promise<StewardObserverStatus> {
  if (!isStewardEnabled()) return { present: false };
  if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;

  const observer = await findObserver();
  const value: StewardObserverStatus = observer
    ? { present: true, status: observer.agent_status }
    : { present: false };
  statusCache = { at: Date.now(), value };
  return value;
}

async function ensureWorkspace(): Promise<string | null> {
  // Matched by the workspace we labelled, not by "the first pane in the
  // session": anything a person opens in here would otherwise become the
  // observer's pane.
  const ours = parseResult<{ workspaces?: WorkspaceRow[] }>(await herdrCli(['workspace', 'list']))
    ?.workspaces?.find((w) => w.label === OBSERVER);
  if (ours?.workspace_id) {
    const panes = parseResult<{ panes?: PaneRow[] }>(await herdrCli(['pane', 'list']));
    const existing = panes?.panes?.find((p) => p.workspace_id === ours.workspace_id)?.pane_id;
    if (existing) return existing;
  }

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
  const after = parseResult<{ workspaces?: WorkspaceRow[] }>(await herdrCli(['workspace', 'list']))
    ?.workspaces?.find((w) => w.label === OBSERVER);
  if (!after?.workspace_id) return null;
  const panes = parseResult<{ panes?: PaneRow[] }>(await herdrCli(['pane', 'list']));
  return panes?.panes?.find((p) => p.workspace_id === after.workspace_id)?.pane_id ?? null;
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

/**
 * What the owner sent straight to a pane, as far as we can know it.
 *
 * The steward learns about a pane from `pane.agent_status_changed`, which says
 * that something moved and never what was said. That is fine for an agent
 * working on its own and wrong for the one case a person cares about: they
 * typed into the pane themselves, and the steward's next reading of it is three
 * seconds later, by which time the agent has redrawn and the question is gone -
 * so it reports the answer to a question it never saw.
 *
 * Two shapes, because the two are worth different amounts:
 *
 * - **A bracketed paste is a whole message.** It is what the input bar sends
 *   (`bracketedPaste(value)`) and what `hrdle send --submit` sends, so the text
 *   is exact and goes through verbatim. No reconstruction, no guessing.
 * - **A bare Enter is only a moment.** Reconstructing what was typed from the
 *   key stream would mean re-implementing the TUI's own line editing -
 *   backspace, history recall, IME composition - and a transcript that is
 *   wrong sometimes is worse than none, because the steward relays it. So this
 *   carries no text: it names the pane and says to read it now.
 */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** Long enough for anything a person types, short enough that pasting a log
 *  does not become the wake-up. */
const SPOKEN_MAX = 2000;

/** One "they are typing" wake per pane per minute. Its whole job is to point at
 *  a pane sooner than the status watcher would; firing on every line turns the
 *  observer's day into reading a shell being used. */
const TYPED_NOTE_MS = 60_000;
const lastTypedNote = new Map<string, number>();

/** What a chunk of pane input amounts to, before anything is done about it.
 *  Pure, so the parsing is testable without waking anybody. */
export type OwnerInput =
  | { kind: 'sent'; text: string }
  | { kind: 'typed' }
  | null;

export function readOwnerInput(data: Buffer): OwnerInput {
  const text = data.toString('utf8');

  const start = text.indexOf(PASTE_START);
  if (start !== -1) {
    const from = start + PASTE_START.length;
    const end = text.indexOf(PASTE_END, from);
    const sent = (end === -1 ? text.slice(from) : text.slice(from, end)).trim();
    return sent ? { kind: 'sent', text: sent.slice(0, SPOKEN_MAX) } : null;
  }

  // A submit, and nothing about what was submitted.
  return text.endsWith('\r') || text.endsWith('\n') ? { kind: 'typed' } : null;
}

export function noteOwnerInput(sessionId: string, paneId: string, data: Buffer): void {
  if (!isStewardEnabled()) return;
  const input = readOwnerInput(data);
  if (!input) return;
  const target = `${sessionId}:${paneId}`;

  if (input.kind === 'sent') {
    lastTypedNote.set(target, Date.now());
    wakeObserverWith(
      `The owner sent this straight to ${target}, bypassing you: "${input.text}"\n` +
        'You were not asked, so do not answer it - read that pane when it settles and write what came of it.',
    );
    return;
  }

  const now = Date.now();
  if (now - (lastTypedNote.get(target) ?? 0) < TYPED_NOTE_MS) return;
  lastTypedNote.set(target, now);
  wakeObserver(
    `the owner typed something into ${target} and submitted it - read that pane now, ` +
      'before the agent redraws over what they asked',
  );
}

/**
 * Wake-ups that had nowhere to go, replayed on the next successful start.
 *
 * Rebuilding on demand is not enough on its own: `ensureSteward` also declines
 * while another rebuild is in flight or during a failure backoff, and a person
 * answering inside one of those windows would be dropped with only the thread
 * to recover it - at the *next* wake, which on a quiet machine never comes.
 */
const undelivered: string[] = [];
const UNDELIVERED_MAX = 20;

async function deliver(text: string): Promise<void> {
  if (!(await findObserver())) {
    // Waking IS the delivery, so a wake-up dropped here is an answer the owner
    // gave and nobody reads - what happened after a herdr restart, which brings
    // the workspace back without its agent.
    if (runtimePort === null || !(await ensureSteward(runtimePort)) || !(await findObserver())) {
      undelivered.push(text);
      if (undelivered.length > UNDELIVERED_MAX) undelivered.shift();
      return;
    }
  }

  for (const held of undelivered.splice(0)) await send(held);
  await send(text);
}

/** Held wake-ups, once there is somewhere to put them. Called from the tick so
 *  a reply given during a rebuild does not wait for the next thing to happen. */
async function flushUndelivered(): Promise<void> {
  if (undelivered.length === 0) return;
  if (!(await findObserver())) return;
  for (const held of undelivered.splice(0)) await send(held);
}

async function send(text: string): Promise<void> {
  const res = await herdrCli(['agent', 'prompt', OBSERVER, text]);
  if (res.ok) return;

  // Held rather than logged and forgotten. An observer that exists can still
  // refuse a prompt - a transient CLI failure, or the measured case of a pane
  // showing a modal - and the text is an answer somebody gave.
  console.error(`[steward] wake failed, holding for the next tick: ${res.stderr.trim()}`);
  undelivered.push(text);
  if (undelivered.length > UNDELIVERED_MAX) undelivered.shift();
}

export function startStewardRuntime(port: number): void {
  if (!isStewardEnabled()) {
    // `steward-do` reads the target file and asks no server whether it should
    // exist - deliberately, so control survives hrdle being down. A file left
    // behind by an earlier run therefore keeps working after the gate is turned
    // off, and this is the only place that can clear it.
    void rm(join(stewardHomeDir(), TARGET_FILE), { force: true }).catch(() => undefined);
    return;
  }
  if (superviseTimer) return;

  runtimePort = port;

  void ensureSteward(port);
  superviseTimer = setInterval(() => {
    void ensureSteward(port).then(flushUndelivered);
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
  undelivered.length = 0;
  backoffUntil = 0;
}
