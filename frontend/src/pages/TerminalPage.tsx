/** biome-ignore-all lint/correctness/useExhaustiveDependencies: depends on refs and setters that React guarantees stable; adding them would cause unintended re-runs */
import {
	forwardRef,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type {
	PaneViewport,
	SessionState,
	SessionTheme,
	TmuxLayoutNode,
} from "../../../shared/types";
import {
	type ControlModeConfig,
	TerminalComponent,
	type TerminalRef,
} from "../components/Terminal";
import { useMultiplexedTerminal } from "../hooks/useMultiplexedTerminal";
import { usePeerConnection } from "../hooks/usePeerConnection";
import { usePeers } from "../hooks/usePeers";
import { useWorkspaces } from "../hooks/useWorkspaces";
import { fireHookNotification } from "../utils/hookNotification";
import { makePseudoViewport } from "../utils/viewport-pseudo";

interface PaneLeafInfo {
	paneId: string;
	width: number;
	height: number;
}

interface TerminalPageProps {
	sessionId: string;
	sessionInstanceId?: string;
	/** Peer that owns this session. Session ids (workspace labels) can collide
	 *  across peers, so the caller's intent must be passed instead of being
	 *  re-derived from an id lookup (which resolves to the local session). */
	peerId?: string;
	token?: string | null;
	onStateChange?: (state: SessionState) => void;
	overlayContent?: ReactNode;
	onOverlayTap?: () => void;
	showOverlay?: boolean;
	theme?: SessionTheme;
	onPanesChange?: (panes: PaneLeafInfo[]) => void;
	/** Fires when the pane actually shown full-screen changes, so the parent can
	 *  keep its tab-bar selection in sync with server truth (e.g. after a reload
	 *  where the server restores a zoom on a non-first pane). */
	onActivePaneChange?: (paneId: string | null) => void;
	externalActivePaneId?: string | null;
	/** When set, replaces the xterm area while keeping the InputBar visible below.
	 *  Always rendered (when truthy) so React state/subscriptions persist; visibility
	 *  is toggled via `mainOverlayVisible`. */
	mainOverlay?: ReactNode;
	/** Whether the mainOverlay is currently shown. Defaults to `!!mainOverlay`. */
	mainOverlayVisible?: boolean;
}

export const TerminalPage = forwardRef<TerminalRef, TerminalPageProps>(
	function TerminalPage(
		{
			sessionId,
			sessionInstanceId,
			peerId,
			token,
			onStateChange,
			overlayContent,
			onOverlayTap,
			showOverlay,
			theme,
			onPanesChange,
			onActivePaneChange,
			externalActivePaneId,
			mainOverlay,
			mainOverlayVisible,
		},
		ref,
	) {
		const [error, setError] = useState<string | null>(null);
		const [sessionExited, setSessionExited] = useState(false);
		const [activePaneId, setActivePaneId] = useState<string | null>(null);
		const [allPanes, setAllPanes] = useState<PaneLeafInfo[]>([]);

		// Derive effective active pane: external takes priority
		const effectiveActivePaneId = externalActivePaneId ?? activePaneId;

		// Per-pane viewport callbacks. Second arg `isPseudo`: true when the frame
		// is a client-stitched preview while the real server reply is in flight.
		const paneCallbacksRef = useRef<
			Map<string, Set<(viewport: PaneViewport, isPseudo?: boolean) => void>>
		>(new Map());
		// Last viewport per pane, replayed when a Terminal mounts late.
		const lastViewportRef = useRef<Map<string, PaneViewport>>(new Map());
		// Current scroll offset per pane (0 = live edge).
		const paneOffsetRef = useRef<Map<string, number>>(new Map());

		// Per-pane viewport cache keyed by offset. Lets a return-trip to a
		// previously-visited offset paint instantly while the real refresh fetches.
		const paneViewportCacheRef = useRef<
			Map<string, Map<number, { viewport: PaneViewport; historySize: number }>>
		>(new Map());
		const VIEWPORT_CACHE_LIMIT = 20;

		const onPanesChangeRef = useRef(onPanesChange);
		onPanesChangeRef.current = onPanesChange;
		const onActivePaneChangeRef = useRef(onActivePaneChange);
		onActivePaneChangeRef.current = onActivePaneChange;

		// Full pane list mirror (used by onConnect to re-request every pane's
		// viewport). Always the complete list — zoom no longer collapses it.
		const cachedPanesRef = useRef<PaneLeafInfo[]>([]);
		// The pane the server currently has zoomed (tmux `%N`), taken from the
		// layout message. Lets us re-assert zoom idempotently on reconnect
		// instead of toggling it back off.
		const serverZoomedPaneIdRef = useRef<string | null>(null);
		// Previous effective active pane — distinguishes a real user switch (drop
		// stale viewport) from the first assignment.
		const prevActivePaneIdRef = useRef<string | null>(null);

		// Multi-server: when the sessionId belongs to a remote peer, connect to that peer's WS
		const { peers } = usePeers();
		const { sessions: apiSessions } = useWorkspaces();
		const peerConn = usePeerConnection(sessionId, apiSessions, peers, peerId);
		// peerId of the session we're rendering; used to route image uploads.
		const sessionPeerId =
			peerId ?? apiSessions.find((s) => s.id === sessionId)?.peerId;

		const controlTerminal = useMultiplexedTerminal({
			sessionId,
			sessionInstanceId,
			token: peerConn.token ?? token,
			peerWsBase: peerConn.wsBase,
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
				// Drop stale responses (rapid wheel scroll fires many requests in
				// flight; an older offset's reply arriving late would snap the
				// screen back). Cache it but don't repaint unless it matches the
				// current expected offset.
				const expected = paneOffsetRef.current.get(paneId);
				if (expected !== undefined && expected !== viewport.offset) return;
				paneOffsetRef.current.set(paneId, viewport.offset);
				const callbacks = paneCallbacksRef.current.get(paneId);
				if (callbacks) {
					for (const cb of callbacks) {
						cb(viewport, false);
					}
				}
			},
			onLayoutChange: (layout: TmuxLayoutNode, zoomedPaneId) => {
				// Pane sizes may have changed; cached viewport `lines` no longer
				// match the new column width, so drop the viewport cache.
				paneViewportCacheRef.current.clear();
				// The layout is always the FULL split tree now (zoom is carried
				// separately as zoomedPaneId), so the leaf list is the real,
				// complete pane list — no client-side preservation needed.
				const leaves = collectLeaves(layout);
				serverZoomedPaneIdRef.current = zoomedPaneId;
				cachedPanesRef.current = leaves;
				setAllPanes(leaves);
				onPanesChangeRef.current?.(leaves);

				// Pick a shown pane when none is valid: prefer the server's zoomed
				// pane (the one that's actually full-size), else the first.
				setActivePaneId((prev) => {
					if (prev && leaves.some((l) => l.paneId === prev)) return prev;
					if (zoomedPaneId && leaves.some((l) => l.paneId === zoomedPaneId)) {
						return zoomedPaneId;
					}
					return leaves[0]?.paneId ?? null;
				});
			},
			onConnect: () => {
				setSessionExited(false);
				setError(null);
				onStateChange?.("idle");
				controlTerminal.sendClientInfo("mobile");
				for (const pane of cachedPanesRef.current) {
					const offset = paneOffsetRef.current.get(pane.paneId) ?? 0;
					controlTerminal.requestViewport(pane.paneId, offset);
				}
			},
			onHookEvent: (
				event,
				cwd,
				agentSessionId,
				data,
				message,
				deliveredToGlasses,
			) => {
				// Already on the G2 screen — the glasses are the notification.
				if (deliveredToGlasses) return;
				fireHookNotification(
					event,
					cwd,
					agentSessionId,
					data,
					message,
					sessionPeerId,
				);
			},
			onDisconnect: () => {
				onStateChange?.("disconnected");
			},
			onSessionExit: () => {
				setSessionExited(true);
				setError(null);
				setActivePaneId(null);
				setAllPanes([]);
				cachedPanesRef.current = [];
				lastViewportRef.current.clear();
				paneOffsetRef.current.clear();
				paneViewportCacheRef.current.clear();
				onPanesChangeRef.current?.([]);
				onActivePaneChangeRef.current?.(null);
				onStateChange?.("disconnected");
			},
			onError: (err) => {
				setError(err);
			},
		});

		// Expose selectPane for external pane switching
		const selectPane = useCallback(
			(paneId: string) => {
				setActivePaneId(paneId);
				controlTerminal.selectPane(paneId);
			},
			[controlTerminal],
		);

		// Keep the shown pane zoomed to fill the mobile screen. Idempotent against
		// the server's zoom state (serverZoomedPaneIdRef), so a reconnect that
		// finds the pane already zoomed re-asserts nothing — no accidental
		// toggle-off, no lost tab bar. On a genuine switch we drop the target
		// pane's stale viewport so it repaints fresh at the live edge.
		useEffect(() => {
			const active = effectiveActivePaneId;
			if (!active || !allPanes.some((p) => p.paneId === active)) {
				prevActivePaneIdRef.current = active ?? null;
				// The layout only carries the tab being rendered, so a pane picked
				// from the workspace list may not be in it yet. Ask for it anyway:
				// the server switches to its tab and the next layout brings it in.
				// A pane that is genuinely gone just leaves this a no-op.
				if (active) controlTerminal.selectPane(active);
				return;
			}
			const isActualSwitch =
				prevActivePaneIdRef.current !== null &&
				prevActivePaneIdRef.current !== active;
			prevActivePaneIdRef.current = active;

			if (allPanes.length > 1) {
				if (serverZoomedPaneIdRef.current !== active) {
					controlTerminal.zoomPane(active, true);
					// Optimistic; the next layout message confirms it.
					serverZoomedPaneIdRef.current = active;
				}
			} else {
				controlTerminal.selectPane(active);
			}

			if (isActualSwitch) {
				lastViewportRef.current.delete(active);
				paneOffsetRef.current.delete(active);
			}
		}, [effectiveActivePaneId, allPanes, controlTerminal]);

		// Report the shown pane up so the parent's tab bar highlights it (matters
		// when the server restored a zoom on a non-first pane after reload).
		useEffect(() => {
			onActivePaneChangeRef.current?.(effectiveActivePaneId);
		}, [effectiveActivePaneId]);

		useEffect(() => {
			prevActivePaneIdRef.current = null;
			serverZoomedPaneIdRef.current = null;
			lastViewportRef.current.clear();
			paneOffsetRef.current.clear();
			cachedPanesRef.current = [];
			controlTerminal.connect();
			return () => {
				controlTerminal.disconnect();
			};
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [sessionId]);

		// Build controlMode config for Terminal - use effectiveActivePaneId
		const currentPaneId = effectiveActivePaneId;
		const controlMode: ControlModeConfig | undefined = currentPaneId
			? {
					paneId: currentPaneId,
					sendInput: (data: string) => {
						controlTerminal.sendInput(currentPaneId, data);
					},
					registerOnViewport: (callback: (viewport: PaneViewport) => void) => {
						let set = paneCallbacksRef.current.get(currentPaneId);
						if (!set) {
							set = new Set();
							paneCallbacksRef.current.set(currentPaneId, set);
						}
						set.add(callback);

						const last = lastViewportRef.current.get(currentPaneId);
						if (last) callback(last);

						if (controlTerminal.isConnected) {
							const offset = paneOffsetRef.current.get(currentPaneId) ?? 0;
							controlTerminal.requestViewport(currentPaneId, offset);
						}

						return () => {
							paneCallbacksRef.current.get(currentPaneId)?.delete(callback);
						};
					},
					isConnected: controlTerminal.isConnected,
					claimActive: () => {
						controlTerminal.claimActiveSize();
					},
					onResize: (cols: number, rows: number) => {
						controlTerminal.resize(cols, rows);
						// Mobile shows exactly one pane at a time, so its per-client
						// demand is that pane at the full-screen size (per-client sizing).
						controlTerminal.sendPaneDemands({ [currentPaneId]: { cols, rows } });
					},
					forceResize: (cols: number, rows: number) => {
						controlTerminal.resize(cols, rows);
						controlTerminal.sendPaneDemands({ [currentPaneId]: { cols, rows } });
					},
					scrollBy: (lines: number) => {
						// Same sign convention as `term.scrollLines`: positive = toward live
						// edge (decrease offset), negative = into history (increase offset).
						if (!controlTerminal.isConnected) return;
						const cur = paneOffsetRef.current.get(currentPaneId) ?? 0;
						const last = lastViewportRef.current.get(currentPaneId);
						const history = last?.historySize ?? 0;
						const next = Math.max(0, Math.min(history, cur - lines));
						if (next === cur) return;
						paneOffsetRef.current.set(currentPaneId, next);
						const cbs = paneCallbacksRef.current.get(currentPaneId);
						const cached = paneViewportCacheRef.current
							.get(currentPaneId)
							?.get(next);
						if (cached && cached.historySize === history) {
							if (cbs) for (const cb of cbs) cb(cached.viewport, false);
						} else if (last && cbs) {
							// Pseudo-scroll: keep the screen moving while the real
							// viewport is fetched. Real reply overwrites this frame.
							const pseudo = makePseudoViewport(last, next - last.offset);
							for (const cb of cbs) cb(pseudo, true);
						}
						controlTerminal.requestViewport(currentPaneId, next);
					},
					scrollToLive: () => {
						if (!controlTerminal.isConnected) return;
						const cur = paneOffsetRef.current.get(currentPaneId) ?? 0;
						if (cur === 0) return;
						paneOffsetRef.current.set(currentPaneId, 0);
						const last = lastViewportRef.current.get(currentPaneId);
						const history = last?.historySize ?? 0;
						const cbs = paneCallbacksRef.current.get(currentPaneId);
						const cached = paneViewportCacheRef.current
							.get(currentPaneId)
							?.get(0);
						if (cached && cached.historySize === history) {
							if (cbs) for (const cb of cbs) cb(cached.viewport, false);
						} else if (last && cbs) {
							const pseudo = makePseudoViewport(last, 0 - last.offset);
							for (const cb of cbs) cb(pseudo, true);
						}
						controlTerminal.requestViewport(currentPaneId, 0);
					},
					refreshViewport: () => {
						const offset = paneOffsetRef.current.get(currentPaneId) ?? 0;
						controlTerminal.requestViewport(currentPaneId, offset);
					},
					getScrollState: () => ({
						offset: paneOffsetRef.current.get(currentPaneId) ?? 0,
						historySize:
							lastViewportRef.current.get(currentPaneId)?.historySize ?? 0,
					}),
				}
			: undefined;

		// Expose selectPane via ref (for parent components)
		useEffect(() => {
			if (ref && typeof ref === "object" && ref.current) {
				(
					ref.current as TerminalRef & { selectPane?: (paneId: string) => void }
				).selectPane = selectPane;
			}
		}, [ref, selectPane]);

		return (
			<div className="flex-1 flex flex-col bg-th-bg min-h-0 select-none">
				{/* Error banner */}
				{error && (
					<div className="bg-red-500/20 border-b border-red-500/50 px-4 py-2 text-red-400 text-sm shrink-0">
						{error}
					</div>
				)}

				{/* Terminal - full screen. mainOverlay (e.g. ChatView) replaces the
          xterm area while the InputBar inside TerminalComponent remains visible. */}
				<main className="flex-1 relative overflow-hidden min-h-0 select-none">
					{!sessionExited && (
						<TerminalComponent
							ref={ref}
							sessionId={sessionId}
							peerId={sessionPeerId}
							onError={(err) => setError(err)}
							overlayContent={overlayContent}
							onOverlayTap={onOverlayTap}
							showOverlay={showOverlay}
							theme={theme}
							controlMode={controlMode}
							hideTerminalArea={!!mainOverlay && (mainOverlayVisible ?? true)}
							terminalAreaOverlay={mainOverlay}
						/>
					)}
				</main>
			</div>
		);
	},
);

// Extract all leaf panes from a tmux layout tree
function collectLeaves(node: TmuxLayoutNode): PaneLeafInfo[] {
	if (node.type === "leaf" && node.paneId !== undefined) {
		return [
			{ paneId: `%${node.paneId}`, width: node.width, height: node.height },
		];
	}
	if (node.children) {
		return node.children.flatMap((child) => collectLeaves(child));
	}
	return [];
}
