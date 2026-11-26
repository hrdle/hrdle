import type { PaneViewport, TmuxLayoutNode } from "../../../shared/types";
import { storageKey } from "../utils/app-storage";
import { getDeviceId } from "../utils/device-id";
import { reportWsLatency } from "./latency-store";
import { appendWsToken } from "./peer-ws";

/**
 * The one `/ws/mux` socket a page holds, shared by every
 * `useMultiplexedTerminal` and conversation stream. It lives at module level so
 * it survives component remounts; the hook only points it at a session and
 * hands it the callbacks of whichever layout is mounted.
 */

const getWsBase = () => {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	return import.meta.env.VITE_WS_URL || `${protocol}//${window.location.host}`;
};

const getAuthToken = (): string | null => {
	return localStorage.getItem(storageKey("token"));
};

let sharedWs: WebSocket | null = null;
let sharedPingInterval: number | null = null;
let sharedReconnectTimeout: number | null = null;
let sharedConnectWatchdog: number | null = null;
let sharedWsConnectStart = 0;
let sharedLastPongAt = 0;
let subscribedSession: string | null = null;
let subscribedSessionInstance: string | null = null;
let wsReady = false;
// Multi-server: the base URL the current WS connection points at.
// When the target changes the socket is force closed and reconnected to the new URL.
let currentWsBase: string | null = null;
let currentWsToken: string | null = null;

// Force-close a CONNECTING socket if onopen hasn't fired by this deadline.
// Mobile networks can leave the TCP handshake in a zombie state — no onopen,
// no onclose — and the existing `ensureConnection()` would early-return on
// CONNECTING forever. The watchdog turns the silent hang into an explicit
// close, letting the onclose reconnect path take over.
const CONNECT_WATCHDOG_MS = 10_000;
const PING_INTERVAL_MS = 10_000;
// Force-close OPEN socket if no pong reply for this long. Catches "silently
// dead" connections where the OS hasn't yet noticed the TCP is gone (common
// on mobile when carrier NAT drops the session).
const PONG_TIMEOUT_MS = 25_000;

// Conversation subscriptions.
//
// Keyed by session *and* pane agent session: a workspace with two agent panes
// has two conversations, and a single key per workspace let the second pane's
// subscription tear down the first.
const CONV_KEY_SEP = "\u0000";

function convKey(sessionId: string, agentSessionId?: string | null): string {
	return agentSessionId ? `${sessionId}${CONV_KEY_SEP}${agentSessionId}` : sessionId;
}

function convParts(key: string): { sessionId: string; agentSessionId?: string } {
	const [sessionId, agentSessionId] = key.split(CONV_KEY_SEP);
	return agentSessionId ? { sessionId, agentSessionId } : { sessionId };
}

const subscribedConversations = new Set<string>();
const pendingConversationSubs = new Set<string>();
const pendingConversationUnsubs = new Set<string>();

function flushConversationPending() {
	if (!sharedWs || sharedWs.readyState !== WebSocket.OPEN || !wsReady) return;
	for (const key of pendingConversationUnsubs) {
		sharedWs.send(
			JSON.stringify({ type: "unsubscribe-conversation", ...convParts(key) }),
		);
		subscribedConversations.delete(key);
	}
	pendingConversationUnsubs.clear();
	for (const key of pendingConversationSubs) {
		sharedWs.send(
			JSON.stringify({ type: "subscribe-conversation", ...convParts(key) }),
		);
		subscribedConversations.add(key);
	}
	pendingConversationSubs.clear();
}

export type MuxCallbacks = {
	onPaneViewport?: (paneId: string, viewport: PaneViewport) => void;
	onLayoutChange?: (
		layout: TmuxLayoutNode,
		zoomedPaneId: string | null,
	) => void;
	onHookEvent?: (
		event: string,
		cwd?: string,
		sessionId?: string,
		data?: Record<string, unknown>,
		message?: string,
		/** The G2 glasses are already showing this event; do not also notify. */
		deliveredToGlasses?: boolean,
	) => void;
	onConnect?: () => void;
	onDisconnect?: () => void;
	onSessionExit?: (reason: string) => void;
	onError?: (error: string, paneId?: string) => void;
	onHerdrRestart?: (phase: "restarting" | "restored" | "failed") => void;
	setIsConnected?: (v: boolean) => void;
	sessionId: string;
	sessionInstanceId?: string;
	/** When false, subscribeToSession is a no-op (remote-control mode). */
	live?: boolean;
};

let activeCallbacks: MuxCallbacks | null = null;

function sendRaw(msg: Record<string, unknown>) {
	if (sharedWs?.readyState === WebSocket.OPEN) {
		sharedWs.send(JSON.stringify(msg));
	}
}

export function sendSessionMessage(msg: Record<string, unknown>) {
	if (activeCallbacks) {
		sendRaw({ ...msg, sessionId: activeCallbacks.sessionId });
	}
}

// Last declared device type, replayed whenever the page is shown or hidden so
// the server knows which device the user is actually looking at. That decides
// which client owns the glasses focus.
let lastDeviceType: "mobile" | "tablet" | "desktop" | null = null;

// False until this page has declared itself once. The declaration is sent again
// on every reconnect (`onConnect` -> `sendClientInfo`), and the server cannot
// tell the two apart from the socket alone - a new socket has no past. Only the
// page knows it was opened rather than merely reconnected, so it says so.
let clientInfoDeclared = false;

function sendClientInfoNow() {
	if (!lastDeviceType) return;
	const fresh = !clientInfoDeclared;
	clientInfoDeclared = true;
	sendSessionMessage({
		type: "client-info",
		deviceType: lastDeviceType,
		visible: typeof document !== "undefined" && !document.hidden,
		// Someone opened this page. A reconnect of a page already open is not a
		// person and claims nothing.
		fresh,
		// A browser being driven rather than watched. The glasses follow the
		// screen someone is holding, and an agent taking a screenshot is not
		// that - it used to claim the focus and carry a wearer off mid-read.
		automated: typeof navigator !== "undefined" && navigator.webdriver === true,
	});
}

function subscribeToSession(
	sessionId: string,
	sessionInstanceId?: string,
	force = false,
) {
	// Remote-control mode: never open a live subscription. This gates all three
	// call sites (ready handler / subscribe effect / connect) at once, so no
	// PaneController is spawned and the local herdr client keeps the terminal.
	if (activeCallbacks?.live === false) return;
	const instanceChanged =
		subscribedSession === sessionId &&
		subscribedSessionInstance !== (sessionInstanceId ?? null);
	if (subscribedSession === sessionId && !instanceChanged && !force) return;

	if (subscribedSession && (subscribedSession !== sessionId || instanceChanged)) {
		sendRaw({ type: "unsubscribe", sessionId: subscribedSession });
	}

	subscribedSession = sessionId;
	subscribedSessionInstance = sessionInstanceId ?? null;
	activeCallbacks?.setIsConnected?.(false);
	// `force` is set only by the reconnect replay in the `ready` handler, so it
	// is exactly "the socket asked, not the user".
	sendRaw({ type: "subscribe", sessionId, resumed: force });
}

export function ensureConnection(token?: string | null, wsBase?: string | null) {
	const desiredBase = wsBase ?? getWsBase();
	const desiredToken = (token ?? getAuthToken()) || null;

	// A changed target (URL or token) forces a close and a reconnect
	const baseChanged =
		(currentWsBase !== null && currentWsBase !== desiredBase) ||
		(currentWsToken !== null && currentWsToken !== desiredToken);
	if (baseChanged && sharedWs) {
		console.log(
			`[MUX] target changed (${currentWsBase} → ${desiredBase}); reconnecting`,
		);
		try {
			sharedWs.close();
		} catch {}
		sharedWs = null;
		subscribedSession = null;
		subscribedSessionInstance = null;
		wsReady = false;
	}

	currentWsBase = desiredBase;
	currentWsToken = desiredToken;

	if (sharedWs?.readyState === WebSocket.OPEN) return;

	if (sharedWs?.readyState === WebSocket.CONNECTING) {
		const elapsed = Date.now() - sharedWsConnectStart;
		if (elapsed < CONNECT_WATCHDOG_MS) return;
		console.warn(
			`[MUX] stale CONNECTING (${elapsed}ms); force closing for retry`,
		);
		try {
			sharedWs.close();
		} catch {}
		sharedWs = null;
	}

	if (sharedReconnectTimeout) {
		clearTimeout(sharedReconnectTimeout);
		sharedReconnectTimeout = null;
	}
	if (sharedConnectWatchdog) {
		clearTimeout(sharedConnectWatchdog);
		sharedConnectWatchdog = null;
	}

	const baseWsUrl = appendWsToken(`${desiredBase}/ws/mux`, desiredToken);
	const sep = baseWsUrl.includes("?") ? "&" : "?";
	const wsUrl = `${baseWsUrl}${sep}deviceId=${encodeURIComponent(getDeviceId())}`;

	const ws = new WebSocket(wsUrl);
	sharedWs = ws;
	wsReady = false;
	sharedWsConnectStart = Date.now();

	sharedConnectWatchdog = window.setTimeout(() => {
		if (sharedWs === ws && ws.readyState === WebSocket.CONNECTING) {
			console.warn(
				"[MUX] connect watchdog timed out; force closing CONNECTING socket",
			);
			try {
				ws.close();
			} catch {}
		}
		sharedConnectWatchdog = null;
	}, CONNECT_WATCHDOG_MS);

	ws.onopen = () => {
		console.log("[MUX] WebSocket opened");
		if (sharedConnectWatchdog) {
			clearTimeout(sharedConnectWatchdog);
			sharedConnectWatchdog = null;
		}
		sharedLastPongAt = Date.now();

		if (sharedPingInterval) clearInterval(sharedPingInterval);
		sharedPingInterval = window.setInterval(() => {
			if (ws.readyState !== WebSocket.OPEN) return;
			if (Date.now() - sharedLastPongAt > PONG_TIMEOUT_MS) {
				console.warn(
					`[MUX] pong timeout (${Date.now() - sharedLastPongAt}ms); force closing socket`,
				);
				try {
					ws.close();
				} catch {}
				return;
			}
			const sid = activeCallbacks?.sessionId || "";
			ws.send(
				JSON.stringify({ type: "ping", timestamp: Date.now(), sessionId: sid }),
			);
		}, PING_INTERVAL_MS);
	};

	let wsMsgCount = 0;

	// Track bytes per second for throughput display
	let wsBytesThisSec = 0;
	const bytesTimer = window.setInterval(() => {
		window.__hrdle_ws_bytes_per_sec = wsBytesThisSec;
		wsBytesThisSec = 0;
	}, 1000);

	// Plain JSON transport only — no binary frames in the state-sync protocol.
	ws.onmessage = (event) => {
		wsMsgCount++;
		if (typeof event.data === "string") {
			wsBytesThisSec += event.data.length;
		}

		if (typeof event.data !== "string") return;

		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(event.data);
		} catch {
			return;
		}

		const cb = activeCallbacks;
		const currentSession = cb?.sessionId;
		const msgSessionId = msg.sessionId as string | undefined;

		switch (msg.type) {
			case "ready": {
				wsReady = true;
				if (currentSession) {
					subscribeToSession(currentSession, cb?.sessionInstanceId, true);
				}
				for (const sid of subscribedConversations) {
					pendingConversationSubs.add(sid);
				}
				flushConversationPending();
				break;
			}
			case "subscribed": {
				if (msgSessionId === currentSession) {
					cb?.setIsConnected?.(true);
					cb?.onConnect?.();
				}
				break;
			}
			case "unsubscribed":
				break;
			case "session-exited": {
				if (msgSessionId !== currentSession) return;
				if (subscribedSession === msgSessionId) {
					subscribedSession = null;
					subscribedSessionInstance = null;
				}
				cb?.setIsConnected?.(false);
				cb?.onSessionExit?.(msg.reason as string);
				break;
			}
			case "sessions-updated":
				// Sessions are sourced from `usePeerSessionsWatcher` (one dedicated WS
				// per peer including the Hub itself), so the terminal sharedWs ignores
				// these pushes to avoid double-updating the cache.
				break;
			// This host is restarting herdr, so every pane PTY is being re-created
			// under us. The socket survives, which is exactly the problem: no
			// frame ever arrives to say the terminal on screen is now a corpse, so
			// the page reads as hung until someone reloads it.
			case "herdr-restart": {
				const phase = msg.phase as "restarting" | "restored" | "failed";
				cb?.onHerdrRestart?.(phase);
				if (phase === "restarting") break;
				// Re-subscribe against the panes that exist now and pull a fresh
				// viewport, rather than waiting for output nothing will prompt.
				if (currentSession) {
					subscribeToSession(currentSession, cb?.sessionInstanceId, true);
				}
				for (const sid of subscribedConversations) {
					pendingConversationSubs.add(sid);
				}
				flushConversationPending();
				break;
			}
			case "viewport": {
				if (msgSessionId !== currentSession) return;
				const viewport = msg.viewport as PaneViewport;
				cb?.onPaneViewport?.(viewport.paneId, viewport);
				break;
			}
			case "layout": {
				if (msgSessionId !== currentSession) return;
				cb?.onLayoutChange?.(
					msg.layout as TmuxLayoutNode,
					(msg.zoomedPaneId as string | null | undefined) ?? null,
				);
				break;
			}
			case "pong": {
				sharedLastPongAt = Date.now();
				const rtt = Date.now() - (msg.timestamp as number);
				reportWsLatency(rtt);
				break;
			}
			case "error": {
				if (msgSessionId && msgSessionId !== currentSession) return;
				cb?.onError?.(msg.message as string, msg.paneId as string | undefined);
				break;
			}
			case "hook-event": {
				cb?.onHookEvent?.(
					msg.event as string,
					msg.cwd as string | undefined,
					msg.sessionId as string | undefined,
					msg.data as Record<string, unknown> | undefined,
					msg.message as string | undefined,
					msg.deliveredToGlasses as boolean | undefined,
				);
				break;
			}
			case "conversation-subscribed":
			case "conversation-unsubscribed":
			case "initial-conversation":
			case "conversation-update": {
				window.dispatchEvent(
					new CustomEvent("hrdle-conversation", { detail: msg }),
				);
				break;
			}
		}
	};

	ws.onclose = (event) => {
		console.log(
			`[MUX] WebSocket closed: code=${event.code} reason=${event.reason} msgs=${wsMsgCount}`,
		);
		window.clearInterval(bytesTimer);
		if (sharedConnectWatchdog) {
			clearTimeout(sharedConnectWatchdog);
			sharedConnectWatchdog = null;
		}
		if (sharedWs !== ws) return;

		sharedWs = null;
		wsReady = false;
		subscribedSession = null;
		if (sharedPingInterval) {
			clearInterval(sharedPingInterval);
			sharedPingInterval = null;
		}
		activeCallbacks?.setIsConnected?.(false);
		activeCallbacks?.onDisconnect?.();

		if (event.code !== 1000) {
			sharedReconnectTimeout = window.setTimeout(() => {
				ensureConnection(currentWsToken, currentWsBase);
			}, 2000);
		}
	};

	ws.onerror = () => {
		activeCallbacks?.onError?.("WebSocket connection error");
	};
}

// Visibility-based reconnect (shared, registered once)
let visibilityListenerRegistered = false;
export function registerVisibilityListener() {
	if (visibilityListenerRegistered) return;
	visibilityListenerRegistered = true;
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible") return;
		if (
			!sharedWs ||
			sharedWs.readyState === WebSocket.CLOSED ||
			sharedWs.readyState === WebSocket.CLOSING
		) {
			if (sharedReconnectTimeout) {
				clearTimeout(sharedReconnectTimeout);
				sharedReconnectTimeout = null;
			}
			ensureConnection(currentWsToken, currentWsBase);
			return;
		}
		// Returning to tab: if CONNECTING is older than a short threshold (3s),
		// assume the handshake stalled while backgrounded and force a fresh attempt
		// without waiting the full watchdog window.
		if (
			sharedWs.readyState === WebSocket.CONNECTING &&
			Date.now() - sharedWsConnectStart > 3000
		) {
			console.warn(
				"[MUX] visibility-change: stale CONNECTING, forcing reconnect",
			);
			try {
				sharedWs.close();
			} catch {}
		}
	});

	// Network status: when the OS reports the network came back, force a fresh
	// connection check. Without this, a stale OPEN socket left over from a
	// dropped cellular session can sit unnoticed until the next ping/pong fails.
	window.addEventListener("online", () => {
		console.log("[MUX] navigator online; refreshing connection");
		if (
			sharedWs?.readyState === WebSocket.CONNECTING ||
			sharedWs?.readyState === WebSocket.OPEN
		) {
			try {
				sharedWs.close();
			} catch {}
		}
		if (sharedReconnectTimeout) {
			clearTimeout(sharedReconnectTimeout);
			sharedReconnectTimeout = null;
		}
		ensureConnection(currentWsToken, currentWsBase);
	});
	window.addEventListener("offline", () => {
		console.log("[MUX] navigator offline");
	});
}

export function subscribeConversation(
	sessionId: string,
	agentSessionId?: string | null,
	token?: string | null,
) {
	const key = convKey(sessionId, agentSessionId);
	pendingConversationUnsubs.delete(key);
	if (sharedWs?.readyState === WebSocket.OPEN && wsReady) {
		// Already subscribed: nothing to do. The backend recreates the watcher
		// on every subscribe-conversation, so re-sending would needlessly tear
		// down and rebuild it (and re-send initial-conversation).
		if (subscribedConversations.has(key)) return;
		sharedWs.send(
			JSON.stringify({ type: "subscribe-conversation", ...convParts(key) }),
		);
		subscribedConversations.add(key);
	} else {
		pendingConversationSubs.add(key);
		// Reconnect to whichever server the socket already serves. With no base
		// given this would be the local hub, and a peer's conversation opened
		// while the socket was down took the socket away from that peer.
		ensureConnection(token ?? currentWsToken, currentWsBase);
	}
}

export function unsubscribeConversation(
	sessionId: string,
	agentSessionId?: string | null,
) {
	const key = convKey(sessionId, agentSessionId);
	pendingConversationSubs.delete(key);
	subscribedConversations.delete(key);
	if (sharedWs?.readyState === WebSocket.OPEN && wsReady) {
		sharedWs.send(
			JSON.stringify({ type: "unsubscribe-conversation", ...convParts(key) }),
		);
	} else {
		pendingConversationUnsubs.add(key);
	}
}

export function setMuxCallbacks(callbacks: MuxCallbacks) {
	activeCallbacks = callbacks;
}

/** Subscribes now if the socket is ready; otherwise `ready` does it. */
export function subscribeWhenReady(sessionId: string, sessionInstanceId?: string) {
	if (sharedWs?.readyState === WebSocket.OPEN && wsReady) {
		subscribeToSession(sessionId, sessionInstanceId);
	}
}

export function dropSessionSubscription() {
	if (subscribedSession) {
		sendRaw({ type: "unsubscribe", sessionId: subscribedSession });
		subscribedSession = null;
		subscribedSessionInstance = null;
	}
}

export function declareClient(deviceType: "mobile" | "tablet" | "desktop") {
	lastDeviceType = deviceType;
	sendClientInfoNow();
}

/** Says again whether the page is visible, under the type last declared. */
export function redeclareClient() {
	sendClientInfoNow();
}
