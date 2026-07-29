/** biome-ignore-all lint/correctness/useExhaustiveDependencies: depends on refs and setters that React guarantees stable; adding them would cause unintended re-runs */
import {
	BarChart3,
	ChevronDown,
	FileText,
	Keyboard,
	List,
	RefreshCw,
	SplitSquareHorizontal,
	SplitSquareVertical,
	Unplug,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type PaneViewport,
	samePeerId,
	type SessionState,
	type SessionTheme,
	type TmuxLayoutNode,
} from "../../../shared/types";
import {
	sendTerminalInputRest,
	useMultiplexedTerminal,
} from "../hooks/useMultiplexedTerminal";
import { usePeerConnection } from "../hooks/usePeerConnection";
import { useRemoteControlMode } from "../hooks/useRemoteControlMode";
import { sessionFetch } from "../services/peer-fetch";
import { nukeClientCache } from "../utils/nuke-cache";
import {
	makeSessionKey,
	migrateStoredPaneNode,
	parseSessionKey,
	type StoredPaneNode,
} from "../utils/sessionKey";
import { usePeers } from "../hooks/usePeers";
import {
	updateCachedSessionsByHookEvent,
	useWorkspaces,
} from "../hooks/useWorkspaces";
import { fireHookNotification } from "../utils/hookNotification";
import { uploadImage } from "../utils/upload-image";
import { makePseudoViewport } from "../utils/viewport-pseudo";
import { DashboardPanel } from "./DashboardPanel";
import { FloatingKeyboard, type FloatingKeyboardRef } from "./FloatingKeyboard";
import { FileViewer } from "./files/FileViewer";
import {
	type ControlModeContext,
	PaneContainer,
	type PaneNode,
} from "./PaneContainer";
import { SessionModal } from "./SessionModal";
import type { ControlModeConfig, TerminalRef } from "./Terminal";
import { storageKey } from "../utils/app-storage";

const DESKTOP_STATE_KEY = storageKey("desktop-state");
// Pre-#487 storage: the peer the user last picked a session from. The pane
// tree now stores composite `peerId:id` keys, so this only feeds the one-time
// migration of a legacy saved tree and is removed afterwards.
const LEGACY_SESSION_PEER_KEY = storageKey("desktop-session-peer");

function readLegacySessionPeerIntent(): { id: string; peerId: string } | null {
	try {
		const raw = localStorage.getItem(LEGACY_SESSION_PEER_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed.id === "string" && typeof parsed.peerId === "string")
			return parsed;
	} catch {
		// ignore
	}
	return null;
}

interface OpenSession {
	id: string;
	name: string;
	instanceId?: string;
	state: SessionState;
	currentPath?: string;
	ccSessionId?: string;
	theme?: SessionTheme;
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
	isTablet?: boolean;
	keyboardControlRef?: React.RefObject<{
		open: () => void;
		close: () => void;
	} | null>;
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

// Find pane by ID in the tree
function findPaneById(node: PaneNode, id: string): PaneNode | null {
	if (node.id === id) return node;
	if (node.type === "split") {
		for (const child of node.children) {
			const found = findPaneById(child, id);
			if (found) return found;
		}
	}
	return null;
}

// First terminal (leaf) pane id under a node, in depth-first order.
function firstLeafId(node: PaneNode): string | null {
	if (node.type === "terminal") return node.id;
	if (node.type === "split") {
		for (const child of node.children) {
			const id = firstLeafId(child);
			if (id) return id;
		}
	}
	return null;
}

// Compute the session's total window size by summing pane sizes from the
// layout tree, following the wire layout's tmux-convention geometry:
// horizontal splits → sum cols + 1-cell borders, vertical → sum rows + borders.
// When useProposed=true, uses proposeDimensions() (what fits the container) instead of
// actual xterm size. This is needed in control mode where xterm size is set by the
// server's layout, not by FitAddon.
function computeTotalSizeFromTree(
	root: PaneNode,
	terminalRefs: React.RefObject<Map<string, TerminalRef | null>>,
	useProposed = false,
): { cols: number; rows: number } | null {
	if (root.type === "terminal") {
		const ref = terminalRefs.current?.get(root.id);
		const size = useProposed
			? (ref?.getProposedSize?.() ?? ref?.getSize?.())
			: ref?.getSize?.();
		return size ?? null;
	}

	if (root.type === "split") {
		const childSizes = root.children.map((c) =>
			computeTotalSizeFromTree(c, terminalRefs, useProposed),
		);
		if (childSizes.some((s) => s === null)) return null;
		const sizes = childSizes as { cols: number; rows: number }[];

		if (root.direction === "horizontal") {
			// Panes side by side: total cols = sum + borders
			return {
				cols: sizes.reduce((sum, s) => sum + s.cols, 0) + (sizes.length - 1),
				rows: Math.max(...sizes.map((s) => s.rows)),
			};
		}
		// Panes stacked: total rows = sum + borders
		return {
			cols: Math.max(...sizes.map((s) => s.cols)),
			rows: sizes.reduce((sum, s) => sum + s.rows, 0) + (sizes.length - 1),
		};
	}

	return null;
}

// Per-pane render sizes to report as per-client demands. Sourced from each
// pane's proposed dimensions (what fits its container) — NOT the layout the
// server sent back — so demands can't lag or feed back into the server's
// sizing. Pass the zoom-aware root (the zoomed subtree when zoomed) so a zoomed
// pane reports its full-container size and hidden panes report nothing.
function collectPaneDemands(
	root: PaneNode,
	terminalRefs: React.RefObject<Map<string, TerminalRef | null>>,
): Record<string, { cols: number; rows: number }> {
	const out: Record<string, { cols: number; rows: number }> = {};
	const walk = (n: PaneNode): void => {
		if (n.type === "terminal") {
			const ref = terminalRefs.current?.get(n.id);
			const size = ref?.getProposedSize?.() ?? ref?.getSize?.();
			if (size && size.cols > 0 && size.rows > 0) {
				out[n.id] = { cols: size.cols, rows: size.rows };
			}
			return;
		}
		if (n.type === "split") n.children.forEach(walk);
	};
	walk(root);
	return out;
}

// Get all pane IDs in order (leaf nodes only)
function getAllPaneIds(node: PaneNode): string[] {
	if (node.type === "split") {
		return node.children.flatMap(getAllPaneIds);
	}
	// terminal, sessions, dashboard, empty are all leaf nodes
	return [node.id];
}

// Boundary-style divider drag. Moving the divider between children[i] and
// children[i+1] of `splitId` must move ONLY that boundary on screen: the two
// panes touching it absorb the delta, every other pane keeps its absolute
// size. Inside each adjacent child, same-direction splits
// along the touching edge renormalize their ratios to hold the interior
// boundaries still; cross-direction splits pass the change through to all
// children (each of their rows/columns touches the dragged boundary).
// Returns the original root unchanged when any resulting ratio would leave
// [10, 90] — the drag hard-stops at the limit instead of crushing a pane.
function applyBoundaryDrag(
	root: PaneNode,
	splitId: string,
	newRatio: number[],
	dividerIndex: number,
): PaneNode {
	let valid = true;

	// `node`'s extent along `dir` changes oldExtent→newExtent (any consistent
	// unit); only the pane touching the dragged boundary — via `edge` — absorbs
	// the difference.
	const renormalize = (
		node: PaneNode,
		dir: "horizontal" | "vertical",
		edge: "start" | "end",
		oldExtent: number,
		newExtent: number,
	): PaneNode => {
		if (node.type !== "split" || oldExtent <= 0 || newExtent <= 0) return node;
		if (node.direction !== dir) {
			return {
				...node,
				children: node.children.map((c) =>
					renormalize(c, dir, edge, oldExtent, newExtent),
				),
			};
		}
		const abs = node.ratio.map((r) => (r / 100) * oldExtent);
		const idx = edge === "end" ? abs.length - 1 : 0;
		const absorbedOld = abs[idx] ?? 0;
		const absorbedNew = absorbedOld + (newExtent - oldExtent);
		abs[idx] = absorbedNew;
		const ratio = abs.map((w) => (w / newExtent) * 100);
		for (const r of ratio) {
			if (r < 10 || r > 90) valid = false;
		}
		return {
			...node,
			ratio,
			children: node.children.map((c, i) =>
				i === idx ? renormalize(c, dir, edge, absorbedOld, absorbedNew) : c,
			),
		};
	};

	const walk = (node: PaneNode): PaneNode => {
		if (node.type !== "split") return node;
		if (node.id !== splitId) {
			return { ...node, children: node.children.map(walk) };
		}
		const i = dividerIndex;
		const oldA = node.ratio[i];
		const oldB = node.ratio[i + 1];
		const newA = newRatio[i];
		const newB = newRatio[i + 1];
		if (
			oldA === undefined ||
			oldB === undefined ||
			newA === undefined ||
			newB === undefined
		) {
			return node;
		}
		const children = node.children.map((c, ci) => {
			if (ci === i) return renormalize(c, node.direction, "end", oldA, newA);
			if (ci === i + 1)
				return renormalize(c, node.direction, "start", oldB, newB);
			return c;
		});
		return { ...node, ratio: newRatio, children };
	};

	const next = walk(root);
	return valid ? next : root;
}

// Update one pane's session key in the tree
function updateSessionKey(
	root: PaneNode,
	paneId: string,
	sessionKey: string,
): PaneNode {
	if (root.id === paneId && root.type === "terminal") {
		return { ...root, sessionKey };
	}
	if (root.type === "split") {
		return {
			...root,
			children: root.children.map((c) => updateSessionKey(c, paneId, sessionKey)),
		};
	}
	return root;
}

// Update ALL terminal panes' session key (used for control mode session switching)
function updateAllSessionKeys(root: PaneNode, sessionKey: string): PaneNode {
	if (root.type === "terminal") {
		return { ...root, sessionKey };
	}
	if (root.type === "split") {
		return {
			...root,
			children: root.children.map((c) => updateAllSessionKeys(c, sessionKey)),
		};
	}
	return root;
}

// Convert TmuxLayoutNode to PaneNode with session IDs.
// Split ids derive from the node's PATH in the tree, not its x/y position:
// a nested split starting at the same corner as its parent (e.g. the left
// column of a 2x2, or the inner-left split of 4 columns) would collide under
// position-based ids, and ratio updates addressed by id would then hit the
// ancestor instead of the dragged split.
function tmuxLayoutToPaneNode(
	node: TmuxLayoutNode,
	sessionKey: string,
	path = "r",
): PaneNode {
	if (node.type === "leaf") {
		return {
			type: "terminal",
			sessionKey,
			id: `%${node.paneId ?? 0}`,
		};
	}

	const children = (node.children || []).map((c, i) =>
		tmuxLayoutToPaneNode(c, sessionKey, `${path}.${i}`),
	);
	const isHorizontal = node.type === "horizontal";
	const totalSize = (node.children || []).reduce(
		(sum, c) => sum + (isHorizontal ? c.width : c.height),
		0,
	);
	const ratio = (node.children || []).map((c) => {
		const size = isHorizontal ? c.width : c.height;
		return totalSize > 0
			? (size / totalSize) * 100
			: 100 / (node.children || []).length;
	});

	return {
		type: "split",
		direction: isHorizontal ? "horizontal" : "vertical",
		children,
		ratio,
		id: `split-${path}`,
	};
}

// Extract per-pane {cols, rows} from a TmuxLayoutNode tree.
// TmuxLayoutNode width/height = pane cols/rows.
function extractPaneSizes(
	node: TmuxLayoutNode,
): Map<string, { cols: number; rows: number }> {
	const sizes = new Map<string, { cols: number; rows: number }>();
	function walk(n: TmuxLayoutNode) {
		if (n.type === "leaf" && n.paneId !== undefined) {
			sizes.set(`%${n.paneId}`, { cols: n.width, rows: n.height });
		}
		if (n.children) {
			n.children.forEach(walk);
		}
	}
	walk(node);
	return sizes;
}

const KEYBOARD_VISIBLE_KEY = storageKey("floating-keyboard-visible");

export function DesktopLayout({
	sessions: propSessions,
	activeSessionKey,
	sessionSwitchRequest,
	onSessionStateChange,
	isTablet = false,
	keyboardControlRef,
}: DesktopLayoutProps) {
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

	// Remote-control mode (PC only): stop the live terminal render so the local
	// herdr client keeps ownership of the panes. Tablet keeps normal terminals.
	const { remoteControl: remoteControlFlag, toggleRemoteControl } =
		useRemoteControlMode();
	const remoteControl = !isTablet && remoteControlFlag;
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
	const [detectedUrls, setDetectedUrls] = useState<string[]>([]);
	const [showUrlMenu, setShowUrlMenu] = useState(false);
	const [urlPage, setUrlPage] = useState(0);
	const URL_PAGE_SIZE = 5;

	// Keyboard elevation for onboarding (raises z-index above overlay)
	const [keyboardElevated, setKeyboardElevated] = useState(false);

	// Register keyboard control for onboarding
	useEffect(() => {
		if (keyboardControlRef && isTablet) {
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
		}
		return () => {
			if (keyboardControlRef) {
				keyboardControlRef.current = null;
			}
		};
	}, [keyboardControlRef, isTablet]);

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

	// Load/save desktop state. Persisted trees from before #487 store bare
	// session ids — migrate them to composite keys once, using the legacy
	// session-peer intent to keep a restored remote session on its peer.
	const [desktopState, setDesktopState] = useState<DesktopState>(() => {
		try {
			const saved = localStorage.getItem(DESKTOP_STATE_KEY);
			if (saved) {
				const parsed = JSON.parse(saved) as DesktopState;
				if (parsed.root && parsed.activePane) {
					const root = migrateStoredPaneNode(
						parsed.root as unknown as StoredPaneNode,
						readLegacySessionPeerIntent(),
					) as unknown as PaneNode;
					localStorage.removeItem(LEGACY_SESSION_PEER_KEY);
					return { root, activePane: parsed.activePane };
				}
			}
		} catch {
			// Ignore
		}
		return createInitialState(activeSessionKey);
	});

	// Save state on change
	useEffect(() => {
		localStorage.setItem(DESKTOP_STATE_KEY, JSON.stringify(desktopState));
	}, [desktopState]);

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
	// out of the key — no intent / merged-list resolution (#487).
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
	// server is the single source of truth (#479). zoomPane sends intent only;
	// the state flips when the server's layout push confirms it, so a zoom made
	// on another client (or restored on reconnect) renders here too.
	const [zoomedPaneId, setZoomedPaneId] = useState<string | null>(null);
	const zoomedPaneIdRef = useRef<string | null>(null);
	zoomedPaneIdRef.current = zoomedPaneId;

	// Per-pane viewport callbacks (paneId -> Set<callbacks>). Second arg
	// `isPseudo`: true when frame is a client-stitched preview while the real
	// server reply is in flight.
	const paneCallbacksRef = useRef<
		Map<string, Set<(viewport: PaneViewport, isPseudo?: boolean) => void>>
	>(new Map());

	// Last viewport per pane. Replayed when a Terminal mounts after the
	// viewport has already arrived (race during session switch / late mount).
	const lastViewportRef = useRef<Map<string, PaneViewport>>(new Map());

	// Current scroll offset per pane (0 = live edge, N = N rows scrolled up
	// into history). Updated by Terminal.scrollBy and by viewport responses.
	const paneOffsetRef = useRef<Map<string, number>>(new Map());

	// Per-pane viewport cache keyed by offset.
	const paneViewportCacheRef = useRef<
		Map<string, Map<number, { viewport: PaneViewport; historySize: number }>>
	>(new Map());
	const VIEWPORT_CACHE_LIMIT = 20;

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
		onPaneViewport: (paneId, viewport) => {
			lastViewportRef.current.set(paneId, viewport);
			let perPane = paneViewportCacheRef.current.get(paneId);
			if (!perPane) {
				perPane = new Map();
				paneViewportCacheRef.current.set(paneId, perPane);
			}
			perPane.delete(viewport.offset);
			perPane.set(viewport.offset, {
				viewport,
				historySize: viewport.historySize,
			});
			if (perPane.size > VIEWPORT_CACHE_LIMIT) {
				const oldest = perPane.keys().next().value;
				if (oldest !== undefined) perPane.delete(oldest);
			}
			// Drop stale responses (out-of-order viewport reply after the user has
			// scrolled past it). Cache it but don't repaint unless it matches the
			// current expected offset.
			const expected = paneOffsetRef.current.get(paneId);
			if (expected !== undefined && expected !== viewport.offset) return;
			// Server clamps the requested offset to historySize; reflect that
			// back so subsequent scrollBy / getScrollState see the canonical value.
			paneOffsetRef.current.set(paneId, viewport.offset);
			const callbacks = paneCallbacksRef.current.get(paneId);
			if (!callbacks || callbacks.size === 0) {
				// Viewport will be replayed when the Terminal mounts (see registerOnViewport).
				return;
			}
			for (const cb of callbacks) {
				cb(viewport, false);
			}
		},
		onLayoutChange: (layout, serverZoomedPaneId) => {
			setControlLayout(layout);
			setZoomedPaneId(serverZoomedPaneId);
			// Pane sizes may have changed; drop the viewport cache (line widths
			// in cached frames no longer match).
			paneViewportCacheRef.current.clear();
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
			// Mobile does the same from TerminalPage.
			controlTerminal.sendClientInfo(isTablet ? "tablet" : "desktop");
			// Send resize with retries for terminal refresh on session switch.
			// The first resize triggers the backend to emit initial state snapshots.
			const delays = [100, 300, 600, 1000];
			for (const delay of delays) {
				setTimeout(() => sendControlResize(), delay);
			}
			// Fallback: explicitly request a viewport per pane in case resize was
			// skipped (layoutPending, dedup). Viewport fetches are idempotent.
			const requestAllViewports = (attempt = 0) => {
				const paneIds = [...paneCallbacksRef.current.keys()];
				if (paneIds.length === 0 && attempt < 5) {
					setTimeout(() => requestAllViewports(attempt + 1), 300);
					return;
				}
				for (const paneId of paneIds) {
					const offset = paneOffsetRef.current.get(paneId) ?? 0;
					controlTerminalRef.current.requestViewport(paneId, offset);
				}
			};
			setTimeout(() => requestAllViewports(), 500);
		},
		onHookEvent: (event, cwd, sessionId, data, message, deliveredToGlasses) => {
			// The glasses already showed it; a second alert on the desk is noise.
			// The indicator update below still runs — it is state, not an alert.
			if (!deliveredToGlasses) {
				fireHookNotification(
					event,
					cwd,
					sessionId,
					data,
					message,
					peerConn.peerId,
				);
			}
			// Update indicatorState on every useWorkspaces instance immediately
			updateCachedSessionsByHookEvent(event, sessionId);
		},
		onDisconnect: () => {},
		onSessionExit: () => {
			setControlLayout(null);
			setZoomedPaneId(null);
			lastViewportRef.current.clear();
			paneOffsetRef.current.clear();
			paneViewportCacheRef.current.clear();
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
		lastViewportRef.current.clear();
		paneOffsetRef.current.clear();
		// paneCallbacksRef is deliberately NOT cleared: registrations are
		// owned by each Terminal's effect (cleanup on unmount). A Terminal
		// that survives the session switch (same pane id, e.g. %1 → %1)
		// never re-registers — wiping here would leave the new session's
		// viewports with no consumer, rendering a blank terminal until a
		// full page reload. #history-resume-blank
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
		// as zoomedPaneId and displayRoot applies it at render time (#479).
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
					const offset = paneOffsetRef.current.get(pid) ?? 0;
					controlTerminalRef.current.requestViewport(pid, offset);
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
				registerOnViewport: (callback: (viewport: PaneViewport) => void) => {
					let set = paneCallbacksRef.current.get(paneId);
					if (!set) {
						set = new Set();
						paneCallbacksRef.current.set(paneId, set);
					}
					set.add(callback);

					// Replay the last viewport if one already arrived (race during
					// session switch / late mount).
					const last = lastViewportRef.current.get(paneId);
					if (last) callback(last);

					// Always request a fresh viewport when a Terminal mounts, in case
					// it joined after the initial viewport was sent.
					if (controlTerminalRef.current.isConnected) {
						const offset = paneOffsetRef.current.get(paneId) ?? 0;
						controlTerminalRef.current.requestViewport(paneId, offset);
					}

					return () => {
						paneCallbacksRef.current.get(paneId)?.delete(callback);
					};
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
					// Same sign convention as `term.scrollLines`: positive lines =
					// scroll DOWN toward the live edge (decrease offset), negative
					// lines = scroll UP into history (increase offset).
					if (!controlTerminalRef.current.isConnected) return;
					const cur = paneOffsetRef.current.get(paneId) ?? 0;
					const last = lastViewportRef.current.get(paneId);
					const history = last?.historySize ?? 0;
					const next = Math.max(0, Math.min(history, cur - lines));
					if (next === cur) return;
					paneOffsetRef.current.set(paneId, next);
					const cbs = paneCallbacksRef.current.get(paneId);
					const cached = paneViewportCacheRef.current.get(paneId)?.get(next);
					if (cached && cached.historySize === history) {
						if (cbs) for (const cb of cbs) cb(cached.viewport, false);
					} else if (last && cbs) {
						const pseudo = makePseudoViewport(last, next - last.offset);
						for (const cb of cbs) cb(pseudo, true);
					}
					controlTerminalRef.current.requestViewport(paneId, next);
				},
				scrollToLive: () => {
					if (!controlTerminalRef.current.isConnected) return;
					const cur = paneOffsetRef.current.get(paneId) ?? 0;
					if (cur === 0) return;
					paneOffsetRef.current.set(paneId, 0);
					const last = lastViewportRef.current.get(paneId);
					const history = last?.historySize ?? 0;
					const cbs = paneCallbacksRef.current.get(paneId);
					const cached = paneViewportCacheRef.current.get(paneId)?.get(0);
					if (cached && cached.historySize === history) {
						if (cbs) for (const cb of cbs) cb(cached.viewport, false);
					} else if (last && cbs) {
						const pseudo = makePseudoViewport(last, 0 - last.offset);
						for (const cb of cbs) cb(pseudo, true);
					}
					controlTerminalRef.current.requestViewport(paneId, 0);
				},
				refreshViewport: () => {
					if (!controlTerminalRef.current.isConnected) return;
					const offset = paneOffsetRef.current.get(paneId) ?? 0;
					controlTerminalRef.current.requestViewport(paneId, offset);
				},
				getScrollState: () => ({
					offset: paneOffsetRef.current.get(paneId) ?? 0,
					historySize: lastViewportRef.current.get(paneId)?.historySize ?? 0,
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
					// layout push confirms it (#479), so all clients stay in sync.
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
			} else {
				navigator.clipboard.writeText(text).catch(() => {});
			}
		},
		onShowSessions: () => setShowSessionModal(true),
		onOpenFileViewer: openFileViewer,
		remoteControl,
		// Chat composer fallback: the mux WS rejects input for unsubscribed
		// sessions, so remote-control mode sends over REST (peer-aware).
		sendInputRest: remoteControl
			? (paneId: string, data: string) =>
					sendTerminalInputRest(
						peerConn.apiBase,
						peerConn.token,
						controlSessionIdRef.current ?? "",
						paneId,
						data,
					)
			: undefined,
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
						ref?.sendInput(result.path);
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

	// Keyboard shortcuts
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Accept both Ctrl and Cmd (Meta) for all shortcuts.
			// This supports Mac keyboards on Linux and vice versa.
			const modifier = e.ctrlKey || e.metaKey;

			if (!modifier) return;

			// Ctrl/Cmd + D: Vertical split (right)
			if (!e.shiftKey && e.key.toLowerCase() === "d") {
				e.preventDefault();
				handleSplit("horizontal");
				return;
			}

			// Ctrl/Cmd + Shift + D: Horizontal split (bottom)
			if (e.shiftKey && e.key.toLowerCase() === "d") {
				e.preventDefault();
				handleSplit("vertical");
				return;
			}

			// Ctrl/Cmd + W: Close pane
			if (!e.shiftKey && e.key.toLowerCase() === "w") {
				e.preventDefault();
				handleClosePane();
				return;
			}

			// Ctrl/Cmd + C: Copy the terminal selection
			if (!e.shiftKey && e.key.toLowerCase() === "c") {
				const ref = terminalRefs.current?.get(activePaneRef.current);
				const selection = ref?.getSelection();

				if (selection) {
					e.preventDefault();
					navigator.clipboard.writeText(selection).catch((err) => {
						console.error("Clipboard write failed:", err);
					});
					return;
				}

				// No selection: suppress the browser's own copy and leave the key to
				// xterm, which sends it on to the pane as SIGINT.
				e.preventDefault();
				return;
			}

			// Ctrl/Cmd + V: Paste to terminal (text or image)
			if (!e.shiftKey && e.key.toLowerCase() === "v") {
				e.preventDefault();
				handlePaste();
				return;
			}

			// Ctrl/Cmd + = or +: Zoom in (increase font size)
			if (!e.shiftKey && (e.key === "=" || e.key === "+")) {
				e.preventDefault();
				const ref = terminalRefs.current?.get(activePaneRef.current);
				ref?.changeFontSize(2);
				return;
			}

			// Ctrl/Cmd + -: Zoom out (decrease font size)
			if (!e.shiftKey && e.key === "-") {
				e.preventDefault();
				const ref = terminalRefs.current?.get(activePaneRef.current);
				ref?.changeFontSize(-2);
				return;
			}

			// Ctrl/Cmd + 0: Reset font size to default
			if (!e.shiftKey && e.key === "0") {
				e.preventDefault();
				const ref = terminalRefs.current?.get(activePaneRef.current);
				if (ref) {
					const current = ref.getFontSize();
					ref.changeFontSize(14 - current);
				}
				return;
			}

			// Ctrl/Cmd + B: Toggle session modal
			if (!e.shiftKey && e.key.toLowerCase() === "b") {
				e.preventDefault();
				setShowSessionModal((prev) => !prev);
				return;
			}

			// Ctrl/Cmd + Shift + B: Toggle dashboard panel
			if (e.shiftKey && e.key.toLowerCase() === "b") {
				e.preventDefault();
				setShowDashboard((prev) => !prev);
				return;
			}

			// Ctrl/Cmd + Shift + Arrow: Resize active pane
			// (no-op in remote-control mode — pane sizes are owned by the local
			// herdr client and the WS path would reject the unsubscribed session)
			if (
				e.shiftKey &&
				!e.altKey &&
				(e.key === "ArrowLeft" ||
					e.key === "ArrowRight" ||
					e.key === "ArrowUp" ||
					e.key === "ArrowDown")
			) {
				e.preventDefault();
				if (remoteControlRef.current) return;
				const paneId = activePaneRef.current;
				const dirMap: Record<string, "L" | "R" | "U" | "D"> = {
					ArrowLeft: "L",
					ArrowRight: "R",
					ArrowUp: "U",
					ArrowDown: "D",
				};
				const amount = e.key === "ArrowLeft" || e.key === "ArrowRight" ? 5 : 3;
				controlTerminalRef.current.adjustPane(paneId, dirMap[e.key], amount);
				return;
			}

			// Ctrl/Cmd + Shift + =: Equalize pane sizes
			if (e.shiftKey && !e.altKey && (e.key === "+" || e.key === "=")) {
				e.preventDefault();
				if (remoteControlRef.current) return;
				const root = desktopStateRef.current.root;
				const dir =
					root.type === "split"
						? root.direction === "horizontal"
							? "horizontal"
							: "vertical"
						: "horizontal";
				controlTerminalRef.current.equalizePanes(dir);
				return;
			}

			// Ctrl/Cmd + Shift + F5: Cache clear & reload
			if (e.shiftKey && e.key === "F5") {
				e.preventDefault();
				void nukeClientCache();
				return;
			}

			// Ctrl/Cmd + Arrow: Focus navigation (without Shift)
			if (
				!e.shiftKey &&
				(e.key === "ArrowLeft" ||
					e.key === "ArrowRight" ||
					e.key === "ArrowUp" ||
					e.key === "ArrowDown")
			) {
				e.preventDefault();
				handleFocusNavigation(e.key);
				return;
			}

			// Ctrl/Cmd + 1-9: Session switch
			const num = parseInt(e.key, 10);
			if (!e.shiftKey && num >= 1 && num <= 9) {
				e.preventDefault();
				const session = sessions[num - 1];
				if (session) {
					setDesktopState((prev) => ({
						...prev,
						root: updateSessionKey(
							prev.root,
							prev.activePane,
							makeSessionKey(session.id, session.peerId),
						),
					}));
				}
				return;
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
					ref?.sendInput(result.path);
				} else {
					console.error("Upload failed:", result.error);
				}
			} finally {
				setIsUploading(false);
			}
		},
		[getActivePeerId],
	);

	const handleUrlExtract = useCallback(() => {
		if (showUrlMenu) {
			setShowUrlMenu(false);
			return;
		}
		const ref = terminalRefs.current?.get(activePaneRef.current);
		const urls = ref?.extractUrls() || [];
		setDetectedUrls(urls);
		setUrlPage(0);
		setShowUrlMenu(true);
	}, [showUrlMenu]);

	const handleCopyUrl = useCallback((url: string) => {
		navigator.clipboard
			.writeText(url)
			.then(() => {
				setShowUrlMenu(false);
			})
			.catch(console.error);
	}, []);

	const handleOpenUrl = useCallback((url: string) => {
		window.open(url, "_blank");
		setShowUrlMenu(false);
	}, []);

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
			// Clear viewport cache from old session
			lastViewportRef.current.clear();
			paneOffsetRef.current.clear();
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

	// Compute the display root: when zoomed, show only the zoomed pane full-screen.
	// The server keeps sending the full tree while zoomed; zoomedPaneId mirrors
	// the server's zoom (#479) and overrides the rendered tree here.
	const displayRoot = useMemo(() => {
		if (zoomedPaneId) {
			const zoomedPane = findPaneById(desktopState.root, zoomedPaneId);
			if (zoomedPane) {
				return zoomedPane;
			}
			// Zoomed pane no longer exists (was closed) - fall back to full tree
		}
		return desktopState.root;
	}, [desktopState.root, zoomedPaneId]);

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

	// Handle session selection from modal
	const handleModalSelectSession = useCallback(
		(session: { id: string; peerId?: string; currentPath?: string }) => {
			const paneId = activePaneRef.current;
			handleSelectSessionForPane(
				paneId,
				makeSessionKey(session.id, session.peerId),
			);
			// Update FileViewer active dir to follow session
			if (session.currentPath) {
				setActiveFileViewerDir(session.currentPath);
			}
		},
		[handleSelectSessionForPane],
	);

	// data-layout pins which of the three layout trees rendered; the responsive
	// e2e matrix asserts on it so a viewport can't silently fall through to the
	// wrong one.
	return (
		<div
			className="h-screen flex bg-th-bg"
			data-layout={isTablet ? "tablet" : "desktop"}
		>
			{/* Main content */}
			<div className="flex-1 flex flex-col min-w-0">
				{/* Header - desktop: minimal icons, tablet: full toolbar */}
				{!isTablet && (
					<div className="flex items-center justify-end px-2 py-0.5 bg-[#0a0a0a] border-b border-white/[0.06] shrink-0 select-none">
						<div className="flex items-center gap-0.5">
							<button
								type="button"
								onClick={() => setShowSessionModal((prev) => !prev)}
								className={`p-1.5 rounded-md transition-colors ${
									showSessionModal
										? "text-blue-400 bg-blue-500/20"
										: "text-zinc-600 hover:text-zinc-400"
								}`}
								title="Sessions (Ctrl+B)"
							>
								<List className="w-[18px] h-[18px]" />
							</button>
							<button
								type="button"
								onClick={() => setShowDashboard((prev) => !prev)}
								className={`p-1.5 rounded-md transition-colors ${
									showDashboard
										? "text-blue-400 bg-blue-500/20"
										: "text-zinc-600 hover:text-zinc-400"
								}`}
								title="Dashboard (Ctrl+Shift+B)"
							>
								<BarChart3 className="w-[18px] h-[18px]" />
							</button>
							<button
								type="button"
								onClick={toggleRemoteControl}
								className={`p-1.5 rounded-md transition-colors ${
									remoteControl
										? "text-amber-400 bg-amber-500/20"
										: "text-zinc-600 hover:text-zinc-400"
								}`}
								title={
									remoteControl
										? "Remote control mode ON — terminal rendered by local herdr"
										: "Remote control mode OFF"
								}
							>
								<Unplug className="w-[18px] h-[18px]" />
							</button>
						</div>
					</div>
				)}
				{isTablet && (
					<div
						className="shrink-0 select-none bg-[#0a0a0a] border-b border-white/[0.06]"
						style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
					>
						{/* Top bar: session selector + core actions */}
						<div className="flex items-center gap-2 px-3 py-1.5">
							{/* Left: Session selector */}
							<button
								type="button"
								onClick={() => setShowSessionModal((prev) => !prev)}
								className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-white/[0.06] transition-colors"
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
									{activeSession?.name || "CC Hub"}
								</span>
								<ChevronDown className="w-3 h-3 text-zinc-500" />
							</button>

							<div className="flex-1" />

							{/* Right: Action icons */}
							<div className="flex items-center gap-0.5">
								<button
									type="button"
									onClick={() => {
										const dir = activeSession?.currentPath;
										if (dir) openFileViewer(dir, activeSession?.peerId);
									}}
									className="p-2 text-zinc-500 hover:text-zinc-300 active:text-zinc-200 transition-colors"
									title="Files"
								>
									<FileText className="w-[18px] h-[18px]" />
								</button>
								<button
									type="button"
									onClick={() => setShowDashboard((prev) => !prev)}
									className={`p-2 transition-colors ${
										showDashboard
											? "text-blue-400"
											: "text-zinc-500 hover:text-zinc-300 active:text-zinc-200"
									}`}
									title="Dashboard"
								>
									<BarChart3 className="w-[18px] h-[18px]" />
								</button>

								{/* Divider */}
								<div className="w-px h-4 bg-white/[0.06] mx-0.5" />

								{/* Pane operations */}
								<div className="flex items-center" data-onboarding="split-pane">
									<button
										type="button"
										onClick={() => handleSplit("horizontal")}
										className="p-2 text-zinc-500 hover:text-zinc-300 active:text-zinc-200 transition-colors"
										title="Split vertically"
									>
										<SplitSquareHorizontal className="w-[18px] h-[18px]" />
									</button>
									<button
										type="button"
										onClick={() => handleSplit("vertical")}
										className="p-2 text-zinc-500 hover:text-zinc-300 active:text-zinc-200 transition-colors"
										title="Split horizontally"
									>
										<SplitSquareVertical className="w-[18px] h-[18px]" />
									</button>
								</div>

								<button
									type="button"
									onClick={handleGlobalReload}
									className="p-2 text-zinc-500 hover:text-zinc-300 active:text-zinc-200 transition-colors"
									title="Reload"
									data-onboarding="reload"
								>
									<RefreshCw className="w-[18px] h-[18px]" />
								</button>
								<button
									type="button"
									onClick={() => setShowKeyboard((prev) => !prev)}
									className={`p-2 transition-colors ${
										showKeyboard
											? "text-blue-400"
											: "text-zinc-500 hover:text-zinc-300 active:text-zinc-200"
									}`}
									title={showKeyboard ? "Hide keyboard" : "Show keyboard"}
									data-onboarding="keyboard"
								>
									<Keyboard className="w-[18px] h-[18px]" />
								</button>
							</div>
						</div>
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
						isTablet={isTablet}
						controlModeContext={controlModeContext}
					/>
				</div>
			</div>

			{/* Dashboard side panel */}
			<DashboardPanel
				isOpen={showDashboard}
				onClose={() => setShowDashboard(false)}
				isTablet={isTablet}
			/>

			{/* Session modal */}
			<SessionModal
				isOpen={showSessionModal}
				onClose={() => setShowSessionModal(false)}
				onSelectSession={handleModalSelectSession}
				isTablet={isTablet}
			/>

			{/* File Viewer Modal - per-session instances kept mounted */}
			{fileViewerDirs.map(({ dir, peerId }) => (
				<FileViewer
					key={dir}
					sessionWorkingDir={dir}
					peerId={peerId}
					onClose={() => closeFileViewer(dir)}
					hidden={
						!fileViewerOpenDirs.has(dir) ||
						dir !== activeFileViewerDir ||
						showSessionModal
					}
					onCopyPrompt={(text) => {
						if (isTablet) {
							setShowKeyboard(true);
							setTimeout(
								() => floatingKeyboardRef.current?.setInputText(text),
								200,
							);
						} else {
							navigator.clipboard.writeText(text).catch(() => {});
						}
						closeFileViewer(dir);
					}}
					onShowSessions={() => {
						setShowSessionModal(true);
					}}
					sessionName={activeSession?.name}
					sessionStatus={activeSession?.state}
					onShowDashboard={() => setShowDashboard((prev) => !prev)}
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
						visible={showKeyboard}
						onClose={() => setShowKeyboard(false)}
						onSend={handleKeyboardSend}
						onFilePicker={handleFilePicker}
						onUrlExtract={handleUrlExtract}
						isUploading={isUploading}
						elevated={keyboardElevated}
					/>
				</>
			)}

			{/* URL menu (tablet only) */}
			{isTablet &&
				showUrlMenu &&
				(() => {
					const totalPages = Math.ceil(detectedUrls.length / URL_PAGE_SIZE);
					const startIdx = urlPage * URL_PAGE_SIZE;
					const pageUrls = detectedUrls.slice(
						startIdx,
						startIdx + URL_PAGE_SIZE,
					);

					return (
						<div className="fixed inset-0 z-50 bg-[var(--color-overlay)] flex items-center justify-center p-4">
							<div className="bg-th-surface rounded-md w-full max-w-md max-h-[80vh] flex flex-col">
								<div className="flex items-center justify-between px-4 py-3 border-b border-th-border">
									<span className="text-th-text font-medium">
										URLs{" "}
										{detectedUrls.length > 0 &&
											`(${startIdx + 1}-${Math.min(startIdx + URL_PAGE_SIZE, detectedUrls.length)}/${detectedUrls.length})`}
									</span>
									<button
										type="button"
										onClick={() => setShowUrlMenu(false)}
										className="p-1 text-th-text-secondary hover:text-th-text"
									>
										✕
									</button>
								</div>
								<div className="flex-1 overflow-y-auto p-2">
									{detectedUrls.length === 0 ? (
										<p className="text-th-text-muted text-center py-4">
											No URLs found
										</p>
									) : (
										pageUrls.map((url, index) => (
											<div
												// biome-ignore lint/suspicious/noArrayIndexKey: URLs may repeat across pagination; composite key keeps uniqueness
												key={`${url}-${startIdx + index}`}
												className="flex items-center gap-2 p-2 hover:bg-th-surface-hover rounded"
											>
												<span className="flex-1 text-th-text text-sm truncate">
													{url}
												</span>
												<button
													type="button"
													onClick={() => handleCopyUrl(url)}
													className="px-2 py-1 text-xs bg-th-surface-active hover:bg-th-surface-hover text-th-text rounded"
												>
													Copy
												</button>
												<button
													type="button"
													onClick={() => handleOpenUrl(url)}
													className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-th-text rounded-md"
												>
													Open
												</button>
											</div>
										))
									)}
								</div>
								{totalPages > 1 && (
									<div className="flex items-center justify-center gap-4 px-4 py-3 border-t border-th-border">
										<button
											type="button"
											onClick={() => setUrlPage((p) => Math.max(0, p - 1))}
											disabled={urlPage === 0}
											className={`px-3 py-1 rounded ${urlPage === 0 ? "bg-th-surface-hover text-th-text-muted" : "bg-th-surface-active text-th-text hover:bg-th-surface-hover"}`}
										>
											Previous
										</button>
										<span className="text-th-text-secondary text-sm">
											{urlPage + 1} / {totalPages}
										</span>
										<button
											type="button"
											onClick={() =>
												setUrlPage((p) => Math.min(totalPages - 1, p + 1))
											}
											disabled={urlPage >= totalPages - 1}
											className={`px-3 py-1 rounded ${urlPage >= totalPages - 1 ? "bg-th-surface-hover text-th-text-muted" : "bg-th-surface-active text-th-text hover:bg-th-surface-hover"}`}
										>
											Next
										</button>
									</div>
								)}
							</div>
						</div>
					);
				})()}
		</div>
	);
}
