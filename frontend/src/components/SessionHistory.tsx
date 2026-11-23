/** biome-ignore-all lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: legacy click-on-div UI; keyboard navigation provided via main shortcuts */
import {
	ChevronRight,
	Clock,
	FolderOpen,
	MessageCircle,
	Search,
	Tag,
	X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	ConversationMessage,
	HistorySession,
	SessionResponse,
} from "../../../shared/types";
import {
	type ProjectInfo,
	projectKey,
	useSessionHistory,
} from "../hooks/useSessionHistory";
import { authFetch } from "../services/api";
import { agentBadge } from "../utils/agentDisplay";
import { formatRelativeTime } from "../utils/format";
import { ConversationViewer } from "./ConversationViewer";
import { type ConversationHolder, liveConversations } from "../utils/live-conversations";

// Extended session type with ccSessionId
interface ActiveSession extends SessionResponse, ConversationHolder {}

interface SessionHistoryProps {
	onSessionResumed?: () => void;
	onSelectSession?: (session: SessionResponse) => void;
	activeSessions?: ActiveSession[];
}

function formatDuration(
	minutes: number | undefined,
	t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
	if (!minutes || minutes <= 0) return null;
	if (minutes < 60) return t("time.minutes", { count: minutes });
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	return mins > 0
		? t("time.hoursMinutes", { hours, minutes: mins })
		: t("time.hours", { count: hours });
}

function HistoryItem({
	session,
	onTap,
	onResume,
	onNavigate,
	isResuming,
	isActive,
}: {
	session: HistorySession;
	onTap: () => void;
	onResume: () => void;
	onNavigate: () => void;
	isResuming: boolean;
	isActive: boolean;
}) {
	const { t, i18n } = useTranslation();
	// Prefer lastPrompt; firstPrompt is the legacy fallback for entries coming
	// from older peers that don't send lastPrompt yet.
	const displayText =
		session.lastPrompt ||
		session.firstPrompt ||
		session.summary ||
		"No description";
	const truncatedText =
		displayText.length > 60
			? `${displayText.substring(0, 60)}...`
			: displayText;

	const duration = formatDuration(session.durationMinutes, t);
	const messageCount = session.messageCount;
	const gitBranch = session.gitBranch;

	const badge = agentBadge(session.agent);

	return (
		<div
			onClick={onTap}
			className="group px-3 py-2.5 hover:bg-white/[0.04] rounded-md cursor-pointer transition-colors"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="flex-1 min-w-0">
					{session.recap ? (
						<p className="text-[12.5px] text-amber-200 leading-relaxed line-clamp-3">
							{session.recap}
							{session.recapAt && (
								<span className="ml-2 text-[10px] text-zinc-500">
									{formatRelativeTime(session.recapAt, t, i18n.language)}
								</span>
							)}
						</p>
					) : (
						<p className="text-[13px] text-zinc-300 leading-snug truncate">
							{truncatedText}
						</p>
					)}
					<div className="flex items-center gap-3 mt-1.5 text-[11px] text-zinc-600">
						<span
							className={`inline-flex items-center px-1.5 py-px rounded border text-[10px] font-medium ${badge.badgeClassName}`}
						>
							{badge.label}
						</span>
						<span>
							{formatRelativeTime(session.modified, t, i18n.language)}
						</span>
						{duration && (
							<span className="inline-flex items-center gap-1">
								<Clock className="w-3 h-3" />
								{duration}
							</span>
						)}
						{messageCount !== undefined && messageCount > 0 && (
							<span className="inline-flex items-center gap-1">
								<MessageCircle className="w-3 h-3" />
								{messageCount}
							</span>
						)}
						{gitBranch && (
							<span className="inline-flex items-center gap-1 text-purple-500 truncate max-w-[120px]">
								<Tag className="w-3 h-3" />
								{gitBranch}
							</span>
						)}
					</div>
				</div>
				{isActive ? (
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							onNavigate();
						}}
						className="shrink-0 mt-0.5 px-2.5 py-1 text-[11px] font-medium text-zinc-500 hover:text-zinc-300 bg-white/[0.04] hover:bg-white/[0.08] rounded-md transition-colors"
					>
						{t("session.navigate")}
					</button>
				) : (
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							onResume();
						}}
						disabled={isResuming}
						className="shrink-0 mt-0.5 px-2.5 py-1 text-[11px] font-medium text-zinc-500 hover:text-zinc-300 bg-white/[0.04] hover:bg-white/[0.08] rounded-md transition-colors disabled:opacity-50"
					>
						{isResuming ? "..." : t("session.resume")}
					</button>
				)}
			</div>
		</div>
	);
}

function ProjectGroupItem({
	project,
	sessions,
	isLoading,
	onExpand,
	onTap,
	onResume,
	onNavigate,
	resumingId,
	activeConversationIds,
}: {
	project: ProjectInfo;
	sessions: HistorySession[] | undefined;
	isLoading: boolean;
	onExpand: () => void;
	onTap: (session: HistorySession, projectDirName: string) => void;
	onResume: (session: HistorySession) => void;
	onNavigate: (session: HistorySession) => void;
	resumingId: string | null;
	activeConversationIds: Set<string>;
}) {
	const { t } = useTranslation();
	const [isExpanded, setIsExpanded] = useState(false);

	const handleToggle = () => {
		const newExpanded = !isExpanded;
		setIsExpanded(newExpanded);

		if (newExpanded && !sessions) {
			onExpand();
		}
	};

	const showPeerBadge =
		project.peerId && project.peerId !== "local" && project.peerNickname;

	return (
		<div>
			<button
				type="button"
				onClick={handleToggle}
				className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/[0.03] rounded-md transition-colors"
				style={
					showPeerBadge && project.peerColor
						? {
								borderLeft: `3px solid ${project.peerColor}`,
								paddingLeft: 8,
							}
						: undefined
				}
			>
				<ChevronRight
					className={`w-3.5 h-3.5 text-zinc-600 transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`}
				/>
				<FolderOpen className="w-3.5 h-3.5 text-zinc-600" />
				<span className="flex-1 text-left text-[13px] text-zinc-400 truncate">
					{project.projectName}
				</span>
				{showPeerBadge && (
					<span
						className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium"
						style={{
							backgroundColor: `${project.peerColor}26`,
							color: project.peerColor,
						}}
					>
						<span
							className="w-1 h-1 rounded-full"
							style={{ backgroundColor: project.peerColor }}
						/>
						{project.peerNickname}
					</span>
				)}
				<span className="text-[11px] text-zinc-600 tabular-nums">
					{project.sessionCount}
				</span>
			</button>

			{isExpanded && (
				<div className="ml-5 border-l border-white/[0.06] mb-1">
					{isLoading ? (
						<div className="px-3 py-2 text-[12px] text-zinc-700">
							{t("common.loading")}
						</div>
					) : sessions && sessions.length > 0 ? (
						<div className="md:grid md:grid-cols-2 md:gap-x-2">
							{sessions.map((session) => (
								<HistoryItem
									key={session.sessionId}
									session={session}
									onTap={() => onTap(session, project.dirName)}
									onResume={() => onResume(session)}
									onNavigate={() => onNavigate(session)}
									isResuming={resumingId === session.sessionId}
									isActive={activeConversationIds.has(session.sessionId)}
								/>
							))}
						</div>
					) : (
						<div className="px-3 py-2 text-[12px] text-zinc-700">
							{t("history.noSessionsInProject")}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

const API_BASE = import.meta.env.VITE_API_URL || "";

export function SessionHistory({
	onSessionResumed,
	onSelectSession,
	activeSessions = [],
}: SessionHistoryProps) {
	const { t } = useTranslation();
	const {
		projects,
		isLoadingProjects,
		sessionsByProject,
		loadingProjects,
		fetchProjectSessions,
		refreshAllLoadedProjects,
		searchResults,
		isSearching,
		searchQuery,
		searchSessions,
		clearSearch,
		resumeSession,
		fetchConversation,
		error,
	} = useSessionHistory();

	const [searchInput, setSearchInput] = useState("");

	const [resumingId, setResumingId] = useState<string | null>(null);
	const [resumeError, setResumeError] = useState<string | null>(null);
	const [selectedSession, setSelectedSession] = useState<HistorySession | null>(
		null,
	);
	const [conversation, setConversation] = useState<ConversationMessage[]>([]);
	const [loadingConversation, setLoadingConversation] = useState(false);

	const live = useMemo(() => liveConversations(activeSessions), [activeSessions]);
	const activeConversationIds = useMemo(() => new Set(live.keys()), [live]);
	const findActiveSession = (historySession: HistorySession) =>
		live.get(historySession.sessionId);

	const handleResume = async (session: HistorySession) => {
		setResumingId(session.sessionId);
		setResumeError(null);
		try {
			const result = await resumeSession(
				session.sessionId,
				session.projectPath,
				session.agent,
				session.peerId,
			);

			if (result) {
				await new Promise((resolve) => setTimeout(resolve, 1000));

				const response = await authFetch(`${API_BASE}/api/workspaces`);
				let foundSession: SessionResponse | undefined;
				if (response.ok) {
					const data = await response.json();
					foundSession = data.sessions?.find(
						(s: { id: string }) => s.id === result.tmuxSessionId,
					);
				}

				if (onSelectSession && foundSession) {
					onSelectSession(foundSession);
				}

				if (onSessionResumed) {
					onSessionResumed();
				}

				// Refresh loaded projects to show updated session info
				await refreshAllLoadedProjects();
			}
			setSelectedSession(null);
		} catch {
			setResumeError(t("session.resumeFailed"));
		} finally {
			setResumingId(null);
		}
	};

	const handleNavigate = (session: HistorySession) => {
		const activeSession = findActiveSession(session);
		if (activeSession && onSelectSession) {
			onSelectSession(activeSession);
			if (onSessionResumed) {
				onSessionResumed();
			}
		}
		setSelectedSession(null);
	};

	const handleTap = async (session: HistorySession, projectDirName: string) => {
		setResumeError(null);
		setSelectedSession(session);
		setLoadingConversation(true);
		setConversation([]);
		try {
			const messages = await fetchConversation(
				session.sessionId,
				projectDirName,
				session.agent,
				session.peerId,
			);
			setConversation(messages);
		} finally {
			setLoadingConversation(false);
		}
	};

	if (isLoadingProjects) {
		return (
			<div className="p-4 text-center text-th-text-muted text-sm">
				{t("history.loadingHistory")}
			</div>
		);
	}

	if (error) {
		return (
			<div className="p-4 text-center text-red-400 text-sm">
				{t("common.error")}: {error}
			</div>
		);
	}

	// Handle search input
	const handleSearchInput = (e: React.ChangeEvent<HTMLInputElement>) => {
		setSearchInput(e.target.value);
	};

	const handleSearchSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (searchInput.trim()) {
			searchSessions(searchInput.trim());
		}
	};

	const handleClearSearch = () => {
		setSearchInput("");
		clearSearch();
	};

	// Handle tap on search result
	const handleSearchResultTap = async (session: HistorySession) => {
		setResumeError(null);
		setSelectedSession(session);
		setLoadingConversation(true);
		setConversation([]);
		try {
			const messages = await fetchConversation(
				session.sessionId,
				undefined,
				session.agent,
				session.peerId,
			);
			setConversation(messages);
		} finally {
			setLoadingConversation(false);
		}
	};

	if (projects.length === 0 && !searchQuery) {
		return (
			<div className="p-4 text-center text-th-text-muted text-sm">
				{t("history.noSessions")}
			</div>
		);
	}

	return (
		<div className="flex flex-col px-3 py-3">
			{/* Search input */}
			<form onSubmit={handleSearchSubmit} className="mb-3">
				<div className="relative max-w-sm">
					<Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-600" />
					<input
						type="text"
						value={searchInput}
						onChange={handleSearchInput}
						placeholder={t("history.searchPlaceholder")}
						className="w-full pl-9 pr-3 py-1.5 bg-white/[0.04] border border-white/[0.06] rounded-md text-[13px] text-white placeholder:text-zinc-700 focus:outline-none focus:border-white/[0.12] transition-colors"
					/>
					{(searchInput || searchQuery) && (
						<button
							type="button"
							onClick={handleClearSearch}
							className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-zinc-600 hover:text-zinc-400"
						>
							<X className="w-3.5 h-3.5" />
						</button>
					)}
				</div>
			</form>

			{/* Resume error banner */}
			{resumeError && (
				<div className="px-3 py-2 bg-red-900/50 text-red-300 text-xs flex items-center justify-between border-b border-th-border">
					<span>{resumeError}</span>
					<button
						type="button"
						onClick={() => setResumeError(null)}
						className="text-red-400 hover:text-red-200 ml-2"
					>
						×
					</button>
				</div>
			)}

			<div>
				{/* Search results */}
				{searchQuery ? (
					<div>
						<div className="px-3 py-2 text-xs text-th-text-secondary border-b border-th-border">
							{isSearching
								? t("history.searching")
								: t("history.searchResults", {
										query: searchQuery,
										count: searchResults.length,
									})}
						</div>
						<div className="md:grid md:grid-cols-2 md:gap-1 md:px-1">
							{searchResults.map((session) => (
								<HistoryItem
									key={session.sessionId}
									session={session}
									onTap={() => handleSearchResultTap(session)}
									onResume={() => handleResume(session)}
									onNavigate={() => handleNavigate(session)}
									isResuming={resumingId === session.sessionId}
									isActive={activeConversationIds.has(session.sessionId)}
								/>
							))}
						</div>
						{!isSearching && searchResults.length === 0 && (
							<div className="p-4 text-center text-th-text-muted text-sm">
								{t("history.noSearchResults")}
							</div>
						)}
					</div>
				) : (
					/* Project list */
					projects.map((project) => {
						const key = projectKey(project.peerId, project.dirName);
						return (
							<ProjectGroupItem
								key={key}
								project={project}
								sessions={sessionsByProject.get(key)}
								isLoading={loadingProjects.has(key)}
								onExpand={() =>
									fetchProjectSessions(project.peerId, project.dirName)
								}
								onTap={handleTap}
								onResume={handleResume}
								onNavigate={handleNavigate}
								resumingId={resumingId}
								activeConversationIds={activeConversationIds}
							/>
						);
					})
				)}
			</div>

			{selectedSession && (
				<ConversationViewer
					title={
						selectedSession.summary ||
						selectedSession.lastPrompt ||
						selectedSession.firstPrompt ||
						"No title"
					}
					subtitle={selectedSession.projectName}
					messages={conversation}
					isLoading={loadingConversation}
					onClose={() => setSelectedSession(null)}
					onResume={() => handleResume(selectedSession)}
					isActive={activeConversationIds.has(selectedSession.sessionId)}
					onNavigate={() => handleNavigate(selectedSession)}
					isResuming={resumingId === selectedSession.sessionId}
					resumeError={resumeError}
					scrollToBottom={true}
				/>
			)}
		</div>
	);
}
