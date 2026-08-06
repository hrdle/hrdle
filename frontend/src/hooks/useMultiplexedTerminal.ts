import { useCallback, useEffect, useRef, useState } from "react";
import type { PaneDemand, PaneViewport, TmuxLayoutNode } from "../../../shared/types";
import { reportWsLatency } from "../services/latency-store";
import { appendWsToken } from "../services/peer-ws";
import { getDeviceId } from "../utils/device-id";
import { storageKey } from "../utils/app-storage";

interface UseMultiplexedTerminalOptions {
	sessionId: string;
	/** Immutable live-session identity (herdr workspace id). Session names can
	 * be reused after deletion, so this forces a fresh mux subscription. */
	sessionInstanceId?: string;
	token?: string | null;
	/** When false, suppress the live terminal subscription (remote-control mode,
	 * PC-only): CC Hub never opens a control stream, so the local herdr client
	 * keeps ownership of the terminal. Other operations are unaffected. */
	live?: boolean;
	// Multi-server: the WS base URL ("wss://host:port") of the active peer.
	// Defaults to the hub (window.location.host).
	peerWsBase?: string | null;
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
}

interface UseMultiplexedTerminalReturn {
	isConnected: boolean;
	connect: () => void;
	disconnect: () => void;
	sendInput: (paneId: string, data: string) => void;
	resize: (cols: number, rows: number, active?: boolean) => void;
	claimActiveSize: () => void;
	splitPane: (paneId: string, direction: "h" | "v") => void;
	closePane: (paneId: string) => void;
	resizePane: (paneId: string, cols: number, rows: number) => void;
	selectPane: (paneId: string) => void;
	adjustPane: (
		paneId: string,
		direction: "L" | "R" | "U" | "D",
		amount: number,
	) => void;
	setSplitRatios: (
		entries: Array<{
			paneA: string;
			paneB: string;
			dir: "h" | "v";
			ratio: number;
		}>,
	) => void;
	equalizePanes: (direction: "horizontal" | "vertical") => void;
	sendClientInfo: (deviceType: "mobile" | "tablet" | "desktop") => void;
	// Report the sizes at which this client currently renders each pane it shows
	// (per-client sizing). Additive to `resize`; the server reconciles one PTY
	// size per pane across clients.
	sendPaneDemands: (demands: Record<string, PaneDemand>) => void;
	// Ask the server for the viewport `offset` rows above the live edge.
	// offset=0 == live mode; the server will keep pushing unsolicited
	// updates whenever output arrives. offset>0 silences unsolicited pushes
	// until the next request-viewport.
	requestViewport: (paneId: string, offset: number) => void;
	zoomPane: (paneId: string, zoomed?: boolean) => void;
}

// =============================================================================
// Module-level singleton WebSocket — survives React component remounts
// =============================================================================

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
// subscription tear down the first (#80).
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

type MuxCallbacks = {
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

function sendSessionMessage(msg: Record<string, unknown>) {
	if (activeCallbacks) {
		sendRaw({ ...msg, sessionId: activeCallbacks.sessionId });
	}
}

// Last declared device type, replayed whenever the page is shown or hidden so
// the server knows which device the user is actually looking at. That decides
// which client owns the glasses focus.
let lastDeviceType: "mobile" | "tablet" | "desktop" | null = null;

function sendClientInfoNow() {
	if (!lastDeviceType) return;
	sendSessionMessage({
		type: "client-info",
		deviceType: lastDeviceType,
		visible: typeof document !== "undefined" && !document.hidden,
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
	sendRaw({ type: "subscribe", sessionId });
}

function ensureConnection(token?: string | null, wsBase?: string | null) {
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
	const bytesTimer = setInterval(() => {
		window.__cchub_ws_bytes_per_sec = wsBytesThisSec;
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
					new CustomEvent("cchub-conversation", { detail: msg }),
				);
				break;
			}
		}
	};

	ws.onclose = (event) => {
		console.log(
			`[MUX] WebSocket closed: code=${event.code} reason=${event.reason} msgs=${wsMsgCount}`,
		);
		clearInterval(bytesTimer);
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
function registerVisibilityListener() {
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

// =============================================================================
// Conversation stream API
// =============================================================================

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
		ensureConnection(token);
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

// =============================================================================
// React Hook
// =============================================================================

export function useMultiplexedTerminal(
	options: UseMultiplexedTerminalOptions,
): UseMultiplexedTerminalReturn {
	const { sessionId, sessionInstanceId, token, peerWsBase } = options;
	const [isConnected, setIsConnected] = useState(false);

	const onPaneViewportRef = useRef(options.onPaneViewport);
	const onLayoutChangeRef = useRef(options.onLayoutChange);
	const onHookEventRef = useRef(options.onHookEvent);
	const onConnectRef = useRef(options.onConnect);
	const onDisconnectRef = useRef(options.onDisconnect);
	const onSessionExitRef = useRef(options.onSessionExit);
	const onErrorRef = useRef(options.onError);

	onPaneViewportRef.current = options.onPaneViewport;
	onLayoutChangeRef.current = options.onLayoutChange;
	onHookEventRef.current = options.onHookEvent;
	onConnectRef.current = options.onConnect;
	onDisconnectRef.current = options.onDisconnect;
	onSessionExitRef.current = options.onSessionExit;
	onErrorRef.current = options.onError;

	useEffect(() => {
		activeCallbacks = {
			onPaneViewport: (p, v) => onPaneViewportRef.current?.(p, v),
			onLayoutChange: (l, z) => onLayoutChangeRef.current?.(l, z),
			onHookEvent: (e, c, s, d, m, g) =>
				onHookEventRef.current?.(e, c, s, d, m, g),
			onConnect: () => onConnectRef.current?.(),
			onDisconnect: () => onDisconnectRef.current?.(),
			onSessionExit: (reason) => onSessionExitRef.current?.(reason),
			onError: (e, p) => onErrorRef.current?.(e, p),
			setIsConnected,
			sessionId,
			sessionInstanceId,
			live: options.live ?? true,
		};
	});

	// Re-declare visibility whenever the page is shown or hidden. Putting a
	// device down must drop it out of the glasses focus election —
	// otherwise a tablet left on a session would keep stealing the glasses from
	// the phone in the user's hand.
	useEffect(() => {
		const onVisibilityChange = () => sendClientInfoNow();
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () =>
			document.removeEventListener("visibilitychange", onVisibilityChange);
	}, []);

	useEffect(() => {
		// On a peer switch ensureConnection force closes and reconnects, so
		// subscribeToSession runs once the connection is back (onopen/ready)
		if (peerWsBase !== undefined) {
			ensureConnection(token, peerWsBase);
		}
		if (sharedWs?.readyState === WebSocket.OPEN && wsReady) {
			subscribeToSession(sessionId, sessionInstanceId);
		}
	}, [sessionId, sessionInstanceId, token, peerWsBase]);

	const connect = useCallback(() => {
		registerVisibilityListener();
		ensureConnection(token, peerWsBase);
		if (sharedWs?.readyState === WebSocket.OPEN && wsReady) {
			subscribeToSession(sessionId, sessionInstanceId);
		}
	}, [sessionId, sessionInstanceId, token, peerWsBase]);

	const disconnect = useCallback(() => {
		if (subscribedSession) {
			sendRaw({ type: "unsubscribe", sessionId: subscribedSession });
			subscribedSession = null;
			subscribedSessionInstance = null;
		}
		setIsConnected(false);
	}, []);

	const sendInput = useCallback((paneId: string, data: string) => {
		const bytes = new TextEncoder().encode(data);
		const base64 = uint8ArrayToBase64(bytes);
		sendSessionMessage({ type: "input", paneId, data: base64 });
	}, []);

	// Last size we sent, so a tap can re-claim ownership at the current size.
	const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
	const resize = useCallback(
		(cols: number, rows: number, active?: boolean) => {
			lastResizeRef.current = { cols, rows };
			sendSessionMessage({ type: "resize", cols, rows, active });
		},
		[],
	);

	// Claim the session size for this client (tap-to-resize): re-send the last
	// size with `active`, so the device being tapped owns the shared size.
	const claimActiveSize = useCallback(() => {
		const last = lastResizeRef.current;
		if (!last) return;
		sendSessionMessage({ type: "resize", cols: last.cols, rows: last.rows, active: true });
	}, []);

	const splitPane = useCallback((paneId: string, direction: "h" | "v") => {
		sendSessionMessage({ type: "split", paneId, direction });
	}, []);

	const closePane = useCallback((paneId: string) => {
		sendSessionMessage({ type: "close-pane", paneId });
	}, []);

	const resizePane = useCallback(
		(paneId: string, cols: number, rows: number) => {
			sendSessionMessage({ type: "resize-pane", paneId, cols, rows });
		},
		[],
	);

	const selectPane = useCallback((paneId: string) => {
		sendSessionMessage({ type: "select-pane", paneId });
	}, []);

	const adjustPane = useCallback(
		(paneId: string, direction: "L" | "R" | "U" | "D", amount: number) => {
			sendSessionMessage({ type: "adjust-pane", paneId, direction, amount });
		},
		[],
	);

	// Set several split ratios atomically (one server relayout). Each entry
	// targets the split whose divider separates paneA from paneB; ratio =
	// paneA's side's share, 0..1.
	const setSplitRatios = useCallback(
		(
			entries: Array<{
				paneA: string;
				paneB: string;
				dir: "h" | "v";
				ratio: number;
			}>,
		) => {
			if (entries.length === 0) return;
			sendSessionMessage({ type: "set-split-ratios", entries });
		},
		[],
	);

	const equalizePanes = useCallback((direction: "horizontal" | "vertical") => {
		sendSessionMessage({ type: "equalize-panes", direction });
	}, []);

	const sendClientInfo = useCallback(
		(deviceType: "mobile" | "tablet" | "desktop") => {
			lastDeviceType = deviceType;
			sendClientInfoNow();
		},
		[],
	);

	const sendPaneDemands = useCallback(
		(demands: Record<string, PaneDemand>) => {
			sendSessionMessage({ type: "pane-demands", demands });
		},
		[],
	);

	const requestViewport = useCallback((paneId: string, offset: number) => {
		sendSessionMessage({ type: "request-viewport", paneId, offset });
	}, []);

	const zoomPane = useCallback((paneId: string, zoomed?: boolean) => {
		sendSessionMessage({ type: "zoom-pane", paneId, zoomed });
	}, []);

	return {
		isConnected,
		connect,
		disconnect,
		sendInput,
		resize,
		claimActiveSize,
		splitPane,
		closePane,
		resizePane,
		selectPane,
		adjustPane,
		setSplitRatios,
		equalizePanes,
		sendClientInfo,
		sendPaneDemands,
		requestViewport,
		zoomPane,
	};
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}
