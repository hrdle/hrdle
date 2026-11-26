import { useCallback, useEffect, useRef, useState } from "react";
import type { PaneDemand, PaneViewport, TmuxLayoutNode } from "../../../shared/types";
import {
	declareClient,
	dropSessionSubscription,
	ensureConnection,
	redeclareClient,
	registerVisibilityListener,
	sendSessionMessage,
	setMuxCallbacks,
	subscribeWhenReady,
} from "../services/mux-connection";

interface UseMultiplexedTerminalOptions {
	sessionId: string;
	/** Immutable live-session identity (herdr workspace id). Session names can
	 * be reused after deletion, so this forces a fresh mux subscription. */
	sessionInstanceId?: string;
	token?: string | null;
	/** When false, suppress the live terminal subscription (remote-control mode,
	 * PC-only): Hrdle never opens a control stream, so the local herdr client
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
	/**
	 * The session `isConnected` is true of, or null.
	 *
	 * `isConnected` alone lags a session switch by a render: it still reads
	 * true, from the session being left, in the commit that asks for the new
	 * one. Anything sent on the strength of it then is refused as "Not
	 * subscribed to session".
	 */
	connectedSessionId: string | null;
	/**
	 * This host is restarting herdr and every pane PTY with it. The socket
	 * stays up throughout, so without this the UI has no way to tell that the
	 * terminal it is showing has stopped being live.
	 */
	herdrRestarting: boolean;
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

export function useMultiplexedTerminal(
	options: UseMultiplexedTerminalOptions,
): UseMultiplexedTerminalReturn {
	const { sessionId, sessionInstanceId, token, peerWsBase } = options;
	const [isConnected, setIsConnected] = useState(false);
	const [connectedSessionId, setConnectedSessionId] = useState<string | null>(
		null,
	);
	/** True between this host's `herdr restarting` and `restored` broadcasts. */
	const [herdrRestarting, setHerdrRestarting] = useState(false);

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
		setMuxCallbacks({
			onPaneViewport: (p, v) => onPaneViewportRef.current?.(p, v),
			onLayoutChange: (l, z) => onLayoutChangeRef.current?.(l, z),
			onHookEvent: (e, c, s, d, m, g) =>
				onHookEventRef.current?.(e, c, s, d, m, g),
			onConnect: () => onConnectRef.current?.(),
			onDisconnect: () => onDisconnectRef.current?.(),
			onSessionExit: (reason) => onSessionExitRef.current?.(reason),
			onError: (e, p) => onErrorRef.current?.(e, p),
			onHerdrRestart: (phase) => setHerdrRestarting(phase === "restarting"),
			setIsConnected: (v) => {
				setIsConnected(v);
				setConnectedSessionId(v ? sessionId : null);
			},
			sessionId,
			sessionInstanceId,
			live: options.live ?? true,
		});
	});

	// Re-declare visibility whenever the page is shown or hidden. Putting a
	// device down must drop it out of the glasses focus election —
	// otherwise a tablet left on a session would keep stealing the glasses from
	// the phone in the user's hand.
	useEffect(() => {
		const onVisibilityChange = () => redeclareClient();
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
		subscribeWhenReady(sessionId, sessionInstanceId);
	}, [sessionId, sessionInstanceId, token, peerWsBase]);

	const connect = useCallback(() => {
		registerVisibilityListener();
		ensureConnection(token, peerWsBase);
		subscribeWhenReady(sessionId, sessionInstanceId);
	}, [sessionId, sessionInstanceId, token, peerWsBase]);

	const disconnect = useCallback(() => {
		dropSessionSubscription();
		setIsConnected(false);
		setConnectedSessionId(null);
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
			declareClient(deviceType);
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
		connectedSessionId,
		herdrRestarting,
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
