import type { ServerWebSocket } from 'bun';
import type { ClientFocus } from '../../../../shared/types';
import { activeMuxConnections, type MuxData } from './connections';

/**
 * What a `subscribe` does to this client's claim on the glasses focus.
 *
 * Opening a session claims it — watching, not typing, is what a person does
 * most of the time. A reconnect replaying what was already open claims
 * nothing: it is the socket asking, not a person, and the election picks the
 * most recently raised screen. A tablet left open on a desk therefore took the
 * wearer off the session they were talking to every time its WebSocket came
 * back — 44 times in one day on 2026-08-08, from a device nobody had touched.
 *
 * The session itself is recorded either way, so the moment a person does
 * something on that client it is followed, on the session it already had.
 *
 * The glasses are the exception, and it is not a detail of theirs: they
 * subscribe *because* the election sent them somewhere, so their subscriptions
 * are its own output. Reading one as a claim would be the loop the whole
 * separation exists to prevent, and the only thing that stood between the two
 * was `pickClientFocus` routing them elsewhere - with the stale write still
 * happening, and logged as a claim that never took place. What the wearer picks
 * arrives on `glasses-focus` instead, and nothing else on that connection is a
 * person's act.
 *
 * Pure and exported for the tests.
 */
export function applySubscribeFocus(
  data: { focusSessionId?: string; focusAt?: number; isGlasses?: boolean },
  msg: { sessionId: string; resumed?: boolean },
  now: number,
): void {
  if (data.isGlasses) return;
  data.focusSessionId = msg.sessionId;
  if (!msg.resumed) data.focusAt = now;
}

/**
 * How long a claim outlives the heartbeat behind it.
 *
 * `visible` is the client's own word for "a person is looking at this", and a
 * sleeping laptop keeps saying it: the lid closes, the restored tab stays
 * foregrounded, and the claim stands until the socket is reaped. Reaping is a
 * 60s timeout checked every 30s, so that is up to 90 seconds in which a machine
 * nobody is near wins the election.
 *
 * Measured on 2026-08-10: a Mac woke for a few seconds, its restored tab
 * claimed w4H, and 51 seconds later - still inside the reaping window, 13
 * seconds after the wearer last touched the glasses - the G2 left the
 * conversation being read for a workspace finished days earlier. That same
 * claim landed 17 times that day and 53 times on 2026-08-08, at 00:08 and
 * 01:19 among them, from a lid that was shut the whole time.
 *
 * Clients ping every 10s (PING_INTERVAL_MS in useMultiplexedTerminal.ts), so
 * this drops one after two missed beats with room for jitter. It removes them
 * from the election only - the connection is still theirs to use, and the next
 * ping puts them straight back in.
 */
const FOCUS_HEARTBEAT_MS = 25_000;

/**
 * The same budget, counted in the glasses' own beats.
 *
 * 25s is two browser beats and a half. The glasses ping every 15s
 * (PING_INTERVAL_MS in glasses/src/ws-client.ts) - the interval is set against
 * the 60s zombie timeout, not against this - so the same number is one beat and
 * two thirds there, and a single dropped ping drops the wearer out of the
 * election. What takes the focus in that gap is a tablet left visible on a
 * desk: the exact thing the ring claim exists to outbid. Nothing on the wire
 * refreshes the clock either - `lastPingAt` moves on `ping` and on nothing
 * else, so a busy connection is no safer than an idle one.
 *
 * The glasses reach the server through the phone over BLE, which is the least
 * reliable leg any client has, so they need more slack than a browser rather
 * than less. Kept as a ratio of the beat, not a round number: two and a half
 * beats of 15s.
 */
const GLASSES_FOCUS_HEARTBEAT_MS = 37_500;

/** A claim is stale after two and a half of the client's own beats, and the
 *  glasses beat slower than a browser. */
function focusHeartbeatWindow(d: MuxData): number {
  return d.isGlasses ? GLASSES_FOCUS_HEARTBEAT_MS : FOCUS_HEARTBEAT_MS;
}

/**
 * What a `client-info` does to this client's claim on the glasses focus.
 *
 * `visible` is a transition, not a state a socket owns. A person picking a
 * device up is hidden -> visible, and that is the moment worth calling a claim.
 * A new socket has no past to compare against, so a reconnect used to look like
 * exactly that transition - which undid the fix that stopped a resumed
 * `subscribe` from claiming, one message later: the page declares itself the
 * moment the subscription is confirmed (`onConnect` -> `sendClientInfo` in
 * DesktopLayout / TerminalPage).
 *
 * v0.3.93 answered that with a per-device memory on this side. It was the wrong
 * side to put it: the memory lives in this process, so a server restart emptied
 * it and made every reconnecting client look brand new. Measured on 2026-08-12,
 * ten minutes after the 0.3.94 restart, a laptop nobody had touched took the
 * wearer to w4H - a workspace finished five days earlier - for the twelfth time
 * in two days.
 *
 * The page is the only party that knows it was opened rather than reconnected,
 * so it says so and this reads it. `fresh` absent means an older client, which
 * is read as "not fresh": a tab open since before that shipped is precisely the
 * one that must not claim.
 *
 * Pure and exported for the tests.
 */
export function applyClientInfoFocus(
  data: { visible?: boolean; focusAt?: number },
  msg: { visible: boolean; fresh?: boolean },
  now: number,
): void {
  const wasVisible = data.visible;
  data.visible = msg.visible;
  if (!msg.visible) return;
  // Picked up: hidden -> visible, watched on this connection rather than
  // inferred from one that ended.
  if (wasVisible === false) {
    data.focusAt = now;
    return;
  }
  // First word from this connection. A page someone just opened is a person
  // arriving; the same page reconnecting is not, and keeps whatever claim it
  // has - which after a reconnect is none.
  if (wasVisible === undefined && msg.fresh) data.focusAt = now;
}

/**
 * Every claim, in the log, with the message that minted it.
 *
 * Three fixes in, the screen recording could say a laptop had taken the glasses
 * and never which path let it - it records the election's answer, not the
 * message behind it, and the two candidate paths are one message apart. This
 * line is the difference between reading the cause off a log and inferring it
 * from timestamps for an afternoon.
 */
export function logFocusClaim(
  ws: ServerWebSocket<MuxData>,
  claimedBefore: number | undefined,
  via: string,
): void {
  if (ws.data.focusAt === claimedBefore) return;
  const device = ws.data.deviceId ?? 'no device id';
  console.log(
    `[focus] ${ws.data.deviceType ?? 'undeclared'} claims ${ws.data.focusSessionId ?? 'no session'}: ${via} (${device})`,
  );
}

/**
 * A client declaring itself, in the words the election judges it by.
 *
 * Pure and exported for the tests.
 */
export function describeDeclaration(msg: {
  visible?: boolean;
  fresh?: boolean;
  automated?: boolean;
}): string {
  const parts = [msg.visible ? 'visible' : 'hidden', msg.fresh ? 'opened' : 'reconnected'];
  if (msg.automated) parts.push('automated');
  return parts.join(', ');
}

/**
 * That a client was here at all, whether or not it claimed anything.
 *
 * A claim is logged where it is minted; nothing was logged when a connection
 * merely arrived, so a quiet log had two readings that could not be told apart:
 * the client came back and correctly declined to claim, or it never came back.
 * That distinction is the whole of the verification, and three fixes to this
 * election were judged on the absence of a symptom without it - one of them
 * declared fixed six minutes before the next unwanted switch.
 *
 * Repeats are dropped. A page re-declares itself every time a subscription is
 * confirmed, which is once per session switch and says nothing new; a change in
 * any of the three words does.
 */
export function logClientPresence(
  ws: ServerWebSocket<MuxData>,
  msg: { deviceType: string; visible?: boolean; fresh?: boolean; automated?: boolean },
): void {
  const said = `${msg.deviceType}: ${describeDeclaration(msg)}`;
  if (ws.data.lastDeclaration === said) return;
  ws.data.lastDeclaration = said;
  console.log(`[focus] present ${said} (${ws.data.deviceId ?? 'no device id'})`);
}

/** A screen someone is looking at, and the session it has open. */
function screenClaim(d: MuxData): ClientFocus | undefined {
  // Focus means "the screen a person is looking at", and a driven browser is
  // not one. This machine runs several agents that open the web UI headlessly
  // to take screenshots; each claimed the focus, and a wearer reading a
  // conversation was carried off to whatever session one of them landed on -
  // three times in one recording. Refused here rather than filtered by the
  // glasses, because nothing downstream wants it either.
  if (d.automated) return undefined;
  // A claim is minted by a person: opening a session, or picking the device
  // up. A connection that has done neither since it came back is a machine
  // that is merely awake, and being the only one awake used to be enough to
  // win - which is how a laptop left on a workspace finished days ago kept
  // taking the wearer there, most of the switches recorded on 2026-08-11.
  // Nobody qualifying leaves the followers holding what they have, which is
  // the right answer when nobody is at a screen.
  if (d.focusAt === undefined) return undefined;
  if (!d.deviceType || !d.focusSessionId || d.visible !== true) return undefined;
  return { sessionId: d.focusSessionId, deviceType: d.deviceType, at: d.focusAt };
}

/**
 * The session the wearer picked with the ring.
 *
 * Read from fields no subscription writes, which is the whole of why this is
 * separate: the glasses subscribe to whatever the election sends them to, so
 * their subscriptions are its output and a claim minted from one would chase
 * its own tail. `visible` and `deviceType` are not asked for - there is no
 * `client-info` from a face, and a wearer who just chose a session is by
 * construction looking at it.
 */
function glassesClaim(d: MuxData): ClientFocus | undefined {
  if (!d.glassesFocusSessionId || d.glassesFocusAt === undefined) return undefined;
  return { sessionId: d.glassesFocusSessionId, deviceType: 'glasses', at: d.glassesFocusAt };
}

/**
 * Elect the session the user is looking at: among clients that claim it, the
 * one that claimed most recently. Undefined when nothing qualifies, which tells
 * followers to hold their current view rather than blank it.
 *
 * Pure and exported for the tests; the caller supplies the connections.
 */
export function pickClientFocus(clients: MuxData[], now: number): ClientFocus | undefined {
  let best: ClientFocus | undefined;
  for (const d of clients) {
    // A screen that stopped saying it is there is not one anyone is looking at,
    // whatever its last `visible` said.
    if (now - d.lastPingAt > focusHeartbeatWindow(d)) continue;
    const claim = d.isGlasses ? glassesClaim(d) : screenClaim(d);
    if (!claim) continue;
    if (!best || claim.at > best.at) best = claim;
  }
  return best;
}


export function computeClientFocus(): ClientFocus | undefined {
  return pickClientFocus([...activeMuxConnections].map((ws) => ws.data), Date.now());
}
