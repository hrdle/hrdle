import type { ServerWebSocket } from 'bun';
import type { HerdrControlSession } from '../../services/herdr-control';
import type { ConversationWatcher } from '../../services/conversation-watcher';

/** Per-session subscription state for a mux client */
export interface MuxSubscription {
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
  /** Set by `subscribe-glasses-relay`: what this connection subscribes to is
   *  the election's own output, so none of the fields above are a claim on it.
   *  Only `glasses-focus` is. */
  isGlasses?: boolean;
  /** The session the wearer last picked with the ring, and when. Separate from
   *  `focusSessionId`/`focusAt` on purpose: those move with every subscription
   *  the app makes, including the ones it makes because the election told it
   *  to, and reusing them would let a follow re-claim as itself. */
  glassesFocusSessionId?: string;
  glassesFocusAt?: number;
  /** Set by `subscribe-glasses-screen`: this connection watches the mirror. */
  watchesGlassesScreen?: boolean;
  /** Last `client-info` this connection was logged as saying, so a page
   *  re-declaring the same thing on every session switch is logged once. */
  lastDeclaration?: string;
}

/** Every open mux connection. The focus election, the sessions push and the
 *  glasses mirror all read it; only the handlers in terminal-mux.ts change it. */
export const activeMuxConnections = new Set<ServerWebSocket<MuxData>>();

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
