import type { ServerWebSocket } from 'bun';
import { HerdrService, findSessionByAddress } from '../services/herdr';
import {
  captureViewportHerdr,
  getOrCreateHerdrControlSession,
  type HerdrControlSession,
} from '../services/herdr-control';
import { startAgentStatusWatcher, stopAgentStatusWatcher } from '../services/herdr-agent-status';
import {
  resetGlassesRelayTracker,
  subscribeGlassesRelay,
  trackGlassesRelay,
  unsubscribeGlassesRelay,
} from '../services/glasses-relay';
import { recordGlassesFocus, recordGlassesInput, recordGlassesScreen } from '../services/glasses-screen-recorder';
import { ConversationWatcher } from '../services/conversation-watcher';
import type {
  ClientFocus,
  ControlClientMessage,
  GlassesScreen,
  MuxClientMessage,
  ConversationMessage,
  SessionResponse,
} from '../../../shared/types';
import { MuxClientMessageSchema } from '../../../shared/types';
import { buildSessionsList, invalidateWorkspacesCache } from './sessions';

// Output → push debounce. Wait this long after the last %output for a pane
// before recapturing. Shorter = lower latency; longer = fewer captures.
const PUSH_DEBOUNCE_MS = 50;

// Hard rate limit per pane per subscription. Live-mode clients receive at
// most one unsolicited viewport push per this window. Each push runs
// display-message + capture-pane + ~10KB JSON, so removing the cap let a
// continuously-redrawing pane consume runaway CPU.
// 200ms = 5/sec/pane.
const PUSH_MIN_INTERVAL_MS = 200;

const DEBUG_MUX = process.env.DEBUG_MUX === '1' || process.env.DEBUG_MUX === 'true';

/** Per-session subscription state for a mux client */
interface MuxSubscription {
  controlSession: HerdrControlSession;
  cleanupFns: Array<() => void>;
  // True once the client has sent at least one `resize` message. The first
  // resize uses setClientSizeImmediate (synchronous PTY size adoption);
  // subsequent resizes use the dedup'd path.
  firstResizeReceived: boolean;
  // Last `offset` the client requested for each pane. 0 means live mode;
  // server pushes fresh viewports unsolicited on %output. >0 means the
  // client is viewing historical scrollback; the server is silent until
  // the client asks for a new offset.
  liveOffset: Map<string, number>;
  // Per-pane debounce timers for unsolicited viewport pushes.
  pushTimers: Map<string, Timer>;
  // Wall-clock of the last unsolicited push, for PUSH_MIN_INTERVAL_MS.
  lastPushAt: Map<string, number>;
  // Pane IDs the subscription has ever touched (request-viewport, push).
  // Used by resize to re-push known panes after the layout reflows.
  knownPanes: Set<string>;
}

export interface MuxData {
  mux: true;
  visitorId: string;
  /** Stable per-device identifier sent by the client (localStorage UUID).
   *  Used to count unique devices, falling back to visitorId if absent. */
  deviceId?: string;
  subscriptions: Map<string, MuxSubscription>;
  conversationWatchers: Map<string, ConversationWatcher>;
  lastPingAt: number;
  // ── Glasses focus follow ──
  /** Declared by `client-info`; a connection without one never claims focus. */
  deviceType?: 'mobile' | 'tablet' | 'desktop';
  /** document.visibilityState mirror. `false` = pocketed/asleep → not a
   *  focus candidate. `undefined` = never declared → also not a candidate. */
  visible?: boolean;
  /** `navigator.webdriver`: a browser being driven rather than watched. */
  automated?: boolean;
  /** Session this client last opened, and when. */
  focusSessionId?: string;
  focusAt?: number;
  /** Set by `subscribe-glasses-relay`: the glasses follow focus, never claim
   *  it, otherwise following would feed back into the election. */
  isGlasses?: boolean;
  /** Set by `subscribe-glasses-screen`: this connection watches the mirror. */
  watchesGlassesScreen?: boolean;
}

// ── Glasses screen mirror ──
//
// The device publishes the three strings it just drew; browsers render them
// with the simulator's own painter. Last frame is retained so a viewer joining
// mid-demo sees the current screen instead of a blank panel until the next
// render.

let lastGlassesScreen: GlassesScreen | null = null;
let glassesScreenPublisher: ServerWebSocket<MuxData> | null = null;

function sendGlassesScreen(ws: ServerWebSocket<MuxData>, screen: GlassesScreen | null) {
  try { ws.send(JSON.stringify({ type: 'glasses-screen', screen })); } catch { /* disconnected */ }
}

function broadcastGlassesScreen(screen: GlassesScreen | null) {
  for (const client of activeMuxConnections) {
    if (client.data.watchesGlassesScreen) sendGlassesScreen(client, screen);
  }
}

const herdrService = new HerdrService();

// Track mux connections for broadcast
const activeMuxConnections = new Set<ServerWebSocket<MuxData>>();

// ── Glasses focus follow ──

/** Elect the session the user is looking at: among clients that declared
 *  themselves visible, the one that opened a session most recently. Returns
 *  undefined when nothing qualifies (all hidden / none declared), which tells
 *  followers to hold their current view rather than blank it. */
/**
 * The screen a person is looking at, among the connected clients.
 *
 * Pure and exported for the tests; the caller supplies the connections.
 */
export function pickClientFocus(clients: MuxData[]): ClientFocus | undefined {
  let best: MuxData | undefined;
  for (const d of clients) {
    // The glasses follow focus; letting them claim it would be a feedback loop.
    if (d.isGlasses) continue;
    // Focus means "the screen a person is looking at", and a driven browser is
    // not one. This machine runs several agents that open the web UI headlessly
    // to take screenshots; each claimed the focus, and a wearer reading a
    // conversation was carried off to whatever session one of them landed on -
    // three times in one recording. Refused here rather than filtered by the
    // glasses, because nothing downstream wants it either.
    if (d.automated) continue;
    if (!d.deviceType || !d.focusSessionId || d.visible !== true) continue;
    if (!best || (d.focusAt ?? 0) > (best.focusAt ?? 0)) best = d;
  }
  if (!best?.focusSessionId || !best.deviceType) return undefined;
  return { sessionId: best.focusSessionId, deviceType: best.deviceType, at: best.focusAt ?? 0 };
}

function computeClientFocus(): ClientFocus | undefined {
  return pickClientFocus([...activeMuxConnections].map((ws) => ws.data));
}

/** Last broadcast focus, so a re-election that lands on the same session
 *  doesn't cost a session-list rebuild. */
let lastFocusKey = '';

function focusKey(f: ClientFocus | undefined): string {
  return f ? `${f.sessionId}:${f.deviceType}` : '';
}

/** Re-elect and, when the winner actually changed, push it out immediately.
 *  The 5s sessions timer would otherwise sit on the change, and following a
 *  phone that lags five seconds behind is worse than not following at all. */
function maybePushFocus(): void {
  const key = focusKey(computeClientFocus());
  if (key === lastFocusKey) return;
  lastFocusKey = key;
  pushSessionsNow();
}

function sessionsUpdatedPayload(sessions: SessionResponse[]): string {
  const focus = computeClientFocus();
  lastFocusKey = focusKey(focus);
  // Every payload passes through here (periodic and pushed), so this is the
  // one place the demo recording (#127) learns which session the user is
  // working in. The recorder dedups; unchanged focus costs nothing.
  recordGlassesFocus(focus);
  return JSON.stringify({ type: 'sessions-updated', sessions, ...(focus ? { focus } : {}) });
}

// Zombie detection: if no client ping for 60s, assume connection is dead.
const PING_TIMEOUT_MS = 60_000;
setInterval(() => {
  const now = Date.now();
  for (const ws of activeMuxConnections) {
    if (now - ws.data.lastPingAt > PING_TIMEOUT_MS) {
      console.log(`[mux] Zombie connection detected: ${ws.data.visitorId} (last ping ${Math.round((now - ws.data.lastPingAt) / 1000)}s ago)`);
      try { ws.close(1008, 'ping timeout'); } catch { /* ignore */ }
      activeMuxConnections.delete(ws);
    }
  }
}, 30_000);

// =============================================================================
// Sessions push
// =============================================================================

const SESSIONS_PUSH_INTERVAL = 5000;
let sessionsPushTimer: ReturnType<typeof setInterval> | null = null;
let lastSessionsJson = '';

function startSessionsPush() {
  if (sessionsPushTimer) return;
  // herdr tells us the instant an agent changes state; the interval below is
  // the floor (metrics, recap, anything herdr doesn't emit), not the ceiling.
  startAgentStatusWatcher(() => {
    if (activeMuxConnections.size > 0) pushSessionsNow();
    // Relay tracker rides the same event (#504): it diffs pane statuses and,
    // while glasses are subscribed, turns blocked transitions into relay items.
    void trackGlassesRelay();
  });
  sessionsPushTimer = setInterval(async () => {
    if (activeMuxConnections.size === 0) {
      stopSessionsPush();
      return;
    }
    void trackGlassesRelay(); // self-heal any missed status event
    try {
      const sessions = await buildSessionsList();
      const stableJson = JSON.stringify(sessions, (key, value) =>
        key === 'durationMinutes' ? undefined : value
      );
      if (stableJson === lastSessionsJson) return;
      lastSessionsJson = stableJson;
      const payload = sessionsUpdatedPayload(sessions);
      for (const ws of activeMuxConnections) {
        try { ws.send(payload); } catch { /* disconnected */ }
      }
    } catch (err) {
      console.warn('[mux] sessions push error:', err);
    }
  }, SESSIONS_PUSH_INTERVAL);
}

function stopSessionsPush() {
  if (sessionsPushTimer) {
    clearInterval(sessionsPushTimer);
    sessionsPushTimer = null;
  }
  stopAgentStatusWatcher();
  // No observers at all: drop tracker state so the next start re-baselines
  // silently instead of firing stale transitions. Store items survive; the
  // subscribe-time snapshot prunes any whose blocked epoch ended meanwhile.
  resetGlassesRelayTracker();
  lastSessionsJson = '';
}

export function pushSessionsNow() {
  lastSessionsJson = '';
  buildSessionsList().then(sessions => {
    const payload = sessionsUpdatedPayload(sessions);
    for (const ws of activeMuxConnections) {
      try { ws.send(payload); } catch { /* disconnected */ }
    }
  }).catch(() => {});
}

export function getConnectedClientCount(): number {
  // Count unique devices, not raw WebSocket connections.
  // A client without a deviceId (very old client / direct WS test) falls back
  // to its per-connection visitorId so it still counts as one.
  const devices = new Set<string>();
  for (const ws of activeMuxConnections) {
    devices.add(ws.data.deviceId ?? ws.data.visitorId);
  }
  return devices.size;
}

export function broadcastToMuxClients(msg: Record<string, unknown>) {
  const payload = JSON.stringify(msg);
  for (const ws of activeMuxConnections) {
    try { ws.send(payload); } catch { /* disconnected */ }
  }
}

export async function muxOpen(ws: ServerWebSocket<MuxData>) {
  console.log(`[mux] WebSocket opened: ${ws.data.visitorId}`);
  activeMuxConnections.add(ws);
  startSessionsPush();

  try {
    const sessions = await buildSessionsList();
    ws.send(sessionsUpdatedPayload(sessions));
  } catch { /* best effort */ }

  ws.send(JSON.stringify({ type: 'ready' }));
}

export async function muxMessage(ws: ServerWebSocket<MuxData>, message: string | Buffer) {
  if (typeof message !== 'string') return;

  let raw: unknown;
  try {
    raw = JSON.parse(message);
  } catch {
    return;
  }

  // Validate the frame before any field reaches a herdr control-stream command.
  // Invalid/unknown frames (incl. paneId or cols/rows injection attempts) are
  // dropped here. #231.
  const parsed = MuxClientMessageSchema.safeParse(raw);
  if (!parsed.success) return;
  const msg = parsed.data as MuxClientMessage;

  if (msg.type === 'subscribe') {
    await handleSubscribe(ws, msg.sessionId);
    // Opening a session claims the glasses focus — watching, not typing,
    // is what the user does most of the time.
    ws.data.focusSessionId = msg.sessionId;
    ws.data.focusAt = Date.now();
    maybePushFocus();
    return;
  }

  if (msg.type === 'unsubscribe') {
    handleUnsubscribe(ws, msg.sessionId);
    if (ws.data.focusSessionId === msg.sessionId) {
      ws.data.focusSessionId = undefined;
      maybePushFocus();
    }
    return;
  }

  if (msg.type === 'subscribe-conversation') {
    await handleSubscribeConversation(ws, msg.sessionId, msg.agentSessionId);
    return;
  }

  if (msg.type === 'unsubscribe-conversation') {
    handleUnsubscribeConversation(ws, msg.sessionId, msg.agentSessionId);
    return;
  }

  // Glasses relay presence subscription (#504). Handled before the sessionId
  // gate below, like ping: it marks the whole connection (no sessionId) as
  // "glasses present", which gates relay assembly/sending.
  if (msg.type === 'subscribe-glasses-relay') {
    // Marks this connection as a follower, excluding it from the focus
    // election. The simulator follows too, so this is not the device flag.
    ws.data.isGlasses = true;
    // Absent means device: an ehpk predating the field is on a face, while the
    // simulator ships inside the server binary that reads it, so it can never
    // be the older of the two.
    // `instanceId` lets the server retire the app's previous run, which the
    // host does not do for us (everything-evenhub#16, "Ghost WebViews on
    // relaunch").
    await subscribeGlassesRelay(ws, msg.onDevice !== false, msg.instanceId);
    return;
  }

  if (msg.type === 'unsubscribe-glasses-relay') {
    unsubscribeGlassesRelay(ws);
    return;
  }

  // Screen mirror (demo). Publishing is not gated on `isGlasses`: a client
  // that publishes has a real bridge by construction, and the simulator never
  // calls this.
  if (msg.type === 'glasses-screen') {
    lastGlassesScreen = msg.screen;
    glassesScreenPublisher = ws;
    // Demo recording (#127) taps the stream here, before the viewer check:
    // it must see every frame whether or not a mirror is open.
    recordGlassesScreen(msg.screen);
    broadcastGlassesScreen(msg.screen);
    return;
  }

  // Ring gestures (#129). Recording-only: viewers of the live mirror need the
  // resulting frame, not the finger, so nothing is broadcast.
  if (msg.type === 'glasses-input') {
    recordGlassesInput(msg.input);
    return;
  }

  if (msg.type === 'subscribe-glasses-screen') {
    ws.data.watchesGlassesScreen = true;
    sendGlassesScreen(ws, lastGlassesScreen);
    return;
  }

  if (msg.type === 'unsubscribe-glasses-screen') {
    ws.data.watchesGlassesScreen = false;
    return;
  }

  // Keepalive. Handle before the sessionId/subscription gate below: the client
  // pings with sessionId="" whenever no terminal is selected (dashboard, file
  // viewer, history). If those pings were dropped, the client never gets a
  // pong, force-closes after the timeout, and reconnect-storms. #236
  if (msg.type === 'ping') {
    ws.data.lastPingAt = Date.now();
    ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp }));
    return;
  }

  const sessionId = (msg as { sessionId?: string }).sessionId;
  if (!sessionId) return;

  const sub = ws.data.subscriptions.get(sessionId);
  if (!sub) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not subscribed to session', sessionId }));
    return;
  }

  const { sessionId: _sid, ...controlMsg } = msg as ControlClientMessage & { sessionId: string };
  await handleControlMessage(ws, sub, sessionId, controlMsg as ControlClientMessage);
}

export function muxClose(ws: ServerWebSocket<MuxData>, code: number, reason: string) {
  console.log(`[mux] WebSocket closed: ${ws.data.visitorId} (code=${code}, reason=${reason})`);
  activeMuxConnections.delete(ws);
  // A glasses run ending, recorded from the one place that does not depend on
  // the run being able to speak. The app announces its own exit when the host
  // gives it the chance, but five of nineteen runs on 2026-07-31 were killed
  // too abruptly for that and left nothing behind at all.
  const departed = unsubscribeGlassesRelay(ws);
  if (departed?.onDevice) {
    const who = departed.instanceId ? `[${departed.instanceId}]` : '(no instance id)';
    console.log(`[glasses-relay] device gone: ${who} code=${code} reason=${reason || '(none)'}`);
  }
  // The publisher going away must reach the viewers: a mirror that keeps
  // showing the last frame is indistinguishable from a live one that has
  // stopped changing.
  if (glassesScreenPublisher === ws) {
    glassesScreenPublisher = null;
    lastGlassesScreen = null;
    recordGlassesScreen(null);
    broadcastGlassesScreen(null);
  }
  if (activeMuxConnections.size === 0) stopSessionsPush();
  // A disconnect can hand the focus to another device.
  else maybePushFocus();

  for (const [sessionId, sub] of ws.data.subscriptions) {
    cleanupSubscription(ws, sessionId, sub);
  }
  ws.data.subscriptions.clear();

  for (const watcher of ws.data.conversationWatchers.values()) {
    try { watcher.stop(); } catch { /* ignore */ }
  }
  ws.data.conversationWatchers.clear();
}

async function handleSubscribe(ws: ServerWebSocket<MuxData>, sessionId: string) {
  console.log(`[mux] subscribe: ${sessionId} (current subs: ${ws.data.subscriptions.size})`);
  // Already subscribed — reset state so the next resize re-emits initial viewports.
  let existing = ws.data.subscriptions.get(sessionId);
  // A workspace can be deleted and recreated with the same public session id.
  // Never re-use the subscription that still points at the destroyed instance.
  if (existing?.controlSession.isDestroyed) {
    cleanupSubscription(ws, sessionId, existing);
    ws.data.subscriptions.delete(sessionId);
    existing = undefined;
  }
  if (existing) {
    existing.firstResizeReceived = false;
    existing.liveOffset.clear();
    for (const t of existing.pushTimers.values()) clearTimeout(t);
    existing.pushTimers.clear();
    existing.lastPushAt.clear();
    ws.send(JSON.stringify({ type: 'subscribed', sessionId }));
    void emitInitialViewports(ws, sessionId, existing).catch((err) => {
      console.warn(`[mux] re-subscribe viewport emit failed for ${sessionId}:`, err);
    });
    return;
  }

  const exists = await herdrService.workspaceExists(sessionId);
  if (!exists) {
    ws.send(JSON.stringify({ type: 'error', message: 'Session not found', sessionId }));
    return;
  }

  let controlSession: HerdrControlSession | null = null;
  let clientAdded = false;
  const cleanupFns: Array<() => void> = [];
  try {
    controlSession = await getOrCreateHerdrControlSession(sessionId);
    controlSession.addClient();
    clientAdded = true;
    // A live terminal client needs the per-pane control streams (raw input,
    // frame-driven pushes, PTY sizing); read-only REST paths never do this.
    controlSession.enableControllers();

    const sub: MuxSubscription = {
      controlSession,
      cleanupFns,
      firstResizeReceived: false,
      liveOffset: new Map(),
      pushTimers: new Map(),
      lastPushAt: new Map(),
      knownPanes: new Set(),
    };

    // %output → schedule a push for any pane this subscription is viewing
    // in live mode. Panes the client has scrolled away from (offset>0) are
    // silent until the client asks for new content. Initial viewports are
    // emitted at subscribe time (below) so we don't need to gate this on
    // `sub.initialized`.
    cleanupFns.push(
      controlSession.onOutput((paneId, _data) => {
        if ((sub.liveOffset.get(paneId) ?? 0) !== 0) return;
        schedulePush(ws, sessionId, sub, paneId);
      })
    );

    // Layout listener
    cleanupFns.push(
      controlSession.onLayoutChange((layout, zoomedPaneId) => {
        try {
          ws.send(JSON.stringify({ type: 'layout', layout, zoomedPaneId, sessionId }));
        } catch { /* disconnected */ }
      })
    );

    cleanupFns.push(
      controlSession.onExit((reason) => {
        try {
          ws.send(JSON.stringify({ type: 'session-exited', reason, sessionId }));
        } catch { /* disconnected */ }
        handleUnsubscribe(ws, sessionId);
      })
    );

    // The client can disconnect while the awaits above are in flight. muxClose
    // has already run at that point and didn't see this subscription, so the
    // listeners and addClient() would leak (the grace period would never
    // start and the pane control-stream subprocess would live forever). #346
    if (!activeMuxConnections.has(ws)) {
      console.log(`[mux] client disconnected during subscribe to ${sessionId}; rolling back`);
      for (const fn of cleanupFns) {
        try { fn(); } catch { /* ignore */ }
      }
      controlSession.removeClient();
      return;
    }

    ws.data.subscriptions.set(sessionId, sub);

    try {
      const layout = controlSession.getCurrentLayout();
      if (layout) {
        ws.send(
          JSON.stringify({
            type: 'layout',
            layout,
            zoomedPaneId: controlSession.zoomedPaneId,
            sessionId,
          }),
        );
      }
    } catch (err) {
      console.error(`[mux] Failed to send initial layout for ${sessionId}:`, err);
    }

    ws.send(JSON.stringify({ type: 'subscribed', sessionId }));

    // Eagerly emit an initial viewport for every pane so the client has
    // content to render even before its first `resize` arrives. Mobile
    // browsers in particular can mount the Terminal component, register
    // its viewport callback, and start expecting content before they
    // measure / send a resize — leaving a blank canvas if we wait.
    // sub.initialized stays false until a real resize comes in; the
    // resize handler is responsible for actually setting the pane's PTY
    // size and re-pushing viewports if dimensions change.
    void emitInitialViewports(ws, sessionId, sub).catch((err) => {
      console.warn(`[mux] initial viewport emit failed for ${sessionId}:`, err);
    });
  } catch (error) {
    console.error(`[mux] Failed to subscribe to ${sessionId}:`, error);
    // Roll back whatever was set up before the failure. Without this the
    // client count stays over-counted, the grace period never starts, and
    // the pane control-stream subprocess lives forever (#332).
    for (const fn of cleanupFns) {
      try { fn(); } catch { /* ignore */ }
    }
    if (ws.data.subscriptions.get(sessionId)?.controlSession === controlSession) {
      ws.data.subscriptions.delete(sessionId);
    }
    if (clientAdded && controlSession) {
      controlSession.removeClient();
    }
    try {
      const detail = error instanceof Error ? error.message : String(error);
      ws.send(JSON.stringify({ type: 'error', message: `Failed to subscribe: ${detail}`, sessionId }));
    } catch { /* disconnected */ }
  }
}

function handleUnsubscribe(ws: ServerWebSocket<MuxData>, sessionId: string) {
  console.log(`[mux] unsubscribe: ${sessionId} (current subs: ${ws.data.subscriptions.size})`);
  const sub = ws.data.subscriptions.get(sessionId);
  if (sub) {
    cleanupSubscription(ws, sessionId, sub);
    ws.data.subscriptions.delete(sessionId);
  }
  try {
    ws.send(JSON.stringify({ type: 'unsubscribed', sessionId }));
  } catch { /* disconnected */ }
}

function cleanupSubscription(ws: ServerWebSocket<MuxData>, _sessionId: string, sub: MuxSubscription) {
  for (const fn of sub.cleanupFns) fn();
  for (const t of sub.pushTimers.values()) clearTimeout(t);
  sub.pushTimers.clear();
  sub.lastPushAt.clear();
  sub.controlSession.removeClientDeviceType(ws.data.visitorId);
  sub.controlSession.removeClientDemands(ws.data.visitorId);
  sub.controlSession.removeClientSize(ws.data.visitorId);
  sub.controlSession.removeClient();
}

// =============================================================================
// Viewport push (unsolicited, for live-mode panes)
// =============================================================================

function schedulePush(
  ws: ServerWebSocket<MuxData>,
  sessionId: string,
  sub: MuxSubscription,
  paneId: string,
) {
  if (sub.pushTimers.has(paneId)) return;
  const lastAt = sub.lastPushAt.get(paneId) ?? 0;
  const sinceLast = Date.now() - lastAt;
  const delay = Math.max(PUSH_DEBOUNCE_MS, PUSH_MIN_INTERVAL_MS - sinceLast);
  const timer = setTimeout(() => {
    sub.pushTimers.delete(paneId);
    void pushViewport(ws, sessionId, sub, paneId, 0);
  }, delay);
  sub.pushTimers.set(paneId, timer);
}

async function pushViewport(
  ws: ServerWebSocket<MuxData>,
  sessionId: string,
  sub: MuxSubscription,
  paneId: string,
  offset: number,
) {
  if (sub.controlSession.isDestroyed) return;
  let viewport: Awaited<ReturnType<typeof captureViewportHerdr>> = null;
  try {
    viewport = await captureViewportHerdr(sub.controlSession, paneId, offset);
  } catch (err) {
    console.warn(`[mux] captureViewport failed for ${paneId}:`, err);
    return;
  }
  if (!viewport) return;

  sub.knownPanes.add(paneId);
  if (DEBUG_MUX) {
    console.log(`[mux] viewport pane=${paneId} offset=${viewport.offset}/${viewport.historySize} rows=${viewport.rows}`);
  }
  try {
    ws.send(JSON.stringify({ type: 'viewport', sessionId, viewport }));
  } catch { return; }
  sub.lastPushAt.set(paneId, Date.now());
}

async function emitInitialViewports(
  ws: ServerWebSocket<MuxData>,
  sessionId: string,
  sub: MuxSubscription,
) {
  let panes: Awaited<ReturnType<HerdrControlSession['listPanes']>> = [];
  try {
    panes = await sub.controlSession.listPanes();
  } catch (err) {
    console.warn(`[mux] listPanes failed for ${sessionId}:`, err);
    return;
  }
  for (const pane of panes) {
    sub.liveOffset.set(pane.paneId, 0);
    await pushViewport(ws, sessionId, sub, pane.paneId, 0);
  }
}

/**
 * Watcher key.
 *
 * A workspace is not a conversation: two agent panes in one workspace are two,
 * and keying the watcher by workspace alone meant the second subscription
 * silently tore down the first (#80).
 */
function conversationKey(sessionId: string, agentSessionId?: string): string {
  return agentSessionId ? `${sessionId}\u0000${agentSessionId}` : sessionId;
}

async function handleSubscribeConversation(
  ws: ServerWebSocket<MuxData>,
  sessionId: string,
  agentSessionId?: string,
) {
  console.log(`[mux] subscribe-conversation: ${sessionId}${agentSessionId ? ` agent=${agentSessionId}` : ''}`);
  const key = conversationKey(sessionId, agentSessionId);

  const existing = ws.data.conversationWatchers.get(key);
  if (existing) {
    try { existing.stop(); } catch { /* ignore */ }
    ws.data.conversationWatchers.delete(key);
  }

  let workingDir: string | undefined;
  try {
    const sessions = await herdrService.listWorkspaces();
    const { session } = findSessionByAddress(sessions, sessionId);
    // The pane's own directory, not the workspace's. `currentPath` is the
    // first agent pane's, so a second pane working elsewhere would have been
    // read against a project directory it has no transcript in.
    const pane = agentSessionId
      ? session?.panes?.find(p => p.agentSessionId === agentSessionId)
      : undefined;
    workingDir = pane?.path || session?.currentPath;
  } catch (err) {
    console.warn(`[mux] subscribe-conversation: failed to list sessions: ${err}`);
  }

  if (!workingDir) {
    try {
      ws.send(JSON.stringify({ type: 'conversation-subscribed', sessionId, agentSessionId, ccSessionId: null }));
      ws.send(JSON.stringify({ type: 'initial-conversation', sessionId, agentSessionId, messages: [] }));
    } catch { /* disconnected */ }
    return;
  }

  const watcher = new ConversationWatcher();
  let initialMessages: ConversationMessage[] = [];
  try {
    initialMessages = await watcher.start(workingDir, agentSessionId);
  } catch (err) {
    console.warn(`[mux] subscribe-conversation start failed for ${sessionId}:`, err);
  }

  // The client can disconnect while watcher.start() is in flight. muxClose
  // has already run at that point and didn't see this watcher, so its
  // FSWatcher would keep running forever. #346
  if (!activeMuxConnections.has(ws)) {
    console.log(`[mux] client disconnected during subscribe-conversation to ${sessionId}; stopping watcher`);
    try { watcher.stop(); } catch { /* ignore */ }
    return;
  }

  watcher.onUpdate((newMessages) => {
    try {
      ws.send(JSON.stringify({ type: 'conversation-update', sessionId, agentSessionId, messages: newMessages }));
    } catch { /* disconnected */ }
  });

  ws.data.conversationWatchers.set(key, watcher);

  try {
    ws.send(JSON.stringify({
      type: 'conversation-subscribed',
      sessionId,
      agentSessionId,
      ccSessionId: watcher.getCcSessionId(),
    }));
    ws.send(JSON.stringify({
      type: 'initial-conversation',
      sessionId,
      agentSessionId,
      messages: initialMessages,
    }));
  } catch { /* disconnected */ }
}

function handleUnsubscribeConversation(
  ws: ServerWebSocket<MuxData>,
  sessionId: string,
  agentSessionId?: string,
) {
  console.log(`[mux] unsubscribe-conversation: ${sessionId}${agentSessionId ? ` agent=${agentSessionId}` : ''}`);
  const key = conversationKey(sessionId, agentSessionId);
  const watcher = ws.data.conversationWatchers.get(key);
  if (watcher) {
    try { watcher.stop(); } catch { /* ignore */ }
    ws.data.conversationWatchers.delete(key);
  }
  try {
    ws.send(JSON.stringify({ type: 'conversation-unsubscribed', sessionId, agentSessionId }));
  } catch { /* disconnected */ }
}

// =============================================================================
// Control message dispatch
// =============================================================================

async function handleControlMessage(
  ws: ServerWebSocket<MuxData>,
  sub: MuxSubscription,
  sessionId: string,
  msg: ControlClientMessage,
) {
  const { controlSession } = sub;

  try {
    switch (msg.type) {
      case 'input': {
        const data = Buffer.from(msg.data, 'base64');
        console.log(`[mux] input pane=${msg.paneId} bytes=${data.length}`);
        // Typing on a device makes it the size owner (active-client sizing).
        controlSession.markClientActive(ws.data.visitorId);
        await controlSession.sendInput(msg.paneId, data);
        // Pre-arm a push: input usually generates output but a silent program
        // (waiting for full line, etc.) wouldn't, and we still want to refresh
        // cursor position promptly.
        if ((sub.liveOffset.get(msg.paneId) ?? 0) === 0) {
          schedulePush(ws, sessionId, sub, msg.paneId);
        }
        break;
      }
      case 'resize': {
        try {
          if (msg.active) {
            // Explicit tap/focus claim: this client takes ownership of the size.
            controlSession.setClientSize(ws.data.visitorId, msg.cols, msg.rows, true);
          } else if (!sub.firstResizeReceived) {
            // First resize: force the panes to adopt the new client size
            // synchronously. Subsequent resizes go through the dedup'd path.
            await controlSession.setClientSizeImmediate(ws.data.visitorId, msg.cols, msg.rows);
            sub.firstResizeReceived = true;
            // Brief settle window so the panes reflow before we capture, then
            // push viewports at the new size (the ones we emitted at subscribe
            // time were at whatever size the panes had previously).
            await new Promise(resolve => setTimeout(resolve, 100));
          } else {
            controlSession.setClientSize(ws.data.visitorId, msg.cols, msg.rows);
          }
          for (const paneId of sub.knownPanes) {
            if ((sub.liveOffset.get(paneId) ?? 0) === 0) {
              schedulePush(ws, sessionId, sub, paneId);
            }
          }
        } catch (err) {
          console.error(`[mux] resize failed for ${sessionId}:`, err);
        }
        break;
      }
      case 'split': {
        await controlSession.splitPane(msg.paneId, msg.direction);
        break;
      }
      case 'close-pane': {
        try {
          await controlSession.closePane(msg.paneId);
        } catch (e) {
          ws.send(JSON.stringify({
            type: 'error',
            message: e instanceof Error ? e.message : 'Failed to close pane',
            paneId: msg.paneId,
            sessionId,
          }));
        }
        break;
      }
      case 'resize-pane': {
        await controlSession.resizePane(msg.paneId, msg.cols, msg.rows);
        break;
      }
      case 'select-pane': {
        await controlSession.selectPane(msg.paneId);
        break;
      }
      case 'adjust-pane': {
        await controlSession.adjustPaneSize(msg.paneId, msg.direction, msg.amount);
        break;
      }
      case 'set-split-ratios': {
        await controlSession.setSplitRatios(msg.entries);
        break;
      }
      case 'equalize-panes': {
        await controlSession.equalizePanes(msg.direction);
        break;
      }
      case 'zoom-pane': {
        try {
          await controlSession.zoomPane(msg.paneId, msg.zoomed);
          await new Promise(resolve => setTimeout(resolve, 100));
          // Zoom changes pane size; emit a fresh viewport in live mode.
          if ((sub.liveOffset.get(msg.paneId) ?? 0) === 0) {
            await pushViewport(ws, sessionId, sub, msg.paneId, 0);
          }
        } catch (err) {
          console.warn(`[mux] zoom-pane failed for ${msg.paneId}:`, err);
        }
        break;
      }
      case 'request-viewport': {
        sub.liveOffset.set(msg.paneId, Math.max(0, msg.offset | 0));
        await pushViewport(ws, sessionId, sub, msg.paneId, msg.offset);
        break;
      }
      case 'client-info': {
        controlSession.setClientDeviceType(ws.data.visitorId, msg.deviceType);
        // Focus follow. A client competes for the glasses focus only
        // while its page is visible; picking a device back up re-claims it,
        // which is the same intent as opening a session on it.
        ws.data.deviceType = msg.deviceType;
        if (msg.automated !== undefined) ws.data.automated = msg.automated;
        if (msg.visible !== undefined) {
          const wasVisible = ws.data.visible;
          ws.data.visible = msg.visible;
          if (msg.visible && !wasVisible) ws.data.focusAt = Date.now();
          maybePushFocus();
        }
        break;
      }
      case 'pane-demands': {
        // Record this client's per-pane render sizes (per-client sizing).
        // Dormant until per-client sizing is enabled — recorded, not yet
        // consulted for PTY sizing.
        controlSession.setPaneDemands(ws.data.visitorId, msg.demands);
        break;
      }
      case 'select-tab':
      case 'create-tab':
      case 'close-tab': {
        try {
          if (msg.type === 'select-tab') await controlSession.selectTab(msg.tabId);
          else if (msg.type === 'create-tab') await controlSession.createTab();
          else await controlSession.closeTab(msg.tabId);
          // Reflect the new tab set / active tab in the pushed session list now,
          // not after the 2s cache TTL (the layout already switched via reconcile).
          invalidateWorkspacesCache();
          pushSessionsNow();
        } catch (e) {
          ws.send(JSON.stringify({
            type: 'error',
            message: e instanceof Error ? e.message : 'Tab operation failed',
            sessionId,
          }));
        }
        break;
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    ws.send(JSON.stringify({ type: 'error', message: errMsg, sessionId }));
  }
}
