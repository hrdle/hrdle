/** biome-ignore-all lint/correctness/useExhaustiveDependencies: depends on refs and setters that React guarantees stable; adding them would cause unintended re-runs */
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type PaneInfo, samePeerId, type SessionState, type SessionTheme, type TmuxLayoutNode } from "../../../shared/types";
import type { LayoutVariant } from "../actions/sessionActions";
import { useMultiplexedTerminal } from "../hooks/useMultiplexedTerminal";
import { usePeerConnection } from "../hooks/usePeerConnection";
import { useRemoteControlMode } from "../hooks/useRemoteControlMode";
import { SessionActionBar } from "./SessionActionBar";
import { sessionFetch } from "../services/peer-fetch";
import { nukeClientCache } from "../utils/nuke-cache";
import { shouldFollowSessionDir } from "../utils/file-viewer-follow";
import { makeSessionKey, parseSessionKey } from "../utils/sessionKey";
import { usePeers } from "../hooks/usePeers";
import { updateCachedSessionsByHookEvent, useWorkspaces } from "../hooks/useWorkspaces";
import { fireHookNotification } from "../utils/hookNotification";
import { imagePastePayload } from "../utils/terminal-paste";
import { uploadImage } from "../utils/upload-image";
import { displayedPaneRoot, findPaneById } from "../utils/pane-display";
import { visiblePanes } from "../utils/panes";
import { PaneViewportStore } from "../utils/pane-viewport-store";
import { MobileDashboard } from "./dashboard/MobileDashboard";
import { DashboardPanel } from "./DashboardPanel";
import { FloatingKeyboard, type FloatingKeyboardRef } from "./FloatingKeyboard";
import { FileViewer } from "./files/FileViewer";
import { type ControlModeContext, PaneContainer, type PaneNode } from "./PaneContainer";
import { SessionModal } from "./SessionModal";
import type { ControlModeConfig, TerminalRef } from "./Terminal";
import { storageKey } from "../utils/app-storage";
import { applyBoundaryDrag, collectPaneDemands, computeTotalSizeFromTree, extractPaneSizes, firstLeafId, getAllPaneIds, tmuxLayoutToPaneNode, updateAllSessionKeys, updateSessionKey } from "../utils/pane-tree";
import {
	DEFAULT_FONT_SIZE,
	matchDesktopShortcut,
} from "../utils/desktop-shortcuts";

const DESKTOP_STATE_KEY = storageKey("desktop-state");
interface OpenSession {
	id: string;
	name: string;
	instanceId?: string;
	state: SessionState;
	currentPath?: string;
	ccSessionId?: string;
	theme?: SessionTheme;
	panes?: PaneInfo[];
	// Multi-server: peer this session belongs to. Unset = local Hub.
	peerId?: string;
}

interface DesktopState {
	root: PaneNode;
	activePane: string;
}

interface DesktopLayoutProps {
	sessions: OpenSession[];
	// Composite `peerId:id` key (utils/sessionKey.ts) of the active session.
	activeSessionKey: string | null;
	sessionSwitchRequest?: {
		sessionKey: string;
		requestId: number;
	} | null;
	onSessionStateChange: (sessionKey: string, state: SessionState) => void;
	/** Which screen this is drawing for. Every layout difference below hangs off
	 *  this one value rather than off a boolean per difference. */
	variant?: LayoutVariant;
	keyboardControlRef?: React.RefObject<{
		open: () => void;
		close: () => void;
	} | null>;
	/** Mobile only: open the app's session list. Which sessions are open and
	 *  which one is active is the app's state, not the layout's. */
	onShowSessionList?: () => void;
	/** Mobile only: whether that list is on screen, so the file browser can get
	 *  out from under it and the back gesture can close it. */
	sessionListOpen?: boolean;
	onCloseSessionList?: () => void;
	/** Focus one pane of the session being switched to - the session list can
	 *  name a pane, not just a workspace. Held until the server's tree actually
	 *  carries that pane, which is several messages after the switch. */
	paneFocusRequest?: { paneId: string; requestId: number } | null;
}

// Generate unique ID
let paneIdCounter = 0;
function generatePaneId(): string {
	return `pane-${Date.now()}-${++paneIdCounter}`;
}

// Create initial single pane
function createInitialState(sessionKey: string | null): DesktopState {
	const paneId = generatePaneId();
	return {
		root: { type: "terminal", sessionKey, id: paneId },
		activePane: paneId,
	};
}

const KEYBOARD_VISIBLE_KEY = storageKey("floating-keyboard-visible");

// Agent colour to a Tailwind text class. The names are the server's; the class
// strings have to be written out because Tailwind scans source text.
const AGENT_TEXT_COLOR: Record<string, string> = {
	red: "text-red-400",
	orange: "text-orange-400",
	amber: "text-amber-400",
	green: "text-green-400",
	teal: "text-teal-400",
	blue: "text-blue-400",
	cyan: "text-cyan-400",
	indigo: "text-indigo-400",
	purple: "text-purple-400",
	pink: "text-pink-400",
};

export function DesktopLayout({
	sessions: propSessions,
	activeSessionKey,
	sessionSwitchRequest,
	onSessionStateChange,
	variant = "desktop",
	keyboardControlRef,
	onShowSessionList,
	sessionListOpen = false,
	onCloseSessionList,
	paneFocusRequest,
}: DesktopLayoutProps) {
	const isTablet = variant === "tablet";
	const isMobile = variant === "mobile";
	const isMobileRef = useRef(isMobile);
	isMobileRef.current = isMobile;
	const { t } = useTranslation();
	const terminalRefs = useRef<Map<string, TerminalRef | null>>(new Map());
	const floatingKeyboardRef = useRef<FloatingKeyboardRef>(null);
	const activePaneRef = useRef<string>("");
	const paneContainerRef = useRef<HTMLDivElement>(null);

	// Get latest session info (including theme) from API
	const { sessions: apiSessions } = useWorkspaces();

	// Merge prop sessions with API sessions to get latest theme info
	// Sessions missing from propSessions are added from apiSessions (for split panes).
	// `peerId` is an immutable attribute naming the host a session belongs to, so the
	// apiSessions value always wins (propSession can hold a stale or unset one).
	const sessions =
		apiSessions.length > 0
			? apiSessions.map((apiSession) => {
					// The id (workspace name) can collide across peers, so match on peer too
					const propSession = propSessions.find(
						(p) =>
							p.id === apiSession.id && samePeerId(p.peerId, apiSession.peerId),
					);
					return propSession
						? {
								...propSession,
								instanceId: apiSession.instanceId,
								theme: apiSession.theme,
								currentCommand: apiSession.currentCommand,
								ccSessionId: apiSession.ccSessionId,
								agent: apiSession.agent,
								agentSessionId: apiSession.agentSessionId,
								panes: apiSession.panes,
								peerId: apiSession.peerId ?? propSession.peerId,
								bridgeSessionId: apiSession.bridgeSessionId,
								state: apiSession.state,
								indicatorState: apiSession.indicatorState,
								activity: apiSession.activity,
							}
						: {
								id: apiSession.id,
								name: apiSession.name,
								instanceId: apiSession.instanceId,
								state: apiSession.state,
								currentPath: apiSession.currentPath,
								ccSessionId: apiSession.ccSessionId,
								agent: apiSession.agent,
								agentSessionId: apiSession.agentSessionId,
								currentCommand: apiSession.currentCommand,
								theme: apiSession.theme,
								panes: apiSession.panes,
								peerId: apiSession.peerId,
								bridgeSessionId: apiSession.bridgeSessionId,
								indicatorState: apiSession.indicatorState,
								activity: apiSession.activity,
							};
				})
			: propSessions;
	const [fileViewerDirs, setFileViewerDirs] = useState<
		{ dir: string; peerId?: string }[]
	>([]);
	const [activeFileViewerDir, setActiveFileViewerDir] = useState<string | null>(
		null,
	);
	const [fileViewerOpenDirs, setFileViewerOpenDirs] = useState<Set<string>>(
		new Set(),
	);
	const openFileViewer = useCallback((dir: string, peerId?: string) => {
		setFileViewerDirs((prev) =>
			prev.some((d) => d.dir === dir) ? prev : [...prev, { dir, peerId }],
		);
		setActiveFileViewerDir(dir);
		setFileViewerOpenDirs((prev) => {
			const next = new Set(prev);
			next.add(dir);
			return next;
		});
	}, []);
	const closeFileViewer = useCallback((dir: string) => {
		setFileViewerOpenDirs((prev) => {
			const next = new Set(prev);
			next.delete(dir);
			return next;
		});
	}, []);
	const [showSessionModal, setShowSessionModal] = useState(false);
	const [showDashboard, setShowDashboard] = useState(false);

	// Which panes are showing a transcript rather than a terminal. The panes own
	// that state; this is the layout's copy of it, so the file browser's chat
	// button and the phone's back gesture have something to act on.
	const [chatOpenPanes, setChatOpenPanes] = useState<Set<string>>(new Set());
	const handleChatOpenChange = useCallback((paneId: string, open: boolean) => {
		setChatOpenPanes((prev) => {
			if (prev.has(paneId) === open) return prev;
			const next = new Set(prev);
			if (open) next.add(paneId);
			else next.delete(paneId);
			return next;
		});
	}, []);
	const [chatRequest, setChatRequest] = useState<{
		paneId: string;
		open: boolean;
		requestId: number;
	} | null>(null);
	const chatRequestIdRef = useRef(0);
	const requestPaneChat = useCallback((paneId: string, open: boolean) => {
		chatRequestIdRef.current += 1;
		setChatRequest({ paneId, open, requestId: chatRequestIdRef.current });
	}, []);

	// Remote-control mode (PC only): stop the live terminal render so the local
	// herdr client keeps ownership of the panes. Tablet keeps normal terminals.
	const { remoteControl: remoteControlFlag, toggleRemoteControl } =
		useRemoteControlMode();
	const remoteControl = variant === "desktop" && remoteControlFlag;
	const remoteControlRef = useRef(remoteControl);
	remoteControlRef.current = remoteControl;

	// Floating keyboard state (for tablet mode)
	const [showKeyboard, setShowKeyboard] = useState(() => {
		if (!isTablet) return false;
		try {
			return localStorage.getItem(KEYBOARD_VISIBLE_KEY) === "true";
		} catch {}
		return true; // Default to visible on tablet
	});
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [isUploading, setIsUploading] = useState(false);

	// Keyboard elevation for onboarding (raises z-index above overlay)
	const [keyboardElevated, setKeyboardElevated] = useState(false);

	// Register keyboard control for onboarding. Which keyboard that is depends on
	// the screen: a tablet's floats over the panes, a phone's is the InputBar
	// inside the one pane it is showing.
	useEffect(() => {
		if (!keyboardControlRef) return;
		if (isTablet) {
			keyboardControlRef.current = {
				open: () => {
					setShowKeyboard(true);
					setKeyboardElevated(true);
				},
				close: () => {
					setShowKeyboard(false);
					setKeyboardElevated(false);
				},
			};
		} else if (isMobile) {
			keyboardControlRef.current = {
				open: () =>
					terminalRefs.current.get(activePaneRef.current)?.showKeyboard(),
				close: () =>
					terminalRefs.current.get(activePaneRef.current)?.hideKeyboard(),
			};
		}
		return () => {
			keyboardControlRef.current = null;
		};
	}, [keyboardControlRef, isTablet, isMobile]);

	// Reload the page to remount every terminal pane from a fresh viewport
	const handleGlobalReload = useCallback(() => {
		window.location.reload();
	}, []);

	// Save keyboard visibility state
	useEffect(() => {
		if (isTablet) {
			localStorage.setItem(KEYBOARD_VISIBLE_KEY, String(showKeyboard));
		}
	}, [showKeyboard, isTablet]);

	// Load/save the pane tree.
	//
	// The phone keeps none of this. Its tree is always the one session the app
	// says is active, so a remembered tree would only be a second opinion about
	// that - and it shares a browser (and this key) with the desktop, whose tree
	// it would overwrite.
	const [desktopState, setDesktopState] = useState<DesktopState>(() => {
		if (isMobile) return createInitialState(activeSessionKey);
		try {
			const saved = localStorage.getItem(DESKTOP_STATE_KEY);
			if (saved) {
				const parsed = JSON.parse(saved) as DesktopState;
				if (parsed.root && parsed.activePane) {
					return { root: parsed.root, activePane: parsed.activePane };
				}
			}
		} catch {
			// Ignore
		}
		return createInitialState(activeSessionKey);
	});

	// Save state on change
	useEffect(() => {
		if (isMobile) return;
		localStorage.setItem(DESKTOP_STATE_KEY, JSON.stringify(desktopState));
	}, [desktopState, isMobile]);

	// The phone shows one session, and which one is the app's decision (the
	// session list, a notification, a restored last session). Desktop and tablet
	// treat the same prop as an initial value so a persisted tree survives.
	const appliedMobileSessionKeyRef = useRef<string | null>(null);
	useEffect(() => {
		if (!isMobile || !activeSessionKey) return;
		if (appliedMobileSessionKeyRef.current === activeSessionKey) return;
		appliedMobileSessionKeyRef.current = activeSessionKey;
		setDesktopState((prev) => ({
			...prev,
			root: updateAllSessionKeys(prev.root, activeSessionKey),
		}));
	}, [isMobile, activeSessionKey]);

	// Keep activePaneRef in sync
	useEffect(() => {
		activePaneRef.current = desktopState.activePane;
	}, [desktopState.activePane]);

	// Update initial session if state was fresh
	useEffect(() => {
		if (
			activeSessionKey &&
			desktopState.root.type === "terminal" &&
			!desktopState.root.sessionKey
		) {
			setDesktopState((prev) => ({
				...prev,
				root: updateSessionKey(prev.root, prev.activePane, activeSessionKey),
			}));
		}
	}, [activeSessionKey, desktopState.root]);

	// Notification navigation is an explicit external switch. Keep the ordinary
	// activeSessionKey prop from overwriting the user's persisted desktop state,
	// while still allowing a notification to move every pane to its target.
	const appliedSessionSwitchRequestRef = useRef(0);
	useEffect(() => {
		if (
			!sessionSwitchRequest ||
			sessionSwitchRequest.requestId === appliedSessionSwitchRequestRef.current
		) {
			return;
		}
		appliedSessionSwitchRequestRef.current = sessionSwitchRequest.requestId;
		setDesktopState((previous) => ({
			...previous,
			root: updateAllSessionKeys(previous.root, sessionSwitchRequest.sessionKey),
		}));
	}, [sessionSwitchRequest]);

	// =========================================================================
	// Control Mode
	// =========================================================================

	// Find the session that should be connected via control mode.
	// For now, use the first terminal pane's session as the control target.
	const getControlSessionKey = (): string | null => {
		const allPanes = getAllPaneIds(desktopState.root);
		for (const pid of allPanes) {
			const pane = findPaneById(desktopState.root, pid);
			if (pane?.type === "terminal" && pane.sessionKey) {
				return pane.sessionKey;
			}
		}
		return null;
	};

	// The pane tree stores composite keys, so the owning peer comes straight
	// out of the key — no intent / merged-list resolution.
	const controlSessionKey = getControlSessionKey();
	const controlTarget = controlSessionKey
		? parseSessionKey(controlSessionKey)
		: null;
	const controlSessionId = controlTarget?.id ?? null;
	const controlPeerId = controlTarget?.peerId;
	const controlSessionInstanceId = sessions.find(
		(session) =>
			session.id === controlSessionId &&
			samePeerId(session.peerId, controlPeerId),
	)?.instanceId;
	const [terminalGeneration, setTerminalGeneration] = useState(0);
	const [controlLayout, setControlLayout] = useState<TmuxLayoutNode | null>(
		null,
	);

	// Multi-server: when the active session lives on a remote peer, switch to that WS
	const { peers } = usePeers();
	const peerConn = usePeerConnection(
		controlSessionId || "",
		apiSessions,
		peers,
		controlPeerId,
	);

	// Refs for remote-control REST operations (avoid re-creating callbacks)
	const controlSessionIdRef = useRef(controlSessionId);
	controlSessionIdRef.current = controlSessionId;
	const controlPeerIdRef = useRef(controlPeerId);
	controlPeerIdRef.current = controlPeerId;
	const peersRef = useRef(peers);
	peersRef.current = peers;

	// Zoom state: when a pane is zoomed, show only that pane full-screen.
	// Mirrors the server's zoomedPaneId, carried on every layout message — the
	// server is the single source of truth. zoomPane sends intent only;
	// the state flips when the server's layout push confirms it, so a zoom made
	// on another client (or restored on reconnect) renders here too.
	const [zoomedPaneId, setZoomedPaneId] = useState<string | null>(null);
	const zoomedPaneIdRef = useRef<string | null>(null);
	zoomedPaneIdRef.current = zoomedPaneId;

	const [viewports] = useState(() => new PaneViewportStore());

	const desktopStateRef = useRef(desktopState);
	desktopStateRef.current = desktopState;
	const sessionsRef = useRef(sessions);
	sessionsRef.current = sessions;

	// Resolve the peer that owns the currently-active pane's session, so
	// image uploads land on the host whose Claude Code will read them.
	const getActivePeerId = useCallback((): string | undefined => {
		const pane = findPaneById(
			desktopStateRef.current.root,
			activePaneRef.current,
		);
		const key = pane?.type === "terminal" ? pane.sessionKey : null;
		return key ? parseSessionKey(key).peerId : undefined;
	}, []);

	// Timer for applying the server layout's exact pane sizes after a layout message
	const layoutSizeTimerRef = useRef<number | null>(null);

	// Flag: true while a layout change is being processed (React re-render pending).
	// While true, sendControlResize is suppressed to avoid sending stale proposed sizes.
	const layoutPendingRef = useRef(false);

	const controlTerminal = useMultiplexedTerminal({
		sessionId: controlSessionId || "",
		sessionInstanceId: controlSessionInstanceId,
		peerWsBase: peerConn.wsBase,
		token: peerConn.token,
		live: !remoteControl,
		onPaneViewport: (paneId, viewport) => viewports.receive(paneId, viewport),
		onLayoutChange: (layout, serverZoomedPaneId) => {
			setControlLayout(layout);
			setZoomedPaneId(serverZoomedPaneId);
			viewports.dropFrames();
			// "Last-write-wins": if the session's total size (from the layout root) differs
			// significantly from what we last sent, another client changed it.
			// Clear lastSentSizeRef so the next user interaction re-sends our size.
			const last = lastSentSizeRef.current;
			if (
				last &&
				(Math.abs(last.cols - layout.width) > 3 ||
					Math.abs(last.rows - layout.height) > 3)
			) {
				lastSentSizeRef.current = null;
			}
			// Suppress sendControlResize while React re-renders with new CSS ratios.
			// Without this, ResizeObserver fires with OLD container sizes → stale
			// proposed dimensions → wrong total sent to the server → size oscillation.
			layoutPendingRef.current = true;

			// Force each xterm.js to match the server layout's exact pane sizes.
			// In control mode, FitAddon.fit() is NOT called (proposeDimensions() is used
			// instead), so xterm size is ONLY set here from the server's layout messages.
			//
			// We must wait for React to re-render with updated CSS ratios AND for the
			// browser to paint (layout reflow). Use requestAnimationFrame to ensure
			// the DOM update has completed before applying sizes.
			if (layoutSizeTimerRef.current) {
				clearTimeout(layoutSizeTimerRef.current);
			}
			layoutSizeTimerRef.current = window.setTimeout(() => {
				requestAnimationFrame(() => {
					const sizes = extractPaneSizes(layout);
					// The layout tree is always the full split tree now, even while a
					// pane is zoomed. A zoomed pane's PTY fills the whole client, but
					// its tree rect is still the normal (e.g. half-width) split rect —
					// so size the zoomed pane to the full container to match its PTY.
					// Use the zoom that came WITH this layout message, not the ref —
					// the ref lags until React re-renders with the new state.
					const zoomedId = serverZoomedPaneId;
					for (const [paneId, size] of sizes) {
						const ref = terminalRefs.current?.get(paneId);
						if (!ref) continue;
						if (zoomedId && paneId === zoomedId) {
							ref.setExactSize(layout.width, layout.height);
						} else {
							ref.setExactSize(size.cols, size.rows);
						}
					}
					// Re-enable sendControlResize but do NOT send one here.
					// The layout message is the server's response to our resize — sending
					// another resize creates a feedback loop (223→221→223→…).
					layoutPendingRef.current = false;
				});
				// Safety timeout: ensure layoutPending is cleared even if rAF doesn't fire
				// (e.g. tab in background, browser throttling)
				setTimeout(() => {
					layoutPendingRef.current = false;
				}, 500);
			}, 50);
		},
		onConnect: () => {
			// Declare the device so this client can own the glasses focus.
			controlTerminal.sendClientInfo(variant);
			// Send resize with retries for terminal refresh on session switch.
			// The first resize triggers the backend to emit initial state snapshots.
			const delays = [100, 300, 600, 1000];
			for (const delay of delays) {
				setTimeout(() => sendControlResize(), delay);
			}
			// Fallback: explicitly request a viewport per pane in case resize was
			// skipped (layoutPending, dedup). Viewport fetches are idempotent.
			const requestAllViewports = (attempt = 0) => {
				const paneIds = viewports.listenedPaneIds();
				if (paneIds.length === 0 && attempt < 5) {
					setTimeout(() => requestAllViewports(attempt + 1), 300);
					return;
				}
				for (const paneId of paneIds) {
					controlTerminalRef.current.requestViewport(
						paneId,
						viewports.offset(paneId),
					);
				}
			};
			setTimeout(() => requestAllViewports(), 500);
		},
		onHookEvent: (event, cwd, sessionId, data, message) => {
			// `deliveredToGlasses` used to silence this. It says a relay item was
			// created, which only establishes that the glasses app holds a socket
			// — not that anyone is looking at a panel. Glasses in a case with the
			// app still running silenced everything else for nothing.
			fireHookNotification(event, cwd, sessionId, data, message, peerConn.peerId);
			// Update indicatorState on every useWorkspaces instance immediately
			updateCachedSessionsByHookEvent(event, sessionId);
		},
		onDisconnect: () => {},
		onSessionExit: () => {
			setControlLayout(null);
			setZoomedPaneId(null);
			viewports.clear();
			lastSentSizeRef.current = null;
			// Dispose every xterm surface immediately so a deleted terminal cannot
			// remain visible while the sessions list catches up.
			setTerminalGeneration((generation) => generation + 1);
		},
		onError: (err) => {
			console.error("[control-mode] Error:", err);
		},
	});

	// Ref for accessing control terminal in callbacks without deps
	const controlTerminalRef = useRef(controlTerminal);
	controlTerminalRef.current = controlTerminal;

	// Remote-control mode: pane operations go over REST (pure RPC — no control
	// stream, no PaneController). The WS path requires an active subscription,
	// which remote-control mode deliberately never opens.
	const restPaneOp = useCallback(
		(op: "focus" | "split" | "close", body: Record<string, unknown>) => {
			const sid = controlSessionIdRef.current;
			if (!sid) return;
			// sessionFetch only looks at peerId, so pass the peer from the composite key through
			const session = { peerId: controlPeerIdRef.current };
			sessionFetch(
				session,
				peersRef.current,
				`/api/workspaces/${encodeURIComponent(sid)}/panes/${op}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				},
			).catch((err) => {
				console.error(`[remote-control] panes/${op} failed:`, err);
			});
		},
		[],
	);

	// Reset control mode state when session changes (but NOT on initial mount).
	// On initial mount, child Terminal components register callbacks before this
	// parent effect runs (React runs child effects first). Clearing on initial mount
	// would wipe those callbacks, causing the first viewport push to be lost.
	const controlSessionInitializedRef = useRef(false);
	useEffect(() => {
		if (!controlSessionInitializedRef.current) {
			controlSessionInitializedRef.current = true;
			return; // Skip initial mount - refs are fresh/empty
		}
		setControlLayout(null);
		setZoomedPaneId(null);
		followedMobileZoomRef.current = null;
		viewports.forgetPositions();
		lastSentSizeRef.current = null;
	}, [controlSessionKey, controlSessionInstanceId]);

	// Connect/disconnect control mode.
	// Remote-control mode: drop the live subscription (disconnect sends only an
	// unsubscribe — sessionId is preserved) but still run connect() so the shared
	// WS stays up for hook events / conversation streams; subscribeToSession is
	// gated by `live: false`, so no PaneController is ever spawned.
	useEffect(() => {
		if (controlSessionId) {
			if (remoteControl) {
				controlTerminal.disconnect();
			}
			controlTerminal.connect();
		}
		return () => {
			controlTerminal.disconnect();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [controlSessionKey, controlSessionInstanceId, remoteControl]);

	// Control mode resize: compute TOTAL window size from layout tree.
	// The resize message carries cols×rows for the entire session window,
	// which is the sum of individual pane sizes + borders.
	const controlResizeTimerRef = useRef<number | null>(null);
	const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);

	const sendControlResize = useCallback(() => {
		if (controlResizeTimerRef.current) {
			clearTimeout(controlResizeTimerRef.current);
		}
		controlResizeTimerRef.current = window.setTimeout(() => {
			if (!controlTerminalRef.current.isConnected) {
				console.log("[Resize] Skipped: not connected");
				return;
			}

			// Skip while layout change is being processed by React.
			// Container CSS sizes haven't been updated yet, so proposeDimensions()
			// would return stale values and cause size oscillation.
			if (layoutPendingRef.current) {
				console.log("[Resize] Skipped: layout pending");
				return;
			}

			// When zoomed, compute size from the zoomed pane only (it fills the screen).
			// When not zoomed, compute from the full tree.
			const zoomedId = zoomedPaneIdRef.current;
			// A phone draws its one pane before the server has zoomed it, so
			// between those two moments the pane on screen is not the whole
			// window. Sending its size as the window's would have the server
			// divide it again; saying nothing leaves the pane at its last size
			// until the zoom lands, which is the recoverable half of the trade.
			if (isMobileRef.current) {
				const shown = displayedPaneRoot(desktopStateRef.current.root, {
					activePane: desktopStateRef.current.activePane,
					zoomedPaneId: zoomedId,
					isMobile: true,
				});
				if (
					getAllPaneIds(desktopStateRef.current.root).length > 1 &&
					zoomedId !== shown.id
				) {
					console.log("[Resize] Skipped: mobile zoom not confirmed");
					return;
				}
			}
			const root = zoomedId
				? findPaneById(desktopStateRef.current.root, zoomedId) ||
					desktopStateRef.current.root
				: desktopStateRef.current.root;
			// Use proposed dimensions (what fits each container) instead of actual
			// xterm size, since in control mode xterm size is set by the server's
			// layout messages, not by FitAddon.fit().
			const totalSize = computeTotalSizeFromTree(root, terminalRefs, true);
			if (totalSize && totalSize.cols > 0 && totalSize.rows > 0) {
				const last = lastSentSizeRef.current;
				// Tolerate ±3 difference to prevent resize oscillation.
				// proposeDimensions() and the server layout can disagree by 2-3 col/row
				// due to integer rounding of pane border allocation (the wire layout's
				// tmux-convention cell rects) and CSS layout differences.
				if (
					last &&
					Math.abs(last.cols - totalSize.cols) <= 3 &&
					Math.abs(last.rows - totalSize.rows) <= 3
				) {
					return; // Within tolerance, skip
				}
				lastSentSizeRef.current = {
					cols: totalSize.cols,
					rows: totalSize.rows,
				};
				console.log(`[Resize] Sending: ${totalSize.cols}x${totalSize.rows}`);
				controlTerminalRef.current.resize(totalSize.cols, totalSize.rows);
				// Per-client sizing: report the size we render each visible pane at,
				// from the same proposed dimensions the total was summed from (zoom-
				// aware root). Sent with resize so demands never lag the layout.
				controlTerminalRef.current.sendPaneDemands(
					collectPaneDemands(root, terminalRefs),
				);
			} else {
				console.log(
					`[Resize] Failed to compute size, root type=${root.type}, totalSize=`,
					totalSize,
				);
			}
		}, 50);
	}, []);

	// Compute control pane tree synchronously (not via useEffect) to avoid paneId mismatch
	const controlPaneTree = useMemo(() => {
		if (!controlLayout || !controlSessionKey) return null;
		return tmuxLayoutToPaneNode(controlLayout, controlSessionKey);
	}, [controlLayout, controlSessionKey]);

	// While a divider is actively dragged (real pointer/touch down..up, reported
	// by SplitContainer), keep the optimistic local ratios and defer any
	// incoming server tree. Applying it mid-drag would snap every divider to
	// the server's freshly-rounded ratios, so dragging one divider visibly
	// nudges the others.
	const dividerDragActiveRef = useRef(false);
	const pendingControlTreeRef = useRef<PaneNode | null>(null);

	const applyControlTree = useCallback((tree: PaneNode) => {
		const allPanes = getAllPaneIds(tree);
		setDesktopState((prev) => ({
			root: tree,
			activePane: allPanes.includes(prev.activePane)
				? prev.activePane
				: allPanes[0] || prev.activePane,
		}));
	}, []);

	// Update desktopState when control pane tree changes
	useEffect(() => {
		if (!controlPaneTree) return;
		if (dividerDragActiveRef.current) {
			pendingControlTreeRef.current = controlPaneTree;
			return;
		}
		// The server sends the full tree even while zoomed; zoom rides alongside
		// as zoomedPaneId and displayRoot applies it at render time.
		applyControlTree(controlPaneTree);
	}, [controlPaneTree, applyControlTree]);

	// React to a server-confirmed zoom change: re-measure and report our size
	// once the zoom-aware DOM has settled (the layout push that flipped the
	// state keeps layoutPending true for ~50ms+rAF, so an immediate call would
	// be skipped), and after an unzoom refetch the panes that were hidden —
	// their PTYs were resized back and their last viewports are stale.
	const prevZoomedPaneIdRef = useRef<string | null>(null);
	useEffect(() => {
		const prev = prevZoomedPaneIdRef.current;
		prevZoomedPaneIdRef.current = zoomedPaneId;
		if (prev === zoomedPaneId) return;
		const timer = window.setTimeout(() => {
			sendControlResize();
			if (prev && !zoomedPaneIdRef.current) {
				for (const pid of getAllPaneIds(desktopStateRef.current.root)) {
					if (pid === prev) continue;
					controlTerminalRef.current.requestViewport(pid, viewports.offset(pid));
				}
			}
		}, 300);
		return () => window.clearTimeout(timer);
	}, [zoomedPaneId, sendControlResize]);

	// Build control mode context for PaneContainer.
	// Always defined - Terminal components always use control mode.
	const controlModeContext: ControlModeContext = {
		getControlConfig: (paneId: string): ControlModeConfig | undefined => {
			return {
				paneId,
				sendInput: (data: string) => {
					if (controlTerminalRef.current.isConnected) {
						controlTerminalRef.current.sendInput(paneId, data);
					}
				},
				registerOnViewport: (callback) => {
					const stop = viewports.listen(paneId, callback);
					// Always request a fresh viewport when a Terminal mounts, in case
					// it joined after the initial viewport was sent.
					if (controlTerminalRef.current.isConnected) {
						controlTerminalRef.current.requestViewport(
							paneId,
							viewports.offset(paneId),
						);
					}
					return stop;
				},
				isConnected: controlTerminal.isConnected,
				claimActive: () => {
					controlTerminalRef.current.claimActiveSize();
				},
				onResize: () => {
					// Individual pane resize triggers total container size calculation.
					// The resize message must carry the TOTAL window size, not per-pane.
					sendControlResize();
				},
				forceResize: (cols: number, rows: number) => {
					if (!controlTerminalRef.current.isConnected) return;
					// forceResize sets the WHOLE client size. That is only correct when a
					// single pane fills the window (pane size == client size). With
					// multiple panes, a per-pane proposal (~1/N of the width) must NOT be
					// sent as the client size — doing so collapses the layout and the
					// client oscillates violently between one pane's width and the real
					// window width. Let normal convergence (sendControlResize + the ±3
					// tolerance) reconcile the per-pane rounding instead.
					if (getAllPaneIds(desktopStateRef.current.root).length > 1) return;
					// Send the requested geometry without consulting the dedup cache;
					// this is the escape hatch when the server's pane size disagrees
					// with what we last sent (e.g. a stale size held it stuck).
					lastSentSizeRef.current = { cols, rows };
					controlTerminalRef.current.resize(cols, rows);
				},
				scrollBy: (lines: number) => {
					if (!controlTerminalRef.current.isConnected) return;
					const next = viewports.scrollBy(paneId, lines);
					if (next !== null) {
						controlTerminalRef.current.requestViewport(paneId, next);
					}
				},
				scrollToLive: () => {
					if (!controlTerminalRef.current.isConnected) return;
					if (viewports.scrollToLive(paneId)) {
						controlTerminalRef.current.requestViewport(paneId, 0);
					}
				},
				refreshViewport: () => {
					if (!controlTerminalRef.current.isConnected) return;
					controlTerminalRef.current.requestViewport(
						paneId,
						viewports.offset(paneId),
					);
				},
				getScrollState: () => ({
					offset: viewports.offset(paneId),
					historySize: viewports.historySize(paneId),
				}),
			};
		},
		splitPane: (paneId: string, direction: "h" | "v") => {
			if (remoteControl) {
				restPaneOp("split", { paneId, direction });
				return;
			}
			controlTerminalRef.current.splitPane(paneId, direction);
		},
		closePane: (paneId: string) => {
			if (remoteControl) {
				restPaneOp("close", { paneId });
				return;
			}
			controlTerminalRef.current.closePane(paneId);
		},
		// Zoom is meaningless while the xterm area shows the remote-control
		// placeholder — leaving the handler unset also hides the zoom button.
		zoomPane: remoteControl
			? undefined
			: (paneId: string) => {
					console.log(`[zoom] ${paneId} (current=${zoomedPaneId})`);
					// Send explicit intent only; the zoom state flips when the server's
					// layout push confirms it, so all clients stay in sync.
					controlTerminalRef.current.zoomPane(paneId, zoomedPaneId !== paneId);
				},
		isZoomed: zoomedPaneId !== null,
		setKeyboardVisible: isTablet
			? (visible: boolean) => setShowKeyboard(visible)
			: undefined,
		onCopyPrompt: (text: string) => {
			if (isTablet) {
				setShowKeyboard(true);
				setTimeout(() => floatingKeyboardRef.current?.setInputText(text), 200);
			} else if (isMobile) {
				terminalRefs.current
					.get(activePaneRef.current)
					?.setInputText?.(text);
			} else {
				navigator.clipboard.writeText(text).catch(() => {});
			}
		},
		// The phone's list is the app's own screen: it decides which session is
		// open, which is more than picking one for a pane.
		onShowSessions: isMobile
			? onShowSessionList
			: () => setShowSessionModal(true),
		onShowDashboard: () => setShowDashboard(true),
		onOpenFileViewer: openFileViewer,
		chatRequest,
		onChatOpenChange: handleChatOpenChange,
		remoteControl,
	};

	const handleSplit = useCallback((direction: "horizontal" | "vertical") => {
		const activeId = activePaneRef.current;
		const dir = direction === "horizontal" ? "h" : "v";
		if (remoteControlRef.current) {
			restPaneOp("split", { paneId: activeId, direction: dir });
			return;
		}
		controlTerminalRef.current.splitPane(activeId, dir);
		// The server responds with a layout message
	}, []);

	const handleClosePane = useCallback((paneId?: string) => {
		const targetId = paneId || activePaneRef.current;
		if (remoteControlRef.current) {
			restPaneOp("close", { paneId: targetId });
			return;
		}
		controlTerminalRef.current.closePane(targetId);
		// The server responds with a layout message
	}, []);

	// Handle paste (text or image)
	const handlePaste = useCallback(async () => {
		const pasteText = async (text: string) => {
			if (text) {
				const ref = terminalRefs.current?.get(activePaneRef.current);
				ref?.sendInput(text);
			}
		};

		try {
			// Try to read clipboard items (for images)
			const items = await navigator.clipboard.read();
			let handled = false;
			for (const item of items) {
				// Check for image
				const imageType = item.types.find((t) => t.startsWith("image/"));
				if (imageType) {
					const blob = await item.getType(imageType);
					const result = await uploadImage(
						blob,
						getActivePeerId(),
						"clipboard-image.png",
					);
					if (result.ok && result.path) {
						const ref = terminalRefs.current?.get(activePaneRef.current);
						ref?.sendInput(imagePastePayload(result.path));
					} else {
						console.error("Upload failed:", result.error);
					}
					return;
				}

				// Check for text
				if (item.types.includes("text/plain")) {
					const blob = await item.getType("text/plain");
					const text = await blob.text();
					await pasteText(text);
					handled = true;
					break;
				}
			}
			// If no items were handled, try readText as fallback
			if (!handled) {
				const text = await navigator.clipboard.readText();
				await pasteText(text);
			}
		} catch {
			// Fallback to readText for browsers that don't support clipboard.read()
			try {
				const text = await navigator.clipboard.readText();
				await pasteText(text);
			} catch (err) {
				console.error("Clipboard read failed:", err);
			}
		}
	}, []);

	const handleFocusNavigation = useCallback(
		(key: string) => {
			const allPanes = getAllPaneIds(desktopState.root);
			const currentIndex = allPanes.indexOf(desktopState.activePane);
			if (currentIndex === -1) return;

			let nextIndex = currentIndex;
			if (key === "ArrowLeft" || key === "ArrowUp") {
				nextIndex = (currentIndex - 1 + allPanes.length) % allPanes.length;
			} else {
				nextIndex = (currentIndex + 1) % allPanes.length;
			}

			setDesktopState((prev) => ({ ...prev, activePane: allPanes[nextIndex] }));
			// Focus the terminal
			const ref = terminalRefs.current.get(allPanes[nextIndex]);
			ref?.focus();
		},
		[desktopState.root, desktopState.activePane],
	);

	// Keyboard shortcuts. Which chord means what is `matchDesktopShortcut`'s;
	// what each one does to this layout is here.
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const shortcut = matchDesktopShortcut(e);
			if (!shortcut) return;
			e.preventDefault();
			const activeTerminal = () =>
				terminalRefs.current?.get(activePaneRef.current);

			switch (shortcut.kind) {
				case "focus-pane":
					handleFocusNavigation(shortcut.key);
					return;
				case "split":
					handleSplit(shortcut.direction);
					return;
				case "close-pane":
					handleClosePane();
					return;
				case "copy": {
					// With no selection the browser's own copy is still suppressed and
					// the key left to xterm, which sends it on to the pane as SIGINT.
					const selection = activeTerminal()?.getSelection();
					if (selection) {
						navigator.clipboard.writeText(selection).catch((err) => {
							console.error("Clipboard write failed:", err);
						});
					}
					return;
				}
				case "paste":
					handlePaste();
					return;
				case "font-size":
					activeTerminal()?.changeFontSize(shortcut.delta);
					return;
				case "font-size-reset": {
					const ref = activeTerminal();
					if (ref) ref.changeFontSize(DEFAULT_FONT_SIZE - ref.getFontSize());
					return;
				}
				case "toggle-session-modal":
					setShowSessionModal((prev) => !prev);
					return;
				case "toggle-dashboard":
					setShowDashboard((prev) => !prev);
					return;
				case "resize-pane":
					// Pane sizes belong to the local herdr client in remote-control
					// mode, and the WS path would reject the unsubscribed session.
					if (remoteControlRef.current) return;
					controlTerminalRef.current.adjustPane(
						activePaneRef.current,
						shortcut.direction,
						shortcut.amount,
					);
					return;
				case "equalize-panes": {
					if (remoteControlRef.current) return;
					const root = desktopStateRef.current.root;
					const dir =
						root.type === "split" && root.direction === "vertical"
							? "vertical"
							: "horizontal";
					controlTerminalRef.current.equalizePanes(dir);
					return;
				}
				case "reload":
					void nukeClientCache();
					return;
				case "switch-session": {
					const session = sessions[shortcut.index];
					if (!session) return;
					setDesktopState((prev) => ({
						...prev,
						root: updateSessionKey(
							prev.root,
							prev.activePane,
							makeSessionKey(session.id, session.peerId),
						),
					}));
					return;
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [
		sessions,
		handleClosePane,
		handleFocusNavigation,
		handlePaste,
		handleSplit,
	]);

	// Floating keyboard handlers (for tablet mode)
	const handleKeyboardSend = useCallback((char: string): boolean => {
		if (!controlTerminalRef.current.isConnected) return false;
		const ref = terminalRefs.current?.get(activePaneRef.current);
		if (!ref) return false;
		ref.sendInput(char);
		return true;
	}, []);

	const handleFilePicker = useCallback(() => {
		fileInputRef.current?.click();
	}, []);

	const handleFileSelect = useCallback(
		async (e: React.ChangeEvent<HTMLInputElement>) => {
			const file = e.target.files?.[0];
			if (!file) return;

			e.target.value = "";
			setIsUploading(true);

			try {
				const result = await uploadImage(file, getActivePeerId());
				if (result.ok && result.path) {
					const ref = terminalRefs.current?.get(activePaneRef.current);
					ref?.sendInput(imagePastePayload(result.path));
				} else {
					console.error("Upload failed:", result.error);
				}
			} finally {
				setIsUploading(false);
			}
		},
		[getActivePeerId],
	);

	const handleFocusPane = useCallback((paneId: string) => {
		// Clear selection in all terminals to prevent stale selection on other panes
		for (const [, ref] of terminalRefs.current) {
			ref?.clearSelection();
		}
		setDesktopState((prev) => ({ ...prev, activePane: paneId }));
		if (remoteControlRef.current) {
			restPaneOp("focus", { paneId });
		} else {
			controlTerminalRef.current.selectPane(paneId);
		}
	}, []);
	// Reached from an effect declared above this point.
	const handleFocusPaneRef = useRef(handleFocusPane);
	handleFocusPaneRef.current = handleFocusPane;

	const handleSelectSessionForPane = useCallback(
		(paneId: string, sessionKey?: string) => {
			if (!sessionKey) return;

			// All panes belong to one workspace (session).
			// Update ALL panes' sessionKey so getControlSessionKey() returns the new
			// session, triggering control WebSocket reconnection to the new session.
			setDesktopState((prev) => ({
				...prev,
				root: updateAllSessionKeys(prev.root, sessionKey),
				activePane: paneId,
			}));
			// Clear stale layout so the new session's layout takes effect
			setControlLayout(null);
			viewports.forgetPositions();
			lastSentSizeRef.current = null;
		},
		[],
	);

	// True when at least one ratio change happened during the current drag, so
	// drag-end knows whether there is anything to sync to the server.
	const dividerDragDirtyRef = useRef(false);

	// During a drag, only the local (optimistic) tree updates — nothing is
	// sent. On release, handleSplitDragStateChange syncs the ratios once.
	const handleSplitRatioChange = useCallback(
		(nodeId: string, ratio: number[], dividerIndex: number) => {
			dividerDragDirtyRef.current = true;
			setDesktopState((prev) => ({
				...prev,
				root: applyBoundaryDrag(prev.root, nodeId, ratio, dividerIndex),
			}));
		},
		[],
	);

	const handleSplitDragStateChange = useCallback(
		(active: boolean) => {
			dividerDragActiveRef.current = active;
			if (active) return;
			// Drag ended. Any tree deferred mid-drag predates the final ratios —
			// drop it; the layout push answering set-split-ratios supersedes it.
			pendingControlTreeRef.current = null;
			const dirty = dividerDragDirtyRef.current;
			dividerDragDirtyRef.current = false;
			if (!dirty || !controlTerminalRef.current.isConnected) return;
			// A boundary drag renormalizes several splits, so sync ALL split
			// ratios in one atomic relayout — idempotent, no diffing needed. Each
			// split is identified for the server by one leaf from each side:
			// their lowest common ancestor is exactly that split, which sidesteps
			// the "deepest same-direction ancestor" ambiguity of pane-size-based
			// resizing (h[h[A,B],C]'s outer divider is unreachable per-pane).
			const entries: Array<{
				paneA: string;
				paneB: string;
				dir: "h" | "v";
				ratio: number;
			}> = [];
			const collect = (node: PaneNode): void => {
				if (node.type !== "split") return;
				node.children.forEach(collect);
				if (node.children.length !== 2) return; // server splits are binary
				const paneA = firstLeafId(node.children[0]);
				const paneB = firstLeafId(node.children[1]);
				const share = (node.ratio[0] ?? 50) / 100;
				if (!paneA || !paneB || !Number.isFinite(share)) return;
				entries.push({
					paneA,
					paneB,
					dir: node.direction === "horizontal" ? "h" : "v",
					ratio: Math.min(0.9, Math.max(0.1, share)),
				});
			};
			collect(desktopStateRef.current.root);
			controlTerminalRef.current.setSplitRatios(entries.slice(0, 32));
		},
		[],
	);

	// What is actually on screen. The rule, and the reason a phone does not wait
	// for the server's zoom to narrow it, are in `utils/pane-display.ts`.
	const displayRoot = useMemo(
		() =>
			displayedPaneRoot(desktopState.root, {
				activePane: desktopState.activePane,
				zoomedPaneId,
				isMobile,
			}),
		[desktopState.root, desktopState.activePane, zoomedPaneId, isMobile],
	);

	// The panes the phone's tab bar offers, in tree order.
	const mobilePaneIds = useMemo(
		() => (isMobile ? getAllPaneIds(desktopState.root) : []),
		[isMobile, desktopState.root],
	);

	// The pane on screen is drawn at the size of the whole window, so the server
	// has to agree that it *is* the whole window - which is what the zoom asks
	// for. The rendering does not wait for that answer (see `pane-display.ts`);
	// this keeps asking until it arrives.
	//
	// It has to keep asking rather than ask once. `zoom-pane` is dropped without
	// error when the socket is not open, and the zoom is server state any other
	// client can change - a desktop on the same workspace unzooms, and this
	// phone is left sized for a pane it no longer has. Neither surfaces as an
	// error, only as a terminal wrapping at the wrong width, so checking and
	// re-asserting is the only way to notice.
	useEffect(() => {
		if (!isMobile || !controlTerminal.isConnected) return;
		if (mobilePaneIds.length <= 1) return;
		// The pane the tree actually draws, which is not always the focused one:
		// a stale id resolves to the first leaf rather than to a split.
		const shown = displayRoot.id;
		if (zoomedPaneId === shown) return;
		controlTerminalRef.current.zoomPane(shown, true);
		const timer = window.setInterval(() => {
			if (zoomedPaneIdRef.current === shown) return;
			controlTerminalRef.current.zoomPane(shown, true);
		}, 2000);
		return () => window.clearInterval(timer);
	}, [
		isMobile,
		displayRoot,
		mobilePaneIds,
		zoomedPaneId,
		controlTerminal.isConnected,
	]);

	const [pendingPaneFocus, setPendingPaneFocus] = useState<string | null>(null);
	const appliedPaneFocusRef = useRef(0);
	useEffect(() => {
		if (
			!paneFocusRequest ||
			paneFocusRequest.requestId === appliedPaneFocusRef.current
		)
			return;
		appliedPaneFocusRef.current = paneFocusRequest.requestId;
		setPendingPaneFocus(paneFocusRequest.paneId);
	}, [paneFocusRequest]);
	// Pane ids repeat across workspaces (`%1` is in most of them), so finding
	// the pane in the tree is not evidence the tree is the right session's: a
	// request made while opening a session matched the one being left, and the
	// focus went out before the subscribe it depended on. The REST path of
	// remote-control mode needs no subscription.
	const paneFocusReady =
		remoteControl || controlTerminal.connectedSessionId === controlSessionId;
	useEffect(() => {
		if (!pendingPaneFocus || !paneFocusReady) return;
		if (!findPaneById(desktopState.root, pendingPaneFocus)) return;
		setPendingPaneFocus(null);
		handleFocusPaneRef.current(pendingPaneFocus);
	}, [pendingPaneFocus, desktopState.root, paneFocusReady]);

	// A reload restores whatever the server had zoomed. Follow it once so the
	// tab bar marks the pane that is actually on screen; after that the bar owns
	// the choice again.
	const followedMobileZoomRef = useRef<string | null>(null);
	useEffect(() => {
		if (!isMobile || !zoomedPaneId) return;
		if (followedMobileZoomRef.current === zoomedPaneId) return;
		followedMobileZoomRef.current = zoomedPaneId;
		setDesktopState((prev) =>
			prev.activePane === zoomedPaneId
				? prev
				: { ...prev, activePane: zoomedPaneId },
		);
	}, [isMobile, zoomedPaneId]);

	// Get active session for file viewer — the pane's composite key carries the
	// owning peer, so a same-name session on another peer can't match.
	const activePane = findPaneById(desktopState.root, desktopState.activePane);
	const activePaneSessionKey =
		activePane?.type === "terminal" ? activePane.sessionKey : null;
	const activePaneTarget = activePaneSessionKey
		? parseSessionKey(activePaneSessionKey)
		: null;
	const activeSession = activePaneTarget
		? (sessions.find(
				(s) =>
					s.id === activePaneTarget.id &&
					samePeerId(s.peerId, activePaneTarget.peerId),
			) ?? null)
		: null;

	// The phone's back gesture closes what is on top rather than leaving the app.
	// Once something has been opened there is always a history entry to pop, and
	// the handler pushes a new one each time so the trap stays armed.
	//
	// Desktop and tablet are left alone: nothing here ever pushes on those, so
	// back has always walked out of the app and this would silently change that.
	const fileViewerVisible = activeFileViewerDir
		? fileViewerOpenDirs.has(activeFileViewerDir)
		: false;
	const chatPaneOnScreen = chatOpenPanes.has(desktopState.activePane)
		? desktopState.activePane
		: null;
	useEffect(() => {
		if (!isMobile) return;
		const handlePopState = () => {
			if (sessionListOpen) {
				onCloseSessionList?.();
			} else if (fileViewerVisible) {
				if (activeFileViewerDir) closeFileViewer(activeFileViewerDir);
			} else if (chatPaneOnScreen) {
				requestPaneChat(chatPaneOnScreen, false);
			}
			window.history.pushState({ view: "terminal" }, "", window.location.href);
		};
		window.addEventListener("popstate", handlePopState);
		return () => window.removeEventListener("popstate", handlePopState);
	}, [
		isMobile,
		sessionListOpen,
		onCloseSessionList,
		fileViewerVisible,
		activeFileViewerDir,
		closeFileViewer,
		chatPaneOnScreen,
		requestPaneChat,
	]);

	useEffect(() => {
		if (!isMobile) return;
		if (sessionListOpen || fileViewerVisible || chatPaneOnScreen) {
			window.history.pushState({ view: "overlay" }, "", window.location.href);
		}
	}, [isMobile, sessionListOpen, fileViewerVisible, chatPaneOnScreen]);

	// The pane the file browser's chat button would switch, when an agent is
	// running in it. Mobile only: chat is one of the phone's actions,
	// and the other two layouts toggle it from the pane header instead.
	const activeChatPane = (() => {
		if (!isMobile) return null;
		const pane = activeSession?.panes?.find(
			(p) => p.paneId === desktopState.activePane,
		);
		return pane?.agent ? desktopState.activePane : null;
	})();

	// Whose edits the file browser's Claude changes list shows: the focused
	// pane's own session. The browser is one per directory and a directory can
	// hold several sessions, so the directory cannot answer this.
	const activeClaudeSessionId = (() => {
		const pane =
			activeSession?.panes?.find((p) => p.paneId === desktopState.activePane) ??
			activeSession?.panes?.find((p) => p.isActive);
		return pane?.agent === "claude" ? (pane.agentSessionId ?? undefined) : undefined;
	})();

	// An open file browser follows the session the pane is showing. Without
	// this it keeps whichever directory it was opened for while the header
	// names the new session — so the panel lists one workspace's files under
	// another's name, and the Changes tab reports a repo the pane is not in.
	//
	// Keyed on the session, not on its currentPath: currentPath is the pane's
	// foreground cwd, so keying on it would yank the panel elsewhere the moment
	// someone typed `cd` in the terminal.
	const followedSessionKeyRef = useRef<string | null>(activePaneSessionKey);
	useEffect(() => {
		if (followedSessionKeyRef.current === activePaneSessionKey) return;
		const dir = activeSession?.currentPath;
		// The session list can arrive a render after the switch. Leave the ref
		// alone until it does, or the switch is recorded as handled and the
		// panel stays where it was.
		if (!dir) return;
		followedSessionKeyRef.current = activePaneSessionKey;
		if (!shouldFollowSessionDir(dir, activeFileViewerDir, fileViewerOpenDirs))
			return;
		openFileViewer(dir, activeSession.peerId);
	}, [
		activePaneSessionKey,
		activeSession,
		activeFileViewerDir,
		fileViewerOpenDirs,
		openFileViewer,
	]);

	// Handle session selection from modal
	const handleModalSelectSession = useCallback(
		(session: { id: string; peerId?: string; currentPath?: string }) => {
			const paneId = activePaneRef.current;
			handleSelectSessionForPane(
				paneId,
				makeSessionKey(session.id, session.peerId),
			);
		},
		[handleSelectSessionForPane],
	);

	const handleModalSelectPane = useCallback(
		(session: { id: string; peerId?: string }, paneId: string) => {
			handleSelectSessionForPane(
				activePaneRef.current,
				makeSessionKey(session.id, session.peerId),
			);
			setPendingPaneFocus(paneId);
		},
		[handleSelectSessionForPane],
	);

	// The phone's substitute for a split, shown only when there is more than one
	// pane to choose between.
	//
	// It is handed to the pane rather than drawn here, because the two things
	// that want the bottom of a phone's screen have to be stacked by someone who
	// can see both. Drawn here it sat in the layout's flow while the session bar
	// was `fixed bottom-0` over the top of it - and a fixed element consumes no
	// height, so the tab bar had no way to know it was covered. It was, whole:
	// 27px of it inside the bar's 51, unreachable by any tap (#406).
	// Listed from the session rather than from the rendered tree. The tree is the
	// layout this client has been sent, and it can carry one pane while the
	// workspace has two - which is exactly when the tabs are needed. The session
	// list is where their labels already came from.
	const mobileTabPanes = isMobile ? visiblePanes(activeSession) : [];
	const mobilePaneTabs =
		isMobile && mobileTabPanes.length > 1 ? (
			<div className="flex bg-th-surface border-t border-th-border shrink-0 overflow-x-auto">
				{mobileTabPanes.map((apiPane) => {
					const paneId = apiPane.paneId;
					const isActive = paneId === desktopState.activePane;
					// Priority: agentName > command > paneId
					const label = apiPane.agentName || apiPane.currentCommand || paneId;
					const colorCls =
						apiPane.agentColor && AGENT_TEXT_COLOR[apiPane.agentColor];
					return (
						<button
							type="button"
							key={paneId}
							onClick={() => handleFocusPane(paneId)}
							className={`px-3 min-h-10 text-xs font-mono whitespace-nowrap transition-colors ${
								isActive
									? `${colorCls || "text-th-text"} bg-th-surface-hover border-t-2 border-blue-400`
									: `${colorCls || "text-th-text-secondary"} hover:text-th-text hover:bg-th-surface-hover/50`
							}`}
						>
							{label}
						</button>
					);
				})}
			</div>
		) : null;

	// data-layout pins which of the three layout trees rendered; the responsive
	// e2e matrix asserts on it so a viewport can't silently fall through to the
	// wrong one.
	return (
		<div className="h-full flex bg-th-bg" data-layout={variant}>
			{/* Main content */}
			<div className="flex-1 flex flex-col min-w-0">
				{/* Header - desktop: minimal icons, tablet: full toolbar. The phone
				    has none: its bar is at the bottom, under the thumb, and a strip
				    here would cost rows on the smallest screen there is. */}
				{variant === "desktop" && (
					<div className="flex items-center justify-end px-2 py-0.5 bg-[#0a0a0a] border-b border-white/[0.06] shrink-0 select-none">
						<SessionActionBar
							variant="desktop"
							className="flex items-center gap-0.5"
							handlers={{
								sessions: {
									active: showSessionModal,
									onSelect: () => setShowSessionModal((prev) => !prev),
								},
								dashboard: {
									active: showDashboard,
									onSelect: () => setShowDashboard((prev) => !prev),
								},
								"remote-control": {
									active: remoteControl,
									onSelect: toggleRemoteControl,
								},
							}}
						/>
					</div>
				)}
				{isTablet && (
					<div className="shrink-0 select-none bg-[#0a0a0a] border-b border-white/[0.06]">
						{/* Top bar: session selector + core actions */}
						<div className="flex items-center gap-2 px-3 py-1.5">
							{/* Left: Session selector */}
							<button
								type="button"
								onClick={() => setShowSessionModal((prev) => !prev)}
								className="flex min-h-10 items-center gap-1.5 px-2 py-1 rounded-md hover:bg-white/[0.06] transition-colors"
								data-onboarding="session-list"
							>
								<div
									className={`w-2 h-2 rounded-full ${
										activeSession?.state === "working"
											? "bg-blue-500"
											: (
														activeSession?.state === "waiting_input" ||
															activeSession?.state === "waiting_permission"
													)
												? "bg-amber-400 animate-pulse"
												: "bg-zinc-600"
									}`}
								/>
								<span className="text-[13px] font-medium text-white truncate max-w-[200px]">
									{activeSession?.name || "Hrdle"}
								</span>
								<ChevronDown className="w-3 h-3 text-zinc-500" />
							</button>

							<div className="flex-1" />

							{/* Right: Action icons, from the shared definition */}
							<SessionActionBar
								variant="tablet"
								className="flex items-center gap-0.5"
								handlers={{
									files: {
										onSelect: () => {
											const dir = activeSession?.currentPath;
											if (dir) openFileViewer(dir, activeSession?.peerId);
										},
									},
									dashboard: {
										active: showDashboard,
										onSelect: () => setShowDashboard((prev) => !prev),
									},
									"split-h": { onSelect: () => handleSplit("horizontal") },
									"split-v": { onSelect: () => handleSplit("vertical") },
									reload: { onSelect: handleGlobalReload },
									keyboard: {
										active: showKeyboard,
										onSelect: () => setShowKeyboard((prev) => !prev),
									},
								}}
							/>
						</div>
					</div>
				)}

				{/* Every pane PTY is being re-created; the terminals below are showing
				    the last frame of processes that no longer exist. Saying so is the
				    difference between a wait and a hang. */}
				{controlTerminal.herdrRestarting && (
					<div className="shrink-0 px-3 py-1.5 bg-amber-500/15 border-b border-amber-500/30 text-[11px] text-amber-200 flex items-center gap-2">
						<span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
						{t("terminal.herdrRestarting")}
					</div>
				)}

				{/* Pane container */}
				<div
					className="flex-1 min-h-0 select-none"
					data-onboarding="terminal"
					ref={paneContainerRef}
				>
					<PaneContainer
						node={displayRoot}
						activePane={desktopState.activePane}
						onFocusPane={handleFocusPane}
						onSelectSession={handleSelectSessionForPane}
						onSessionStateChange={onSessionStateChange}
						onSplitRatioChange={handleSplitRatioChange}
						onSplitDragStateChange={handleSplitDragStateChange}
						onClosePane={handleClosePane}
						onSplit={handleSplit}
						sessions={sessions}
						terminalRefs={terminalRefs}
						globalReloadKey={terminalGeneration}
						variant={variant}
						paneTabs={mobilePaneTabs}
						controlModeContext={controlModeContext}
					/>
				</div>

			</div>

			{/* Dashboard - a side panel beside the terminal, except on a phone,
			    where it takes the screen. */}
			{isMobile ? (
				showDashboard && (
					<MobileDashboard onClose={() => setShowDashboard(false)} />
				)
			) : (
				<DashboardPanel
					isOpen={showDashboard}
					onClose={() => setShowDashboard(false)}
					isTablet={variant === "tablet"}
				/>
			)}

			{/* Session modal. The phone has no use for it - its list is a screen of
			    the app's own, opened through onShowSessionList. */}
			{!isMobile && (
				<SessionModal
					isOpen={showSessionModal}
					onClose={() => setShowSessionModal(false)}
					onSelectSession={handleModalSelectSession}
					onSelectPane={handleModalSelectPane}
					isTablet={variant === "tablet"}
				/>
			)}

			{/* File Viewer Modal - per-session instances kept mounted */}
			{fileViewerDirs.map(({ dir, peerId }) => (
				<FileViewer
					key={dir}
					sessionWorkingDir={dir}
					peerId={peerId}
					claudeSessionId={
						dir === activeFileViewerDir ? activeClaudeSessionId : undefined
					}
					onClose={() => closeFileViewer(dir)}
					hidden={
						!fileViewerOpenDirs.has(dir) ||
						dir !== activeFileViewerDir ||
						(isMobile ? sessionListOpen : showSessionModal)
					}
					onCopyPrompt={(text) => {
						controlModeContext.onCopyPrompt?.(text);
						closeFileViewer(dir);
					}}
					onShowSessions={() => {
						controlModeContext.onShowSessions?.();
					}}
					sessionName={activeSession?.name}
					sessionStatus={activeSession?.state}
					onShowConversation={
						activeChatPane
							? () => requestPaneChat(activeChatPane, true)
							: undefined
					}
					onShowDashboard={() => setShowDashboard((prev) => !prev)}
					sessionPlaces={sessions
						.filter(
							(s) =>
								samePeerId(s.peerId, peerId) &&
								!!s.currentPath &&
								s.currentPath !== dir,
						)
						.map((s) => ({ name: s.name, path: s.currentPath as string }))}
				/>
			))}

			{/* Floating Keyboard (tablet only) */}
			{isTablet && (
				<>
					{/* Hidden file input for image upload */}
					<input
						type="file"
						accept="image/png,image/jpeg,image/gif,image/webp"
						className="hidden"
						ref={fileInputRef}
						onChange={handleFileSelect}
					/>

					<FloatingKeyboard
						ref={floatingKeyboardRef}
						// It types into the pane, and the chat has a composer of its own:
						// with both up, the keyboard on screen is not the one being read.
						visible={showKeyboard && !chatPaneOnScreen}
						onClose={() => setShowKeyboard(false)}
						onSend={handleKeyboardSend}
						onFilePicker={handleFilePicker}
						isUploading={isUploading}
						elevated={keyboardElevated}
					/>
				</>
			)}

		</div>
	);
}
