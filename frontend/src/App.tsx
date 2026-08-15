/** biome-ignore-all lint/correctness/useExhaustiveDependencies: depends on refs and setters that React guarantees stable; adding them would cause unintended re-runs */
import {
	BarChart3,
	ChevronDown,
	Server,
	Terminal as TerminalIcon,
	X as XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type AgentProvider,
	type ExtendedSessionResponse,
	type IndicatorState,
	LOCAL_PEER_ID,
	type PaneInfo,
	type SessionState,
	type SessionTheme,
	threadAgentOf,
} from "../../shared/types";
import { ChatView } from "./components/chat/ChatView";
import { DesktopLayout } from "./components/DesktopLayout";
import { Dashboard } from "./components/dashboard/Dashboard";
import { FileViewer } from "./components/files/FileViewer";
import { LoginForm } from "./components/LoginForm";
import { PeerManager } from "./components/PeerManager";
import { Onboarding, useOnboarding } from "./components/Onboarding";
import { WorkspaceList } from "./components/WorkspaceList";
import type { TerminalRef } from "./components/Terminal";
import { openClaudeAppSession } from "./utils/claude-app";
import {
	makeSessionKey,
	parseSessionKey,
	sessionKeyOf,
} from "./utils/sessionKey";
import { useAuth } from "./hooks/useAuth";
import { useWorkspaces } from "./hooks/useWorkspaces";
import { ServerUnreachableHint } from "./components/ServerUnreachable";
import { SessionActionBar } from "./components/SessionActionBar";
import { TerminalPage } from "./pages/TerminalPage";
import { authFetch, isTransientNetworkError } from "./services/api";
import {
	findNotificationSession,
	isSameNotificationPeer,
	NOTIFICATION_NAVIGATION_EVENT,
	parseNotificationTarget,
	type NotificationTarget,
} from "./utils/notificationNavigation";
import { soleVisiblePane } from "./utils/panes";
import { storageKey } from "./utils/app-storage";

// Loading screen with phase display and timeout detection
function LoadingScreen({
	phase,
	error,
	onRetry,
}: {
	phase: "auth" | "sessions";
	error: string | null;
	onRetry: () => void;
}) {
	const { t } = useTranslation();
	const [elapsed, setElapsed] = useState(0);

	useEffect(() => {
		setElapsed(0);
		const start = Date.now();
		const timer = setInterval(() => {
			setElapsed(Math.floor((Date.now() - start) / 1000));
		}, 1000);
		return () => clearInterval(timer);
	}, [phase]);

	const phaseText =
		phase === "auth"
			? t("loading.checkingAuth")
			: t("loading.fetchingSessions");

	return (
		<div className="flex flex-col items-center justify-center h-full bg-th-bg gap-3">
			{error ? (
				<>
					<div className="text-red-400 text-sm">{error}</div>
					{/* The error alone says the connection failed; this says what to do
					    about it, which from a phone is almost always the VPN. */}
					<ServerUnreachableHint />
					<button
						type="button"
						onClick={onRetry}
						className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-md text-white text-sm font-medium transition-colors"
					>
						{t("loading.retry")}
					</button>
				</>
			) : (
				<>
					<div className="w-5 h-5 border-2 border-th-surface-active border-t-blue-500 rounded-full animate-spin" />
					<div className="text-th-text-secondary text-sm">{phaseText}</div>
					{elapsed >= 5 && (
						<div className="text-th-text-muted text-xs">
							{t("loading.slow", { seconds: elapsed })}
						</div>
					)}
				</>
			)}
		</div>
	);
}

// Session info type (simplified from SessionTabs)
interface OpenSession {
	id: string;
	name: string;
	instanceId?: string;
	state: SessionState;
	currentPath?: string;
	ccSessionId?: string;
	// Remote Control deep-link target (`session_…`). Present only while Remote
	// Control is active; drives the "Open in Claude app" button.
	bridgeSessionId?: string;
	agent?: AgentProvider;
	agentSessionId?: string;
	currentCommand?: string;
	theme?: SessionTheme;
	panes?: PaneInfo[];
	indicatorState?: IndicatorState;
	// Multi-server: the peer this session lives on. Unset = local Hub.
	peerId?: string;
}

function apiToOpenSession(s: ExtendedSessionResponse): OpenSession {
	return {
		id: s.id,
		name: s.name,
		instanceId: s.instanceId,
		state: s.state,
		currentPath: s.currentPath,
		ccSessionId: s.ccSessionId,
		bridgeSessionId: s.bridgeSessionId,
		agent: s.agent,
		agentSessionId: s.agentSessionId,
		currentCommand: s.currentCommand,
		theme: s.theme,
		panes: s.panes,
		indicatorState: s.indicatorState,
		peerId: s.peerId,
	};
}

const API_BASE = import.meta.env.VITE_API_URL || "";

// Confirm dialog for delete
function ConfirmDeleteDialog({
	sessionName,
	onConfirm,
	onCancel,
}: {
	sessionName: string;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-overlay)] animate-backdrop-in">
			<div className="bg-th-surface rounded-lg p-6 max-w-sm w-full mx-4 shadow-xl animate-modal-in">
				<h3 className="text-lg font-bold text-th-text mb-2">
					{t("session.deleteSession")}
				</h3>
				<p className="text-th-text-secondary mb-4">
					{t("session.deleteConfirm", { name: sessionName })}
				</p>
				<p className="text-sm text-th-text-secondary mb-6">
					{t("session.deleteWarning")}
				</p>
				<div className="flex gap-3 justify-end">
					<button
						type="button"
						onClick={onCancel}
						className="px-4 py-2 bg-th-surface-active hover:bg-th-surface-hover rounded font-medium transition-colors text-th-text"
					>
						{t("common.cancel")}
					</button>
					<button
						type="button"
						onClick={onConfirm}
						className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded font-medium transition-colors text-th-text"
					>
						{t("common.delete")}
					</button>
				</div>
			</div>
		</div>
	);
}

// localStorage keys for session persistence. Values are composite
// `peerId:id` keys (utils/sessionKey.ts).
const STORAGE_KEY_LAST_SESSION = storageKey("last-session-id");
const STORAGE_KEY_OPEN_SESSIONS = storageKey("open-sessions");

function saveLastSessionKey(sessionKey: string | null) {
	if (sessionKey) {
		localStorage.setItem(STORAGE_KEY_LAST_SESSION, sessionKey);
	} else {
		localStorage.removeItem(STORAGE_KEY_LAST_SESSION);
	}
}

function getLastSessionKey(): string | null {
	return localStorage.getItem(STORAGE_KEY_LAST_SESSION);
}

function saveOpenSessions(sessions: OpenSession[]) {
	localStorage.setItem(
		STORAGE_KEY_OPEN_SESSIONS,
		JSON.stringify(sessions.map((s) => sessionKeyOf(s))),
	);
}

function getSavedOpenSessionKeys(): string[] {
	try {
		const saved = localStorage.getItem(STORAGE_KEY_OPEN_SESSIONS);
		const parsed: unknown = saved ? JSON.parse(saved) : [];
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((v): v is string => typeof v === "string");
	} catch {
		return [];
	}
}

// Device type detection
// - desktop: a PC (non-touch device), so no soft keyboard is needed
// - tablet: a touch device with width >= 640px && height >= 500px
// - mobile: any other touch device
type DeviceType = "mobile" | "tablet" | "desktop";

function checkIsTouchDevice(): boolean {
	const hasTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
	const hasCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
	return hasTouch && hasCoarsePointer;
}

function checkDeviceType(): DeviceType {
	// Real touch device: decided by the shorter side of the physical resolution (orientation-independent)
	if (checkIsTouchDevice()) {
		const shortSide = Math.min(screen.width, screen.height);
		const longSide = Math.max(screen.width, screen.height);
		if (shortSide >= 500 && longSide >= 640) return "tablet";
		return "mobile";
	}
	// Non-touch device (a PC, including DevTools emulation): decided by viewport width
	const w = window.innerWidth;
	if (w < 640) return "mobile";
	if (w < 1024) return "tablet";
	return "desktop";
}

export function App() {
	const { t } = useTranslation();
	const tRef = useRef(t);
	tRef.current = t;
	// Auth state
	const auth = useAuth();
	// Onboarding state
	const {
		showOnboarding,
		completeOnboarding,
		showSessionListOnboarding,
		completeSessionListOnboarding,
	} = useOnboarding();

	// Terminal ref for mobile view refresh
	const mobileTerminalRef = useRef<TerminalRef>(null);

	// Keyboard control ref for onboarding (tablet: FloatingKeyboard via DesktopLayout)
	const keyboardControlRef = useRef<{
		open: () => void;
		close: () => void;
	} | null>(null);
	const keyboardOpenedByOnboarding = useRef(false);

	// Tablet: control FloatingKeyboard via ref
	const handleTabletStepAction = useCallback((action: string) => {
		if (action === "open-keyboard") {
			keyboardControlRef.current?.open();
			keyboardOpenedByOnboarding.current = true;
		} else if (action === "close-keyboard") {
			keyboardControlRef.current?.close();
			keyboardOpenedByOnboarding.current = false;
		} else if (action === "cleanup") {
			if (keyboardOpenedByOnboarding.current) {
				keyboardControlRef.current?.close();
				keyboardOpenedByOnboarding.current = false;
			}
		}
	}, []);

	// Mobile: control Terminal's built-in keyboard via ref
	const handleMobileStepAction = useCallback((action: string) => {
		if (action === "open-keyboard") {
			mobileTerminalRef.current?.showKeyboard();
			keyboardOpenedByOnboarding.current = true;
		} else if (action === "close-keyboard") {
			mobileTerminalRef.current?.hideKeyboard();
			keyboardOpenedByOnboarding.current = false;
		} else if (action === "cleanup") {
			if (keyboardOpenedByOnboarding.current) {
				mobileTerminalRef.current?.hideKeyboard();
				keyboardOpenedByOnboarding.current = false;
			}
		}
	}, []);

	const [openSessions, setOpenSessions] = useState<OpenSession[]>([]);
	// Composite `peerId:id` key of the active session (utils/sessionKey.ts) —
	// session ids alone collide across peers.
	const [activeSessionKey, setActiveSessionKey] = useState<string | null>(null);
	const [pendingNotificationTarget, setPendingNotificationTarget] =
		useState<NotificationTarget | null>(null);
	const notificationRequestIdRef = useRef(0);
	const notificationNavigationHandledRef = useRef(false);
	const [desktopSessionSwitchRequest, setDesktopSessionSwitchRequest] = useState<{
		sessionKey: string;
		requestId: number;
	} | null>(null);

	const [isLoading, setIsLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [retryCount, setRetryCount] = useState(0);
	const [showSessionList, setShowSessionList] = useState(false);
	const [showMobileDashboard, setShowMobileDashboard] = useState(false);
	const [mobileDashboardTab, setMobileDashboardTab] = useState<
		"dashboard" | "peers"
	>("dashboard");
	const [sessionToDelete, setSessionToDelete] = useState<OpenSession | null>(
		null,
	);
	const [showOverlay, setShowOverlay] = useState(true);
	// FileViewer state: per-session instances kept mounted for state preservation.
	// `peerId` rides along so the FileViewer hits the host that actually owns the
	// files (otherwise remote-peer paths return "Access denied" from the Hub).
	const [fileViewerDirs, setFileViewerDirs] = useState<
		{ dir: string; peerId?: string }[]
	>([]);
	const [activeFileViewerDir, setActiveFileViewerDir] = useState<string | null>(
		null,
	);
	// Tracks which session dirs have FileViewer "open" (per-session)
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
	const fileViewerVisible = activeFileViewerDir
		? fileViewerOpenDirs.has(activeFileViewerDir)
		: false;
	const overlayTimeoutRef = useRef<number | null>(null);

	// Conversation viewer state — per-session (each session remembers whether
	// it was last shown in chat mode or terminal mode). Persisted to localStorage.
	const [conversationModeSessions, setConversationModeSessions] = useState<
		Set<string>
	>(() => {
		try {
			const saved = localStorage.getItem(storageKey("conversation-mode-sessions"));
			const parsed: unknown = saved ? JSON.parse(saved) : [];
			if (!Array.isArray(parsed)) return new Set();
			return new Set(
				parsed.filter((v): v is string => typeof v === "string"),
			);
		} catch {
			return new Set();
		}
	});
	const showConversation = activeSessionKey
		? conversationModeSessions.has(activeSessionKey)
		: false;
	const setShowConversation = useCallback(
		(show: boolean) => {
			if (!activeSessionKey) return;
			setConversationModeSessions((prev) => {
				const has = prev.has(activeSessionKey);
				if (show === has) return prev;
				const next = new Set(prev);
				if (show) next.add(activeSessionKey);
				else next.delete(activeSessionKey);
				return next;
			});
		},
		[activeSessionKey],
	);

	// Persist per-session conversation mode to localStorage
	useEffect(() => {
		try {
			localStorage.setItem(
				storageKey("conversation-mode-sessions"),
				JSON.stringify([...conversationModeSessions]),
			);
		} catch {
			// ignore quota errors
		}
	}, [conversationModeSessions]);

	// Chat mode is read-only: no composer, no soft keyboard. Typing belongs to
	// the terminal, and a keyboard over a transcript only asked the reader to
	// guess where the characters were going.

	// Mobile pane tabs state
	const [mobilePanes, setMobilePanes] = useState<
		{ paneId: string; width: number; height: number }[]
	>([]);
	const [mobileActivePaneId, setMobileActivePaneId] = useState<string | null>(
		null,
	);

	// Session API state (for theme updates in mobile view)
	const { sessions: apiSessions, createSession } = useWorkspaces();

	const [deviceType, setDeviceType] = useState<DeviceType>(checkDeviceType);

	// Both tablet and mobile need keyboard control during onboarding
	const onboardingStepAction =
		deviceType === "tablet"
			? handleTabletStepAction
			: deviceType === "mobile"
				? handleMobileStepAction
				: undefined;

	// Update device type on resize. checkDeviceType is a stable module-level
	// function, so the listener is registered once for the component's life.
	useEffect(() => {
		const handleResize = () => setDeviceType(checkDeviceType());
		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, []);

	// Sessions are now delivered via WS push (no HTTP polling needed)

	// Update openSessions live fields from API (for mobile view)
	useEffect(() => {
		if (deviceType !== "mobile" || apiSessions.length === 0) return;
		setOpenSessions((prev) =>
			prev.map((session) => {
				// ids can collide across peers, so update from a session on the same peer
				const apiSession = apiSessions.find(
					(s) =>
						s.id === session.id &&
						isSameNotificationPeer(s.peerId, session.peerId),
				);
				if (!apiSession) return session;
				const next = {
					...session,
					instanceId: apiSession.instanceId,
					theme: apiSession.theme,
					currentCommand: apiSession.currentCommand,
					ccSessionId: apiSession.ccSessionId,
					bridgeSessionId: apiSession.bridgeSessionId,
					agent: apiSession.agent,
					agentSessionId: apiSession.agentSessionId,
					panes: apiSession.panes,
					indicatorState: apiSession.indicatorState,
				};
				// Skip update if nothing actually changed (avoid extra renders)
				if (
					next.instanceId === session.instanceId &&
					next.theme === session.theme &&
					next.currentCommand === session.currentCommand &&
					next.ccSessionId === session.ccSessionId &&
					next.agent === session.agent &&
					next.agentSessionId === session.agentSessionId &&
					next.panes === session.panes &&
					next.indicatorState === session.indicatorState
				) {
					return session;
				}
				return next;
			}),
		);
	}, [deviceType, apiSessions]);

	// Handle browser back navigation - return to terminal from overlays
	useEffect(() => {
		const handlePopState = () => {
			// Close any open overlays and return to terminal
			if (showSessionList) {
				setShowSessionList(false);
				window.history.pushState(
					{ view: "terminal" },
					"",
					window.location.href,
				);
			} else if (fileViewerVisible) {
				if (activeFileViewerDir) closeFileViewer(activeFileViewerDir);
				window.history.pushState(
					{ view: "terminal" },
					"",
					window.location.href,
				);
			} else if (showConversation) {
				setShowConversation(false);
				window.history.pushState(
					{ view: "terminal" },
					"",
					window.location.href,
				);
			} else {
				// Already at terminal, prevent leaving the app
				window.history.pushState(
					{ view: "terminal" },
					"",
					window.location.href,
				);
			}
		};

		window.addEventListener("popstate", handlePopState);
		return () => window.removeEventListener("popstate", handlePopState);
	}, [
		showSessionList,
		fileViewerVisible,
		activeFileViewerDir,
		closeFileViewer,
		showConversation,
	]);

	// Push history state when opening overlays
	useEffect(() => {
		if (showSessionList || fileViewerVisible || showConversation) {
			window.history.pushState({ view: "overlay" }, "", window.location.href);
		}
	}, [showSessionList, fileViewerVisible, showConversation]);

	// Create initial session for first-time users
	// A fresh instance on every render would re-run fetchAndOpenSession's useEffect
	// forever and keep rewinding activeSessionId from localStorage. useCallback
	// stabilizes it, and t is reached through a ref.
	const createInitialSession = useCallback(async (): Promise<OpenSession | null> => {
		try {
			const response = await authFetch(`${API_BASE}/api/workspaces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "Welcome",
					workingDir: "~",
					initialPrompt: tRef.current("onboarding.welcomePrompt"),
				}),
			});
			if (response.ok) {
				const session: ExtendedSessionResponse = await response.json();
				return apiToOpenSession(session);
			}
		} catch (err) {
			console.error("Failed to create initial session:", err);
		}
		return null;
	}, []);

	// Retry handler for loading screen
	const handleRetry = useCallback(() => {
		setLoadError(null);
		setIsLoading(true);
		setRetryCount((c) => c + 1);
	}, []);

	// On mount (and retry), fetch sessions and restore from localStorage
	useEffect(() => {
		const fetchAndOpenSession = async () => {
			setLoadError(null);
			try {
				// Fetch all sessions (including external)
				const sessionsRes = await authFetch(`${API_BASE}/api/workspaces`);
				const allSessions: ExtendedSessionResponse[] = sessionsRes.ok
					? (await sessionsRes.json()).sessions
					: [];

				// Try to restore previously open sessions. The initial fetch only
				// covers the local Hub, so remote-peer keys stay unresolved here —
				// same as before, they reappear once their peer's watcher hydrates.
				const savedSessionKeys = getSavedOpenSessionKeys();
				const lastSessionKey = getLastSessionKey();

				const sessionsToOpen = savedSessionKeys
					.map((key) => {
						const target = parseSessionKey(key);
						return allSessions.find(
							(s) =>
								s.id === target.id &&
								isSameNotificationPeer(s.peerId, target.peerId),
						);
					})
					.filter((s): s is ExtendedSessionResponse => !!s)
					.map(apiToOpenSession);

				if (sessionsToOpen.length > 0) {
					if (!notificationNavigationHandledRef.current) {
						setOpenSessions(sessionsToOpen);
					}
					const validKeys = sessionsToOpen.map((s) => sessionKeyOf(s));
					const activeKey =
						lastSessionKey && validKeys.includes(lastSessionKey)
							? lastSessionKey
							: validKeys[0];
					if (!notificationNavigationHandledRef.current) {
						setActiveSessionKey(activeKey);
					}
				} else if (allSessions.length > 0) {
					const mostRecent = apiToOpenSession(allSessions[0]);
					if (!notificationNavigationHandledRef.current) {
						setOpenSessions([mostRecent]);
						setActiveSessionKey(sessionKeyOf(mostRecent));
					}
				} else {
					if (notificationNavigationHandledRef.current) return;
					const initialSession = await createInitialSession();
					if (initialSession) {
						if (!notificationNavigationHandledRef.current) {
							setOpenSessions([initialSession]);
							setActiveSessionKey(sessionKeyOf(initialSession));
						}
					} else {
						setShowSessionList(true);
					}
				}
			} catch (err) {
				if (isTransientNetworkError(err)) {
					setLoadError(tRef.current("loading.connectionFailed"));
				} else {
					setShowSessionList(true);
				}
			} finally {
				setIsLoading(false);
			}
		};

		fetchAndOpenSession();
		// `t` (useTranslation) can change identity while i18n hydrates. If that
		// re-runs fetchAndOpenSession it reads localStorage from before
		// saveLastSession() and activeSessionId rewinds. So t is reached through a
		// ref and kept out of these deps.
	}, [createInitialSession, retryCount]);

	// Save to localStorage when sessions change
	useEffect(() => {
		if (openSessions.length > 0) {
			saveOpenSessions(openSessions);
		}
	}, [openSessions]);

	// Save active session to localStorage (only when not loading)
	useEffect(() => {
		// Don't save null during initial load - it would overwrite the saved session
		if (!isLoading && activeSessionKey !== null) {
			saveLastSessionKey(activeSessionKey);
		}
	}, [activeSessionKey, isLoading]);

	const handleSelectSession = useCallback(
		async (session: ExtendedSessionResponse) => {
			// Lost session: resume with the original agent's resume command when we have
			// a conversation id (Claude → ccSessionId, thread agents → agentSessionId),
			// otherwise recreate a fresh session preserving the original agent.
			if (session.state === "lost") {
				try {
					let newSessionId: string;
					let newSessionName: string;
					const conversationId = threadAgentOf(session.agent)
						? session.agentSessionId
						: session.ccSessionId;
					if (conversationId && session.currentPath) {
						const response = await authFetch(
							`${API_BASE}/api/sessions/history/resume`,
							{
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({
									sessionId: conversationId,
									projectPath: session.currentPath,
									agent: session.agent,
								}),
							},
						);
						if (!response.ok) {
							throw new Error("Failed to resume session");
						}
						const data = await response.json();
						newSessionId = data.tmuxSessionId;
						newSessionName = data.tmuxSessionId;
					} else {
						// No conversation id: fall back to a fresh session in the same agent.
						const newSession = await createSession(
							session.name,
							session.currentPath,
							session.agent,
						);
						if (!newSession) return;
						newSessionId = newSession.id;
						newSessionName = newSession.name;
					}
					setOpenSessions((prev) => [
						...prev,
						{
							id: newSessionId,
							name: newSessionName,
							state: "working" as const,
							currentPath: session.currentPath,
							ccSessionId: session.ccSessionId,
							agent: session.agent,
							agentSessionId: session.agentSessionId,
							theme: session.theme,
						},
					]);
					// Resume always lands on the local Hub.
					setActiveSessionKey(makeSessionKey(newSessionId));
					if (session.currentPath) setActiveFileViewerDir(session.currentPath);
					setShowSessionList(false);
				} catch (err) {
					console.error("Failed to resume lost session:", err);
				}
				return;
			}

			// Check if already open. Everything is keyed by (peerId, id), so a
			// same-name session on another peer is a distinct entry and both can
			// stay open at once.
			const key = sessionKeyOf(session);
			if (!openSessions.some((s) => sessionKeyOf(s) === key)) {
				setOpenSessions((prev) => [...prev, apiToOpenSession(session)]);
			}
			setActiveSessionKey(key);
			// Update FileViewer active dir to follow session
			if (session.currentPath) {
				setActiveFileViewerDir(session.currentPath);
			}
			setShowSessionList(false);
			setMobileActivePaneId(null);
		},
		[openSessions],
	);

	// Select a specific pane within a session (mobile)
	const handleSelectPane = useCallback(
		(session: ExtendedSessionResponse, paneId: string) => {
			// Open session without resetting paneId (handleSelectSession sets it to null)
			const key = sessionKeyOf(session);
			if (!openSessions.some((s) => sessionKeyOf(s) === key)) {
				setOpenSessions((prev) => [...prev, apiToOpenSession(session)]);
			}
			setActiveSessionKey(key);
			setShowSessionList(false);
			// Set pane directly - don't go through handleSelectSession which resets it
			setMobileActivePaneId(paneId);
		},
		[openSessions],
	);

	const handleCloseSession = useCallback(
		(sessionKey: string) => {
			setOpenSessions((prev) => {
				const filtered = prev.filter((s) => sessionKeyOf(s) !== sessionKey);

				// If closing the active session, switch to another
				if (sessionKey === activeSessionKey) {
					if (filtered.length > 0) {
						setActiveSessionKey(sessionKeyOf(filtered[filtered.length - 1]));
					} else {
						setActiveSessionKey(null);
						setShowSessionList(true);
					}
				}

				return filtered;
			});
			// Clean up per-session conversation mode entry
			setConversationModeSessions((prev) => {
				if (!prev.has(sessionKey)) return prev;
				const next = new Set(prev);
				next.delete(sessionKey);
				return next;
			});
		},
		[activeSessionKey],
	);

	// Actually delete the session
	const handleConfirmDelete = useCallback(async () => {
		if (!sessionToDelete) return;

		try {
			const response = await authFetch(
				`${API_BASE}/api/workspaces/${sessionToDelete.id}`,
				{
					method: "DELETE",
				},
			);

			if (response.ok) {
				// Close the tab first
				handleCloseSession(sessionKeyOf(sessionToDelete));
			}
		} catch (err) {
			console.error("Failed to delete session:", err);
		} finally {
			setSessionToDelete(null);
		}
	}, [sessionToDelete, handleCloseSession]);

	const handleCancelDelete = useCallback(() => {
		setSessionToDelete(null);
	}, []);

	const handleShowSessionList = useCallback(() => {
		setShowSessionList(true);
	}, []);

	const handleBackFromList = useCallback(() => {
		if (openSessions.length > 0) {
			setShowSessionList(false);
		}
	}, [openSessions.length]);

	// Update session state (called from terminal, keyed by composite key)
	const updateSessionState = useCallback(
		(sessionKey: string, state: SessionState) => {
			setOpenSessions((prev) =>
				prev.map((s) => (sessionKeyOf(s) === sessionKey ? { ...s, state } : s)),
			);
		},
		[],
	);

	// Refresh current terminal display (must be before early returns)
	const handleReload = useCallback(() => {
		if (mobileTerminalRef.current?.refreshTerminal) {
			mobileTerminalRef.current.refreshTerminal();
		}
	}, []);

	// Show conversation history for current session
	const handleShowConversation = useCallback(() => {
		const activeSession = openSessions.find(
			(s) => sessionKeyOf(s) === activeSessionKey,
		);
		const activePane =
			activeSession?.panes?.find(
				(p) => mobileActivePaneId && p.paneId === mobileActivePaneId,
			) ??
			activeSession?.panes?.find((p) => p.isActive) ??
			soleVisiblePane(activeSession);
		if (!activePane?.agent || !activePane.agentSessionId) return;
		setShowConversation(true);
	}, [openSessions, activeSessionKey, mobileActivePaneId]);

	// Keep overlay visible (no auto-hide)
	const startOverlayTimer = useCallback(() => {
		// Disabled: keep overlay always visible
		if (overlayTimeoutRef.current) {
			clearTimeout(overlayTimeoutRef.current);
			overlayTimeoutRef.current = null;
		}
	}, []);

	// Show overlay and restart timer
	const handleShowOverlay = useCallback(() => {
		setShowOverlay(true);
		startOverlayTimer();
	}, [startOverlayTimer]);

	// Start timer when overlay is shown
	useEffect(() => {
		if (showOverlay && !showSessionList && !isLoading) {
			startOverlayTimer();
		}
		return () => {
			if (overlayTimeoutRef.current) {
				clearTimeout(overlayTimeoutRef.current);
			}
		};
	}, [showOverlay, showSessionList, isLoading, startOverlayTimer]);

	// Receive notification navigation from either a deep link (new window) or
	// Service Worker / Notification click event (existing window, no reload).
	useEffect(() => {
		const handleNotificationNavigation = (event: Event) => {
			const detail = (event as CustomEvent<NotificationTarget>).detail;
			if (detail && typeof detail.sessionId === "string") {
				setPendingNotificationTarget(detail);
			}
		};
		window.addEventListener(
			NOTIFICATION_NAVIGATION_EVENT,
			handleNotificationNavigation,
		);

		const deepLinkTarget = parseNotificationTarget(window.location.search);
		if (deepLinkTarget) {
			setPendingNotificationTarget(deepLinkTarget);
			const url = new URL(window.location.href);
			url.searchParams.delete("notify-session");
			url.searchParams.delete("notify-peer");
			window.history.replaceState(
				{},
				"",
				`${url.pathname}${url.search}${url.hash}`,
			);
		}

		return () => {
			window.removeEventListener(
				NOTIFICATION_NAVIGATION_EVENT,
				handleNotificationNavigation,
			);
		};
	}, []);

	// Give session watchers time to deliver a newly-created target, but do not
	// retain an unresolved click indefinitely.
	useEffect(() => {
		if (!pendingNotificationTarget) return;
		const target = pendingNotificationTarget;
		const timer = window.setTimeout(() => {
			setPendingNotificationTarget((current) =>
				current === target ? null : current,
			);
		}, 15_000);
		return () => window.clearTimeout(timer);
	}, [pendingNotificationTarget]);

	// Resolve against the full live API list first so notifications can open a
	// session that this device has never opened before. openSessions remains a
	// fallback while the watcher is still hydrating.
	useEffect(() => {
		if (!pendingNotificationTarget) return;
		const match = findNotificationSession(
			[...apiSessions, ...openSessions],
			pendingNotificationTarget,
		);
		if (!match) return;

		const apiMatch = apiSessions.find(
			(session) =>
				session.id === match.id &&
				isSameNotificationPeer(session.peerId, match.peerId),
		);
		const openMatch = apiMatch ? apiToOpenSession(apiMatch) : (match as OpenSession);
		const openMatchKey = sessionKeyOf(openMatch);
		notificationNavigationHandledRef.current = true;
		setOpenSessions((previous) =>
			previous.some((session) => sessionKeyOf(session) === openMatchKey)
				? previous
				: [...previous, openMatch],
		);
		setPendingNotificationTarget(null);
		setActiveSessionKey(openMatchKey);
		setDesktopSessionSwitchRequest({
			sessionKey: openMatchKey,
			requestId: ++notificationRequestIdRef.current,
		});
		setShowSessionList(false);
		setMobileActivePaneId(null);
	}, [apiSessions, openSessions, pendingNotificationTarget]);

	// Diagnostic: log render state for debugging black screen issues
	useEffect(() => {
		console.log(
			`[App] Render state: device=${deviceType} authLoading=${auth.isLoading} loading=${isLoading} authRequired=${auth.authRequired} authenticated=${auth.isAuthenticated} sessions=${openSessions.length} active=${activeSessionKey} showList=${showSessionList}`,
		);
	}, [
		deviceType,
		auth.isLoading,
		isLoading,
		auth.authRequired,
		auth.isAuthenticated,
		openSessions.length,
		activeSessionKey,
		showSessionList,
	]);

	// Show loading (including auth check)
	if (auth.isLoading || isLoading) {
		return (
			<LoadingScreen
				phase={auth.isLoading ? "auth" : "sessions"}
				error={loadError}
				onRetry={handleRetry}
			/>
		);
	}

	// Show login form if auth required but not authenticated
	if (auth.authRequired && !auth.isAuthenticated) {
		return (
			<LoginForm
				onLogin={auth.login}
				isLoading={auth.isLoading}
				error={auth.error}
			/>
		);
	}

	// Show session list (mobile overlay - no early return to keep FileViewer mounted)
	const sessionListOverlay = showSessionList ? (
		<div className="fixed inset-0 z-[60]">
			<WorkspaceList
				onSelectSession={handleSelectSession}
				onSelectPane={handleSelectPane}
				onBack={openSessions.length > 0 ? handleBackFromList : undefined}
				isOnboarding={showSessionListOnboarding}
				onToggleDashboard={() => setShowMobileDashboard((v) => !v)}
				dashboardOpen={showMobileDashboard}
			/>
			{showSessionListOnboarding && (
				<Onboarding
					type="sessionList"
					onComplete={completeSessionListOnboarding}
				/>
			)}
		</div>
	) : null;

	// Desktop layout: split-pane layout for a PC
	if (deviceType === "desktop") {
		return (
			<>
				<DesktopLayout
					sessions={openSessions}
					activeSessionKey={activeSessionKey}
					sessionSwitchRequest={desktopSessionSwitchRequest}
					onSessionStateChange={updateSessionState}
				/>
				{showOnboarding && <Onboarding onComplete={completeOnboarding} />}
			</>
		);
	}

	// Tablet layout: use DesktopLayout with floating keyboard
	if (deviceType === "tablet") {
		return (
			<>
				<DesktopLayout
					sessions={openSessions}
					activeSessionKey={activeSessionKey}
					sessionSwitchRequest={desktopSessionSwitchRequest}
					onSessionStateChange={updateSessionState}
					isTablet={true}
					keyboardControlRef={keyboardControlRef}
				/>
				{showOnboarding && (
					<Onboarding
						onComplete={completeOnboarding}
						onStepAction={onboardingStepAction}
					/>
				)}
			</>
		);
	}

	// Get current active session
	const activeSession = openSessions.find(
		(s) => sessionKeyOf(s) === activeSessionKey,
	);
	const activeConversationPane =
		activeSession?.panes?.find(
			(p) => mobileActivePaneId && p.paneId === mobileActivePaneId,
		) ??
		activeSession?.panes?.find((p) => p.isActive) ??
		soleVisiblePane(activeSession);
	const conversationAvailable = !!(
		activeConversationPane?.agent && activeConversationPane.agentSessionId
	);

	// Overlay bar content (shared between positions)
	const overlayBar = (
		<div
			className={`flex items-center gap-2 px-3 py-1.5 bg-[#0a0a0a] border-b border-white/[0.06] transition-opacity duration-300 ${
				showOverlay ? "opacity-100" : "opacity-0 pointer-events-none"
			}`}
		>
			{/* Left: Session selector. Takes the bar's free space so the name gets
			    every pixel the action buttons don't need — a fixed cap truncated
			    names like storageKey("work-1") while the bar sat half empty. The action
			    group is shrink-0, so this only ever grows into real slack. */}
			<button
				type="button"
				onClick={() => handleShowSessionList()}
				className="flex flex-1 min-w-0 min-h-10 items-center gap-1.5 px-2 py-1 rounded-md hover:bg-white/[0.06] transition-colors"
				data-onboarding="session-list"
			>
				<div
					className={`w-2 h-2 rounded-full shrink-0 ${
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
				<span className="text-[13px] font-medium text-white truncate min-w-0">
					{activeSession?.name || "-"}
				</span>
				<ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
			</button>

			{/* Right: Core actions, from the shared definition */}
			<SessionActionBar
				variant="mobile"
				handlers={{
					chat: {
						hidden: !conversationAvailable,
						active: showConversation,
						onSelect: () =>
							showConversation
								? setShowConversation(false)
								: handleShowConversation(),
					},
					"claude-app": {
						hidden: !activeSession?.bridgeSessionId,
						onSelect: () => {
							const id = activeSession?.bridgeSessionId;
							if (id) openClaudeAppSession(id);
						},
					},
					files: {
						onSelect: () => {
							// The composite key itself carries the owning peer - no session
							// lookup needed even while openSessions is still hydrating.
							const peerId =
								activeSession?.peerId ??
								(activeSessionKey
									? parseSessionKey(activeSessionKey).peerId
									: undefined);
							openFileViewer(activeSession?.currentPath || "/", peerId);
						},
					},
					dashboard: { onSelect: () => setShowMobileDashboard(true) },
					reload: { onSelect: handleReload },
				}}
			/>
		</div>
	);

	// Mobile: Show terminal with overlay (position depends on keyboard state)
	return (
		<div className="h-full flex flex-col bg-th-bg relative" data-layout="mobile">
			{/* Terminal - full screen */}
			{activeSession ? (
				<div
					className="flex-1 flex flex-col min-h-0"
					data-onboarding="terminal"
				>
					{(() => {
						// Use the session-level Claude indicator (set by hook events / jsonl).
						// `state === 'working'` is unreliable here — it just means the herdr
						// workspace is focused, so it would always be true once connected.
						const indicator = activeSession.indicatorState;
						const isProcessing = indicator === "processing";
						const isWaitingInput = indicator === "waiting_input";
						// Always-mounted chat overlay (visibility controlled via mainOverlayVisible).
						// Keeping ChatView mounted preserves the conversation subscription so
						// messages are pre-loaded by the time the user toggles to chat mode —
						// avoiding the black/loading flash on every open.
						const chatOverlay = conversationAvailable ? (
							<div className="h-full flex flex-col bg-cv-bg">
								<div
									className="flex items-center gap-2 px-3 py-2 border-b border-cv-border shrink-0"
									style={{
										paddingTop: "max(env(safe-area-inset-top, 0px), 8px)",
									}}
								>
									<button
										type="button"
										onClick={() => setShowConversation(false)}
										className="p-1.5 text-cv-text-muted hover:text-cv-text shrink-0"
										title="Switch to terminal"
										aria-label="Switch to Terminal"
									>
										<TerminalIcon className="w-5 h-5" />
									</button>
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-2">
											<h2 className="text-[13px] font-medium text-cv-text truncate">
												{activeSession.name || "Conversation"}
											</h2>
											{isProcessing && (
												<span className="inline-flex items-center gap-1 text-[10px] text-cv-accent bg-cv-surface px-1.5 py-0.5 rounded shrink-0">
													<span className="inline-block w-2 h-2 border border-cv-accent border-t-transparent rounded-full animate-spin" />
													Working
												</span>
											)}
											{!isProcessing && isWaitingInput && (
												<span className="inline-flex items-center gap-1 text-[10px] text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded shrink-0">
													Waiting for input
												</span>
											)}
										</div>
										<p className="text-[11px] text-cv-text-muted truncate">
											{activeSession.currentPath?.replace(
												/^\/home\/[^/]+\//,
												"~/",
											) || ""}
										</p>
									</div>
								</div>
								<div className="flex-1 min-h-0">
									<ChatView
										sessionId={activeSession.id}
										title={activeSession.name}
										subtitle={activeSession.currentPath?.replace(
											/^\/home\/[^/]+\//,
											"~/",
										)}
										inline
										enabled
										agent={activeConversationPane?.agent}
										agentSessionId={activeConversationPane?.agentSessionId}
									/>
								</div>
							</div>
						) : null;
						return (
							<TerminalPage
								ref={mobileTerminalRef}
								key={`${activeSession.peerId ?? "local"}:${activeSession.id}:${activeSession.instanceId ?? "legacy"}`}
								sessionId={activeSession.id}
								sessionInstanceId={activeSession.instanceId}
								peerId={activeSession.peerId ?? LOCAL_PEER_ID}
								onStateChange={(state) =>
									updateSessionState(sessionKeyOf(activeSession), state)
								}
								overlayContent={overlayBar}
								onOverlayTap={handleShowOverlay}
								showOverlay={showOverlay}
								theme={activeSession.theme}
								onPanesChange={(panes) => {
									setMobilePanes(panes);
									if (
										mobileActivePaneId &&
										!panes.some((p) => p.paneId === mobileActivePaneId)
									) {
										setMobileActivePaneId(null);
									}
								}}
								onActivePaneChange={(paneId) => {
									// Keep the tab-bar selection in sync with the pane the
									// TerminalPage actually shows (e.g. server-restored zoom on a
									// non-first pane after reload).
									setMobileActivePaneId((prev) =>
										prev === paneId ? prev : paneId,
									);
								}}
								externalActivePaneId={mobileActivePaneId}
								mainOverlay={chatOverlay}
								mainOverlayVisible={showConversation}
							/>
						);
					})()}
					{/* Pane tab bar - only shown when multiple panes exist */}
					{mobilePanes.length > 1 &&
						(() => {
							// Get pane command info from API sessions data (same peer —
							// ids can collide across peers)
							const apiSession = apiSessions.find(
								(s) => sessionKeyOf(s) === activeSessionKey,
							);
							const apiPanes = apiSession?.panes;
							// Agent color to Tailwind text class
							const agentColorClass: Record<string, string> = {
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
							return (
								<div className="flex bg-th-surface border-t border-th-border shrink-0 overflow-x-auto">
									{mobilePanes.map((pane) => {
										const isActive = mobileActivePaneId
											? pane.paneId === mobileActivePaneId
											: pane.paneId === mobilePanes[0]?.paneId;
										const apiPane = apiPanes?.find(
											(p) => p.paneId === pane.paneId,
										);
										// Priority: agentName > command > paneId
										const label =
											apiPane?.agentName ||
											apiPane?.currentCommand ||
											pane.paneId;
										const colorCls =
											apiPane?.agentColor &&
											agentColorClass[apiPane.agentColor];
										return (
											<button
												type="button"
												key={pane.paneId}
												onClick={() => setMobileActivePaneId(pane.paneId)}
												className={`px-3 py-1.5 text-xs font-mono whitespace-nowrap transition-colors ${
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
							);
						})()}
				</div>
			) : (
				<div
					className="flex-1 flex flex-col items-center justify-center"
					data-onboarding="terminal"
				>
					<p className="text-th-text-muted">{t("pane.selectSession")}</p>
					<button
						type="button"
						onClick={handleShowSessionList}
						className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-th-text rounded transition-colors"
						data-onboarding="session-list"
					>
						{t("session.list")}
					</button>
				</div>
			)}

			{/* Delete confirmation dialog */}
			{sessionToDelete && (
				<ConfirmDeleteDialog
					sessionName={sessionToDelete.name}
					onConfirm={handleConfirmDelete}
					onCancel={handleCancelDelete}
				/>
			)}

			{/* Mobile Dashboard Overlay.
			    z-[70] so it also covers the workspace list overlay (z-[60]) — the
			    list header now has its own dashboard button, and closing the
			    dashboard drops the user back onto the list. */}
			{showMobileDashboard && (
				<div className="fixed inset-0 z-[70] flex flex-col bg-[#0a0a0a] animate-modal-in">
					<div className="shrink-0 px-4 pt-3 pb-3 border-b border-white/[0.06]">
						<div className="flex items-center justify-between gap-2">
							<div className="flex items-center gap-1 bg-white/[0.04] rounded-lg p-0.5">
								<button
									type="button"
									onClick={() => setMobileDashboardTab("dashboard")}
									className={`px-3 py-1.5 rounded-md text-sm font-medium inline-flex items-center gap-1.5 transition-colors ${
										mobileDashboardTab === "dashboard"
											? "bg-white/[0.08] text-white"
											: "text-zinc-400 hover:text-zinc-200"
									}`}
								>
									<BarChart3 className="w-4 h-4" />
									Dashboard
								</button>
								<button
									type="button"
									onClick={() => setMobileDashboardTab("peers")}
									className={`px-3 py-1.5 rounded-md text-sm font-medium inline-flex items-center gap-1.5 transition-colors ${
										mobileDashboardTab === "peers"
											? "bg-white/[0.08] text-white"
											: "text-zinc-400 hover:text-zinc-200"
									}`}
								>
									<Server className="w-4 h-4" />
									Servers
								</button>
							</div>
							<button
								type="button"
								onClick={() => setShowMobileDashboard(false)}
								className="p-2 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
							>
								<XIcon className="w-5 h-5" />
							</button>
						</div>
					</div>
					{/* Dashboard brings its own scroller; nesting a second one here made
					    a flick land on whichever the finger happened to be over. */}
					<div className="flex-1 min-h-0 flex flex-col">
						{mobileDashboardTab === "dashboard" ? (
							<Dashboard className="flex-1 min-h-0" />
						) : (
							<div className="flex-1 min-h-0 overflow-y-auto">
								<PeerManager />
							</div>
						)}
					</div>
				</div>
			)}

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
						showSessionList
					}
					onCopyPrompt={(text) => {
						mobileTerminalRef.current?.setInputText(text);
						closeFileViewer(dir);
					}}
					onShowSessions={() => {
						setShowSessionList(true);
					}}
					sessionName={activeSession?.name}
					sessionStatus={activeSession?.state}
					onShowConversation={
						conversationAvailable ? handleShowConversation : undefined
					}
					onShowDashboard={() => setShowMobileDashboard(true)}
				/>
			))}

			{/* Session List Overlay */}
			{sessionListOverlay}

			{/* (Conversation overlay is rendered inside TerminalPage as mainOverlay
          so it replaces the xterm area while keeping the InputBar visible.) */}

			{/* Onboarding overlay */}
			{showOnboarding && (
				<Onboarding
					onComplete={completeOnboarding}
					onStepAction={onboardingStepAction}
				/>
			)}
		</div>
	);
}
