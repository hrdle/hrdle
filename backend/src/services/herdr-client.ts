/**
 * Low-level herdr socket API client.
 *
 * herdr (https://herdr.dev) speaks newline-delimited JSON over a Unix socket.
 * The server closes the connection after each response, so `herdrRpc` opens
 * one connection per request. `events.subscribe` is the exception: the
 * connection is held open and later lines are pushed events.
 *
 * Pane id mapping: CC Hub's wire protocol and frontend validate pane ids as
 * tmux-style `%N` (PaneIdSchema). herdr ids are `w<K>:p<N>` with `N` unique
 * within a workspace, so `%N ↔ <workspaceId>:pN` is a lossless mapping as
 * long as one CC Hub session maps to one herdr workspace.
 */

import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Name of the herdr session to run against, or null for the default one.
 *
 * A named session is a separate herdr server with its own socket, workspaces
 * and persisted state, which is how two builds of this app share a machine
 * without seeing each other's panes (#459).
 */
export function herdrSessionName(): string | null {
  return process.env.HERDR_SESSION || null;
}

export function herdrSocketPath(): string {
  // HERDR_SESSION is checked first, and this order matters: herdr exports
  // HERDR_SOCKET_PATH into every pane it runs (alongside HERDR_PANE_ID and
  // friends), so a copy of this app launched from a terminal inside another
  // copy inherits a socket nobody chose. Letting that win would silently attach
  // the two to the same herdr server — the collision named sessions exist to
  // prevent, reached by the one route where it looks like it is working.
  const session = herdrSessionName();
  // Verified against herdr 0.7.4: `herdr --session <name> server` reports this
  // path, and `herdr session list --json` returns it as `socket_path`. Reading
  // it from the CLI would be sturdier, but this is called once per RPC
  // connection — and it has to answer before the session exists, which is
  // exactly when it is not in that listing.
  if (session) {
    return `${homedir()}/.config/herdr/sessions/${session}/herdr.sock`;
  }

  // No session named: an inherited or explicit socket is all we have to go on.
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;

  return `${homedir()}/.config/herdr/herdr.sock`;
}

/**
 * Environment for herdr CLI children, pinned to the socket this process
 * resolved.
 *
 * Inheritance is not enough. A child run from a systemd unit has no ambient
 * HERDR_SOCKET_PATH and would fall back to the default socket, so a server
 * addressed by HERDR_SESSION would end up driving panes in somebody else's
 * session. Saying it outright leaves nothing to infer.
 */
export function herdrChildEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    HERDR_SOCKET_PATH: herdrSocketPath(),
  };
}

let cachedHerdrBinary: string | null | undefined;

/**
 * Absolute path to the herdr binary, or null when it isn't installed.
 *
 * PATH alone isn't enough: herdr's install script drops the binary in
 * `~/.local/bin`, which systemd (`zsh -lc` never sources .zshrc) and launchd
 * leave out of PATH — so a service that works interactively fails at boot.
 * Spawns must use the resolved absolute path, not the bare name.
 */
export function herdrBinaryPath(): string | null {
  if (cachedHerdrBinary !== undefined) return cachedHerdrBinary;

  const override = process.env.HERDR_BIN;
  if (override && existsSync(override)) {
    cachedHerdrBinary = override;
    return cachedHerdrBinary;
  }

  const which = Bun.spawnSync(['which', 'herdr']);
  if (which.exitCode === 0) {
    const resolved = which.stdout.toString().trim();
    if (resolved) {
      cachedHerdrBinary = resolved;
      return cachedHerdrBinary;
    }
  }

  const candidates = [
    join(homedir(), '.local', 'bin', 'herdr'), // install.sh
    '/opt/homebrew/bin/herdr', // brew (Apple Silicon)
    '/usr/local/bin/herdr', // brew (Intel) / manual
    '/usr/bin/herdr', // distro package
  ];
  cachedHerdrBinary = candidates.find((p) => existsSync(p)) ?? null;
  return cachedHerdrBinary;
}

/** Resolved herdr path, falling back to the bare name so spawns still error usefully. */
export function herdrBin(): string {
  return herdrBinaryPath() ?? 'herdr';
}

export interface HerdrScroll {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
}

/**
 * herdr's AgentStatus enum (protocol 16, `herdr api schema`). Kept as a union
 * of known values plus `string`: herdr may add states, and an unknown one must
 * fall through to the caller's default rather than be mapped to a wrong state.
 */
export type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown' | (string & {});

export interface HerdrPane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  terminal_id: string;
  cwd: string;
  foreground_cwd?: string;
  focused: boolean;
  agent_status: HerdrAgentStatus;
  revision: number;
  /** Absent on herdr servers older than protocol 16 (< v0.7.3). */
  scroll?: HerdrScroll;
  /** Name the user gave the pane (`herdr pane rename`). Absent until they do,
   *  which is why nothing may show it as a fallback for the pane id. */
  label?: string;
}

export interface HerdrWorkspace {
  workspace_id: string;
  label: string;
  number: number;
  focused: boolean;
  active_tab_id?: string;
  agent_status?: string;
  pane_count?: number;
  tab_count?: number;
}

export interface HerdrTab {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count?: number;
  agent_status?: HerdrAgentStatus;
}

const RPC_TIMEOUT_MS = 10_000;
let reqCounter = 0;

/**
 * Incremental NDJSON line splitter with correct UTF-8 handling: raw socket
 * chunks are decoded with a streaming TextDecoder, so a multi-byte character
 * split across TCP chunks survives intact (naive per-chunk toString('utf-8')
 * turns it into replacement characters — visible as mojibake in Japanese
 * pane content).
 */
export function createNdjsonReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  const decoder = new TextDecoder();
  let buf = '';
  return (chunk: Buffer) => {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
      nl = buf.indexOf('\n');
    }
  };
}

export async function herdrRpc<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const sock = connect(herdrSocketPath());
    const id = `cchub_${++reqCounter}`;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      sock.destroy();
      settle(() => reject(new Error(`herdr rpc timeout: ${method}`)));
    }, RPC_TIMEOUT_MS);
    const readLine = createNdjsonReader((line) => {
      sock.end();
      try {
        const msg = JSON.parse(line) as {
          result?: T;
          error?: { code?: string; message?: string };
        };
        if (msg.error) {
          settle(() =>
            reject(new Error(`herdr ${method}: ${msg.error?.message ?? msg.error?.code ?? 'error'}`)),
          );
        } else {
          settle(() => resolve(msg.result as T));
        }
      } catch (err) {
        settle(() => reject(err as Error));
      }
    });
    sock.on('connect', () => {
      sock.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    sock.on('data', readLine);
    sock.on('error', (err: Error) => {
      settle(() => reject(err));
    });
    // A connection that closes before delivering a complete response line
    // must fail fast — without this, callers hang for the full RPC timeout
    // whenever herdr shuts down mid-request.
    sock.on('close', () => {
      settle(() => reject(new Error(`herdr connection closed before response: ${method}`)));
    });
  });
}

/**
 * Subscribe to herdr push events. Returns an unsubscribe function.
 * The first response line is the subscription ack; later lines are events.
 * `onClose` fires once if the connection drops (herdr restart etc.) or if
 * the subscription itself is rejected — a failed subscribe must not be
 * mistaken for a healthy silent stream.
 */
export function herdrSubscribe(
  subscriptions: Array<Record<string, unknown>>,
  onEvent: (ev: Record<string, unknown>) => void,
  onClose: () => void,
): () => void {
  const sock = connect(herdrSocketPath());
  let acked = false;
  let stopped = false;
  const emitClose = () => {
    if (!stopped) {
      stopped = true;
      onClose();
    }
  };
  const readLine = createNdjsonReader((line) => {
    try {
      const msg = JSON.parse(line) as { error?: { code?: string; message?: string } } & Record<
        string,
        unknown
      >;
      if (!acked) {
        acked = true;
        if (msg.error) {
          console.error(
            `[herdr-client] events.subscribe rejected: ${msg.error.message ?? msg.error.code}`,
          );
          sock.destroy();
          emitClose();
        }
      } else {
        onEvent(msg);
      }
    } catch {
      // skip malformed line
    }
  });
  sock.on('connect', () => {
    sock.write(
      `${JSON.stringify({ id: 'cchub_sub', method: 'events.subscribe', params: { subscriptions } })}\n`,
    );
  });
  sock.on('data', readLine);
  sock.on('close', emitClose);
  sock.on('error', emitClose);
  return () => {
    stopped = true;
    sock.destroy();
  };
}

/**
 * Workspace id of a received pane lifecycle event, or null when absent.
 * Wire shapes differ per event (verified live against herdr 0.7.4 /
 * protocol 16): `pane_created` nests it as `data.pane.workspace_id`, while
 * `pane_closed` / `pane_exited` carry `data.workspace_id` directly.
 */
export function eventWorkspaceId(ev: Record<string, unknown>): string | null {
  const data = ev.data;
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.workspace_id === 'string') return d.workspace_id;
  // pane.* nest it under `pane`, tab.* under `tab` (verified against 0.7.4).
  for (const key of ['pane', 'tab'] as const) {
    const nested = d[key];
    if (nested && typeof nested === 'object') {
      const n = nested as Record<string, unknown>;
      if (typeof n.workspace_id === 'string') return n.workspace_id;
    }
  }
  return null;
}

/** `w1:p3` → `%3` (null if the id doesn't match the herdr shape) */
export function toTmuxPaneId(herdrPaneId: string): string | null {
  const m = herdrPaneId.match(/:p(\d+)$/);
  return m ? `%${m[1]}` : null;
}

/** `%3` + workspace `w1` → `w1:p3` */
export function toHerdrPaneId(workspaceId: string, tmuxPaneId: string): string {
  return `${workspaceId}:p${tmuxPaneId.slice(1)}`;
}

export async function listWorkspaces(): Promise<HerdrWorkspace[]> {
  const res = await herdrRpc<{ workspaces: HerdrWorkspace[] }>('workspace.list', {});
  return res.workspaces ?? [];
}

/**
 * Fetch one workspace (for its authoritative `active_tab_id`). herdr updates
 * `active_tab_id` immediately on `tab.focus`, so this is how the control
 * session follows tab switches. Null on any failure.
 */
export async function getWorkspace(workspaceId: string): Promise<HerdrWorkspace | null> {
  try {
    const res = await herdrRpc<{ workspace?: HerdrWorkspace }>('workspace.get', {
      workspace_id: workspaceId,
    });
    return res.workspace ?? null;
  } catch {
    return null;
  }
}

export async function listPanes(workspaceId?: string): Promise<HerdrPane[]> {
  const params: Record<string, unknown> = workspaceId ? { workspace_id: workspaceId } : {};
  const res = await herdrRpc<{ panes: HerdrPane[] }>('pane.list', params);
  return res.panes ?? [];
}

/** Tabs of a workspace (herdr workspace > tab > pane), with labels + counts. */
export async function listTabs(workspaceId: string): Promise<HerdrTab[]> {
  try {
    const res = await herdrRpc<{ tabs?: HerdrTab[] }>('tab.list', { workspace_id: workspaceId });
    return res.tabs ?? [];
  } catch {
    return [];
  }
}

/** Focus (switch to) a tab. */
export async function focusTab(tabId: string): Promise<void> {
  await herdrRpc('tab.focus', { tab_id: tabId });
}

/** Create a new tab in a workspace, optionally focusing it. Returns its id. */
export async function createTab(workspaceId: string, focus = true): Promise<string | null> {
  const res = await herdrRpc<{ tab?: { tab_id?: string } }>('tab.create', {
    workspace_id: workspaceId,
    focus,
  });
  return res.tab?.tab_id ?? null;
}

/** Close a tab (and every pane in it). */
export async function closeTab(tabId: string): Promise<void> {
  await herdrRpc('tab.close', { tab_id: tabId });
}

export async function getPane(herdrPaneId: string): Promise<HerdrPane | null> {
  try {
    const res = await herdrRpc<{ pane: HerdrPane }>('pane.get', { pane_id: herdrPaneId });
    return res.pane ?? null;
  } catch {
    return null;
  }
}

/**
 * A node in herdr's `layout.export` split tree (recursive). `direction`
 * describes where the `second` child sits relative to `first`: `right` =
 * side-by-side, `down` = stacked. `ratio` is the first child's share.
 */
export type HerdrLayoutNode =
  | { type: 'pane'; pane_id: string }
  | {
      type: 'split';
      direction: 'right' | 'down';
      ratio: number;
      first: HerdrLayoutNode;
      second: HerdrLayoutNode;
    };

export interface HerdrLayoutExport {
  workspace_id: string;
  tab_id: string;
  zoomed: boolean;
  focused_pane_id: string | null;
  root: HerdrLayoutNode;
}

/**
 * Export a workspace's split tree via any pane it contains. herdr retains the
 * real geometry (structure + direction) across a cchub restart, so this is how
 * CC Hub rehydrates its layout instead of guessing a flat chain. Null on any
 * failure — the caller falls back to a flat layout.
 */
export async function exportLayout(herdrPaneId: string): Promise<HerdrLayoutExport | null> {
  try {
    const res = await herdrRpc<{ layout?: HerdrLayoutExport }>('layout.export', {
      pane_id: herdrPaneId,
    });
    return res.layout ?? null;
  } catch {
    return null;
  }
}

export interface HerdrReadResult {
  pane_id: string;
  source: string;
  format: string;
  text: string;
}

export async function readPane(
  herdrPaneId: string,
  source: 'visible' | 'recent' | 'recent_unwrapped',
  lines?: number,
): Promise<string | null> {
  try {
    const res = await herdrRpc<{ read: HerdrReadResult }>('pane.read', {
      pane_id: herdrPaneId,
      source,
      ...(lines != null ? { lines } : {}),
      format: 'ansi',
      strip_ansi: false,
    });
    return res.read?.text ?? null;
  } catch {
    return null;
  }
}

export async function readPaneText(
  herdrPaneId: string,
  source: 'visible' | 'recent',
  lines?: number,
): Promise<string | null> {
  try {
    const res = await herdrRpc<{ read: HerdrReadResult }>('pane.read', {
      pane_id: herdrPaneId,
      source,
      ...(lines != null ? { lines } : {}),
      format: 'text',
      strip_ansi: true,
    });
    return res.read?.text ?? null;
  } catch {
    return null;
  }
}

export interface FrameMeta {
  /** true = full repaint, false = incremental */
  full: boolean;
  width: number;
  height: number;
  seq: number;
}

export interface PaneControllerHandlers {
  /** Called for every terminal.frame with the decoded VT bytes. */
  onFrame: (bytes: Buffer, meta: FrameMeta) => void;
  /** Called once when the control subprocess exits or its stream ends. */
  onExit: () => void;
}

/**
 * Persistent `herdr terminal session control` client for one pane.
 *
 * This is the herdr equivalent of tmux -CC for a single pane: stdin accepts
 * newline-delimited JSON commands and stdout streams terminal.frame records.
 *
 *   {"type":"terminal.input","bytes":"<base64>"}  raw PTY write, NO
 *       sanitization (verified against herdr 0.7.3 src/client/mod.rs) —
 *       unlike pane.send_input, which strips ESC/newlines from text.
 *   {"type":"terminal.resize","cols":N,"rows":N}  absolute PTY resize.
 *
 * Input ordering is guaranteed by the single stdin pipe, and raw byte
 * passthrough means mouse SGR sequences, bracketed paste, and arbitrary
 * escape sequences reach the application intact.
 */
export class PaneController {
  private proc: ReturnType<typeof Bun.spawn>;
  private stdinWriter: { write(s: string): unknown; flush?(): unknown };
  private exited = false;

  constructor(
    readonly herdrPaneId: string,
    size: { cols: number; rows: number } | null,
    handlers: PaneControllerHandlers,
  ) {
    // Without --cols/--rows the control client attaches at the pane's
    // current size — important for read-only-ish attaches (REST captures on
    // sessions no browser is viewing) so we don't forcibly reflow a pane a
    // human is using elsewhere. Size is applied only when a real client
    // geometry is known.
    const sizeArgs = size ? ['--cols', String(size.cols), '--rows', String(size.rows)] : [];
    this.proc = Bun.spawn(
      [herdrBin(), 'terminal', 'session', 'control', herdrPaneId, '--takeover', ...sizeArgs],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: herdrChildEnv() },
    );
    this.stdinWriter = this.proc.stdin as unknown as { write(s: string): unknown };

    void this.readFrames(handlers);
    void this.proc.exited.then(() => {
      if (!this.exited) {
        this.exited = true;
        handlers.onExit();
      }
    });
  }

  private async readFrames(handlers: PaneControllerHandlers): Promise<void> {
    const stdout = this.proc.stdout;
    if (!stdout || typeof stdout === 'number') return;
    const reader = stdout.getReader();
    const readLine = createNdjsonReader((line) => {
      try {
        const msg = JSON.parse(line) as {
          type?: string;
          bytes?: string;
          full?: boolean;
          width?: number;
          height?: number;
          seq?: number;
        };
        if (msg.type === 'terminal.frame' && typeof msg.bytes === 'string') {
          handlers.onFrame(Buffer.from(msg.bytes, 'base64'), {
            full: msg.full ?? false,
            width: msg.width ?? 0,
            height: msg.height ?? 0,
            seq: msg.seq ?? 0,
          });
        }
      } catch {
        // skip malformed line
      }
    });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        readLine(Buffer.from(value));
      }
    } catch {
      // stream torn down
    }
  }

  private send(obj: Record<string, unknown>): void {
    if (this.exited) return;
    try {
      this.stdinWriter.write(`${JSON.stringify(obj)}\n`);
    } catch {
      // stdin closed
    }
  }

  /** Write raw bytes to the pane's PTY (ordering guaranteed by the pipe). */
  input(data: Buffer): void {
    this.send({ type: 'terminal.input', bytes: data.toString('base64') });
  }

  /** Absolute PTY resize. */
  resize(cols: number, rows: number): void {
    this.send({ type: 'terminal.resize', cols, rows });
  }

  get isAlive(): boolean {
    return !this.exited;
  }

  kill(): void {
    this.exited = true;
    try {
      (this.proc.stdin as unknown as { end?: () => void })?.end?.();
    } catch {
      // already closed
    }
    try {
      this.proc.kill();
    } catch {
      // already dead
    }
  }
}
