import type { ServerWebSocket } from 'bun';
import { VERSION } from '../../cli';
import { startAgentStatusWatcher, stopAgentStatusWatcher } from '../../services/herdr-agent-status';
import { resetGlassesRelayTracker, trackGlassesRelay } from '../../services/glasses-relay';
import { recordGlassesFocus } from '../../services/glasses-screen-recorder';
import { sessionsWithPeers } from '../../services/peer-sessions';
import { buildSessionsList } from '../../services/session-list';
import type { ClientFocus, ExtendedSessionResponse, SessionResponse } from '../../../../shared/types';
import { computeClientFocus } from './client-focus';
import { activeMuxConnections, type MuxData } from './connections';

/** Last broadcast focus, so a re-election that lands on the same session
 *  doesn't cost a session-list rebuild. */
let lastFocusKey = '';

function focusKey(f: ClientFocus | undefined): string {
  return f ? `${f.sessionId}:${f.deviceType}` : '';
}

/** Re-elect and, when the winner actually changed, push it out immediately.
 *  The 5s sessions timer would otherwise sit on the change, and following a
 *  phone that lags five seconds behind is worse than not following at all. */
export function maybePushFocus(): void {
  const key = focusKey(computeClientFocus());
  if (key === lastFocusKey) return;
  lastFocusKey = key;
  pushSessionsNow();
}

/** Elect the focus for one push and record it. Called once per push: the
 *  glasses' frame carries the same election as the browsers', so it must not
 *  re-run this. */
function pushFocus(): ClientFocus | undefined {
  const focus = computeClientFocus();
  lastFocusKey = focusKey(focus);
  // Every payload passes through here (periodic and pushed), so this is the
  // one place the demo recording learns which session the user is
  // working in. The recorder dedups; unchanged focus costs nothing.
  recordGlassesFocus(focus);
  return focus;
}

function sessionsUpdatedPayload(sessions: SessionResponse[], focus: ClientFocus | undefined): string {
  return JSON.stringify({
    type: 'sessions-updated',
    sessions,
    version: VERSION,
    ...(focus ? { focus } : {}),
  });
}

/**
 * The one rule every sessions frame obeys:
 *
 *   **a glasses connection is sent the merged list, or nothing at all.**
 *
 * The app treats each frame as the whole truth and drops any session the frame
 * does not mention. So a single plain frame deletes every peer session it holds,
 * and the next merged frame re-adds them at the end — which is how the group
 * order came out wrong on the device (renders of 17 → 4 → 17 sessions, measured
 * 2026-08-13). Sending nothing costs a stale list for a few seconds; sending the
 * plain list corrupts what the wearer sees.
 *
 * Browsers get the plain list, always: each holds a WebSocket to every peer
 * itself, so a merged list here would show those sessions a second time.
 */
type GlassesList = ExtendedSessionResponse[] | null;

function anyGlassesConnected(): boolean {
  for (const ws of activeMuxConnections) {
    if (ws.data.isGlasses) return true;
  }
  return false;
}

/** The merged list, or null when there is none to send. Never the plain list —
 *  see the rule above: a failed merge must not reach the glasses as a frame. */
async function glassesSessions(local: ExtendedSessionResponse[]): Promise<GlassesList> {
  // No glasses, no fanout: nobody would read the result.
  if (!anyGlassesConnected()) return null;
  try {
    return await sessionsWithPeers(local);
  } catch {
    return null;
  }
}

/** Send one election's frames to every client, each audience its own list.
 *  `to` narrows it to the audience whose list actually changed. */
function broadcastSessions(
  local: ExtendedSessionResponse[],
  forGlasses: GlassesList,
  to: { browsers: boolean; glasses: boolean },
  focus: ClientFocus | undefined,
): void {
  const payload = sessionsUpdatedPayload(local, focus);
  const glassesPayload = forGlasses ? sessionsUpdatedPayload(forGlasses, focus) : null;
  for (const ws of activeMuxConnections) {
    if (ws.data.isGlasses) {
      if (!to.glasses) continue;
      // No merged frame prepared — this connection said "glasses" after the
      // merge was decided. It gets its own, rather than the plain list.
      if (!glassesPayload) { void sendSessionsTo(ws, local); continue; }
      try { ws.send(glassesPayload); } catch { /* disconnected */ }
      continue;
    }
    if (!to.browsers) continue;
    try { ws.send(payload); } catch { /* disconnected */ }
  }
}

/**
 * Send one connection the list it should see.
 *
 * The audience is read here, immediately before the frame is built — not
 * earlier. A connection announces itself as the glasses (`subscribe-glasses-relay`)
 * while the first list is still being assembled, so anything that decided the
 * audience before that assembly sends a plain frame to a connection that has
 * meanwhile become the glasses. That was the bug: the frame `muxOpen` sends
 * never consulted `isGlasses` at all.
 *
 * `isGlasses` only ever goes false → true (nothing clears it), so re-reading it
 * after an await cannot take the merged list away from a glasses connection.
 *
 * `merge` is the test's way in; production always uses the real merge.
 */
export async function sendSessionsTo(
  ws: ServerWebSocket<MuxData>,
  local: ExtendedSessionResponse[],
  merge: (l: ExtendedSessionResponse[]) => Promise<ExtendedSessionResponse[]> = sessionsWithPeers,
): Promise<void> {
  if (!ws.data.isGlasses) {
    // Nothing is awaited between the check and the send, so the audience
    // cannot change underneath it.
    try { ws.send(sessionsUpdatedPayload(local, computeClientFocus())); } catch { /* disconnected */ }
    return;
  }
  let merged: ExtendedSessionResponse[];
  try {
    merged = await merge(local);
  } catch {
    return; // the rule: no merged list, no frame
  }
  try { ws.send(sessionsUpdatedPayload(merged, computeClientFocus())); } catch { /* disconnected */ }
}

/**
 * The sessions frame a freshly opened connection gets.
 *
 * Split out of `muxOpen` so the race it exists to close can be driven in a
 * test: `build` is where the glasses' announcement lands in production.
 */
export async function sendInitialSessions(
  ws: ServerWebSocket<MuxData>,
  build: () => Promise<ExtendedSessionResponse[]> = buildSessionsList,
  merge: (l: ExtendedSessionResponse[]) => Promise<ExtendedSessionResponse[]> = sessionsWithPeers,
): Promise<void> {
  try {
    await sendSessionsTo(ws, await build(), merge);
  } catch { /* best effort: the 5s push carries it otherwise */ }
}

/** The comparison the push dedup runs on: a minute ticking over is not news. */
function stableSessionsJson(sessions: SessionResponse[]): string {
  return JSON.stringify(sessions, (key, value) => (key === 'durationMinutes' ? undefined : value));
}

const SESSIONS_PUSH_INTERVAL = 5000;
let sessionsPushTimer: ReturnType<typeof setInterval> | null = null;
let lastSessionsJson = '';
/** The same dedup for the glasses' list, which carries the peers'
 *  sessions and therefore changes when theirs do. */
let lastGlassesSessionsJson = '';

export function startSessionsPush() {
  if (sessionsPushTimer) return;
  // herdr tells us the instant an agent changes state; the interval below is
  // the floor (metrics, recap, anything herdr doesn't emit), not the ceiling.
  startAgentStatusWatcher(() => {
    if (activeMuxConnections.size > 0) pushSessionsNow();
    // Relay tracker rides the same event: it diffs pane statuses and,
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
      // Two lists, two dedups: a peer's agent changing state is news for the
      // glasses and nothing at all for a browser, which watches that peer itself.
      // The browsers' frame goes out before the merge is awaited: a peer that
      // is down holds the merge for its whole timeout, and that must not stall
      // a machine that never asked for the peers.
      const localJson = stableSessionsJson(sessions);
      let focus: ClientFocus | undefined;
      if (localJson !== lastSessionsJson) {
        lastSessionsJson = localJson;
        focus = pushFocus();
        broadcastSessions(sessions, null, { browsers: true, glasses: false }, focus);
      }
      const forGlasses = await glassesSessions(sessions);
      // Nothing merged this round: leave the glasses dedup where it is, so the
      // next round that does merge still counts as news for them.
      if (!forGlasses) return;
      const glassesJson = stableSessionsJson(forGlasses);
      if (glassesJson === lastGlassesSessionsJson) return;
      lastGlassesSessionsJson = glassesJson;
      broadcastSessions(sessions, forGlasses, { browsers: false, glasses: true }, focus ?? pushFocus());
    } catch (err) {
      console.warn('[mux] sessions push error:', err);
    }
  }, SESSIONS_PUSH_INTERVAL);
}

export function stopSessionsPush() {
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
  lastGlassesSessionsJson = '';
}

export function pushSessionsNow() {
  lastSessionsJson = '';
  lastGlassesSessionsJson = '';
  buildSessionsList().then(async sessions => {
    const focus = pushFocus();
    broadcastSessions(sessions, null, { browsers: true, glasses: false }, focus);
    broadcastSessions(sessions, await glassesSessions(sessions), { browsers: false, glasses: true }, focus);
  }).catch(() => {});
}
