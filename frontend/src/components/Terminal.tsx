/** biome-ignore-all lint/correctness/useExhaustiveDependencies: depends on refs and setters that React guarantees stable; adding them would cause unintended re-runs */
/** biome-ignore-all lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: legacy click-on-div UI; keyboard navigation provided via main shortcuts */
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import {
	forwardRef,
	memo,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import "@xterm/xterm/css/xterm.css";
import type { PaneViewport, SessionTheme } from "../../../shared/types";
import { useSelectionMode } from "../hooks/useSelectionMode";
import { bench } from "../utils/bench";
import { copyText } from "../utils/clipboard";
import {
	filterMouseTrackingInput,
	shouldInterceptKeyEvent,
} from "../utils/terminal-filters";
import { extractViewportUrls } from "../utils/terminal-links";
import { viewportToVTSequence } from "../utils/viewport-render";
import { InputBar, type InputBarRef, type InputMode } from "./InputBar";
import { SelectionOverlay } from "./SelectionOverlay";
import {
	DEFAULT_FONT_SIZE,
	getTerminalThemes,
	isLightMode,
	LIGHT_ANSI_COLORS,
	loadFontSize,
	MAX_FONT_SIZE,
	MIN_FONT_SIZE,
	saveFontSize,
} from "./terminal-themes";

// Control mode: terminal data comes from the multiplexed WebSocket. xterm
// is the rendering surface only — tmux holds both the visible region and
// the scrollback, and the client asks for a viewport offset rows above the
// live edge whenever the user scrolls.
export interface ControlModeConfig {
	paneId: string;
	sendInput: (data: string) => void;
	/** Subscribe for viewport updates pushed by the server (offset=0 stream)
	 *  or returned in response to scroll. Returns an unsubscribe fn. */
	/** `isPseudo=true` marks a client-side stitched frame produced while the
	 *  real server reply is still in flight — Terminal uses this to show a
	 *  "loading" badge until the real viewport lands and clears it. */
	registerOnViewport: (
		callback: (viewport: PaneViewport, isPseudo?: boolean) => void,
	) => () => void;
	isConnected: boolean;
	onResize?: (cols: number, rows: number) => void;
	/** Force-send a resize to the backend even if the dedup cache would skip
	 *  it. Used when viewport.rows != term.rows to break out of a stuck tmux
	 *  pane size (e.g. when an earlier refresh-client -C didn't take effect). */
	forceResize?: (cols: number, rows: number) => void;
	/** Adjust the current scroll offset by `lines` (positive = scroll up
	 *  into history, negative = scroll down toward the live edge). The
	 *  control mode is responsible for clamping to [0, historySize] and
	 *  re-requesting the viewport from the server. */
	scrollBy?: (lines: number) => void;
	/** Snap the viewport back to the live edge (offset=0). Equivalent to
	 *  the old `term.scrollToBottom()` in the days of frontend scrollback.
	 *  No-op if already at the live edge. */
	scrollToLive?: () => void;
	/** Claim the session size for this client (tap-to-resize): when the user taps
	 *  to interact with this device, it takes ownership of the shared size so two
	 *  devices on one session don't fight over it. */
	claimActive?: () => void;
	/** Force-refresh the current viewport (e.g. after a re-connect). */
	refreshViewport?: () => void;
	/** Snapshot of the current scroll state for indicator UI. */
	getScrollState?: () => { offset: number; historySize: number };
}

interface TerminalProps {
	sessionId: string;
	/** Peer this session belongs to. Routes image uploads to the right host
	 *  so the Claude Code instance can actually read the file. */
	peerId?: string;
	onConnect?: () => void;
	onDisconnect?: () => void;
	onError?: (error: string) => void;
	onReady?: (send: (data: string) => void) => void;
	hideKeyboard?: boolean;
	overlayContent?: React.ReactNode;
	onOverlayTap?: () => void;
	showOverlay?: boolean;
	theme?: SessionTheme;
	controlMode?: ControlModeConfig;
	/** When true, hides the xterm area but keeps the InputBar visible. */
	hideTerminalArea?: boolean;
	/** Replacement content shown in the xterm area when hideTerminalArea is true. */
	terminalAreaOverlay?: React.ReactNode;
}

// Ref interface for external keyboard input
export interface TerminalRef {
	sendInput: (char: string) => void;
	focus: () => void;
	getSelection: () => string;
	clearSelection: () => void;
	refreshTerminal: () => void;
	showKeyboard: () => void;
	hideKeyboard: () => void;
	getCellDimensions: () => { width: number; height: number } | null;
	getSize: () => { cols: number; rows: number } | null;
	getProposedSize: () => { cols: number; rows: number } | null;
	setExactSize: (cols: number, rows: number) => void;
	scrollToBottom: () => void;
	setInputText: (text: string) => void;
	changeFontSize: (delta: number) => number;
	getFontSize: () => number;
}

export const TerminalComponent = memo(
	forwardRef<TerminalRef, TerminalProps>(function TerminalComponent(
		{
			sessionId,
			peerId,
			onConnect,
			onDisconnect,
			onError,
			onReady,
			hideKeyboard,
			overlayContent,
			onOverlayTap,
			showOverlay = true,
			theme: sessionTheme,
			controlMode,
			hideTerminalArea,
			terminalAreaOverlay,
		},
		ref,
	) {
		const containerRef = useRef<HTMLDivElement>(null);
		const overlayRef = useRef<HTMLDivElement>(null);
		const terminalRef = useRef<Terminal | null>(null);
		const fitAddonRef = useRef<FitAddon | null>(null);
		const sendRef = useRef<(data: string) => void>(() => {});
		const resizeRef = useRef<(cols: number, rows: number) => void>(() => {});
		const refreshRef = useRef<() => void>(() => {});
		const closeInputBarRef = useRef<() => void>(() => {});
		const showKeyboardRef = useRef<() => void>(() => {});
		const inputBarRef = useRef<InputBarRef>(null);
		const selectionRef = useRef<string>("");
		const [isInitialized, setIsInitialized] = useState(false);
		const [inputMode, setInputMode] = useState<InputMode>("hidden");
		const [fontSize, setFontSize] = useState(() => loadFontSize(sessionId));
		const [keyboardOffset, setKeyboardOffset] = useState(0);
		const [showFontSizeIndicator, setShowFontSizeIndicator] = useState(false);
		const [scrollIndicator, setScrollIndicator] = useState<{
			text: string;
			loading: boolean;
		} | null>(null);
		const scrollIndicatorTimerRef = useRef<number | null>(null);
		// URLs on the screen right now, rejoined across the rows they were
		// wrapped over. The pane's own "c to copy" cannot reach a browser's
		// clipboard (herdr consumes the OSC 52 it writes), so this is how a
		// login URL gets off a tablet's screen.
		const [screenUrls, setScreenUrls] = useState<string[]>([]);
		const [urlsOpen, setUrlsOpen] = useState(false);
		const [urlCopied, setUrlCopied] = useState<string | null>(null);
		const urlCopiedTimerRef = useRef<number | null>(null);

		const [isTouchDevice] = useState(() => {
			const hasTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
			const hasCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
			return hasTouch && hasCoarsePointer;
		});
		const [isTablet, setIsTablet] = useState(() => window.innerWidth >= 640);
		const fontSizeTimeoutRef = useRef<number | null>(null);

		// Use refs to avoid recreating callbacks
		const onConnectRef = useRef(onConnect);
		const onDisconnectRef = useRef(onDisconnect);
		const onErrorRef = useRef(onError);
		const onReadyRef = useRef(onReady);

		useEffect(() => {
			onConnectRef.current = onConnect;
			onDisconnectRef.current = onDisconnect;
			onErrorRef.current = onError;
			onReadyRef.current = onReady;
		});

		// Update tablet detection on resize
		useEffect(() => {
			const handleResize = () => setIsTablet(window.innerWidth >= 640);
			window.addEventListener("resize", handleResize);
			return () => window.removeEventListener("resize", handleResize);
		}, []);

		const controlCleanupRef = useRef<(() => void) | null>(null);
		const controlModeRef = useRef(controlMode);
		controlModeRef.current = controlMode;
		// Whether the active pane is on the alternate screen (fullscreen TUIs like
		// Claude/Codex/vim). Updated from each viewport frame. When true we hand
		// scrolling to the app (SGR mouse wheel) instead of paging tmux scrollback,
		// because the alt screen has no tmux scrollback and the app scrolls itself.
		const altScreenRef = useRef(false);
		const hideKeyboardRef = useRef(hideKeyboard);
		hideKeyboardRef.current = hideKeyboard;

		// Selection mode hook
		const selection = useSelectionMode({ terminalRef, containerRef });

		// Send function: filters out mouse tracking escape sequences
		const send = useCallback((data: string) => {
			const filtered = filterMouseTrackingInput(data);
			if (filtered.length > 0) {
				terminalRef.current?.clearSelection();
				controlModeRef.current?.sendInput(filtered);
				terminalRef.current?.scrollToBottom();
			}
		}, []);

		const resize = useCallback((cols: number, rows: number) => {
			controlModeRef.current?.onResize?.(cols, rows);
		}, []);

		const noopFn = useCallback(() => {}, []);

		const isConnected = controlMode?.isConnected ?? false;
		const connect = noopFn;
		const refresh = useCallback(() => {
			controlModeRef.current?.refreshViewport?.();
		}, []);

		useEffect(() => {
			sendRef.current = send;
			resizeRef.current = resize;
			refreshRef.current = refresh;
		}, [send, resize, refresh]);

		// Expose ref API
		useImperativeHandle(
			ref,
			() => ({
				sendInput: (char: string) => sendRef.current(char),
				focus: () => terminalRef.current?.focus(),
				getSelection: () => selectionRef.current,
				clearSelection: () => terminalRef.current?.clearSelection(),
				refreshTerminal: () => refreshRef.current(),
				showKeyboard: () => showKeyboardRef.current(),
				hideKeyboard: () => closeInputBarRef.current(),
				getCellDimensions: () => {
					const term = terminalRef.current;
					if (!term) return null;
					// biome-ignore lint/suspicious/noExplicitAny: xterm.js exposes cell dimensions via undocumented _core API
					const core = (term as any)._core;
					const w = core?._renderService?.dimensions?.css?.cell?.width;
					const h = core?._renderService?.dimensions?.css?.cell?.height;
					return w > 0 && h > 0 ? { width: w, height: h } : null;
				},
				getSize: () => {
					const term = terminalRef.current;
					if (!term || term.cols <= 0 || term.rows <= 0) return null;
					return { cols: term.cols, rows: term.rows };
				},
				getProposedSize: () => {
					const fit = fitAddonRef.current;
					if (!fit) return null;
					const dims = fit.proposeDimensions();
					if (!dims || dims.cols <= 0 || dims.rows <= 0) return null;
					return { cols: dims.cols, rows: dims.rows };
				},
				setExactSize: (cols: number, rows: number) => {
					const term = terminalRef.current;
					if (!term) return;
					if (term.cols !== cols || term.rows !== rows) {
						term.resize(cols, rows);
					}
				},
				scrollToBottom: () => terminalRef.current?.scrollToBottom(),
				setInputText: (text: string) => {
					inputBarRef.current?.setText(text);
				},
				changeFontSize: (delta: number) => {
					const term = terminalRef.current;
					if (!term) return DEFAULT_FONT_SIZE;
					const current = term.options.fontSize || DEFAULT_FONT_SIZE;
					const newSize = Math.max(
						MIN_FONT_SIZE,
						Math.min(MAX_FONT_SIZE, current + delta),
					);
					if (newSize === current) return current;
					term.options.fontSize = newSize;
					setFontSize(newSize);
					saveFontSize(sessionId, newSize);
					const dims = fitAddonRef.current?.proposeDimensions();
					if (dims && dims.cols > 0 && dims.rows > 0) {
						term.resize(dims.cols, dims.rows);
						resizeRef.current(dims.cols, dims.rows);
					}
					return newSize;
				},
				getFontSize: () =>
					terminalRef.current?.options.fontSize || DEFAULT_FONT_SIZE,
			}),
			[sessionId],
		);

		// Fit and resize terminal
		const fitTerminal = useCallback(() => {
			const fit = fitAddonRef.current;
			const term = terminalRef.current;
			if (fit && term) {
				const dims = fit.proposeDimensions();
				if (dims && dims.cols > 0 && dims.rows > 0) {
					if (term.cols !== dims.cols || term.rows !== dims.rows) {
						term.resize(dims.cols, dims.rows);
					}
					resizeRef.current(dims.cols, dims.rows);
				}
			}
		}, []);

		// Notify parent when ready and trigger resize on connect
		useEffect(() => {
			if (isConnected) {
				onReadyRef.current?.(send);
				setTimeout(() => fitTerminal(), 150);
			}
		}, [isConnected, send, fitTerminal]);

		// Create terminal - run only once per sessionId
		useEffect(() => {
			if (!containerRef.current) return;

			const container = containerRef.current;
			const initialFontSize = loadFontSize(sessionId);
			const themeColors = getTerminalThemes()[sessionTheme || "default"];
			// Captured in the effect closure so the cleanup can clear the WebGL
			// context-loss reload timer if the effect tears down before it fires.
			let webglReloadTimer: number | null = null;
			const term = new Terminal({
				fontSize: initialFontSize,
				fontFamily:
					'"JetBrains Mono", "M PLUS 1 Code", Menlo, Monaco, monospace',
				fontWeight: "normal",
				fontWeightBold: "bold",
				letterSpacing: 0,
				lineHeight: 1,
				cursorStyle: "block",
				cursorBlink: false,
				cursorInactiveStyle: "outline",
				// Server-side scrollback: tmux is the authoritative store; xterm.js
				// is a pure render surface for the current viewport. The client
				// re-requests previous viewports when the user scrolls up.
				scrollback: 0,
				smoothScrollDuration: 0,
				scrollSensitivity: 3,
				allowProposedApi: true,
				minimumContrastRatio: isLightMode() ? 4.5 : 1,
				rescaleOverlappingGlyphs: true,
				drawBoldTextInBrightColors: false,
				convertEol: false,
				ignoreBracketedPasteMode: false,
				theme: {
					background: themeColors.background,
					foreground: themeColors.foreground,
					cursor: themeColors.foreground,
					cursorAccent: themeColors.background,
					selectionBackground: isLightMode()
						? "rgba(59, 130, 246, 0.3)"
						: "rgba(59, 130, 246, 0.5)",
					...(isLightMode() ? LIGHT_ANSI_COLORS : {}),
				},
			});

			const fitAddon = new FitAddon();
			term.loadAddon(fitAddon);

			const unicode11Addon = new Unicode11Addon();
			term.loadAddon(unicode11Addon);
			term.unicode.activeVersion = "11";

			term.open(container);

			// Hide xterm.js native scrollbar
			const xtermViewport = container.querySelector(
				".xterm-viewport",
			) as HTMLElement;
			if (xtermViewport) {
				xtermViewport.style.setProperty("scrollbar-width", "none");
				const styleId = "xterm-hide-scrollbar";
				if (!document.getElementById(styleId)) {
					const style = document.createElement("style");
					style.id = styleId;
					style.textContent = `
          .xterm-viewport::-webkit-scrollbar { display: none !important; }
          .xterm, .xterm-viewport, .xterm-screen { touch-action: none !important; }
        `;
					document.head.appendChild(style);
				}
			}

			// Prevent OS keyboard on touch devices
			const isCoarseTouchDevice =
				("ontouchstart" in window || navigator.maxTouchPoints > 0) &&
				window.matchMedia("(pointer: coarse)").matches;
			if (isCoarseTouchDevice) {
				const xtermTextarea = container.querySelector(
					".xterm-helper-textarea",
				) as HTMLTextAreaElement;
				if (xtermTextarea) {
					xtermTextarea.setAttribute("inputmode", "none");
					xtermTextarea.setAttribute("readonly", "readonly");
				}
			}

			// Load WebGL addon
			try {
				const webglAddon = new WebglAddon();
				webglAddon.onContextLoss(() => {
					console.warn(
						"[Terminal] WebGL context lost, disposing and reloading",
					);
					webglAddon.dispose();
					webglReloadTimer = window.setTimeout(() => {
						webglReloadTimer = null;
						try {
							const newWebgl = new WebglAddon();
							newWebgl.onContextLoss(() => {
								console.warn(
									"[Terminal] WebGL context lost again, staying on canvas",
								);
								newWebgl.dispose();
							});
							term.loadAddon(newWebgl);
							console.log(
								"[Terminal] WebGL renderer reloaded after context loss",
							);
						} catch {
							console.warn(
								"[Terminal] WebGL reload failed, using canvas renderer",
							);
						}
						term.refresh(0, term.rows - 1);
					}, 500);
				});
				term.loadAddon(webglAddon);
				console.log("[Terminal] WebGL renderer loaded");
			} catch (e) {
				console.warn(
					"[Terminal] WebGL not available, using canvas renderer:",
					e,
				);
			}

			// Handle OSC 52 (clipboard).
			//
			// Dormant, and kept anyway. Nothing reaches it today: xterm only sees
			// what `viewportToVTSequence` writes, and the sequence is consumed by
			// herdr's renderer well before that — it is absent from the control
			// stream's frames and from the socket API's schema alike (measured on
			// herdr 0.7.5, 2026-08-09). It fires the day a pane's copy is
			// forwarded to API clients, which is asked for in
			// herdrdev/herdr#1459; until then `terminal-links.ts` recovers URLs
			// from the rendered rows instead.
			term.parser.registerOscHandler(52, (data) => {
				const parts = data.split(";");
				if (parts.length >= 2) {
					const base64Data = parts.slice(1).join(";");
					try {
						const binaryString = atob(base64Data);
						const bytes = new Uint8Array(binaryString.length);
						for (let i = 0; i < binaryString.length; i++) {
							bytes[i] = binaryString.charCodeAt(i);
						}
						const text = new TextDecoder("utf-8").decode(bytes);
						navigator.clipboard.writeText(text).catch(console.error);
					} catch {
						// Invalid base64, ignore
					}
				}
				return true;
			});

			fitAddon.fit();

			terminalRef.current = term;
			fitAddonRef.current = fitAddon;
			setIsInitialized(true);
			// Dev-only: expose the xterm instance for browser-console debugging.
			if (import.meta.env.DEV) {
				(window as unknown as { __hrdle_term?: Terminal }).__hrdle_term = term;
			}
			console.log(
				`[Terminal] Initialized for session ${sessionId}, size: ${term.cols}x${term.rows}`,
			);

			// Handle special key combinations
			term.attachCustomKeyEventHandler((e) => {
				const action = shouldInterceptKeyEvent(e, !!selectionRef.current);
				if (action === "shift-enter") {
					e.preventDefault();
					sendRef.current("\\\r");
					return false;
				}
				if (action === "copy" || action === "paste") {
					e.preventDefault();
					return false;
				}
				// An app shortcut: xterm must not consume it, and must not
				// stopPropagation() it either, or the window listener that runs
				// the shortcut never sees it. The default is that listener's to
				// suppress.
				if (action === "app-shortcut") {
					return false;
				}
				return true;
			});

			const onDataDisposable = term.onData((data) => sendRef.current(data));

			// Track selection changes - auto-copy on desktop
			const isCoarseTouch =
				("ontouchstart" in window || navigator.maxTouchPoints > 0) &&
				window.matchMedia("(pointer: coarse)").matches;
			const onSelectionDisposable = term.onSelectionChange(() => {
				const sel = term.getSelection();
				selectionRef.current = sel;
				if (!isCoarseTouch && sel && navigator.clipboard?.writeText) {
					navigator.clipboard.writeText(sel).catch(() => {});
				}
			});

			connect();

			// Handle resize with debounce
			let resizeTimeout: number | null = null;
			let lastSentCols = 0;
			let lastSentRows = 0;
			const doResize = () => {
				if (resizeTimeout) clearTimeout(resizeTimeout);
				resizeTimeout = window.setTimeout(() => {
					if (fitAddonRef.current && terminalRef.current) {
						const dims = fitAddonRef.current.proposeDimensions();
						if (dims && dims.cols > 0 && dims.rows > 0) {
							if (!hideKeyboardRef.current) {
								const t = terminalRef.current;
								if (t.cols !== dims.cols || t.rows !== dims.rows) {
									t.resize(dims.cols, dims.rows);
								}
							}
							if (dims.cols !== lastSentCols || dims.rows !== lastSentRows) {
								lastSentCols = dims.cols;
								lastSentRows = dims.rows;
								resizeRef.current(dims.cols, dims.rows);
							}
						}
					}
				}, 50);
			};

			const resizeObserver = new ResizeObserver(doResize);
			resizeObserver.observe(container);

			const onVisibilityChange = () => {
				if (document.visibilityState === "visible" && terminalRef.current) {
					terminalRef.current.refresh(0, terminalRef.current.rows - 1);
				}
			};
			document.addEventListener("visibilitychange", onVisibilityChange);
			window.addEventListener("resize", doResize);
			const viewport = window.visualViewport;
			viewport?.addEventListener("resize", doResize);

			// Focus terminal (only on non-touch devices)
			const isTouchDev =
				"ontouchstart" in window || navigator.maxTouchPoints > 0;
			if (!isTouchDev) term.focus();

			// --- Touch handling ---
			let touchStartY: number | null = null;
			let touchMoved = false;
			let accumulatedDelta = 0;
			let scrollRafId: number | null = null;
			let momentumRafId: number | null = null;
			let lastTouchY = 0;
			let lastTouchTime = 0;
			const velocityHistory: Array<{ v: number; t: number }> = [];
			let initialPinchDistance: number | null = null;
			let initialFontSizeOnPinch: number = initialFontSize;
			let longPressTimer: number | null = null;
			let longPressTriggered = false;
			const LONG_PRESS_DURATION = 400;

			// rAF-coalesce scrollBy: a single wheel notch can fire several wheel
			// events back-to-back, and touch momentum produces 50+ scroll ticks/sec.
			// Sum deltas inside a frame and emit one scrollBy at frame boundary so
			// we issue one viewport refetch per frame instead of many tiny ones.
			let pendingScrollDelta = 0;
			let pendingScrollRafId: number | null = null;
			// Alt-screen panes (fullscreen Claude/Codex/vim) have no tmux scrollback:
			// the app scrolls its own transcript in response to mouse-wheel input.
			// Forward the accumulated scroll as SGR mouse-wheel events aimed at the
			// middle of the screen so the app pages itself. delta<0 = up (button 64),
			// delta>0 = down (button 65). Capped per flush so touch momentum can't
			// flood the pane with a burst of events.
			const MAX_WHEEL_PER_FLUSH = 4;
			const sendWheelToPane = (delta: number) => {
				const button = delta < 0 ? 64 : 65;
				const col = Math.max(1, Math.min(term.cols, Math.round(term.cols / 2)));
				const row = Math.max(1, Math.min(term.rows, Math.round(term.rows / 2)));
				const seq = `\x1b[<${button};${col};${row}M`;
				const count = Math.min(Math.abs(delta), MAX_WHEEL_PER_FLUSH);
				for (let i = 0; i < count; i++) controlModeRef.current?.sendInput(seq);
			};
			const flushPendingScroll = () => {
				pendingScrollRafId = null;
				const delta = pendingScrollDelta;
				pendingScrollDelta = 0;
				if (delta === 0) return;
				if (altScreenRef.current) {
					sendWheelToPane(delta);
				} else {
					controlModeRef.current?.scrollBy?.(delta);
				}
			};
			const scrollTerminal = (lines: number) => {
				// Server-side scrollback: tmux holds the authoritative history; the
				// control mode adjusts the viewport offset and re-fetches.
				pendingScrollDelta += lines;
				if (pendingScrollRafId === null) {
					pendingScrollRafId = requestAnimationFrame(flushPendingScroll);
				}
			};

			const updateScrollIndicator = () => {
				const state = controlModeRef.current?.getScrollState?.();
				if (state && state.offset > 0) {
					setScrollIndicator((prev) => ({
						text: `[${state.offset}/${state.historySize}]`,
						loading: prev?.loading ?? false,
					}));
					if (scrollIndicatorTimerRef.current)
						clearTimeout(scrollIndicatorTimerRef.current);
					scrollIndicatorTimerRef.current = window.setTimeout(
						() => setScrollIndicator(null),
						3000,
					);
				} else {
					setScrollIndicator(null);
				}
			};

			const stopMomentum = () => {
				if (momentumRafId !== null) {
					cancelAnimationFrame(momentumRafId);
					momentumRafId = null;
				}
			};

			const getPinchDistance = (touches: TouchList): number => {
				const dx = touches[0].clientX - touches[1].clientX;
				const dy = touches[0].clientY - touches[1].clientY;
				return Math.sqrt(dx * dx + dy * dy);
			};

			let stoppedMomentum = false;

			/**
			 * A row's actual height in px, for turning finger travel into lines.
			 * A fixed step drifts as soon as the font size changes: at 8px against
			 * a default row of ~18px, the text moved more than twice as fast as
			 * the finger (measured 2026-08-08).
			 */
			const cellHeightPx = (): number => {
				// biome-ignore lint/suspicious/noExplicitAny: xterm.js exposes cell dimensions via undocumented _core API
				const core = (term as any)._core;
				const h = core?._renderService?.dimensions?.css?.cell?.height;
				return typeof h === "number" && h > 0 ? h : 18;
			};

			const touchToCell = (
				clientX: number,
				clientY: number,
			): { col: number; row: number; viewportRow: number } | null => {
				// biome-ignore lint/suspicious/noExplicitAny: xterm.js exposes cell dimensions via undocumented _core API
				const core = (term as any)._core;
				const cellW = core?._renderService?.dimensions?.css?.cell?.width;
				const cellH = core?._renderService?.dimensions?.css?.cell?.height;
				if (!cellW || !cellH || !container) return null;
				const screenEl = container.querySelector(".xterm-screen");
				if (!screenEl) return null;
				const rect = screenEl.getBoundingClientRect();
				const col = Math.max(
					0,
					Math.min(term.cols - 1, Math.floor((clientX - rect.left) / cellW)),
				);
				const viewportRow = Math.max(
					0,
					Math.min(term.rows - 1, Math.floor((clientY - rect.top) / cellH)),
				);
				const row = term.buffer.active.viewportY + viewportRow;
				return { col, row, viewportRow };
			};

			let touchStartClientX = 0;
			let touchStartClientY = 0;

			const handleTouchStart = (e: TouchEvent) => {
				if (selection.selectionModeRef.current) {
					const target = e.target as HTMLElement;
					if (target.closest("[data-selection-control]")) return;
					const touch = e.touches[0];
					if (touch) {
						const els = document.elementsFromPoint(
							touch.clientX,
							touch.clientY,
						);
						if (
							els.some((el) =>
								(el as HTMLElement).closest?.("[data-selection-control]"),
							)
						)
							return;
					}
					selection.exitSelectionModeRef.current();
					return;
				}

				term.clearSelection();
				stoppedMomentum = momentumRafId !== null;
				if (stoppedMomentum) stopMomentum();

				if (e.touches.length === 2) {
					if (longPressTimer) {
						clearTimeout(longPressTimer);
						longPressTimer = null;
					}
					initialPinchDistance = getPinchDistance(e.touches);
					initialFontSizeOnPinch = term.options.fontSize || initialFontSize;
					touchMoved = true;
				} else if (e.touches.length === 1) {
					touchStartY = e.touches[0].clientY;
					touchStartClientX = e.touches[0].clientX;
					touchStartClientY = e.touches[0].clientY;
					lastTouchY = e.touches[0].clientY;
					lastTouchTime = e.timeStamp;
					touchMoved = false;
					longPressTriggered = false;
					accumulatedDelta = 0;
					velocityHistory.length = 0;

					longPressTimer = window.setTimeout(() => {
						longPressTriggered = true;
						touchMoved = true;
						const start = touchToCell(touchStartClientX, touchStartClientY);
						if (start) {
							selection.selectionStartRef.current = start;
							selection.selectionModeRef.current = true;
							selection.setSelectionMode(true);
							selection.setCopyButtonPos(null);
							term.select(start.col, start.row, 1);
							selection.setSelectionRange({
								startCol: start.col,
								startRow: start.viewportRow,
								endCol: start.col,
								endRow: start.viewportRow,
							});
							navigator.vibrate?.(30);
						} else {
							showKeyboardRef.current();
						}
					}, LONG_PRESS_DURATION);
				}
			};

			const handleTouchMove = (e: TouchEvent) => {
				if (longPressTimer && !longPressTriggered) {
					clearTimeout(longPressTimer);
					longPressTimer = null;
				}

				// Selection mode drag
				if (
					selection.selectionModeRef.current &&
					selection.selectionStartRef.current &&
					e.touches.length === 1
				) {
					e.preventDefault();
					const current = touchToCell(
						e.touches[0].clientX,
						e.touches[0].clientY,
					);
					if (!current) return;
					const start = selection.selectionStartRef.current;
					const cols = term.cols;
					const startOffset = start.row * cols + start.col;
					const currentOffset = current.row * cols + current.col;
					const startVRow = start.viewportRow;
					const currentVRow = current.viewportRow;

					if (currentOffset >= startOffset) {
						term.select(start.col, start.row, currentOffset - startOffset + 1);
						selection.setSelectionRange({
							startCol: start.col,
							startRow: startVRow,
							endCol: current.col,
							endRow: currentVRow,
						});
					} else {
						term.select(
							current.col,
							current.row,
							startOffset - currentOffset + 1,
						);
						selection.setSelectionRange({
							startCol: current.col,
							startRow: currentVRow,
							endCol: start.col,
							endRow: startVRow,
						});
					}
					return;
				}

				// Pinch zoom
				if (e.touches.length === 2 && initialPinchDistance !== null) {
					e.preventDefault();
					touchMoved = true;
					const currentDistance = getPinchDistance(e.touches);
					const scale = currentDistance / initialPinchDistance;
					const newSize = Math.round(initialFontSizeOnPinch * scale);
					if (newSize !== term.options.fontSize) {
						const clampedSize = Math.max(
							MIN_FONT_SIZE,
							Math.min(MAX_FONT_SIZE, newSize),
						);
						term.options.fontSize = clampedSize;
						setFontSize(clampedSize);
						const dims = fitAddonRef.current?.proposeDimensions();
						if (dims && dims.cols > 0 && dims.rows > 0) {
							term.resize(dims.cols, dims.rows);
							resizeRef.current(dims.cols, dims.rows);
						}
					}
					return;
				}

				// Scroll
				if (touchStartY === null || e.touches.length !== 1) return;
				const currentY = e.touches[0].clientY;
				const deltaY = touchStartY - currentY;
				if (Math.abs(deltaY) > 5) {
					if (!touchMoved) closeInputBarRef.current();
					touchMoved = true;
					e.preventDefault();
					const now = e.timeStamp;
					const dt = now - lastTouchTime;
					const dy = lastTouchY - currentY;
					if (dt > 0) {
						velocityHistory.push({ v: dy / dt, t: now });
						while (
							velocityHistory.length > 0 &&
							now - velocityHistory[0].t > 100
						)
							velocityHistory.shift();
					}
					lastTouchY = currentY;
					lastTouchTime = now;
					touchStartY = currentY;
					accumulatedDelta += deltaY;
					if (scrollRafId === null) {
						scrollRafId = requestAnimationFrame(() => {
							scrollRafId = null;
							const step = cellHeightPx();
							const lines = Math.round(accumulatedDelta / step);
							if (lines !== 0) {
								accumulatedDelta = accumulatedDelta % step;
								scrollTerminal(lines);
								updateScrollIndicator();
							}
						});
					}
				}
			};

			const handleTouchEnd = (e: TouchEvent) => {
				if (longPressTimer) {
					clearTimeout(longPressTimer);
					longPressTimer = null;
				}

				// Selection mode: show copy button
				if (
					selection.selectionModeRef.current &&
					selection.selectionStartRef.current &&
					!mouseInitiatedSelection
				) {
					const sel = term.getSelection();
					if (sel && sel.length > 0) {
						const touch = e.changedTouches[0];
						if (touch && container) {
							const rect = container.getBoundingClientRect();
							selection.setCopyButtonPos({
								x: touch.clientX - rect.left,
								y: touch.clientY - rect.top - 50,
							});
						}
					} else {
						selection.exitSelectionModeRef.current();
					}
					return;
				}

				if (scrollRafId !== null) {
					cancelAnimationFrame(scrollRafId);
					scrollRafId = null;
				}

				if (initialPinchDistance !== null) {
					const currentSize = term.options.fontSize || initialFontSize;
					saveFontSize(sessionId, currentSize);
					setFontSize(currentSize);
					initialPinchDistance = null;
				}

				// Momentum scroll
				if (touchMoved && velocityHistory.length > 0) {
					const sum = velocityHistory.reduce((acc, s) => acc + s.v, 0);
					let vel = sum / velocityHistory.length;
					if (Math.abs(vel) > 0.3) {
						const FRICTION = 0.97;
						const MIN_VEL = 0.02;
						let residual = 0;
						let lastFrame = performance.now();
						const animate = (now: number) => {
							const dt = now - lastFrame;
							lastFrame = now;
							vel *= FRICTION;
							if (Math.abs(vel) < MIN_VEL) {
								momentumRafId = null;
								updateScrollIndicator();
								return;
							}
							residual += vel * dt;
							const step = cellHeightPx();
							const lines = Math.trunc(residual / step);
							if (lines !== 0) {
								residual -= lines * step;
								scrollTerminal(lines);
								updateScrollIndicator();
							}
							momentumRafId = requestAnimationFrame(animate);
						};
						momentumRafId = requestAnimationFrame(animate);
					}
				}

				if (!touchMoved && !longPressTriggered && !stoppedMomentum)
					showKeyboardRef.current();
				touchStartY = null;
				touchMoved = false;
				stoppedMomentum = false;
				longPressTriggered = false;
				accumulatedDelta = 0;
				velocityHistory.length = 0;
			};

			// --- Mouse long-press selection (desktop) ---
			let mouseLongPressTimer: number | null = null;
			let mouseStartX = 0;
			let mouseStartY = 0;
			let mouseInitiatedSelection = false;
			let mouseIsDown = false;

			const handleMouseDown = (e: MouseEvent) => {
				if (e.button !== 0) return;
				if (selection.selectionModeRef.current) {
					const target = e.target as HTMLElement;
					if (target.closest("[data-selection-control]")) return;
					selection.exitSelectionModeRef.current();
					mouseInitiatedSelection = false;
					return;
				}
				mouseStartX = e.clientX;
				mouseStartY = e.clientY;
				mouseIsDown = true;
				mouseLongPressTimer = window.setTimeout(() => {
					mouseLongPressTimer = null;
					mouseInitiatedSelection = true;
					const start = touchToCell(mouseStartX, mouseStartY);
					if (start) {
						selection.selectionStartRef.current = start;
						selection.selectionModeRef.current = true;
						selection.setSelectionMode(true);
						selection.setCopyButtonPos(null);
						term.select(start.col, start.row, 1);
						selection.setSelectionRange({
							startCol: start.col,
							startRow: start.viewportRow,
							endCol: start.col,
							endRow: start.viewportRow,
						});
					}
				}, LONG_PRESS_DURATION);
			};

			const handleMouseMoveForLongPress = (e: MouseEvent) => {
				if (mouseLongPressTimer) {
					const dx = e.clientX - mouseStartX;
					const dy = e.clientY - mouseStartY;
					if (dx * dx + dy * dy > 25) {
						clearTimeout(mouseLongPressTimer);
						mouseLongPressTimer = null;
					}
				}
				if (
					mouseIsDown &&
					mouseInitiatedSelection &&
					selection.selectionModeRef.current &&
					selection.selectionStartRef.current
				) {
					const current = touchToCell(e.clientX, e.clientY);
					if (current) {
						const start = selection.selectionStartRef.current;
						const startOffset = start.row * (term.cols || 80) + start.col;
						const endOffset = current.row * (term.cols || 80) + current.col;
						const length = endOffset - startOffset;
						if (length >= 0) {
							term.select(start.col, start.row, length + 1);
						} else {
							term.select(current.col, current.row, -length + 1);
						}
						selection.setSelectionRange({
							startCol: start.col,
							startRow: start.viewportRow,
							endCol: current.col,
							endRow: current.viewportRow,
						});
					}
				}
			};

			const handleMouseUp = () => {
				mouseIsDown = false;
				if (mouseLongPressTimer) {
					clearTimeout(mouseLongPressTimer);
					mouseLongPressTimer = null;
				}
				if (
					mouseInitiatedSelection &&
					selection.selectionModeRef.current &&
					selection.selectionStartRef.current
				) {
					const sel = term.getSelection();
					const start = selection.selectionStartRef.current;
					if (sel && sel.length > 0) {
						const selRange = term.getSelectionPosition();
						if (selRange) {
							requestAnimationFrame(() => {
								const startOff =
									selRange.start.y * (term.cols || 80) + selRange.start.x;
								const endOff =
									selRange.end.y * (term.cols || 80) + selRange.end.x;
								term.select(
									selRange.start.x,
									selRange.start.y,
									endOff - startOff + 1,
								);
							});
						}
					} else {
						requestAnimationFrame(() => term.select(start.col, start.row, 1));
					}
				}
			};

			const handleContextMenu = (e: Event) => {
				if (hideKeyboardRef.current) return; // Desktop: allow native right-click
				e.preventDefault(); // Mobile/tablet: prevent default
			};

			// Mouse wheel scroll — intercept on the capture phase before xterm.js
			// receives the event. xterm.js forwards wheel events to the application
			// (e.g. Claude / Codex Ink TUIs interpret wheel as ↑/↓ → input history),
			// which prevents the user from scrolling tmux's scrollback. Stopping
			// propagation here keeps the wheel local to our scrollTerminal() call.
			const handleWheel = (e: WheelEvent) => {
				const term = terminalRef.current;
				if (!term) return;
				e.preventDefault();
				e.stopPropagation();
				const lines = Math.ceil(Math.abs(e.deltaY) / 40);
				scrollTerminal(e.deltaY > 0 ? lines : -lines);
				updateScrollIndicator();
			};

			if (container) {
				container.addEventListener("wheel", handleWheel, { capture: true, passive: false });
				container.addEventListener("touchstart", handleTouchStart, {
					passive: true,
				});
				container.addEventListener("touchmove", handleTouchMove, {
					passive: false,
				});
				container.addEventListener("touchend", handleTouchEnd);
				container.addEventListener("mousedown", handleMouseDown);
				container.addEventListener("mousemove", handleMouseMoveForLongPress);
				container.addEventListener("mouseup", handleMouseUp);
				container.addEventListener("contextmenu", handleContextMenu);
			}

			return () => {
				if (longPressTimer) clearTimeout(longPressTimer);
				if (mouseLongPressTimer) clearTimeout(mouseLongPressTimer);
				// Clear the scroll-indicator auto-hide timer so a session switch
				// doesn't let an old timer null out the new session's indicator.
				if (scrollIndicatorTimerRef.current)
					clearTimeout(scrollIndicatorTimerRef.current);
				// Cancel rAF loops and the WebGL reload timer so they don't keep
				// running against the disposed terminal — momentum scroll, touch
				// coalesce, wheel flush, and the queued WebGL re-init all post
				// scrollBy / setState back into the now-stale closure.
				if (scrollRafId !== null) cancelAnimationFrame(scrollRafId);
				if (momentumRafId !== null) cancelAnimationFrame(momentumRafId);
				if (pendingScrollRafId !== null) cancelAnimationFrame(pendingScrollRafId);
				if (webglReloadTimer !== null) clearTimeout(webglReloadTimer);
				if (container) {
					container.removeEventListener("touchstart", handleTouchStart);
					container.removeEventListener("touchmove", handleTouchMove);
					container.removeEventListener("touchend", handleTouchEnd);
					container.removeEventListener("mousedown", handleMouseDown);
					container.removeEventListener(
						"mousemove",
						handleMouseMoveForLongPress,
					);
					container.removeEventListener("mouseup", handleMouseUp);
					container.removeEventListener("contextmenu", handleContextMenu);
					container.removeEventListener("wheel", handleWheel, { capture: true } as EventListenerOptions);
				}
				if (resizeTimeout) clearTimeout(resizeTimeout);
				resizeObserver.disconnect();
				document.removeEventListener("visibilitychange", onVisibilityChange);
				window.removeEventListener("resize", doResize);
				viewport?.removeEventListener("resize", doResize);
				onDataDisposable.dispose();
				onSelectionDisposable.dispose();
				term.dispose();
				terminalRef.current = null;
				fitAddonRef.current = null;
			};
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [sessionId, connect, sessionTheme]);

		// Register control mode output listener
		const prevControlPaneIdRef = useRef<string | null>(null);
		const prevSessionIdRef = useRef(sessionId);

		if (prevSessionIdRef.current !== sessionId) {
			prevSessionIdRef.current = sessionId;
			prevControlPaneIdRef.current = null;
		}

		useEffect(() => {
			const cm = controlModeRef.current;
			if (!cm || !terminalRef.current) return;

			if (
				prevControlPaneIdRef.current !== null &&
				prevControlPaneIdRef.current !== cm.paneId
			) {
				terminalRef.current.clearSelection();
				terminalRef.current.clear();
				terminalRef.current.reset();
			}
			prevControlPaneIdRef.current = cm.paneId;

			const term = terminalRef.current;
			if (term) {
				// Disable any mouse tracking modes the previous tenant of this xterm
				// may have left enabled; mouse events stay in the browser.
				term.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l");
			}

			const applyResize = (cols: number, rows: number) => {
				term.resize(cols, rows);
				const fit = fitAddonRef.current;
				const dims = fit?.proposeDimensions();
				if (
					dims &&
					dims.cols > 0 &&
					dims.rows > 0 &&
					(dims.cols !== cols || dims.rows !== rows)
				) {
					cm.forceResize?.(dims.cols, dims.rows);
				}
			};
			const cleanup = cm.registerOnViewport((viewport, isPseudo) => {
				const term = terminalRef.current;
				if (!term) return;
				altScreenRef.current = viewport.modes.altScreen;
				if (term.cols !== viewport.cols || term.rows !== viewport.rows) {
					applyResize(viewport.cols, viewport.rows);
				}
				const vt = viewportToVTSequence(viewport);
				const t0 = bench.recordWriteStart();
				term.write(vt, () => {
					bench.recordWriteEnd(t0, vt.length);
				});
				// Runs on every frame, so the no-URL screen costs one substring
				// scan and the state is only replaced when the set changes —
				// otherwise every keystroke would re-render the chip.
				if (import.meta.env.DEV) {
					(
						window as unknown as { __hrdle_viewport?: PaneViewport }
					).__hrdle_viewport = viewport;
				}
				const urls = extractViewportUrls(viewport.lines, viewport.cols);
				setScreenUrls((prev) =>
					prev.length === urls.length && prev.every((u, i) => u === urls[i])
						? prev
						: urls,
				);
				// An empty screen closes the panel, so the next URL to appear does
				// not reopen it on its own — the list has to be asked for.
				if (urls.length === 0) setUrlsOpen(false);
				const state = cm.getScrollState?.();
				if (state && state.offset > 0) {
					setScrollIndicator({
						text: `[${state.offset}/${state.historySize}]`,
						loading: !!isPseudo,
					});
					if (scrollIndicatorTimerRef.current)
						clearTimeout(scrollIndicatorTimerRef.current);
					// Pin the badge while waiting for the real reply; only auto-fade
					// once the real (non-pseudo) viewport has landed.
					if (!isPseudo) {
						scrollIndicatorTimerRef.current = window.setTimeout(
							() => setScrollIndicator(null),
							3000,
						);
					}
				} else {
					setScrollIndicator(null);
				}
			});
			controlCleanupRef.current = cleanup;
			return () => {
				cleanup();
				controlCleanupRef.current = null;
				// Another pane's URLs are not this one's.
				setScreenUrls([]);
				setUrlsOpen(false);
			};
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [!!controlMode, controlMode?.paneId]);

		// Track visual viewport for soft keyboard offset
		useEffect(() => {
			const viewport = window.visualViewport;
			if (!viewport) return;

			const updateKeyboardOffset = async () => {
				const isStandalone = window.matchMedia(
					"(display-mode: standalone)",
				).matches;
				const isBrowserFullscreen = document.fullscreenElement !== null;

				if (isStandalone || !isBrowserFullscreen) {
					setKeyboardOffset(0);
					return;
				}
				const offset = window.innerHeight - viewport.height;
				setKeyboardOffset(offset > 0 ? offset : 0);
			};

			viewport.addEventListener("resize", updateKeyboardOffset);
			viewport.addEventListener("scroll", updateKeyboardOffset);
			updateKeyboardOffset();

			return () => {
				viewport.removeEventListener("resize", updateKeyboardOffset);
				viewport.removeEventListener("scroll", updateKeyboardOffset);
			};
		}, [sessionId]);

		// Desktop selection mode (activated by mouse long-press) — Enter to copy and
		// exit, Esc to cancel. Touch devices keep using the SelectionOverlay buttons.
		useEffect(() => {
			if (!selection.selectionMode) return;
			const handler = (e: KeyboardEvent) => {
				if (e.key === "Enter") {
					e.preventDefault();
					e.stopPropagation();
					e.stopImmediatePropagation();
					selection.handleCopySelection();
				} else if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					e.stopImmediatePropagation();
					selection.exitSelectionMode();
				}
			};
			document.addEventListener("keydown", handler, true);
			return () => document.removeEventListener("keydown", handler, true);
		}, [
			selection.selectionMode,
			selection.handleCopySelection,
			selection.exitSelectionMode,
		]);

		// Show font size indicator
		useEffect(() => {
			if (isInitialized) {
				setShowFontSizeIndicator(true);
				if (fontSizeTimeoutRef.current)
					clearTimeout(fontSizeTimeoutRef.current);
				fontSizeTimeoutRef.current = window.setTimeout(
					() => setShowFontSizeIndicator(false),
					1500,
				);
			}
			return () => {
				if (fontSizeTimeoutRef.current)
					clearTimeout(fontSizeTimeoutRef.current);
			};
		}, [isInitialized, fontSize]);

		// Update terminal theme
		useEffect(() => {
			const term = terminalRef.current;
			const container = containerRef.current;
			if (!term || !container) return;

			const applyTerminalTheme = () => {
				const themeColors = getTerminalThemes()[sessionTheme || "default"];
				const light = isLightMode();
				term.options.minimumContrastRatio = light ? 4.5 : 1;
				term.options.theme = {
					background: themeColors.background,
					foreground: themeColors.foreground,
					cursor: themeColors.foreground,
					cursorAccent: themeColors.background,
					selectionBackground: light
						? "rgba(0, 0, 0, 0.15)"
						: "rgba(255, 255, 255, 0.3)",
					...(light ? LIGHT_ANSI_COLORS : {}),
				};
				const viewport = container.querySelector(
					".xterm-viewport",
				) as HTMLElement;
				if (viewport) viewport.style.backgroundColor = themeColors.background;
				const screen = container.querySelector(".xterm-screen") as HTMLElement;
				if (screen) screen.style.backgroundColor = themeColors.background;
				term.refresh(0, term.rows - 1);
			};

			applyTerminalTheme();

			const observer = new MutationObserver((mutations) => {
				for (const m of mutations) {
					if (m.type === "attributes" && m.attributeName === "data-theme")
						applyTerminalTheme();
				}
			});
			observer.observe(document.documentElement, {
				attributes: true,
				attributeFilter: ["data-theme"],
			});
			return () => observer.disconnect();
		}, [sessionTheme]);

		const handleCloseInputBar = useCallback(() => {
			setInputMode("hidden");
			setTimeout(() => fitTerminal(), 50);
		}, [fitTerminal]);
		closeInputBarRef.current = handleCloseInputBar;

		const handleShowKeyboard = useCallback(() => {
			setInputMode("input");
			// Tapping to interact claims the session size for this device.
			controlModeRef.current?.claimActive?.();
			// Snap back to the live edge when the user taps to interact, matching
			// the pre-server-side-scrollback behavior. `term.scrollToBottom()` is
			// a no-op now (xterm scrollback is 0); the actual reset goes through
			// the control mode's offset.
			if (altScreenRef.current) {
				// Fullscreen TUIs (Claude/Codex) own their own transcript scroll, so
				// there is no tmux offset to reset — send Ctrl+End so the app jumps
				// its transcript to the bottom. No-op when already at the live edge.
				controlModeRef.current?.sendInput("\x1b[1;5F");
			} else {
				controlModeRef.current?.scrollToLive?.();
			}
			fitTerminal();
		}, [fitTerminal]);
		showKeyboardRef.current = handleShowKeyboard;

		const handleCopyUrl = useCallback((url: string) => {
			void copyText(url).then((ok) => {
				setUrlCopied(ok ? url : null);
				if (urlCopiedTimerRef.current)
					clearTimeout(urlCopiedTimerRef.current);
				urlCopiedTimerRef.current = window.setTimeout(
					() => setUrlCopied(null),
					1500,
				);
			});
		}, []);

		useEffect(
			() => () => {
				if (urlCopiedTimerRef.current)
					clearTimeout(urlCopiedTimerRef.current);
			},
			[],
		);

		const themeColors = getTerminalThemes()[sessionTheme || "default"];
		const containerStyle: React.CSSProperties = {
			...(keyboardOffset > 0
				? { height: `calc(100% - ${keyboardOffset}px)` }
				: {}),
			backgroundColor: themeColors.background,
		};

		return (
			<div
				className={`h-full w-full flex flex-col overflow-hidden${isTouchDevice ? " select-none" : ""}`}
				style={containerStyle}
			>
				{/* Terminal area */}
				<div
					className={`flex-1 relative min-h-0 overflow-hidden${isTouchDevice ? " select-none" : ""}`}
					onMouseUp={(e) => e.stopPropagation()}
				>
					<div
						ref={containerRef}
						className={`absolute inset-0 p-1${hideTerminalArea ? " invisible pointer-events-none" : ""}`}
						style={{
							...(isTouchDevice
								? { WebkitTouchCallout: "none", WebkitUserSelect: "none" }
								: {}),
							touchAction: "none",
						}}
					/>
					{/* Always render the overlay container so ChatView keeps its state /
            subscription mounted; toggle visibility via display style. */}
					{terminalAreaOverlay && (
						<div
							className="absolute inset-0 z-20 bg-[#0a0a0a]"
							style={{ display: hideTerminalArea ? "block" : "none" }}
						>
							{terminalAreaOverlay}
						</div>
					)}
					<div
						ref={overlayRef}
						className="absolute inset-0 z-10 pointer-events-none"
						style={{ touchAction: "none" }}
					/>
					{/* Hidden while an overlay replaces the xterm area (remote-control
					    mode keeps isConnected=false by design — no live subscription). */}
					{!hideTerminalArea && (!isInitialized || !isConnected) && (
						<div className="absolute top-2 left-2 z-30 pointer-events-none">
							<div className="flex items-center gap-2 bg-yellow-900/80 text-yellow-200 text-xs px-2.5 py-1 rounded-lg shadow">
								<div className="w-3 h-3 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin" />
								{!isInitialized ? "Loading..." : "Connecting..."}
							</div>
						</div>
					)}
					{showFontSizeIndicator && (
						<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 bg-[var(--color-overlay)] px-4 py-2 rounded-lg pointer-events-none">
							<span className="text-th-text text-lg font-medium">
								{fontSize}px
							</span>
						</div>
					)}
					{scrollIndicator && (
						<div
							className={`absolute top-2 right-2 z-30 bg-[var(--color-overlay)] px-2 py-1 rounded text-xs pointer-events-none font-mono ${
								scrollIndicator.loading
									? "text-blue-300/90"
									: "text-yellow-400/80"
							}`}
						>
							{scrollIndicator.text}
							{scrollIndicator.loading && (
								<span className="ml-1 opacity-70">⏳</span>
							)}
						</div>
					)}
					{/* URLs on screen. The pane's own copy key writes an OSC 52
					    sequence that herdr consumes, so on a tablet this is the only
					    way a login URL reaches the browser's clipboard. Hidden in
					    selection mode, whose panel sits over the same corner. */}
					{!hideTerminalArea &&
						!selection.selectionMode &&
						screenUrls.length > 0 && (
							<div className="absolute bottom-2 right-2 z-30 flex max-w-[min(30rem,calc(100%-1rem))] flex-col items-end gap-2">
								{urlsOpen && (
									<div
										className="w-full overflow-hidden rounded-lg border border-blue-500/50 bg-black/90 shadow-xl"
										onMouseDown={(e) => e.stopPropagation()}
									>
										{screenUrls.map((url) => (
											<div
												key={url}
												className="border-b border-white/10 px-2.5 py-2 last:border-b-0"
											>
												<div className="line-clamp-2 break-all font-mono text-[11px] leading-snug text-blue-200">
													{url}
												</div>
												<div className="mt-1.5 flex gap-2">
													<button
														type="button"
														className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white active:bg-blue-700"
														onTouchEnd={(e) => {
															e.preventDefault();
															e.stopPropagation();
															handleCopyUrl(url);
														}}
														onClick={() => handleCopyUrl(url)}
													>
														{urlCopied === url ? "Copied!" : "Copy"}
													</button>
													<a
														href={url}
														target="_blank"
														rel="noreferrer"
														className="rounded bg-gray-600 px-3 py-1 text-xs font-medium text-white active:bg-gray-700"
														onClick={(e) => e.stopPropagation()}
													>
														Open
													</a>
												</div>
											</div>
										))}
									</div>
								)}
								<button
									type="button"
									aria-label="URLs on screen"
									aria-expanded={urlsOpen}
									className="flex items-center gap-1 rounded-full bg-[var(--color-overlay)] px-2.5 py-1.5 text-xs text-blue-300/90 active:bg-blue-700/60"
									onTouchEnd={(e) => {
										e.preventDefault();
										e.stopPropagation();
										setUrlsOpen((open) => !open);
									}}
									onClick={() => setUrlsOpen((open) => !open)}
								>
									<svg
										className="h-4 w-4"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth={2}
										strokeLinecap="round"
									>
										<title>Link</title>
										<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
										<path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
									</svg>
									{screenUrls.length > 1 && (
										<span className="font-mono">{screenUrls.length}</span>
									)}
								</button>
							</div>
						)}
					{/* Selection mode controls */}
					{selection.selectionMode && (
						<SelectionOverlay
							terminalRef={terminalRef}
							containerRef={containerRef}
							selectionRange={selection.selectionRange}
							copyFeedback={selection.copyFeedback}
							onHandleTouchDragStart={selection.handleHandleDragStart}
							onHandleMouseDragStart={selection.handleHandleMouseDragStart}
							onCopy={selection.handleCopySelection}
							onCancel={selection.exitSelectionMode}
						/>
					)}
				</div>

				{/* Input bar (mobile/tablet keyboard) */}
				<InputBar
					ref={inputBarRef}
					inputMode={inputMode}
					setInputMode={setInputMode}
					sendRef={sendRef}
					fitTerminal={fitTerminal}
					isTablet={isTablet}
					overlayContent={overlayContent}
					onOverlayTap={onOverlayTap}
					showOverlay={showOverlay}
					hideKeyboard={hideKeyboard}
					peerId={peerId}
				/>

				{/* Bottom overlay when keyboard is hidden (mobile only) */}
				{!hideKeyboard && inputMode === "hidden" && overlayContent && (
					<div className="fixed bottom-0 left-0 right-0 z-40 bg-th-bg border-t border-th-border">
						{overlayContent}
						{!showOverlay && onOverlayTap && (
							<div className="absolute inset-0 z-50" onClick={onOverlayTap} />
						)}
					</div>
				)}

				{/* Tap area at bottom when keyboard hidden */}
				{!hideKeyboard && inputMode === "hidden" && !overlayContent && (
					<div
						className="fixed bottom-0 left-0 right-0 h-8 z-40 bg-[var(--color-overlay)] flex items-center justify-center"
						onClick={handleShowKeyboard}
					>
						<svg
							aria-hidden="true"
							className="w-5 h-5 text-th-text-muted"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth={2}
						>
							<rect x="2" y="6" width="20" height="12" rx="2" />
							<path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
						</svg>
					</div>
				)}
			</div>
		);
	}),
);
