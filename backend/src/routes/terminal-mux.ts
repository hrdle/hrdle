import type { ServerWebSocket } from 'bun';
import { HerdrService } from '../services/herdr';
import { getOrCreateHerdrControlSession, type HerdrControlSession } from '../services/herdr-control';
import { subscribeGlassesRelay, unsubscribeGlassesRelay } from '../services/glasses-relay';
import { recordGlassesInput } from '../services/glasses-screen-recorder';
import type { ControlClientMessage, MuxClientMessage } from '../../../shared/types';
import { MuxClientMessageSchema } from '../../../shared/types';
import { invalidateWorkspacesCache } from '../services/session-list';
import {
  applyClientInfoFocus,
  applySubscribeFocus,
  logClientPresence,
  logFocusClaim,
} from './mux/client-focus';
import { activeMuxConnections, type MuxData, type MuxSubscription } from './mux/connections';
import { handleSubscribeConversation, handleUnsubscribeConversation } from './mux/conversation';
import { publishGlassesScreen, releaseGlassesScreen, watchGlassesScreen } from './mux/glasses-screen';
import {
  maybePushFocus,
  pushSessionsNow,
  sendInitialSessions,
  startSessionsPush,
  stopSessionsPush,
} from './mux/sessions-push';
import { emitInitialViewports, pushViewport, schedulePush } from './mux/viewport-push';

const herdrService = new HerdrService();

export async function muxOpen(ws: ServerWebSocket<MuxData>) {
  console.log(`[mux] WebSocket opened: ${ws.data.visitorId}`);
  activeMuxConnections.add(ws);
  startSessionsPush();

  // This frame races the connection's "I am the glasses" announcement, which
  // lands while the list is being built - so which list it gets is decided
  // after the build, in sendSessionsTo.
  await sendInitialSessions(ws);

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
  // dropped here.
  const parsed = MuxClientMessageSchema.safeParse(raw);
  if (!parsed.success) return;
  const msg = parsed.data as MuxClientMessage;

  if (msg.type === 'subscribe') {
    await handleSubscribe(ws, msg.sessionId);
    const claimed = ws.data.focusAt;
    applySubscribeFocus(ws.data, msg, Date.now());
    logFocusClaim(ws, claimed, 'opened a session');
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

  // Glasses relay presence subscription. Handled before the sessionId
  // gate below, like ping: it marks the whole connection (no sessionId) as
  // "glasses present", which gates relay assembly/sending.
  if (msg.type === 'subscribe-glasses-relay') {
    // Marks this connection as a follower, excluding it from the focus
    // election. The simulator follows too, so this is not the device flag.
    ws.data.isGlasses = true;
    // Anything a subscribe wrote before this arrived is not a claim either. The
    // app subscribes to the relay first, so today there is nothing to discard;
    // this keeps the invariant a property of the flag rather than of the order
    // two messages happen to be sent in.
    ws.data.focusSessionId = undefined;
    ws.data.focusAt = undefined;
    // The merged list is wanted from this moment; the next push is up to 5s away.
    void sendInitialSessions(ws);
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
    ws.data.glassesFocusSessionId = undefined;
    ws.data.glassesFocusAt = undefined;
    maybePushFocus();
    return;
  }

  // The wearer picked a session with the ring. Accepted only from a connection
  // that declared itself glasses, so an ordinary client cannot mint a claim
  // that skips the visibility rules the election holds it to.
  if (msg.type === 'glasses-focus') {
    if (!ws.data.isGlasses) return;
    ws.data.glassesFocusSessionId = msg.sessionId;
    ws.data.glassesFocusAt = Date.now();
    console.log(`[focus] glasses claim ${msg.sessionId}: ring selection`);
    maybePushFocus();
    return;
  }

  // Screen mirror (demo). Publishing is not gated on `isGlasses`: a client
  // that publishes has a real bridge by construction, and the simulator never
  // calls this.
  if (msg.type === 'glasses-screen') {
    publishGlassesScreen(ws, msg.screen);
    return;
  }

  // Ring gestures. Recording-only: viewers of the live mirror need the
  // resulting frame, not the finger, so nothing is broadcast.
  if (msg.type === 'glasses-input') {
    recordGlassesInput(msg.input);
    return;
  }

  if (msg.type === 'subscribe-glasses-screen') {
    watchGlassesScreen(ws);
    return;
  }

  if (msg.type === 'unsubscribe-glasses-screen') {
    ws.data.watchesGlassesScreen = false;
    return;
  }

  // Keepalive. Handle before the sessionId/subscription gate below: the client
  // pings with sessionId="" whenever no terminal is selected (dashboard, file
  // viewer, history). If those pings were dropped, the client never gets a
  // pong, force-closes after the timeout, and reconnect-storms.
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
  // The other end of a presence line. Arrivals alone cannot say who was there
  // at a given moment, and the close line above carries the visitor id rather
  // than the device - a different identifier, and not the one the election or
  // the claim lines are written in.
  if (ws.data.lastDeclaration) {
    console.log(`[focus] gone ${ws.data.deviceType} (${ws.data.deviceId ?? 'no device id'})`);
  }
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
  releaseGlassesScreen(ws);
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
    // start and the pane control-stream subprocess would live forever).
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
    // the pane control-stream subprocess lives forever.
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
        logClientPresence(ws, msg);
        if (msg.visible !== undefined) {
          const claimed = ws.data.focusAt;
          applyClientInfoFocus(ws.data, { visible: msg.visible, fresh: msg.fresh }, Date.now());
          logFocusClaim(ws, claimed, msg.fresh ? 'opened the page' : 'picked the device up');
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

