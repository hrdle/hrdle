/**
 * Each remote peer gets a persistent WebSocket to its `/ws/mux` so
 * `sessions-updated` push lands in the client without polling. The terminal
 * sharedWs only follows the currently-active session, so leaving this watcher
 * separate lets every peer's session list stay live in the background.
 */
import { useEffect, useMemo } from "react";
import {
	type IndicatorState,
	LOCAL_PEER_ID,
	type MuxServerMessage,
	type PeerClientView,
	type PeerSession,
	type SessionResponse,
} from "../../../shared/types";
import { appendWsToken, peerHttpUrlToWsUrl } from "../services/peer-ws";
import { noteServerVersion } from "../services/build-version";
import { fireHookNotification } from "../utils/hookNotification";
import { storageKey } from "../utils/app-storage";

type PeerSessionsListener = (
	sessionsByPeer: ReadonlyMap<string, PeerSession[]>,
) => void;

interface PeerWatcher {
	ws: WebSocket | null;
	retryTimer: number | null;
	pingTimer: number | null;
	retryAttempt: number;
	lastSessionsJson: string;
	closed: boolean;
}

const RETRY_INITIAL_MS = 5_000;
const RETRY_MAX_MS = 60_000;
// Backend zombie cutoff is 60s; ping every 25s with margin.
const PING_INTERVAL_MS = 25_000;

const watchers = new Map<string, PeerWatcher>();
const peerInfoById = new Map<string, PeerClientView>();
const sessionsByPeer = new Map<string, PeerSession[]>();
const listeners = new Set<PeerSessionsListener>();

function notifyListeners() {
	for (const listener of listeners) listener(sessionsByPeer);
}

function isLocalPeer(peer: PeerClientView): boolean {
	return peer.id === LOCAL_PEER_ID || peer.url === "self";
}

/**
 * Whether to hold a socket open for this peer.
 *
 * The peers poll already knows when a peer cannot be reached: it reports
 * `status: "offline"` along with `errorMessage: "unreachable: ..."`. Dialling
 * one anyway costs a full TCP timeout per attempt - measured at roughly 30s
 * over Tailscale - and the backoff caps at 60s, so a peer that has been down
 * for hours keeps a CONNECTING socket alive most of the time and logs a
 * WebSocket error every time one expires.
 *
 * Found by attaching to a tablet's Chrome over CDP: it was still dialling a
 * Mac whose `lastSeenAt` was twelve hours old, and each failure also produced
 * a `[control-mode] Error: WebSocket connection error` line.
 *
 * Only `offline` is skipped. `unauthorized` is refused immediately rather than
 * timing out, so it does not pile up the same way, and `unknown` is what a
 * fresh poll looks like - treating "not yet known" as "do not connect" would
 * keep the first attempt from ever happening.
 */
export function shouldDial(peer: PeerClientView): boolean {
	// The local Hub is this very page's origin; its reported status is never a
	// reason to stop watching it.
	return isLocalPeer(peer) || peer.status !== "offline";
}

function peerWsUrl(peer: PeerClientView): string {
	if (isLocalPeer(peer)) {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const base = `${protocol}//${window.location.host}`;
		const token = localStorage.getItem(storageKey("token"));
		return appendWsToken(`${base}/ws/mux`, token);
	}
	const base = peerHttpUrlToWsUrl(peer.url);
	return appendWsToken(`${base}/ws/mux`, peer.wsToken ?? null);
}

function enrichPeerSessions(
	peer: PeerClientView,
	sessions: SessionResponse[],
): PeerSession[] {
	return sessions.map((s) => ({
		...s,
		peerId: peer.id,
		peerNickname: peer.nickname,
		peerColor: peer.color,
	}));
}

function scheduleRetry(peerId: string) {
	const watcher = watchers.get(peerId);
	if (!watcher || watcher.closed) return;
	if (watcher.retryTimer !== null) return;
	const delay = Math.min(
		RETRY_INITIAL_MS * 2 ** watcher.retryAttempt,
		RETRY_MAX_MS,
	);
	watcher.retryAttempt++;
	watcher.retryTimer = window.setTimeout(() => {
		watcher.retryTimer = null;
		const peer = peerInfoById.get(peerId);
		if (peer && !watcher.closed) openWatcher(peer);
	}, delay);
}

function openWatcher(peer: PeerClientView) {
	let watcher = watchers.get(peer.id);
	if (!watcher) {
		watcher = {
			ws: null,
			retryTimer: null,
			pingTimer: null,
			retryAttempt: 0,
			lastSessionsJson: "",
			closed: false,
		};
		watchers.set(peer.id, watcher);
	}

	if (!shouldDial(peer)) {
		// Drop the pending backoff and wait to be told it is back. `reconcile`
		// re-runs whenever a peer's status changes, so the 5s peers poll is what
		// reopens this - no timer of our own has to survive here.
		if (watcher.retryTimer !== null) {
			window.clearTimeout(watcher.retryTimer);
			watcher.retryTimer = null;
		}
		watcher.retryAttempt = 0;
		return;
	}

	if (
		watcher.ws &&
		(watcher.ws.readyState === WebSocket.OPEN ||
			watcher.ws.readyState === WebSocket.CONNECTING)
	) {
		return;
	}

	try {
		const ws = new WebSocket(peerWsUrl(peer));
		watcher.ws = ws;

		ws.onopen = () => {
			if (!watcher) return;
			watcher.retryAttempt = 0;
			// Backend disconnects WS that hasn't sent a `ping` for 60s, so keep it
			// alive while the watcher's only job is to listen for pushes.
			watcher.pingTimer = window.setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
				}
			}, PING_INTERVAL_MS);
		};

		ws.onmessage = (event) => {
			if (typeof event.data !== "string") return;
			let msg: MuxServerMessage;
			try {
				msg = JSON.parse(event.data) as MuxServerMessage;
			} catch {
				return;
			}

			if (msg.type === "hook-event") {
				// Indicator state should react before the next 5s sessions-updated push.
				// `ccSessionId` is a UUID so it is safe to look up across all peers.
				const ccSessionId = msg.sessionId;
				const newState = hookEventToIndicatorState(msg.event);
				if (ccSessionId && newState) {
					applyHookIndicatorUpdate(ccSessionId, newState);
				}
				// Forward to OS notification path so non-active peers can notify too.
				// The terminal sharedWs only ever subscribes to one peer, so without
				// this the user never gets notified from any other peer.
				//
				// `deliveredToGlasses` used to suppress this too. It says the peer
				// created a relay item, which only establishes that a glasses app
				// there holds a socket — not that anyone is wearing anything, so a
				// peer with the app running went quiet for nothing.
				fireHookNotification(
					msg.event,
					msg.cwd,
					ccSessionId,
					msg.data,
					msg.message,
					peer.id,
				);
				return;
			}

			if (msg.type !== "sessions-updated") return;

			// The hub's own build, on a message that already arrives every five
			// seconds. A peer's version says nothing about the page's.
			if (peer.id === LOCAL_PEER_ID) noteServerVersion(msg.version);

			// Per-peer dedup: backend already filters identical payloads, but a
			// second listener registering would otherwise re-stringify the same
			// data downstream. Hash once here.
			const json = JSON.stringify(msg.sessions);
			if (json === watcher.lastSessionsJson) return;
			watcher.lastSessionsJson = json;

			sessionsByPeer.set(peer.id, enrichPeerSessions(peer, msg.sessions));
			notifyListeners();
		};

		ws.onclose = () => {
			if (!watcher) return;
			watcher.ws = null;
			if (watcher.pingTimer !== null) {
				window.clearInterval(watcher.pingTimer);
				watcher.pingTimer = null;
			}
			// Keep last-known sessions until reconnect succeeds; clearing here would
			// flash the UI empty on transient drops.
			if (!watcher.closed) scheduleRetry(peer.id);
		};
	} catch {
		scheduleRetry(peer.id);
	}
}

/**
 * Drop the backoff and reconnect every watcher at once. Called when something
 * else has just established that the server is answering again (the peers poll
 * succeeding after a failure), because a watcher that has been retrying for a
 * while is up to 60s from its next attempt - long enough that switching the VPN
 * back on looks like it did not work.
 */
export function reconnectPeerWatchersNow() {
	for (const [peerId, watcher] of watchers) {
		if (watcher.closed) continue;
		if (watcher.ws && watcher.ws.readyState === WebSocket.OPEN) continue;
		if (watcher.retryTimer !== null) {
			window.clearTimeout(watcher.retryTimer);
			watcher.retryTimer = null;
		}
		watcher.retryAttempt = 0;
		const peer = peerInfoById.get(peerId);
		if (peer) openWatcher(peer);
	}
}

function closeWatcher(peerId: string) {
	const watcher = watchers.get(peerId);
	if (!watcher) return;
	watcher.closed = true;
	if (watcher.retryTimer !== null) {
		window.clearTimeout(watcher.retryTimer);
		watcher.retryTimer = null;
	}
	if (watcher.pingTimer !== null) {
		window.clearInterval(watcher.pingTimer);
		watcher.pingTimer = null;
	}
	if (watcher.ws) {
		try {
			watcher.ws.close();
		} catch {
			// ignore
		}
		watcher.ws = null;
	}
	watchers.delete(peerId);
	if (sessionsByPeer.delete(peerId)) notifyListeners();
}

function reconcile(peers: PeerClientView[]) {
	// Watch every peer including the local Hub. Without a dedicated WS for
	// the Hub, the multiplexed terminal sharedWs is the only source of
	// `sessions-updated`, and that WS follows the active session's peer —
	// when it's pointing at a remote peer the Hub's session list goes stale.
	const want = new Map<string, PeerClientView>();
	for (const peer of peers) {
		want.set(peer.id, peer);
	}

	for (const id of Array.from(watchers.keys())) {
		const next = want.get(id);
		if (!next) {
			closeWatcher(id);
			continue;
		}
		const prev = peerInfoById.get(id);
		if (prev && (prev.url !== next.url || prev.wsToken !== next.wsToken)) {
			closeWatcher(id);
		}
	}

	for (const peer of want.values()) {
		peerInfoById.set(peer.id, peer);
		openWatcher(peer);
	}

	for (const id of Array.from(peerInfoById.keys())) {
		if (!want.has(id)) peerInfoById.delete(id);
	}
}

/**
 * Stabilize the dependency for reconcile. `usePeers()` returns a new array
 * reference on every poll, but only `id|url|wsToken|status` actually affect the
 * watcher; rerun reconcile only when one of those changes.
 *
 * `status` belongs here because `shouldDial` reads it: without it, a peer that
 * came back online would keep its watcher closed until something else happened
 * to change the key.
 */
export function peersWatcherKey(peers: PeerClientView[]): string {
	return peers
		.map((p) => `${p.id}|${p.url}|${p.wsToken ?? ""}|${p.status}`)
		.sort()
		.join(";");
}

/**
 * Push an immediate indicatorState change for any peer's sessions whose
 * Claude Code session matches `ccSessionId`. Called from hook event handlers
 * so the spinner reacts before the next `sessions-updated` push arrives.
 * Covers Hub-local sessions as well as remote peers — `ccSessionId` is a
 * Claude-generated UUID so collisions across peers are negligible.
 */
export function applyHookIndicatorUpdate(
	ccSessionId: string,
	indicatorState: IndicatorState,
): boolean {
	let changed = false;
	for (const [peerId, sessions] of sessionsByPeer) {
		let peerChanged = false;
		const next = sessions.map((session) => {
			if (session.ccSessionId !== ccSessionId) return session;
			if (!session.panes) return session;
			peerChanged = true;
			return {
				...session,
				panes: session.panes.map((pane) => ({ ...pane, indicatorState })),
			};
		});
		if (peerChanged) {
			sessionsByPeer.set(peerId, next);
			changed = true;
		}
	}
	if (changed) notifyListeners();
	return changed;
}

function hookEventToIndicatorState(event: string): IndicatorState | null {
	switch (event) {
		case "Stop":
		case "Notification":
		case "SubagentStop":
			return "completed";
		case "PostToolUse":
			return "waiting_input";
		case "PreToolUse":
		case "UserPromptSubmit":
			return "processing";
		default:
			return null;
	}
}

export function usePeerSessionsWatcher(
	peers: PeerClientView[],
	onChange: PeerSessionsListener,
) {
	const key = useMemo(() => peersWatcherKey(peers), [peers]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` already encodes the parts of `peers` that matter; including the raw array would re-run on every poll.
	useEffect(() => {
		reconcile(peers);
	}, [key]);

	useEffect(() => {
		listeners.add(onChange);
		onChange(sessionsByPeer);
		return () => {
			listeners.delete(onChange);
		};
	}, [onChange]);
}
