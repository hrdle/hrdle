/** biome-ignore-all lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: legacy click-on-div UI; keyboard navigation provided via main shortcuts */
import { closestCenter, DndContext, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { BarChart3, ChevronLeft, LayoutGrid, Plus, Rows3, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type AgentProvider, type ConversationMessage, DEFAULT_AGENT_PROVIDER, type ExtendedSessionResponse, LOCAL_PEER_ID, type SessionResponse, type SessionTheme, threadAgentOf } from "../../../shared/types";
import { usePeers, useServerReachable } from "../hooks/usePeers";
import { ServerUnreachableBanner, ServerUnreachableNotice } from "./ServerUnreachable";
import { applyLocalSessionReorder, useWorkspaces } from "../hooks/useWorkspaces";
import { sessionFetch } from "../services/peer-fetch";

import { useHistoryV2Flag } from "../hooks/useHistoryV2Flag";
import { useSessionHistory } from "../hooks/useSessionHistory";
import { authFetch } from "../services/api";
import { ConversationViewer } from "./ConversationViewer";
import { SessionHistory } from "./SessionHistory";
import { SessionHistoryV2 } from "./history/SessionHistoryV2";
import { HOOK_COMMAND } from "../../../shared/identity";
import { storageKey } from "../utils/app-storage";
import { WorkspaceBoard } from "./WorkspaceBoard";
import { CreateSessionModal } from "./workspace-list/CreateSessionModal";
import {
	AGENT_FAILURE_KEYS,
	SortableSessionItem,
	sessionCompositeKey,
} from "./workspace-list/SessionItem";
import { SessionMenuDialog } from "./workspace-list/SessionMenuDialog";

const API_BASE = import.meta.env.VITE_API_URL || "";

interface SessionListProps {
	onSelectSession: (session: ExtendedSessionResponse) => void;
	onSelectPane?: (session: ExtendedSessionResponse, paneId: string) => void;
	onBack?: () => void;
	onClose?: () => void; // Close button in header (used in modal)
	contentScale?: number; // Scale factor for content (tabs remain fixed)
	isOnboarding?: boolean; // Show dummy session for onboarding
	onToggleDashboard?: () => void; // Show a dashboard toggle in the header when provided
	dashboardOpen?: boolean; // Active state for the dashboard toggle button
	// Whether this list is the whole screen. It is what decides the bottom
	// room: the browser toolbar overlaps the viewport itself, so a list ending
	// at the bottom edge loses its last row. Inside the desktop picker the
	// list ends at the modal's edge, which nothing overlaps.
	fullScreen?: boolean;
}

export function WorkspaceList({
	onSelectSession,
	onSelectPane,
	onBack,
	onClose,
	contentScale,
	isOnboarding = false,
	onToggleDashboard,
	dashboardOpen = false,
	fullScreen = false,
}: SessionListProps) {
	const { t } = useTranslation();
	const {
		sessions,
		isLoading,
		error,
		createSession,
		deleteSession,
		updateSessionTheme,
	} = useWorkspaces();
	const { peers, refresh: refreshPeers } = usePeers();
	const serverReachable = useServerReachable();
	const { fetchConversation } = useSessionHistory();

	const [sessionForMenu, setSessionForMenu] = useState<SessionResponse | null>(
		null,
	);
	const [paneToClose, setPaneToClose] = useState<{
		sessionId: string;
		paneId: string;
		name: string;
	} | null>(null);
	const [closePaneError, setClosePaneError] = useState<string | null>(null);
	const [tabToClose, setTabToClose] = useState<{
		sessionId: string;
		tabId: string;
		label: string;
	} | null>(null);
	const [showCreateModal, setShowCreateModal] = useState(false);
	const [activeTab, setActiveTab] = useState<"sessions" | "history">(
		"sessions",
	);
	const historyV2 = useHistoryV2Flag();
	const [boardView, setBoardView] = useState(
		() =>
			typeof localStorage !== "undefined" &&
			localStorage.getItem(storageKey("workspace-board")) === "1",
	);
	const chooseBoardView = (on: boolean) => {
		setBoardView(on);
		try {
			localStorage.setItem(storageKey("workspace-board"), on ? "1" : "0");
		} catch {
			// private mode: the choice lasts for this page only
		}
	};
	const [showSearch, setShowSearch] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [hookConfigured, setHookConfigured] = useState<boolean | null>(null);
	// Falls back to the bare name until the server answers with a resolved path.
	const [hookCommand, setHookCommand] = useState(HOOK_COMMAND);
	const [hookBannerDismissed, setHookBannerDismissed] = useState(
		() =>
			typeof localStorage !== "undefined" &&
			localStorage.getItem(storageKey("hook-banner-dismissed")) === "1",
	);

	// Conversation viewer state
	const [viewingConversation, setViewingConversation] = useState<{
		sessionId: string;
		title: string;
		subtitle: string;
		isActive: boolean;
		peerId?: string;
	} | null>(null);
	const [conversation, setConversation] = useState<ConversationMessage[]>([]);
	const [loadingConversation, setLoadingConversation] = useState(false);

	// Check hook configuration status. The server also reports the invocation to
	// write (an absolute path when it can resolve one) — a bare `hrdle notify`
	// dies in the hook's non-interactive shell if PATH lacks the install dir.
	useEffect(() => {
		if (hookBannerDismissed) return;
		authFetch(`${API_BASE}/api/notify/hook-status`)
			.then((r) => r.json())
			.then((data) => {
				setHookConfigured(data.configured);
				if (typeof data.command === "string" && data.command) {
					setHookCommand(data.command);
				}
			})
			.catch(() => {});
	}, [hookBannerDismissed]);

	// Resume an agent session, preserving the original agent (claude / codex / ...)
	const handleResume = useCallback(
		async (sessionId: string, ccSessionId?: string) => {
			try {
				const session = sessions.find((s) => s.id === sessionId);
				const isLost = session?.state === "lost";
				// Per-agent conversation id: Claude → ccSessionId, thread agents
				// (codex / grok / ...) → agentSessionId. Pick the one matching the
				// session's agent so we don't accidentally hand a Codex thread id to
				// `claude -r` (or vice versa).
				const conversationId = threadAgentOf(session?.agent)
					? session?.agentSessionId
					: (ccSessionId ?? session?.ccSessionId);

				if (isLost && session?.currentPath) {
					if (conversationId) {
						// Lost session with a known conversation id: resume via history API.
						// Route to the owning peer so a remote peer's lost session is resumed
						// on that peer's Hub, not the local one.
						const response = await sessionFetch(
							session,
							peers,
							`/api/sessions/history/resume`,
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
						if (response.ok) {
							const data = await response.json();
							// Build a session object from the API response + the lost session's metadata
							// so we can navigate immediately, instead of waiting for the WS push and
							// searching `sessions` (which is stale inside this closure).
							onSelectSession({
								id: data.tmuxSessionId,
								name: data.name ?? data.tmuxSessionId,
								createdAt: "",
								lastAccessedAt: "",
								state: "working",
								currentPath: session.currentPath,
								agent: data.agent ?? session.agent,
								theme: session.theme,
								customTitle: session.customTitle,
								peerId: session.peerId,
							});
						}
					} else {
						// Lost session without a conversation id: create a fresh session in the same
						// directory using the original agent so a Codex session doesn't come back as Claude.
						// Pass through the peerId so a remote lost session re-creates on the same peer.
						const newSession = await createSession(
							session.name,
							session.currentPath,
							session.agent,
							session.peerId,
						);
						if (newSession) onSelectSession(newSession);
					}
				} else {
					// Active session: resume the agent in the existing tmux session.
					// Route via the owning peer for the same reason as above.
					const response = await sessionFetch(
						session,
						peers,
						`/api/workspaces/${sessionId}/resume`,
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								ccSessionId: conversationId,
								agent: session?.agent,
							}),
						},
					);
					if (response.ok && session) {
						onSelectSession(session);
					}
				}
			} catch (err) {
				console.error("Failed to resume session:", err);
			}
		},
		[sessions, onSelectSession, createSession, peers],
	);

	// Show conversation for an active session
	const handleShowConversation = useCallback(
		async (
			ccSessionId: string,
			title: string,
			subtitle: string,
			isActive: boolean,
			peerId?: string,
		) => {
			setViewingConversation({
				sessionId: ccSessionId,
				title,
				subtitle,
				isActive,
				peerId,
			});
			setLoadingConversation(true);
			setConversation([]);
			try {
				const messages = await fetchConversation(ccSessionId, undefined, undefined, peerId);
				setConversation(messages);
			} finally {
				setLoadingConversation(false);
			}
		},
		[fetchConversation],
	);

	// Refresh conversation (for auto-refresh)
	const handleRefreshConversation = useCallback(async () => {
		if (!viewingConversation) return;
		try {
			const messages = await fetchConversation(
				viewingConversation.sessionId,
				undefined,
				undefined,
				viewingConversation.peerId,
			);
			setConversation(messages);
		} catch (err) {
			console.error("Failed to refresh conversation:", err);
		}
	}, [viewingConversation, fetchConversation]);

	// Pane operations
	const handlePaneAction = useCallback(
		async (
			sessionId: string,
			action: "focus" | "close" | "split",
			paneId: string,
			direction?: "h" | "v",
		) => {
			try {
				// Peer sessions are merged into the same list (flattenPeerSessions),
				// so the action could target a remote peer's session. Route through
				// sessionFetch so the request reaches the owning Hub/peer with the
				// right token, not always the local Hub origin.
				const session = sessions.find((s) => s.id === sessionId);
				const path =
					action === "split"
						? `/api/workspaces/${sessionId}/panes/split`
						: `/api/workspaces/${sessionId}/panes/${action}`;
				const body = action === "split" ? { paneId, direction } : { paneId };
				const response = await sessionFetch(session, peers, path, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				if (!response.ok) {
					console.error(`Pane ${action} failed: ${response.status}`);
				}
			} catch (err) {
				console.error(`Pane ${action} failed:`, err);
			}
		},
		[sessions, peers],
	);

	// Tab operations mirror handlePaneAction: route over sessionFetch so they
	// reach the owning Hub/peer, and rely on the resulting sessions push (via the
	// backend's notifySessionChange) to reflect the new tab set.
	const handleTabAction = useCallback(
		async (
			sessionId: string,
			action: "select" | "create" | "close",
			tabId?: string,
		) => {
			try {
				const session = sessions.find((s) => s.id === sessionId);
				const path = `/api/workspaces/${sessionId}/tabs/${action}`;
				const body = action === "create" ? {} : { tabId };
				const response = await sessionFetch(session, peers, path, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				if (!response.ok) {
					console.error(`Tab ${action} failed: ${response.status}`);
				}
			} catch (err) {
				console.error(`Tab ${action} failed:`, err);
			}
		},
		[sessions, peers],
	);

	// Drag-to-reorder handler. The order lives in herdr (workspace order) and
	// nowhere else, so a drag writes straight through to the owning peer's
	// herdr and the resulting `sessions-updated` push is what actually reorders
	// the list. A herdr only knows its own machine's workspaces, so the list is
	// grouped by peer and a drag across a peer boundary has nowhere to be
	// stored — ignore it rather than half-applying it.
	const handleDragEnd = useCallback(
		async (event: DragEndEvent) => {
			const { active, over } = event;
			if (!over || active.id === over.id) return;

			const oldIndex = sessions.findIndex(
				(s) => sessionCompositeKey(s) === active.id,
			);
			const newIndex = sessions.findIndex(
				(s) => sessionCompositeKey(s) === over.id,
			);
			if (oldIndex === -1 || newIndex === -1) return;

			const moved = sessions[oldIndex];
			const peerOf = (s: ExtendedSessionResponse) => s.peerId ?? LOCAL_PEER_ID;
			if (peerOf(moved) !== peerOf(sessions[newIndex])) return;

			const reordered = [...sessions];
			reordered.splice(oldIndex, 1);
			reordered.splice(newIndex, 0, moved);

			// herdr indexes within one machine's workspaces, so translate the
			// merged-list position into the target's index among its own peer.
			const targetIndex = reordered
				.filter((s) => peerOf(s) === peerOf(moved))
				.findIndex((s) => sessionCompositeKey(s) === active.id);
			if (targetIndex === -1) return;

			// Optimistic local update so the UI reorders before the round-trip.
			applyLocalSessionReorder(reordered);

			try {
				const res = await sessionFetch(
					moved,
					peers,
					`/api/workspaces/${encodeURIComponent(moved.id)}/move`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ index: targetIndex }),
					},
				);
				if (!res.ok) {
					console.error("Failed to move session:", await res.text());
				}
			} catch (err) {
				console.error("Failed to move session:", err);
			}
		},
		[sessions, peers],
	);

	const [createError, setCreateError] = useState<string | null>(null);
	const [agentFailure, setAgentFailure] = useState<{
		session: ExtendedSessionResponse;
		agent: AgentProvider;
		message: string;
	} | null>(null);

	// Bumped on every submit and on cancel, so an answer that arrives after the
	// modal was closed (the create waits for the agent) does not reopen or
	// navigate anything.
	const createAttemptRef = useRef(0);

	const handleCreateSession = async (
		name: string,
		workingDir?: string,
		agent?: AgentProvider,
		peerId?: string,
	) => {
		const attempt = ++createAttemptRef.current;
		setCreateError(null);
		setAgentFailure(null);
		try {
			const created = await createSession(
				name || undefined,
				workingDir,
				agent,
				peerId,
				true,
			);
			if (attempt !== createAttemptRef.current) return;
			if (created) {
				const { agentName, agentReady, agentError, promptSent, ...session } = created;
				if (agentError) {
					setAgentFailure({
						session,
						agent: agent ?? DEFAULT_AGENT_PROVIDER,
						// herdr's own wording is the useful part of a refused start;
						// the rest are hrdle's codes and read better translated.
						message: AGENT_FAILURE_KEYS.has(agentError.code)
							? t(`session.agentFailure.${agentError.code}`)
							: agentError.message,
					});
					return;
				}
				setShowCreateModal(false);
				onSelectSession(session);
			}
		} catch (err) {
			if (attempt !== createAttemptRef.current) return;
			setCreateError((err as Error).message || t("common.error"));
		}
	};

	const handleMenuDelete = async () => {
		if (sessionForMenu) {
			await deleteSession(
				sessionForMenu.id,
				(sessionForMenu as ExtendedSessionResponse).peerId ?? LOCAL_PEER_ID,
			);
			setSessionForMenu(null);
		}
	};

	const handleMenuChangeTheme = async (theme: SessionTheme | null) => {
		if (sessionForMenu) {
			await updateSessionTheme(
				sessionForMenu.id,
				theme,
				(sessionForMenu as ExtendedSessionResponse).peerId ?? LOCAL_PEER_ID,
			);
			setSessionForMenu(null);
		}
	};

	const handleMenuChangeTitle = async (title: string) => {
		if (sessionForMenu) {
			try {
				await sessionFetch(
					sessionForMenu as ExtendedSessionResponse,
					peers,
					`/api/workspaces/${sessionForMenu.id}/title`,
					{
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ title }),
					},
				);
				setSessionForMenu(null);
			} catch (err) {
				console.error("Failed to update title:", err);
			}
		}
	};

	const handleMenuChangeSttPrompt = async (sttPrompt: string | null) => {
		if (sessionForMenu) {
			try {
				await sessionFetch(
					sessionForMenu as ExtendedSessionResponse,
					peers,
					`/api/workspaces/${sessionForMenu.id}/stt-prompt`,
					{
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ sttPrompt }),
					},
				);
				setSessionForMenu(null);
			} catch (err) {
				console.error("Failed to update STT prompt:", err);
			}
		}
	};

	const handleMenuClose = () => {
		setSessionForMenu(null);
	};

	const handleShowMenu = (session: SessionResponse) => {
		setSessionForMenu(session);
	};

	// Nothing to list and nothing answering: say so, rather than spinning for as
	// long as the VPN is off. The sessions themselves arrive over a WebSocket
	// that has no failure of its own to report, so the peers poll is what knows.
	if (serverReachable === false && sessions.length === 0 && !isOnboarding) {
		return (
			<div
				className="h-full flex items-center justify-center bg-[#0a0a0a]"
			>
				<ServerUnreachableNotice onRetry={() => void refreshPeers()} />
			</div>
		);
	}

	// Don't show loading screen during onboarding (need to show UI elements)
	if (isLoading && sessions.length === 0 && !isOnboarding) {
		return (
			<div
				className="h-full flex items-center justify-center bg-[#0a0a0a]"
			>
				<div className="text-zinc-500">{t("common.loading")}</div>
			</div>
		);
	}

	// Filter sessions by search query
	const filteredSessions = searchQuery
		? sessions.filter((s) => {
				const q = searchQuery.toLowerCase();
				return (
					s.name.toLowerCase().includes(q) ||
					(s.customTitle || "").toLowerCase().includes(q) ||
					(s.currentPath || "").toLowerCase().includes(q) ||
					(s.ccFirstPrompt || "").toLowerCase().includes(q) ||
					(s.ccSummary || "").toLowerCase().includes(q) ||
					(s.ccRecap || "").toLowerCase().includes(q)
				);
			})
		: sessions;

	const isDraggable = !searchQuery; // Disable drag during search

	// One search, drawn either always-open (wide header) or behind the search
	// button (narrow header); both edit the same query.
	const renderSearchInput = (autoFocus: boolean) => (
		<div className="relative">
			<Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
			<input
				// biome-ignore lint/a11y/noAutofocus: only the narrow header's input autofocuses, and it is mounted by the user's own tap on the search button
				autoFocus={autoFocus}
				value={searchQuery}
				onChange={(e) => setSearchQuery(e.target.value)}
				placeholder={`${t("session.title")}...`}
				className="w-full pl-9 pr-8 py-1.5 bg-white/[0.05] border border-white/[0.08] rounded-lg text-[13px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all"
			/>
			{searchQuery && (
				<button
					type="button"
					onClick={() => setSearchQuery("")}
					className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-zinc-500 hover:text-zinc-300"
				>
					<X className="w-3.5 h-3.5" />
				</button>
			)}
		</div>
	);

	return (
		<div className="h-full flex flex-col bg-[#0a0a0a] text-white overflow-hidden">
			{/* ─── Header: frosted glass ─── */}
			{/* The first line holds what means the same on every tab; the second
			    holds the workspace list's own view switch and search, and exists
			    only on that tab. Where the header is wide enough the two lines
			    join into one. That is decided by the header's own width rather
			    than the device, because a dashboard opened beside the list
			    narrows it on a tablet. */}
			<div className="@container shrink-0 px-4 pt-3 pb-2 bg-[#0a0a0a]/80 backdrop-blur-xl border-b border-white/[0.06] sticky top-0 z-10">
				<div className="flex flex-wrap items-center gap-x-1 gap-y-2 mb-2">
					<div className="order-1 flex items-center gap-2 min-w-0">
						{onBack && (
							<button
								type="button"
								onClick={onBack}
								className="p-1.5 -ml-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors shrink-0"
							>
								<ChevronLeft className="w-[18px] h-[18px]" />
							</button>
						)}
						<div className="inline-flex bg-white/[0.04] rounded-lg p-0.5">
							<button
								type="button"
								onClick={() => setActiveTab("sessions")}
								className={`px-3 sm:px-5 py-1.5 text-[13px] font-medium whitespace-nowrap rounded-md transition-all duration-200 ${
									activeTab === "sessions"
										? "bg-white/[0.09] text-white shadow-sm"
										: "text-zinc-500 hover:text-zinc-400"
								}`}
							>
								{t("session.title")}
							</button>
							<button
								type="button"
								onClick={() => setActiveTab("history")}
								className={`px-3 sm:px-5 py-1.5 text-[13px] font-medium whitespace-nowrap rounded-md transition-all duration-200 ${
									activeTab === "history"
										? "bg-white/[0.09] text-white shadow-sm"
										: "text-zinc-500 hover:text-zinc-400"
								}`}
								data-onboarding="history-tab"
							>
								{t("history.title")}
							</button>
						</div>
					</div>

					{activeTab === "sessions" && (
						<>
							<div aria-hidden className="order-3 basis-full h-0 @3xl:hidden" />
							<span
								aria-hidden
								className="hidden @3xl:block order-4 w-px h-5 mx-2 bg-white/[0.1]"
							/>
							<div className="order-4 inline-flex bg-white/[0.04] rounded-lg p-0.5">
								<button
									type="button"
									onClick={() => chooseBoardView(false)}
									aria-pressed={!boardView}
									className={`flex items-center gap-1.5 px-2.5 py-1 text-[12px] font-medium whitespace-nowrap rounded-md transition-all duration-200 ${
										!boardView
											? "bg-white/[0.09] text-white shadow-sm"
											: "text-zinc-500 hover:text-zinc-400"
									}`}
								>
									<LayoutGrid className="w-3.5 h-3.5" />
									{t("board.list")}
								</button>
								<button
									type="button"
									onClick={() => chooseBoardView(true)}
									aria-pressed={boardView}
									className={`flex items-center gap-1.5 px-2.5 py-1 text-[12px] font-medium whitespace-nowrap rounded-md transition-all duration-200 ${
										boardView
											? "bg-white/[0.09] text-white shadow-sm"
											: "text-zinc-500 hover:text-zinc-400"
									}`}
								>
									<Rows3 className="w-3.5 h-3.5" />
									{t("board.board")}
								</button>
							</div>
							<div className="order-5 ml-auto flex items-center min-w-0">
								<button
									type="button"
									onClick={() => setShowSearch(!showSearch)}
									title={t("common.search")}
									className={`@3xl:hidden p-2 rounded-lg transition-colors ${
										showSearch
											? "text-blue-400"
											: "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06]"
									}`}
								>
									<Search className="w-[18px] h-[18px]" />
								</button>
								<div className="hidden @3xl:block w-60 mr-1">
									{renderSearchInput(false)}
								</div>
							</div>
						</>
					)}

					<div
						className={`order-2 @3xl:order-6 flex items-center gap-1 shrink-0 ${
							activeTab === "sessions" ? "ml-auto @3xl:ml-0" : "ml-auto"
						}`}
					>
						{onToggleDashboard && (
							<button
								type="button"
								onClick={onToggleDashboard}
								className={`p-2 rounded-lg transition-colors ${
									dashboardOpen
										? "text-blue-400"
										: "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06]"
								}`}
								title={t("dashboard.title")}
								aria-pressed={dashboardOpen}
							>
								<BarChart3 className="w-[18px] h-[18px]" />
							</button>
						)}
						<button
							type="button"
							onClick={() => setShowCreateModal(true)}
							className="p-2 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
							data-onboarding="new-session"
						>
							<Plus className="w-[18px] h-[18px]" />
						</button>
						{onClose && (
							<button
								type="button"
								onClick={onClose}
								className="p-2 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
							>
								<X className="w-[18px] h-[18px]" />
							</button>
						)}
					</div>
				</div>

				{showSearch && activeTab === "sessions" && (
					<div className="mb-2 max-w-sm @3xl:hidden">
						{renderSearchInput(true)}
					</div>
				)}
			</div>

			{/* Error message */}
			{error && activeTab === "sessions" && (
				<div className="px-4 py-2.5 bg-red-900/30 text-red-400 text-[12px] border-b border-red-500/20 shrink-0">
					{error}
				</div>
			)}

			{/* ─── Content ─── */}
			<div className="flex-1 min-h-0 overflow-hidden">
				<div
					className="h-full"
					style={
						contentScale
							? {
									transform: `scale(${contentScale})`,
									transformOrigin: "top left",
									width: `${100 / contentScale}%`,
									height: `${100 / contentScale}%`,
								}
							: undefined
					}
				>
					{activeTab === "sessions" && (
						<div className="h-full overflow-y-auto overscroll-contain">
							<div className={fullScreen ? "px-3 pt-3 scroll-bottom-room" : "px-3 py-3"}>
								{/* The list below is whatever last arrived. The server is not
								    answering now, so say so before any of it is acted on. */}
								{serverReachable === false && <ServerUnreachableBanner />}

								{/* Hook configuration banner */}
								{hookConfigured === false && !hookBannerDismissed && (
									<div className="mb-3 p-2.5 bg-amber-900/20 border border-amber-700/30 rounded-lg text-[12px] text-amber-400 flex items-start gap-2">
										<span className="flex-1">
											{t("onboarding.hookNotConfigured")}
										</span>
										<button
											type="button"
											onClick={async () => {
												// Find the first available session to send the setup prompt
												const target = sessions[0];
												if (!target) return;
												try {
													const res = await authFetch(
														`${API_BASE}/api/workspaces/${encodeURIComponent(target.id)}/prompt`,
														{
															method: "POST",
															headers: { "Content-Type": "application/json" },
															body: JSON.stringify({
																text: t("onboarding.hookSetupPrompt", {
																	command: hookCommand,
																}),
															}),
														},
													);
													if (res.ok) {
														setHookBannerDismissed(true);
														localStorage.setItem(
															storageKey("hook-banner-dismissed"),
															"1",
														);
														onSelectSession(target);
													}
												} catch {}
											}}
											className="shrink-0 text-blue-400 hover:text-blue-300"
										>
											{t("onboarding.hookSetupAction")}
										</button>
										<button
											type="button"
											onClick={() => {
												setHookBannerDismissed(true);
												localStorage.setItem(
													storageKey("hook-banner-dismissed"),
													"1",
												);
											}}
											className="shrink-0 text-amber-500 hover:text-amber-300"
										>
											{t("onboarding.hookNotConfiguredDismiss")}
										</button>
									</div>
								)}

								{filteredSessions.length === 0 && sessions.length === 0 ? (
									<div className="text-center text-zinc-600 py-12">
										<p className="text-[14px]">{t("session.noSessions")}</p>
										<p className="text-[12px] mt-1">
											{t("session.noSessionsHint")}
										</p>
									</div>
								) : filteredSessions.length === 0 && searchQuery ? (
									<div className="text-center text-zinc-600 py-12">
										<p className="text-[13px]">No matching sessions</p>
									</div>
								) : boardView ? (
									<WorkspaceBoard
										sessions={filteredSessions}
										onSelectSession={onSelectSession}
										onSelectPane={onSelectPane}
									/>
								) : (
									<>
										<DndContext
											collisionDetection={closestCenter}
											onDragEnd={handleDragEnd}
										>
											<SortableContext
												items={filteredSessions.map(sessionCompositeKey)}
												strategy={verticalListSortingStrategy}
												disabled={!isDraggable}
											>
												<div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
													{filteredSessions.map((session, index) => (
														<SortableSessionItem
															key={sessionCompositeKey(session)}
															session={session}
															index={index}
															isDraggable={isDraggable}
															onSelect={onSelectSession}
															onSelectPane={onSelectPane}
															onShowMenu={handleShowMenu}
															onResume={handleResume}
															onDelete={(id, peerId) =>
																deleteSession(id, peerId ?? LOCAL_PEER_ID)
															}
															onShowConversation={handleShowConversation}
															onPaneAction={handlePaneAction}
															onClosePane={(sid, pid, name) =>
																setPaneToClose({
																	sessionId: sid,
																	paneId: pid,
																	name,
																})
															}
															onSelectTab={(s, tabId) =>
																handleTabAction(s.id, "select", tabId)
															}
															onCreateTab={(s) => handleTabAction(s.id, "create")}
															onCloseTab={(s, tabId, label) =>
																setTabToClose({
																	sessionId: s.id,
																	tabId,
																	label,
																})
															}
														/>
													))}
												</div>
											</SortableContext>
										</DndContext>

										{/* New session button at bottom */}
										<button
											type="button"
											onClick={() => setShowCreateModal(true)}
											className="mt-4 sm:mt-3 sm:w-auto inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-dashed border-white/[0.08] text-zinc-500 hover:text-zinc-400 hover:border-white/[0.12] hover:bg-white/[0.02] transition-all max-sm:w-full max-sm:justify-center"
										>
											<Plus className="w-4 h-4" />
											<span className="text-[13px]">
												{t("session.newSession")}
											</span>
										</button>
									</>
								)}
							</div>
						</div>
					)}

					{activeTab === "history" &&
						(historyV2 ? (
							// V2 owns its own internal scroll container, so the host
							// wrapper must not add a second one.
							<div className="h-full overflow-hidden">
								<SessionHistoryV2
									onSelectSession={onSelectSession}
									onSessionResumed={() => {
										setActiveTab("sessions");
									}}
									activeSessions={sessions}
								/>
							</div>
						) : (
							<div className="h-full overflow-y-auto overscroll-contain">
								<SessionHistory
									onSelectSession={onSelectSession}
									onSessionResumed={() => {
										setActiveTab("sessions");
									}}
									activeSessions={sessions}
								/>
							</div>
						))}
				</div>
			</div>

			{/* Pane close confirmation dialog */}
			{paneToClose && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-overlay)] animate-backdrop-in"
					onClick={() => {
						setPaneToClose(null);
						setClosePaneError(null);
					}}
				>
					<div
						className="bg-th-surface rounded-lg p-6 max-w-sm w-full mx-4 shadow-xl animate-modal-in"
						onClick={(e) => e.stopPropagation()}
					>
						<h3 className="text-lg font-bold text-th-text mb-2">
							{t("session.closePaneTitle")}
						</h3>
						<p className="text-th-text-secondary mb-4">
							{t("session.closePaneBody", { name: paneToClose.name })}
						</p>
						{closePaneError && (
							<p
								role="alert"
								className="mb-4 rounded-md bg-red-500/15 px-3 py-2 text-[13px] text-red-400"
							>
								{closePaneError}
							</p>
						)}
						<div className="flex gap-3 justify-end">
							<button
								type="button"
								onClick={() => {
									setPaneToClose(null);
									setClosePaneError(null);
								}}
								className="px-4 py-2 bg-th-surface-active hover:bg-th-surface-hover rounded font-medium transition-colors text-th-text"
							>
								{t("common.cancel")}
							</button>
							<button
								type="button"
								onClick={async () => {
									// Route to the owning Hub/peer instead of always the
									// local Hub — otherwise closing a pane on a remote
									// peer's session silently fails (or, on id collision,
									// closes the wrong pane).
									const session = sessions.find(
										(s) => s.id === paneToClose.sessionId,
									);
									let failure: string | null = null;
									try {
										const res = await sessionFetch(
											session,
											peers,
											`/api/workspaces/${encodeURIComponent(paneToClose.sessionId)}/panes/close`,
											{
												method: "POST",
												headers: { "Content-Type": "application/json" },
												body: JSON.stringify({ paneId: paneToClose.paneId }),
											},
										);
										if (!res.ok) {
											const body = (await res.json().catch(() => ({}))) as {
												error?: string;
											};
											failure = body.error?.includes("last pane")
												? t("session.closePaneLast")
												: t("session.closePaneFailed", {
														reason: body.error || res.status,
													});
										}
									} catch (err) {
										failure = t("session.closePaneFailed", {
											reason: err instanceof Error ? err.message : String(err),
										});
									}
									// A refusal has to be seen: closing the dialog on it
									// looks exactly like the tap not registering.
									if (failure) {
										setClosePaneError(failure);
										return;
									}
									setClosePaneError(null);
									setPaneToClose(null);
								}}
								className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded font-medium transition-colors text-white"
							>
								{t("session.closePaneAction")}
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Close-tab confirmation (destructive: closes every pane in the tab) */}
			{tabToClose && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-overlay)] animate-backdrop-in"
					onClick={() => setTabToClose(null)}
				>
					<div
						className="bg-th-surface rounded-lg p-6 max-w-sm w-full mx-4 shadow-xl animate-modal-in"
						onClick={(e) => e.stopPropagation()}
					>
						<h3 className="text-lg font-bold text-th-text mb-2">
							{t("session.closeTabTitle")}
						</h3>
						<p className="text-th-text-secondary mb-4">
							{t("session.closeTabConfirm", {
								label: tabToClose.label,
							})}
						</p>
						<div className="flex gap-3 justify-end">
							<button
								type="button"
								onClick={() => setTabToClose(null)}
								className="px-4 py-2 bg-th-surface-active hover:bg-th-surface-hover rounded font-medium transition-colors text-th-text"
							>
								{t("common.cancel")}
							</button>
							<button
								type="button"
								onClick={async () => {
									await handleTabAction(
										tabToClose.sessionId,
										"close",
										tabToClose.tabId,
									);
									setTabToClose(null);
								}}
								className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded font-medium transition-colors text-white"
							>
								{t("session.closeTabAction")}
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Session menu dialog */}
			{sessionForMenu && (
				<SessionMenuDialog
					session={sessionForMenu}
					onChangeTheme={handleMenuChangeTheme}
					onChangeTitle={handleMenuChangeTitle}
					onChangeSttPrompt={handleMenuChangeSttPrompt}
					onCreateTab={() => {
						handleTabAction(sessionForMenu.id, "create");
						handleMenuClose();
					}}
					onDelete={handleMenuDelete}
					onCancel={handleMenuClose}
				/>
			)}

			{/* Create session modal */}
			{showCreateModal && (
				<CreateSessionModal
					peers={peers}
					onConfirm={handleCreateSession}
					onCancel={() => {
						createAttemptRef.current++;
						setShowCreateModal(false);
						setCreateError(null);
						setAgentFailure(null);
					}}
					existingNames={new Set(sessions.map((s) => s.name))}
					externalError={createError}
					agentFailure={
						agentFailure && {
							name: agentFailure.session.name,
							agent: agentFailure.agent,
							message: agentFailure.message,
						}
					}
					onOpenCreated={() => {
						if (!agentFailure) return;
						setShowCreateModal(false);
						setAgentFailure(null);
						onSelectSession(agentFailure.session);
					}}
				/>
			)}

			{/* Conversation viewer modal */}
			{viewingConversation && (
				<ConversationViewer
					title={viewingConversation.title}
					subtitle={viewingConversation.subtitle}
					messages={conversation}
					isLoading={loadingConversation}
					onClose={() => setViewingConversation(null)}
					isActive={viewingConversation.isActive}
					onRefresh={handleRefreshConversation}
				/>
			)}

		</div>
	);
}
