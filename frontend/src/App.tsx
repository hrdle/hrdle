/** biome-ignore-all lint/correctness/useExhaustiveDependencies: depends on refs and setters that React guarantees stable; adding them would cause unintended re-runs */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type AgentProvider,
	type ExtendedSessionResponse,
	type IndicatorState,
	type PaneInfo,
	type SessionState,
	type SessionTheme,
	threadAgentOf,
} from "../../shared/types";
import { MobileDashboard } from "./components/dashboard/MobileDashboard";
import { StewardView } from "./components/steward/StewardView";
import { useStewardEnabled } from "./hooks/useSteward";
import { DesktopLayout } from "./components/DesktopLayout";
import { LoginForm } from "./components/LoginForm";
import { Onboarding, useOnboarding } from "./components/Onboarding";
import { WorkspaceList } from "./components/WorkspaceList";
import {
	makeSessionKey,
	parseSessionKey,
	sessionKeyOf,
} from "./utils/sessionKey";
import { useAuth } from "./hooks/useAuth";
import { useWorkspaces } from "./hooks/useWorkspaces";
import { ServerUnreachableHint } from "./components/ServerUnreachable";
import { authFetch, isTransientNetworkError } from "./services/api";
import {
	findNotificationSession,
	isSameNotificationPeer,
	NOTIFICATION_NAVIGATION_EVENT,
	parseNotificationTarget,
	type NotificationTarget,
} from "./utils/notificationNavigation";
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
	/** The tool call the agent is on, while it is on one. */
	activity?: { tool: string; target?: string };
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
		activity: s.activity,
		peerId: s.peerId,
	};
}

const API_BASE = import.meta.env.VITE_API_URL || "";

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

	// Keyboard control for onboarding. The layout registers it - a tablet's is
	// FloatingKeyboard, a phone's is the InputBar inside the pane - so which one
	// gets opened is not a question the app has to answer.
	const keyboardControlRef = useRef<{
		open: () => void;
		close: () => void;
	} | null>(null);
	const keyboardOpenedByOnboarding = useRef(false);

	const handleKeyboardStepAction = useCallback((action: string) => {
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
	// The dashboard reached from the session list's own header. The one the
	// session bar opens belongs to the layout.
	const [listDashboardOpen, setListDashboardOpen] = useState(false);
	const [stewardOpen, setStewardOpen] = useState(false);
	// A server setting, so it is asked once - a mode that appears while someone
	// is looking at the screen is worse than one that waits for a reload.
	const stewardEnabled = useStewardEnabled();

	// The session list can name a pane, not just a workspace. The layout owns
	// which pane is in front, so this is a request rather than a value.
	const [paneFocusRequest, setPaneFocusRequest] = useState<{
		paneId: string;
		requestId: number;
	} | null>(null);
	const paneFocusRequestIdRef = useRef(0);

	// Session API state (for theme updates in mobile view)
	const { sessions: apiSessions, createSession } = useWorkspaces();

	const [deviceType, setDeviceType] = useState<DeviceType>(checkDeviceType);

	// Both tablet and mobile need keyboard control during onboarding
	const onboardingStepAction =
		deviceType === "desktop" ? undefined : handleKeyboardStepAction;

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
					activity: apiSession.activity,
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
			setShowSessionList(false);
		},
		[openSessions],
	);

	// Select a specific pane within a session
	const handleSelectPane = useCallback(
		(session: ExtendedSessionResponse, paneId: string) => {
			const key = sessionKeyOf(session);
			if (!openSessions.some((s) => sessionKeyOf(s) === key)) {
				setOpenSessions((prev) => [...prev, apiToOpenSession(session)]);
			}
			setActiveSessionKey(key);
			setShowSessionList(false);
			setPaneFocusRequest({
				paneId,
				requestId: ++paneFocusRequestIdRef.current,
			});
		},
		[openSessions],
	);

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

	// Show session list (a screen of its own on a phone - no early return, so the
	// file browser underneath stays mounted)
	const sessionListOverlay =
		deviceType === "mobile" && showSessionList ? (
			<div className="fixed inset-0 z-[60]">
				<WorkspaceList
					fullScreen
					onSelectSession={handleSelectSession}
					onSelectPane={handleSelectPane}
					onBack={openSessions.length > 0 ? handleBackFromList : undefined}
					isOnboarding={showSessionListOnboarding}
					onToggleDashboard={() => setListDashboardOpen((v) => !v)}
					dashboardOpen={listDashboardOpen}
					onToggleSteward={
						stewardEnabled ? () => setStewardOpen((v) => !v) : undefined
					}
					stewardOpen={stewardOpen}
				/>
				{listDashboardOpen && (
					<MobileDashboard onClose={() => setListDashboardOpen(false)} />
				)}
				{stewardOpen && <StewardView onClose={() => setStewardOpen(false)} />}
				{showSessionListOnboarding && (
					<Onboarding
						type="sessionList"
						onComplete={completeSessionListOnboarding}
					/>
				)}
			</div>
		) : null;

	// One layout for all three screens. What differs between a phone, a tablet
	// and a PC is `variant`; the app above it only says which sessions are open
	// and which one is in front.
	return (
		<>
			<DesktopLayout
				sessions={openSessions}
				activeSessionKey={activeSessionKey}
				sessionSwitchRequest={desktopSessionSwitchRequest}
				onSessionStateChange={updateSessionState}
				variant={deviceType}
				keyboardControlRef={keyboardControlRef}
				onShowSessionList={handleShowSessionList}
				onCloseSessionList={handleBackFromList}
				sessionListOpen={showSessionList}
				paneFocusRequest={paneFocusRequest}
			/>

			{sessionListOverlay}

			{showOnboarding && (
				<Onboarding
					onComplete={completeOnboarding}
					onStepAction={onboardingStepAction}
				/>
			)}
		</>
	);
}
