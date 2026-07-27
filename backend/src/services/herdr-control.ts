/**
 * HerdrControlSession — herdr-backed drop-in for TmuxControlSession.
 *
 * One instance per CC Hub session (= one herdr workspace). Exposes the same
 * public surface `routes/terminal-mux.ts` consumes from TmuxControlSession,
 * so the WS mux layer and the frontend stay unchanged.
 *
 * Differences from the tmux backend:
 *  - Per-pane transport: one persistent `herdr terminal session control`
 *    subprocess per pane (see PaneController). It carries raw PTY input
 *    (base64, no sanitization — mouse SGR / bracketed paste / escape
 *    sequences pass through intact), absolute PTY resizes, and streams
 *    terminal.frame records that (a) trigger viewport recaptures and
 *    (b) are scanned for cursor position and alt-screen state.
 *  - Layout: CC Hub owns the split tree (see herdr-layout.ts) because the
 *    herdr workspace grid cannot be resized headlessly.
 *  - Scrollback: herdr's pane.read is capped at 1000 lines, so viewports
 *    clamp history to (1000 - rows) rows above the live edge (see
 *    poc/herdr/FINDINGS.md).
 */

import type { PaneCursor, PaneDemand, PaneModes, PaneViewport, TmuxLayoutNode } from '../../../shared/types';
import { type ClientPaneDemands, reconcilePaneSizes, resolveTargetSizes } from './pane-sizing';
import {
  closeTab as herdrCloseTab,
  createTab as herdrCreateTab,
  eventWorkspaceId,
  exportLayout,
  focusTab as herdrFocusTab,
  getPane,
  getWorkspace,
  type HerdrPane,
  herdrRpc,
  herdrSubscribe,
  listPanes,
  listWorkspaces,
  PaneController,
  readPane,
  toHerdrPaneId,
  toTmuxPaneId,
} from './herdr-client';
import { herdrLayoutToNode, PaneLayoutTree } from './herdr-layout';

const GRACE_PERIOD_MS = 30_000;
const RESIZE_DEBOUNCE_MS = 50;
// Experimental per-pane smallest-wins override (opt-in via
// CCHUB_PER_CLIENT_SIZING=1). Superseded for the common case by active-client
// sizing (the device being used owns the session size), which fixes the
// dual-view flicker without letterboxing the active device. Kept off by
// default; may be removed once active-client sizing is proven in the field.
const PER_CLIENT_SIZING = process.env.CCHUB_PER_CLIENT_SIZING === '1';
// A client's proposeDimensions and the server's ratio split can disagree by a
// cell or two from rounding; only a demand this many cells smaller than the
// tree slot counts as a real cross-client conflict worth shrinking a pane for.
// Matches the ±3 tolerance the desktop resize path already uses.
const SIZING_TOLERANCE = 3;
// herdr pane.read hard cap (server-side, not configurable in 0.7.x)
const HERDR_READ_CAP = 1000;

const PANE_ID_RE = /^%\d+$/;

/**
 * Active-client sizing rule: which client drives the shared session size.
 *
 * The shared size is owned by whichever client is being interacted with, so two
 * devices on one session don't fight over it (that flickered). A client owns the
 * size when it explicitly claims (a tap/focus), when nobody is active yet, when
 * it is already the active client, or when it is the only one that has reported
 * a size. Otherwise its resize is recorded but does not move the shared size.
 */
export function clientOwnsSessionSize(
  activeClientId: string | null,
  clientId: string,
  claim: boolean,
  clientCount: number,
): boolean {
  return claim || activeClientId === null || activeClientId === clientId || clientCount <= 1;
}

// Pane ids come from WS/REST clients and end up inside herdr JSON-RPC
// params (via toHerdr), so reject anything outside the tmux-style `%N`
// shape at the boundary. The WS layer validates the same shape
// (PaneIdSchema) before dispatch; this is the in-process backstop.
export function assertPaneId(paneId: string): void {
  if (typeof paneId !== 'string' || !PANE_ID_RE.test(paneId)) {
    throw new Error(`Invalid pane id: ${JSON.stringify(paneId)}`);
  }
}

type LayoutListener = (layout: TmuxLayoutNode, zoomedPaneId: string | null) => void;
type ExitListener = (reason: string) => void;

/** Live terminal state tracked from a pane's frame stream. */
export interface PaneRuntimeState {
  altScreen: boolean;
  cursorX: number; // 0-based
  cursorY: number; // 0-based
  cursorVisible: boolean;
  /** altScreen came from the attach-time heuristic (not an observed 1049
   *  transition). Guessed state is revoked if host scrollback grows — alt
   *  screens never add host history, so growth proves the guess wrong. */
  altGuessed?: boolean;
  /** max_offset_from_bottom at guess time, for the growth check. */
  altGuessBaseline?: number;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes by design.
const CUP_RE = /\x1b\[(\d*)(?:;(\d*))?[Hf]/g;

const SHELL_NAMES = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'nu', 'pwsh']);

/**
 * Best-effort initial alt-screen guess for a pane that was already running
 * when we attached. herdr 0.7.x tracks `alternate_screen` internally but
 * doesn't expose it over the socket API, and attach frames repaint cells
 * without re-emitting mode toggles. Heuristic: a non-shell foreground
 * process with zero host scrollback is almost certainly a fullscreen TUI
 * (Claude, vim, htop, less) — alt apps accumulate no host history, while a
 * normal-screen program quickly does. Later frames correct the state on any
 * real transition.
 */
async function guessInitialAltScreen(
  herdrPaneId: string,
  state: PaneRuntimeState,
): Promise<void> {
  try {
    const res = await herdrRpc<{
      process_info?: { foreground_processes?: Array<{ name?: string }> };
    }>('pane.process_info', { pane_id: herdrPaneId });
    const leader = res.process_info?.foreground_processes?.[0]?.name ?? '';
    if (!leader || SHELL_NAMES.has(leader)) return;
    const pane = await getPane(herdrPaneId);
    if (!pane?.scroll) return;
    const offset = pane.scroll.max_offset_from_bottom;
    // Allow up to one screenful of host scrollback: panes created by the
    // resume/create flows carry a few shell lines (the `cd … && claude -r`
    // echo) from before the agent entered the alt screen. A wrong guess is
    // self-corrected in captureViewportHerdr when host scrollback GROWS —
    // alt screens never add host history.
    if (offset <= pane.scroll.viewport_rows) {
      state.altScreen = true;
      state.altGuessed = true;
      state.altGuessBaseline = offset;
    }
  } catch {
    // keep the default (normal screen)
  }
}

/**
 * A pane reports no scroll state until it has a terminal runtime, and a
 * restored pane has none until its agent is resumed — herdr defers that resume
 * until a client attaches with a non-zero size. So "no scroll" is a normal
 * transient state on exactly the panes a subscribe is meant to revive, and
 * refusing to subscribe over it deadlocks: no subscribe → no client size → no
 * resume → still no scroll. It is NOT a signal about the server's version
 * (version skew has its own accurate source in HerdrUpdateService, which reads
 * the real protocol number from `herdr status --json`). Callers must treat a
 * missing scroll as "unknown yet" and fall back to the client's own size.
 */
export function paneViewportRows(pane: Pick<HerdrPane, 'scroll'>, fallbackRows: number): number {
  return pane.scroll?.viewport_rows || fallbackRows;
}

/**
 * Update tracked state from one rendered frame.
 *
 * herdr frames are re-renders (not raw PTY passthrough) and always end with
 * explicit cursor placement (CUP) plus a show/hide-cursor toggle, so "last
 * occurrence wins" scanning is sufficient — no VT emulation needed.
 */
export function scanFrameForState(state: PaneRuntimeState, bytes: Buffer): void {
  const s = bytes.toString('latin1');

  // Alt-screen enter/leave (1049/1047/47 variants), last occurrence wins.
  let altPos = -1;
  let altVal = state.altScreen;
  for (const [pat, val] of [
    ['\x1b[?1049h', true],
    ['\x1b[?1049l', false],
    ['\x1b[?1047h', true],
    ['\x1b[?1047l', false],
    ['\x1b[?47h', true],
    ['\x1b[?47l', false],
  ] as Array<[string, boolean]>) {
    const p = s.lastIndexOf(pat);
    if (p > altPos) {
      altPos = p;
      altVal = val;
    }
  }
  if (altPos >= 0) {
    // An observed transition supersedes any attach-time guess.
    state.altGuessed = false;
  }
  state.altScreen = altVal;

  // Cursor visibility, last occurrence wins.
  const show = s.lastIndexOf('\x1b[?25h');
  const hide = s.lastIndexOf('\x1b[?25l');
  if (show >= 0 || hide >= 0) {
    state.cursorVisible = show > hide;
  }

  // Cursor position: the final CUP of the frame is where the cursor rests.
  let last: RegExpExecArray | null = null;
  CUP_RE.lastIndex = 0;
  for (let m = CUP_RE.exec(s); m !== null; m = CUP_RE.exec(s)) {
    last = m;
  }
  if (last) {
    const row = last[1] ? Number.parseInt(last[1], 10) : 1;
    const col = last[2] ? Number.parseInt(last[2], 10) : 1;
    state.cursorY = Math.max(0, row - 1);
    state.cursorX = Math.max(0, col - 1);
  }
}

export class HerdrControlSession {
  private sessionId: string;
  private workspaceId: string | null = null;
  // A herdr workspace holds one or more tabs; CC Hub renders a single tab at a
  // time (its split tree is one tab's geometry). This tracks which tab is live,
  // following herdr's `active_tab_id`. null = pre-init or herdr too old to
  // report tabs, in which case every pane is treated as one flat tab.
  private activeTabId: string | null = null;
  private tree = new PaneLayoutTree();

  // Client size as reported by the browser (drives pane PTY sizes).
  // Until a real client reports a size (clientSizeKnown), controllers attach
  // WITHOUT resizing so REST-only access never reflows a pane someone else
  // is using at a different geometry.
  private clientSize: { cols: number; rows: number } = { cols: 80, rows: 24 };
  private clientSizeKnown = false;
  private resizeTimer: Timer | null = null;
  private lastClientSize: { cols: number; rows: number } | null = null;
  // Active-client sizing: the shared session size is owned by whichever client
  // is currently being interacted with (input or an explicit tap claim). Other
  // clients' resizes are recorded here but do NOT move the shared size, so two
  // devices on one session don't fight over it (which flickered). `clientSizes`
  // remembers each client's last reported size so ownership can hand off.
  private clientSizes = new Map<string, { cols: number; rows: number }>();
  private activeClientId: string | null = null;
  // Last known per-pane size: written by applyLayout when we resize, and
  // kept fresh from frame metadata (the renderer's actual geometry).
  private paneSizes = new Map<string, { cols: number; rows: number }>();
  // Started-once gate so concurrent getOrCreate callers all await the same
  // initialization instead of observing a half-started instance.
  private startPromise: Promise<void> | null = null;
  // Controllers (per-pane control streams) are lazy: false until a WS client
  // subscribes or input is sent. Read-only REST access never flips this.
  private controllersEnabled = false;

  // persistent control client per herdr pane id (input + resize + frames)
  private controllers = new Map<string, PaneController>();
  // live cursor / alt-screen state per tmux pane id, fed by frame scanning
  private runtimeStates = new Map<string, PaneRuntimeState>();
  private unsubscribeEvents: (() => void) | null = null;

  private globalOutputListeners = new Set<(paneId: string, data: Buffer) => void>();
  private layoutListeners = new Set<LayoutListener>();
  private exitListeners = new Set<ExitListener>();

  private clientCount = 0;
  private graceTimer: Timer | null = null;
  private destroyed = false;
  private clientDeviceTypes = new Map<string, 'mobile' | 'tablet' | 'desktop'>();
  // Per-client reported pane render sizes (see PaneDemand). Keyed by clientId
  // (visitorId), each value keyed by tmux-style pane id. Reconciled into one
  // PTY size per pane. Recorded now; consulted for sizing only once per-client
  // sizing is enabled (kept dormant so this is a no-op change on its own).
  private paneDemands = new Map<string, ClientPaneDemands>();

  // Focused pane (tmux-style id). Initialized from herdr's focused flag,
  // updated by selectPane/splitPane and reconciled against herdr state.
  private activePaneId: string | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** Idempotent start: all callers share one initialization. */
  startOnce(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.start();
    }
    return this.startPromise;
  }

  private async start(): Promise<void> {
    const workspaces = await listWorkspaces();
    const ws = workspaces.find(
      (w) => w.label === this.sessionId || w.workspace_id === this.sessionId,
    );
    if (!ws) {
      throw new Error(`herdr workspace not found for session: ${this.sessionId}`);
    }
    this.workspaceId = ws.workspace_id;
    this.activeTabId = ws.active_tab_id ?? null;

    const allPanes = await listPanes(ws.workspace_id);
    const panes = this.filterActiveTab(allPanes);
    const tmuxIds = panes
      .map((p) => toTmuxPaneId(p.pane_id))
      .filter((id): id is string => id !== null);
    await this.hydrateLayout(panes, tmuxIds);

    const focused = panes.find((p) => p.focused);
    this.activePaneId = (focused ? toTmuxPaneId(focused.pane_id) : null) ?? tmuxIds[0] ?? null;

    // No controllers yet: reads (REST viewport, previews) are pure RPC and
    // must not take over / resize panes a human may be using elsewhere.
    // Controllers spawn via enableControllers() when a WS client subscribes
    // or input is sent (writing inherently takes control).
    for (const pane of panes) {
      const tmuxId = toTmuxPaneId(pane.pane_id);
      if (tmuxId) {
        this.paneSizes.set(tmuxId, {
          cols: this.clientSize.cols,
          rows: paneViewportRows(pane, this.clientSize.rows),
        });
      }
    }

    // Structural events → reconcile pane set. herdr's lifecycle subscriptions
    // accept no server-side filter (protocol 16), so every session receives
    // every pane event; filter on the event's workspace here so pane churn in
    // other workspaces (previews, throwaway workspaces, other sessions) does
    // not fan out into a pane.list reconcile per session. An event with no
    // recognizable workspace still reconciles — a wasted reconcile is
    // harmless, a missed one would cost correctness. tab.* events drive the
    // active-tab switch (reconcile re-reads active_tab_id authoritatively).
    this.unsubscribeEvents = herdrSubscribe(
      [
        { type: 'pane.created' },
        { type: 'pane.closed' },
        { type: 'pane.exited' },
        { type: 'tab.focused' },
        { type: 'tab.created' },
        { type: 'tab.closed' },
        { type: 'tab.moved' },
      ],
      (ev) => {
        const wsId = eventWorkspaceId(ev);
        if (wsId === null || wsId === this.workspaceId) {
          void this.reconcilePanes();
        }
      },
      () => {
        if (!this.destroyed) this.handleExit('herdr event stream closed');
      },
    );

    console.log(
      `[herdr-control] Session ready: ${this.sessionId} (workspace=${ws.workspace_id}, tab=${this.activeTabId ?? 'n/a'}, panes=${tmuxIds.length})`,
    );
  }

  /** Panes belonging to the live tab (all panes when tabs aren't reported). */
  private filterActiveTab(panes: HerdrPane[]): HerdrPane[] {
    if (!this.activeTabId) return panes;
    return panes.filter((p) => p.tab_id === this.activeTabId);
  }

  /**
   * Rebuild the split tree, preferring herdr's exported layout so a session's
   * pane geometry (structure + direction) survives a cchub restart instead of
   * collapsing to a flat horizontal chain. Falls back to a flat chain when the
   * export is unavailable or its pane set disagrees with the live panes — the
   * worst case is then exactly the old behavior, never a corrupt tree.
   */
  private async hydrateLayout(panes: HerdrPane[], tmuxIds: string[]): Promise<void> {
    const anchor = panes[0]?.pane_id;
    if (anchor) {
      const exported = await exportLayout(anchor);
      const root = exported ? herdrLayoutToNode(exported.root, toTmuxPaneId) : null;
      if (root) {
        this.tree.setInitialTree(root);
        const treeIds = this.tree.paneIds();
        const matches =
          treeIds.length === tmuxIds.length && treeIds.every((id) => tmuxIds.includes(id));
        if (matches) {
          if (exported?.zoomed && exported.focused_pane_id) {
            const zoomed = toTmuxPaneId(exported.focused_pane_id);
            if (zoomed && this.tree.has(zoomed)) this.tree.toggleZoom(zoomed);
          }
          return;
        }
      }
    }
    this.tree.setInitialPanes(tmuxIds);
  }

  /** Map a tmux-style `%N` pane id to this session's herdr pane id. */
  toHerdr(paneId: string): string {
    if (!this.workspaceId) throw new Error('Control session not active');
    return toHerdrPaneId(this.workspaceId, paneId);
  }

  /**
   * Spawn per-pane control streams (raw input + frame push + PTY resize).
   * Taking a pane's control stream kicks any other controller and may
   * resize the PTY, so this only happens when a client actually needs
   * write/live access: WS subscribe, or the first input into the session.
   */
  enableControllers(): void {
    if (this.controllersEnabled || this.destroyed) return;
    this.controllersEnabled = true;
    for (const tmuxId of this.tree.paneIds()) {
      this.startController(
        this.toHerdr(tmuxId),
        this.clientSizeKnown ? (this.paneSizes.get(tmuxId) ?? null) : null,
      );
    }
  }

  getPaneSize(paneId: string): { cols: number; rows: number } | undefined {
    return this.paneSizes.get(paneId);
  }

  // ==========================================================================
  // Pane controller management (input + resize + frame stream)
  // ==========================================================================

  private startController(herdrPaneId: string, size: { cols: number; rows: number } | null): void {
    if (this.destroyed || this.controllers.get(herdrPaneId)?.isAlive) return;
    const tmuxId = toTmuxPaneId(herdrPaneId);
    if (!tmuxId) return;

    const existing = this.runtimeStates.get(tmuxId);
    const state: PaneRuntimeState = existing ?? {
      altScreen: false,
      cursorX: 0,
      cursorY: 0,
      cursorVisible: false,
    };
    this.runtimeStates.set(tmuxId, state);
    if (!existing) {
      // Frames only carry alt-screen TRANSITIONS; a pane already inside an
      // alt-screen app when we attach would stay misclassified forever.
      void guessInitialAltScreen(herdrPaneId, state);
    }

    let controller: PaneController;
    try {
      controller = new PaneController(herdrPaneId, size, {
        onFrame: (bytes, meta) => {
          scanFrameForState(state, bytes);
          // Frame metadata carries the renderer's actual geometry — keep
          // paneSizes truthful even for panes we never explicitly resized.
          if (meta.width > 0 && meta.height > 0) {
            this.paneSizes.set(tmuxId, { cols: meta.width, rows: meta.height });
          }
          for (const listener of this.globalOutputListeners) {
            listener(tmuxId, Buffer.alloc(0));
          }
        },
        onExit: () => {
          console.log(`[herdr-control] controller exited for ${herdrPaneId} (session=${this.sessionId})`);
          if (this.controllers.get(herdrPaneId) === controller) {
            this.controllers.delete(herdrPaneId);
          }
          if (this.destroyed) return;
          // The control client can die without the pane being gone (herdr
          // restart, takeover by another client). Reconcile decides whether
          // the pane still exists and layout-applies a fresh controller.
          setTimeout(() => void this.reconcilePanes(), 500);
        },
      });
    } catch (err) {
      console.error(`[herdr-control] control spawn failed for ${herdrPaneId}:`, err);
      return;
    }
    this.controllers.set(herdrPaneId, controller);
    console.log(
      `[herdr-control] controller spawned for ${herdrPaneId} (${size ? `${size.cols}x${size.rows}` : 'attach-size'}, session=${this.sessionId})`,
    );

    // Nudge subscribers to recapture shortly after a controller (re)spawn.
    // A capture can race the app's resize repaint (blank/transitional
    // content), and if the app then goes idle no frame would ever trigger a
    // corrective push — the stale viewport would stick until the next real
    // output. Two delayed ticks cover fast and slow repaints.
    for (const delay of [300, 1200]) {
      setTimeout(() => {
        if (this.destroyed || !this.controllers.get(herdrPaneId)?.isAlive) return;
        for (const listener of this.globalOutputListeners) {
          listener(tmuxId, Buffer.alloc(0));
        }
      }, delay);
    }
  }

  private stopController(herdrPaneId: string): void {
    const controller = this.controllers.get(herdrPaneId);
    if (controller) {
      this.controllers.delete(herdrPaneId);
      controller.kill();
    }
  }

  private controllerFor(paneId: string): PaneController | undefined {
    const controller = this.controllers.get(this.toHerdr(paneId));
    return controller?.isAlive ? controller : undefined;
  }

  /** Live cursor / alt-screen state for a pane (from its frame stream). */
  getRuntimeState(paneId: string): PaneRuntimeState | undefined {
    return this.runtimeStates.get(paneId);
  }

  private async reconcilePanes(): Promise<void> {
    if (this.destroyed || !this.workspaceId) return;
    let allPanes: Awaited<ReturnType<typeof listPanes>>;
    try {
      allPanes = await listPanes(this.workspaceId);
    } catch {
      // Distinguish "workspace is gone" (terminal) from a transient RPC
      // failure. Swallowing the former leaves this session in the registry
      // as a zombie bound to a dead workspace — a later same-name workspace
      // then resolves to it and every read fails (blank terminal until the
      // grace timer finally reaps it).
      try {
        const workspaces = await listWorkspaces();
        if (!workspaces.some((w) => w.workspace_id === this.workspaceId)) {
          this.handleExit('workspace closed');
        }
      } catch {
        // herdr unreachable — keep the session; the event-stream onClose
        // path handles a dead server.
      }
      return;
    }

    // Follow herdr's active tab. workspace.get reports active_tab_id
    // authoritatively (it updates the instant a tab is focused), so a tab.*
    // event that brought us here re-points the session at the new tab's
    // geometry rather than merging tabs into one flat tree.
    const ws = await getWorkspace(this.workspaceId);
    const activeTab = ws?.active_tab_id ?? this.activeTabId;
    if (activeTab && activeTab !== this.activeTabId && allPanes.some((p) => p.tab_id === activeTab)) {
      await this.switchActiveTab(activeTab, allPanes);
      return;
    }

    const panes = this.filterActiveTab(allPanes);
    const live = new Set<string>();
    let changed = false;

    for (const pane of panes) {
      const tmuxId = toTmuxPaneId(pane.pane_id);
      if (!tmuxId) continue;
      live.add(tmuxId);
      if (!this.tree.has(tmuxId)) {
        this.tree.addUnknown(tmuxId);
        changed = true;
      }
      // herdr's focused flag is authoritative for panes focused outside our
      // own selectPane calls (other herdr clients, focus-follows on split).
      if (pane.focused) {
        this.activePaneId = tmuxId;
      }
      // A live pane without a running controller (fresh pane, or its control
      // client died) gets one — but only once controllers are enabled at all.
      if (this.controllersEnabled && !this.controllers.get(pane.pane_id)?.isAlive) {
        this.startController(
          pane.pane_id,
          this.clientSizeKnown ? (this.paneSizes.get(tmuxId) ?? null) : null,
        );
      }
    }

    for (const tmuxId of this.tree.paneIds()) {
      if (!live.has(tmuxId)) {
        this.tree.remove(tmuxId);
        this.stopController(this.toHerdr(tmuxId));
        this.paneSizes.delete(tmuxId);
        this.runtimeStates.delete(tmuxId);
        changed = true;
      }
    }

    if (this.activePaneId && !live.has(this.activePaneId)) {
      this.activePaneId = this.tree.paneIds()[0] ?? null;
    }

    if (this.tree.paneIds().length === 0) {
      // The active tab is empty. Only an empty *workspace* means the session is
      // gone; if other tabs still hold panes, the active tab was just closed —
      // switch to a surviving tab instead of tearing the session down.
      if (allPanes.length === 0) {
        this.handleExit('all panes closed');
        return;
      }
      await this.switchActiveTab(allPanes[0].tab_id, allPanes);
      return;
    }
    if (changed) {
      await this.applyLayout();
    }
  }

  /**
   * Re-point the control session at a different tab of the same workspace:
   * rebuild the split tree from that tab's panes and swap the per-pane control
   * streams over. Used when herdr's active tab changes (tab focus / the active
   * tab being closed). Mirrors start()'s per-tab setup.
   */
  private async switchActiveTab(tabId: string, allPanes: HerdrPane[]): Promise<void> {
    if (this.destroyed) return;
    const previousPaneIds = this.tree.paneIds();
    this.activeTabId = tabId;
    const panes = this.filterActiveTab(allPanes);
    const tmuxIds = panes
      .map((p) => toTmuxPaneId(p.pane_id))
      .filter((id): id is string => id !== null);

    // Tear down the outgoing tab's controllers / runtime state; those panes
    // are just off-screen — the new layout tells the client which panes exist
    // now.
    for (const tmuxId of previousPaneIds) {
      this.stopController(this.toHerdr(tmuxId));
      this.paneSizes.delete(tmuxId);
      this.runtimeStates.delete(tmuxId);
    }

    await this.hydrateLayout(panes, tmuxIds);

    const focused = panes.find((p) => p.focused);
    this.activePaneId = (focused ? toTmuxPaneId(focused.pane_id) : null) ?? tmuxIds[0] ?? null;

    for (const pane of panes) {
      const tmuxId = toTmuxPaneId(pane.pane_id);
      if (tmuxId) {
        this.paneSizes.set(tmuxId, {
          cols: this.clientSize.cols,
          rows: paneViewportRows(pane, this.clientSize.rows),
        });
      }
    }

    if (this.controllersEnabled) {
      for (const tmuxId of this.tree.paneIds()) {
        this.startController(
          this.toHerdr(tmuxId),
          this.clientSizeKnown ? (this.paneSizes.get(tmuxId) ?? null) : null,
        );
      }
    }

    console.log(
      `[herdr-control] Active tab → ${tabId} (session=${this.sessionId}, panes=${tmuxIds.length})`,
    );
    await this.applyLayout();
  }

  // ==========================================================================
  // Layout (CC Hub-owned split tree)
  // ==========================================================================

  /** Resize every pane PTY to its computed rect and notify layout listeners. */
  private async applyLayout(): Promise<void> {
    if (this.destroyed) return;
    if (this.clientSizeKnown) {
      const { cols, rows } = this.clientSize;
      // Base sizes: today's tree/zoom geometry (unchanged when the flag is off).
      const base = new Map<string, { cols: number; rows: number }>();
      for (const [paneId, rect] of this.tree.computeRects(cols, rows)) {
        base.set(paneId, { cols: rect.width, rows: rect.height });
      }
      // Per-client sizing only intervenes for a genuine multi-client conflict
      // (see resolveTargetSizes); a single client keeps the tree/zoom path.
      const targets = PER_CLIENT_SIZING
        ? resolveTargetSizes(base, this.reconciledPaneSizes(), this.paneDemands.size, SIZING_TOLERANCE)
        : base;
      for (const [paneId, size] of targets) {
        const prev = this.paneSizes.get(paneId);
        if (prev && prev.cols === size.cols && prev.rows === size.rows) continue;
        this.paneSizes.set(paneId, size);
        this.controllerFor(paneId)?.resize(size.cols, size.rows);
      }
      if (PER_CLIENT_SIZING && this.paneDemands.size >= 2) this.logSizingParity();
    }
    this.emitLayout();
  }

  /**
   * Diagnostics for per-client sizing: report panes whose reconciled demand is
   * a real conflict with the tree/zoom slot (beyond rounding tolerance) — i.e.
   * a pane that per-client sizing actually shrinks. A single client trips
   * nothing (equivalent). Logs only; changes nothing.
   */
  private logSizingParity(): void {
    const reconciled = this.reconciledPaneSizes();
    if (reconciled.size === 0) return;
    const { cols, rows } = this.clientSize;
    const rects = this.tree.computeRects(cols, rows);
    const diffs: string[] = [];
    for (const [paneId, size] of reconciled) {
      const rect = rects.get(paneId);
      if (!rect) {
        diffs.push(`${paneId}: demand ${size.cols}x${size.rows}, no current rect`);
      } else if (
        rect.width - size.cols >= SIZING_TOLERANCE ||
        rect.height - size.rows >= SIZING_TOLERANCE
      ) {
        diffs.push(`${paneId}: slot ${rect.width}x${rect.height} shrunk to ${size.cols}x${size.rows}`);
      }
    }
    console.log(
      `[per-client-sizing] ${this.sessionId}: ${this.paneDemands.size} client(s), ` +
        `${reconciled.size} pane demand(s), ${diffs.length} conflict(s)` +
        (diffs.length ? `: ${diffs.join('; ')}` : ' (no shrink — equivalent)'),
    );
  }

  private emitLayout(): void {
    const layout = this.tree.toTmuxLayout(this.clientSize.cols, this.clientSize.rows);
    if (!layout) return;
    const zoomed = this.tree.zoomed;
    for (const listener of this.layoutListeners) {
      listener(layout, zoomed);
    }
  }

  getCurrentLayout(): TmuxLayoutNode | null {
    return this.tree.toTmuxLayout(this.clientSize.cols, this.clientSize.rows);
  }

  /** Which pane is zoomed (tmux-style `%N`), or null. Sent alongside layout. */
  get zoomedPaneId(): string | null {
    return this.tree.zoomed;
  }

  get layout(): TmuxLayoutNode | null {
    return this.getCurrentLayout();
  }

  private handleExit(reason: string): void {
    if (this.destroyed) return;
    // Snapshot the listeners: mux cleanup removes its listener while handling
    // this callback, and every subscribed client still needs the close event.
    for (const listener of [...this.exitListeners]) {
      try {
        listener(reason);
      } catch (error) {
        console.warn(`[herdr-control] exit listener failed for ${this.sessionId}:`, error);
      }
    }
    this.destroy();
  }

  /** End this control session and notify every live subscriber first. */
  terminate(reason: string): void {
    this.handleExit(reason);
  }

  // ==========================================================================
  // Public API - Commands
  // ==========================================================================

  async sendInput(paneId: string, data: Buffer): Promise<void> {
    assertPaneId(paneId);
    if (data.length === 0) return;
    // Writing requires a control stream; take one lazily for input-only
    // access (REST sends into an unwatched session). stdin pipe buffering
    // delivers the bytes once the client finishes attaching.
    if (!this.controllersEnabled) {
      this.enableControllers();
    } else if (!this.controllerFor(paneId)) {
      this.startController(
        this.toHerdr(paneId),
        this.clientSizeKnown ? (this.paneSizes.get(paneId) ?? null) : null,
      );
    }
    // Raw byte passthrough over the pane's control stream. Ordering is
    // guaranteed by the single stdin pipe; no serialization needed.
    const controller = this.controllerFor(paneId);
    if (!controller) {
      // Surface the failure instead of silently dropping bytes — callers
      // like `cchub send` must not get a success response for lost input.
      throw new Error(`pane ${paneId} has no active control stream`);
    }
    controller.input(data);
  }

  async splitPane(paneId: string, direction: 'h' | 'v'): Promise<void> {
    assertPaneId(paneId);
    const res = await herdrRpc<{ pane?: { pane_id?: string } }>('pane.split', {
      target_pane_id: this.toHerdr(paneId),
      direction: direction === 'h' ? 'right' : 'down',
      focus: true,
    });
    const newHerdrId = res.pane?.pane_id;
    const newTmuxId = newHerdrId ? toTmuxPaneId(newHerdrId) : null;
    if (newHerdrId && newTmuxId) {
      this.tree.split(paneId, direction, newTmuxId);
      // pane.split was issued with focus: true — the new pane is focused.
      this.activePaneId = newTmuxId;
      if (this.controllersEnabled) {
        const rect = this.clientSizeKnown
          ? this.tree.computeRects(this.clientSize.cols, this.clientSize.rows).get(newTmuxId)
          : undefined;
        this.startController(newHerdrId, rect ? { cols: rect.width, rows: rect.height } : null);
      }
      await this.applyLayout();
    } else {
      // Shape mismatch — fall back to reconcile
      await this.reconcilePanes();
    }
  }

  async closePane(paneId: string): Promise<void> {
    assertPaneId(paneId);
    if (this.tree.paneIds().length <= 1) {
      throw new Error('Cannot close the last pane');
    }
    await herdrRpc('pane.close', { pane_id: this.toHerdr(paneId) });
    this.tree.remove(paneId);
    this.stopController(this.toHerdr(paneId));
    this.paneSizes.delete(paneId);
    this.runtimeStates.delete(paneId);
    if (this.activePaneId === paneId) {
      this.activePaneId = this.tree.paneIds()[0] ?? null;
    }
    await this.applyLayout();
  }

  async resizePane(paneId: string, cols: number, rows: number): Promise<void> {
    assertPaneId(paneId);
    // Route the absolute size through the layout tree (ancestor split ratio)
    // so the resize survives later applyLayout passes; writing paneSizes/PTY
    // directly would be silently reverted by the next split/zoom/resize.
    this.tree.setPaneSize(paneId, cols, rows, this.clientSize.cols, this.clientSize.rows);
    await this.applyLayout();
  }

  async adjustPaneSize(paneId: string, direction: 'L' | 'R' | 'U' | 'D', amount: number): Promise<void> {
    assertPaneId(paneId);
    this.tree.adjust(paneId, direction, amount, this.clientSize.cols, this.clientSize.rows);
    await this.applyLayout();
  }

  /**
   * Set the ratios of several splits atomically (one relayout). Each entry
   * targets the split whose divider separates paneA from paneB. Boundary-style
   * divider drags renormalize a set of same-direction splits together, so
   * applying them one-by-one would flash intermediate layouts.
   */
  async setSplitRatios(
    entries: Array<{ paneA: string; paneB: string; dir: 'h' | 'v'; ratio: number }>,
  ): Promise<void> {
    let changed = false;
    for (const e of entries) {
      assertPaneId(e.paneA);
      assertPaneId(e.paneB);
      if (this.tree.setSplitRatio(e.paneA, e.paneB, e.dir, e.ratio)) {
        changed = true;
      }
    }
    if (changed) {
      await this.applyLayout();
    }
  }

  async equalizePanes(direction: 'horizontal' | 'vertical'): Promise<void> {
    this.tree.equalize(direction);
    await this.applyLayout();
  }

  async selectPane(paneId: string): Promise<void> {
    assertPaneId(paneId);
    // Picking a pane is the same intent as answering one: the split tree only
    // holds the live tab's panes, so without this a pane parked in another tab
    // resolves to nothing and the view stays on whatever tab it was already
    // showing — the pane the user pointed at is not the pane they get.
    await this.ensurePaneReachable(paneId);
    this.activePaneId = paneId;
    try {
      await herdrRpc('pane.focus', { pane_id: this.toHerdr(paneId) });
    } catch {
      // focus is best-effort
    }
  }

  // ==========================================================================
  // Tab operations (herdr workspace > tab > pane)
  // ==========================================================================

  /**
   * Switch the workspace's active tab. reconcilePanes then re-points the split
   * tree at the new tab (also driven independently by the tab.focused event).
   */
  async selectTab(tabId: string): Promise<void> {
    await herdrFocusTab(tabId);
    await this.reconcilePanes();
  }

  /**
   * Bring a pane into view before acting on it.
   *
   * The split tree only holds the live tab's panes, so input aimed at a pane
   * parked in another tab found nothing and the caller returned 404 — readable
   * from the history API, unanswerable. Switching first makes the reply land,
   * and leaves the terminal showing the pane that was just answered, which is
   * where the next thing happens anyway.
   *
   * Returns false when the pane is nowhere in the workspace; the caller still
   * owns the 404.
   */
  async ensurePaneReachable(paneId: string): Promise<boolean> {
    if (this.tree.paneIds().includes(paneId)) return true;
    if (!this.workspaceId) return false;
    const all = await listPanes(this.workspaceId);
    const target = all.find((p) => (toTmuxPaneId(p.pane_id) ?? p.pane_id) === paneId);
    if (!target?.tab_id || target.tab_id === this.activeTabId) return false;
    console.log(
      `[herdr-control] ${this.sessionId}: pane ${paneId} lives in ${target.tab_id}, switching from ${this.activeTabId ?? 'n/a'}`,
    );
    await this.selectTab(target.tab_id);
    return this.tree.paneIds().includes(paneId);
  }

  /** Create a new focused tab in this workspace and switch to it. */
  async createTab(): Promise<void> {
    if (!this.workspaceId) throw new Error('Control session not active');
    await herdrCreateTab(this.workspaceId, true);
    await this.reconcilePanes();
  }

  /**
   * Close a tab (and its panes). If it was the active tab, reconcile switches
   * to a surviving tab; the workspace is torn down only when its last tab goes.
   */
  async closeTab(tabId: string): Promise<void> {
    await herdrCloseTab(tabId);
    await this.reconcilePanes();
  }

  /**
   * Zoom (or unzoom) a pane. `zoomed` states the intent explicitly; when
   * omitted the zoom is toggled (legacy behavior for clients that don't send
   * it). Explicit intent lets a client re-assert "this pane is zoomed" on
   * reconnect without accidentally toggling it back off.
   */
  async zoomPane(paneId: string, zoomed?: boolean): Promise<void> {
    assertPaneId(paneId);
    if (zoomed === undefined) {
      this.tree.toggleZoom(paneId);
    } else {
      this.tree.setZoom(zoomed ? paneId : null);
    }
    await this.applyLayout();
  }

  /** Does this client currently own (drive) the shared session size? */
  private clientOwnsSize(clientId: string, claim: boolean): boolean {
    return clientOwnsSessionSize(this.activeClientId, clientId, claim, this.clientSizes.size);
  }

  /**
   * Record a client's reported size. Only the active client (or one explicitly
   * claiming via `claim`, or the sole client) actually moves the shared size —
   * a passive second device's resizes are remembered but ignored, so the two
   * don't thrash the layout.
   */
  setClientSize(clientId: string, cols: number, rows: number, claim = false): void {
    this.clientSizes.set(clientId, { cols, rows });
    if (!this.clientOwnsSize(clientId, claim)) return;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      const last = this.lastClientSize;
      if (
        this.activeClientId === clientId &&
        last &&
        last.cols === cols &&
        Math.abs(last.rows - rows) <= 1
      ) {
        return;
      }
      this.activeClientId = clientId;
      this.lastClientSize = { cols, rows };
      this.clientSize = { cols, rows };
      this.clientSizeKnown = true;
      void this.applyLayout();
    }, RESIZE_DEBOUNCE_MS);
  }

  async setClientSizeImmediate(clientId: string, cols: number, rows: number): Promise<void> {
    this.clientSizes.set(clientId, { cols, rows });
    // A newly-connected second client must not steal the size from the device
    // the user is on; only apply immediately when this client owns the size.
    if (!this.clientOwnsSize(clientId, false)) return;
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    this.activeClientId = clientId;
    this.lastClientSize = { cols, rows };
    this.clientSize = { cols, rows };
    this.clientSizeKnown = true;
    await this.applyLayout();
  }

  /**
   * Make `clientId` the size owner and resize the session to its last reported
   * size. Called on input (typing) and on an explicit tap claim, so the device
   * being used drives the size. No-op if it already owns the size at that size,
   * or hasn't reported one yet.
   */
  markClientActive(clientId: string): void {
    const size = this.clientSizes.get(clientId);
    if (!size) return;
    if (
      this.activeClientId === clientId &&
      this.clientSize.cols === size.cols &&
      this.clientSize.rows === size.rows
    ) {
      return;
    }
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    this.activeClientId = clientId;
    this.lastClientSize = size;
    this.clientSize = size;
    this.clientSizeKnown = true;
    void this.applyLayout();
  }

  /** Drop a disconnected client's size and hand ownership to a remaining one. */
  removeClientSize(clientId: string): void {
    this.clientSizes.delete(clientId);
    if (this.activeClientId !== clientId) return;
    const next = this.clientSizes.keys().next().value ?? null;
    this.activeClientId = next;
    const size = next ? this.clientSizes.get(next) : undefined;
    if (size) {
      this.lastClientSize = size;
      this.clientSize = size;
      void this.applyLayout();
    }
  }

  async capturePane(paneId: string): Promise<string> {
    assertPaneId(paneId);
    return (await readPane(this.toHerdr(paneId), 'visible')) ?? '';
  }

  async capturePaneWithScrollback(paneId: string): Promise<string> {
    assertPaneId(paneId);
    return (await readPane(this.toHerdr(paneId), 'recent', HERDR_READ_CAP)) ?? '';
  }

  async listPanes(): Promise<Array<{ paneId: string; width: number; height: number; isActive: boolean }>> {
    const rects = this.tree.computeRects(this.clientSize.cols, this.clientSize.rows);
    const ids = this.tree.paneIds();
    const active = this.activePaneId && ids.includes(this.activePaneId) ? this.activePaneId : ids[0];
    return ids.map((paneId) => {
      const rect = rects.get(paneId);
      return {
        paneId,
        width: rect?.width ?? this.clientSize.cols,
        height: rect?.height ?? this.clientSize.rows,
        isActive: paneId === active,
      };
    });
  }

  // ==========================================================================
  // Public API - Listeners
  // ==========================================================================

  onOutput(listener: (paneId: string, data: Buffer) => void): () => void {
    this.globalOutputListeners.add(listener);
    return () => {
      this.globalOutputListeners.delete(listener);
    };
  }

  onLayoutChange(listener: LayoutListener): () => void {
    this.layoutListeners.add(listener);
    return () => {
      this.layoutListeners.delete(listener);
    };
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  // ==========================================================================
  // Client management (grace period) — same semantics as tmux backend
  // ==========================================================================

  setClientDeviceType(clientId: string, deviceType: 'mobile' | 'tablet' | 'desktop'): void {
    this.clientDeviceTypes.set(clientId, deviceType);
  }

  /** Record a client's current per-pane render sizes (per-client sizing). */
  setPaneDemands(clientId: string, demands: ClientPaneDemands): void {
    this.paneDemands.set(clientId, demands);
  }

  /** Drop a client's demands (on disconnect) so its sizes stop constraining panes. */
  removeClientDemands(clientId: string): void {
    this.paneDemands.delete(clientId);
  }

  /**
   * One reconciled PTY size per pane across all clients' current demands
   * (smallest-wins). Empty when no client has reported — callers fall back to
   * the existing tree/zoom sizing. Not yet consulted by applyLayout.
   */
  reconciledPaneSizes(): Map<string, PaneDemand> {
    return reconcilePaneSizes(this.paneDemands.values());
  }

  removeClientDeviceType(clientId: string): void {
    this.clientDeviceTypes.delete(clientId);
  }

  getClientDeviceType(clientId: string): 'mobile' | 'tablet' | 'desktop' | undefined {
    return this.clientDeviceTypes.get(clientId);
  }

  hasDesktopOrTabletClients(excludeClientId?: string): boolean {
    for (const [clientId, deviceType] of this.clientDeviceTypes) {
      if (clientId === excludeClientId) continue;
      if (deviceType === 'desktop' || deviceType === 'tablet') return true;
    }
    return false;
  }

  addClient(): void {
    if (this.destroyed) return;
    this.clientCount++;
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  removeClient(): void {
    if (this.destroyed) return;
    this.clientCount--;
    if (this.clientCount <= 0) {
      this.clientCount = 0;
      // Several subscriptions can be cleaned up in one exit broadcast. Keep
      // exactly one reap timer; otherwise an overwritten timer survives
      // destroy() and fires later against the deleted session instance.
      if (this.graceTimer) clearTimeout(this.graceTimer);
      this.graceTimer = setTimeout(() => {
        if (this.clientCount <= 0) {
          console.log(`[herdr-control] Grace period expired for session: ${this.sessionId}`);
          this.destroy();
        }
      }, GRACE_PERIOD_MS);
    }
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    if (this.unsubscribeEvents) {
      this.unsubscribeEvents();
      this.unsubscribeEvents = null;
    }
    for (const herdrPaneId of [...this.controllers.keys()]) {
      this.stopController(herdrPaneId);
    }
    this.runtimeStates.clear();

    this.globalOutputListeners.clear();
    this.layoutListeners.clear();
    this.exitListeners.clear();
    this.clientDeviceTypes.clear();
    this.paneDemands.clear();
    this.clientSizes.clear();
    this.paneSizes.clear();

    // A same-name workspace may already have installed a newer control
    // session. An old delayed cleanup must never evict that replacement.
    if (herdrControlSessions.get(this.sessionId) === this) {
      herdrControlSessions.delete(this.sessionId);
    }
    console.log(`[herdr-control] Session destroyed: ${this.sessionId}`);
  }
}

export const herdrControlSessions = new Map<string, HerdrControlSession>();

export async function getOrCreateHerdrControlSession(sessionId: string): Promise<HerdrControlSession> {
  let session = herdrControlSessions.get(sessionId);
  if (session && !session.isDestroyed) {
    // Concurrent callers during initialization share the same start — no one
    // observes a half-started instance (empty tree, null workspaceId).
    await session.startOnce();
    return session;
  }
  session = new HerdrControlSession(sessionId);
  herdrControlSessions.set(sessionId, session);
  try {
    await session.startOnce();
  } catch (error) {
    session.destroy();
    throw error;
  }
  return session;
}

// =============================================================================
// Viewport capture (herdr flavor of services/pane-viewport.ts)
// =============================================================================

/**
 * Compose a PaneViewport from herdr reads.
 *
 *   offset = 0 → pane.read(visible): the actual current surface, correct for
 *                both normal and alt-screen apps. Trailing blank rows are
 *                trimmed by herdr; we pad back to `rows` (top-aligned).
 *   offset > 0 → pane.read(recent) window slice, clamped to herdr's
 *                1000-line read cap.
 *
 * Cursor position/visibility and alt-screen state come from the pane's
 * control-stream frames (see scanFrameForState), since herdr's read API
 * exposes neither.
 */
export async function captureViewportHerdr(
  cs: HerdrControlSession,
  paneId: string,
  offset: number,
): Promise<PaneViewport | null> {
  assertPaneId(paneId);
  const size = cs.getPaneSize(paneId);
  let herdrId: string;
  try {
    herdrId = cs.toHerdr(paneId);
  } catch {
    return null;
  }

  const pane = await getPane(herdrId);
  if (!pane) return null;

  const rows = size?.rows ?? pane.scroll?.viewport_rows ?? 0;
  const cols = size?.cols ?? 80;
  if (rows <= 0 || cols <= 0) return null;

  // Revoke a guessed alt-screen state if host scrollback has grown since the
  // guess: alt screens never append host history, so growth proves the pane
  // is on the normal screen (e.g. inline-mode Claude misdetected at attach).
  const runtimeCheck = cs.getRuntimeState(paneId);
  if (
    runtimeCheck?.altGuessed &&
    (pane.scroll?.max_offset_from_bottom ?? 0) > (runtimeCheck.altGuessBaseline ?? 0)
  ) {
    runtimeCheck.altScreen = false;
    runtimeCheck.altGuessed = false;
  }

  // History the UI is allowed to scroll into: herdr's own metric, clamped to
  // what pane.read can actually reach (1000-line cap minus the window).
  const historySize = Math.max(
    0,
    Math.min(pane.scroll?.max_offset_from_bottom ?? 0, HERDR_READ_CAP - rows),
  );
  const clampedOffset = Math.max(0, Math.min(offset, historySize));

  let lines: string[];
  if (clampedOffset === 0) {
    const text = await readPane(herdrId, 'visible');
    if (text === null) return null;
    lines = text.split('\n').slice(0, rows);
  } else {
    const want = Math.min(clampedOffset + rows, HERDR_READ_CAP);
    const text = await readPane(herdrId, 'recent', want);
    if (text === null) return null;
    const all = text.split('\n');
    const end = Math.max(0, all.length - clampedOffset);
    const start = Math.max(0, end - rows);
    lines = all.slice(start, end);
  }

  while (lines.length < rows) {
    lines.push('');
  }

  const runtime = cs.getRuntimeState(paneId);
  const atTail = clampedOffset === 0;
  // Hide the cursor in scrolled mode so the client doesn't render a stale
  // cursor inside historical content (same rule as the tmux backend).
  const cursor: PaneCursor = {
    x: runtime?.cursorX ?? 0,
    y: runtime?.cursorY ?? 0,
    visible: atTail && (runtime?.cursorVisible ?? false),
  };
  const modes: PaneModes = { altScreen: runtime?.altScreen ?? false };

  return {
    paneId,
    cols,
    rows,
    lines,
    cursor,
    modes,
    historySize,
    offset: clampedOffset,
    atTail,
  };
}
