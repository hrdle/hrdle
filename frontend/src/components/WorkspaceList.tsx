/** biome-ignore-all lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: legacy click-on-div UI; keyboard navigation provided via main shortcuts */
import { closestCenter, DndContext, type DragEndEvent } from "@dnd-kit/core";
import {
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TFunction } from "i18next";
import {
	ArrowRight,
	BarChart3,
	MessagesSquare,
	ChevronLeft,
	ChevronRight,
	ExternalLink,
	Folder,
	GripVertical,
	Play,
	Plus,
	Search,
	X,
} from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	AGENT_PROVIDER_IDS,
	AGENT_PROVIDERS,
	type AgentProvider,
	agentSupportsConversationMetadata,
	type ConversationMessage,
	DEFAULT_AGENT_PROVIDER,
	type ExtendedSessionResponse,
	type FileInfo,
	type IndicatorState,
	isAgentProvider,
	LOCAL_PEER_ID,
	type PaneInfo,
	type PeerClientView,
	type SessionMetrics,
	type SessionResponse,
	type SessionTheme,
	type TabInfo,
	threadAgentOf,
} from "../../../shared/types";
import { openClaudeAppSession } from "../utils/claude-app";
import { usePeers, useServerReachable } from "../hooks/usePeers";
import {
	ServerUnreachableBanner,
	ServerUnreachableNotice,
} from "./ServerUnreachable";
import {
	applyLocalSessionReorder,
	useWorkspaces,
} from "../hooks/useWorkspaces";
import { sessionFetch } from "../services/peer-fetch";
import { formatModelName, formatRelativeTime } from "../utils/format";
import { toHomeShortPath } from "../utils/path";

// Theme color mapping
const THEME_COLORS: Record<SessionTheme, { border: string; bg: string }> = {
	red: { border: "border-red-500", bg: "bg-red-500" },
	orange: { border: "border-orange-500", bg: "bg-orange-500" },
	amber: { border: "border-amber-500", bg: "bg-amber-500" },
	green: { border: "border-green-500", bg: "bg-green-500" },
	teal: { border: "border-teal-500", bg: "bg-teal-500" },
	blue: { border: "border-blue-500", bg: "bg-blue-500" },
	indigo: { border: "border-indigo-500", bg: "bg-indigo-500" },
	purple: { border: "border-purple-500", bg: "bg-purple-500" },
	pink: { border: "border-pink-500", bg: "bg-pink-500" },
};

const THEME_OPTIONS: (SessionTheme | null)[] = [
	null,
	"red",
	"orange",
	"amber",
	"green",
	"teal",
	"blue",
	"indigo",
	"purple",
	"pink",
];

// Accent color hex values for redesigned card left bar
const ACCENT_HEX: Record<SessionTheme, string> = {
	red: "#ef4444",
	orange: "#f97316",
	amber: "#f59e0b",
	green: "#22c55e",
	teal: "#14b8a6",
	blue: "#3b82f6",
	indigo: "#6366f1",
	purple: "#a855f7",
	pink: "#ec4899",
};

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatTokenCount(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

import { useHistoryV2Flag } from "../hooks/useHistoryV2Flag";
import { useSessionHistory } from "../hooks/useSessionHistory";
import { useStewardLines } from "../hooks/useSteward";
import { authFetch } from "../services/api";
import { ConversationViewer } from "./ConversationViewer";
import { SessionHistory } from "./SessionHistory";
import { SessionHistoryV2 } from "./history/SessionHistoryV2";
import { HOOK_COMMAND } from "../../../shared/identity";
import { storageKey } from "../utils/app-storage";

const API_BASE = import.meta.env.VITE_API_URL || "";

// Directory browser API functions
// When peerId is given, the call is routed to /api/peers/:peerId/files/*.
async function browseDirectory(
	path?: string,
	peerId?: string,
): Promise<{ path: string; files: FileInfo[]; parentPath: string | null }> {
	const isRemote = peerId && peerId !== "local";
	const base = isRemote
		? `${API_BASE}/api/peers/${encodeURIComponent(peerId)}/files/browse`
		: `${API_BASE}/api/files/browse`;
	const url = path ? `${base}?path=${encodeURIComponent(path)}` : base;
	const response = await authFetch(url);
	if (!response.ok) {
		throw new Error("Failed to browse directory");
	}
	return response.json();
}

async function createDirectory(
	path: string,
	peerId?: string,
): Promise<{ path: string; success: boolean }> {
	const isRemote = peerId && peerId !== "local";
	const url = isRemote
		? `${API_BASE}/api/peers/${encodeURIComponent(peerId)}/files/mkdir`
		: `${API_BASE}/api/files/mkdir`;
	const response = await authFetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path }),
	});
	if (!response.ok) {
		const error = await response.json();
		throw new Error(error.error || "Failed to create directory");
	}
	return response.json();
}

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
	// Only passed when the server reports a steward; absent, no button appears.
	onToggleSteward?: () => void;
	stewardOpen?: boolean;
}

/**
 * The line the steward wrote for each workspace, by workspace id.
 *
 * A context rather than a prop threaded through the sortable wrapper: with no
 * steward it is empty, and every row renders exactly as it did before.
 */
export const StewardLinesContext = createContext<Map<string, string>>(new Map());

// Session menu dialog (color change + title edit + delete)
function SessionMenuDialog({
	session,
	onChangeTheme,
	onChangeTitle,
	onChangeSttPrompt,
	onCreateTab,
	onDelete,
	onCancel,
}: {
	session: SessionResponse;
	onChangeTheme: (theme: SessionTheme | null) => void;
	onChangeTitle?: (title: string) => void;
	onChangeSttPrompt?: (prompt: string | null) => void;
	onCreateTab?: () => void;
	onDelete: () => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation();
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	// The workspace label is the name; customTitle only appears from peers on
	// older versions that still store one.
	const currentName = session.customTitle || session.name;
	const [titleValue, setTitleValue] = useState(currentName);
	const [sttPromptValue, setSttPromptValue] = useState(session.sttPrompt || "");

	if (showDeleteConfirm) {
		return (
			<div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-overlay)] animate-backdrop-in">
				<div className="bg-th-surface rounded-lg p-6 max-w-sm w-full mx-4 shadow-xl animate-modal-in">
					<h3 className="text-lg font-bold text-th-text mb-2">
						{t("session.deleteSession")}
					</h3>
					<p className="text-th-text-secondary mb-4">
						{t("session.deleteConfirm", { name: session.name })}
					</p>
					<p className="text-sm text-th-text-secondary mb-6">
						{t("session.deleteWarning")}
					</p>
					<div className="flex gap-3 justify-end">
						<button
							type="button"
							onClick={() => setShowDeleteConfirm(false)}
							className="px-4 py-2 bg-th-surface-active hover:bg-th-surface-active rounded font-medium transition-colors"
						>
							{t("common.cancel")}
						</button>
						<button
							type="button"
							onClick={onDelete}
							className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded font-medium transition-colors"
						>
							{t("common.delete")}
						</button>
					</div>
				</div>
			</div>
		);
	}

	const getThemeLabel = (theme: SessionTheme | null) => {
		if (theme === null) return t("common.none");
		return t(`theme.${theme}`);
	};

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-overlay)] animate-backdrop-in"
			onClick={onCancel}
		>
			<div
				className="bg-th-surface rounded-lg p-4 max-w-sm w-full mx-4 shadow-xl animate-modal-in"
				onClick={(e) => e.stopPropagation()}
			>
				<h3 className="text-lg font-bold text-th-text mb-3">{session.name}</h3>

				{/* Color picker */}
				<div className="mb-4">
					<p className="text-sm text-th-text-secondary mb-2">
						{t("session.colorTheme")}
					</p>
					<div className="flex flex-wrap gap-2">
						{THEME_OPTIONS.map((theme) => (
							<button
								type="button"
								key={theme ?? "none"}
								onClick={() => onChangeTheme(theme)}
								className={`w-8 h-8 rounded-full border-2 transition-all ${
									theme === null
										? "bg-th-surface-active border-gray-500"
										: `${THEME_COLORS[theme].bg} border-transparent`
								} ${
									session.theme === theme ||
									(session.theme === undefined && theme === null)
										? "ring-2 ring-white ring-offset-2 ring-offset-gray-800"
										: "hover:scale-110"
								}`}
								title={getThemeLabel(theme)}
							/>
						))}
					</div>
				</div>

				{/* Name edit — writes through to the herdr workspace label */}
				{onChangeTitle && (
					<div className="mb-4">
						<p className="text-sm text-th-text-secondary mb-2">
							{t("session.workspaceName")}
						</p>
						<div className="flex gap-2">
							<input
								type="text"
								value={titleValue}
								onChange={(e) => setTitleValue(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && titleValue.trim()) {
										onChangeTitle(titleValue.trim());
									}
								}}
								placeholder={t("session.workspaceNamePlaceholder")}
								className="flex-1 bg-th-bg border border-th-border rounded px-2 py-1 text-sm text-th-text placeholder-th-text-muted focus:outline-none focus:border-blue-500"
							/>
							<button
								type="button"
								disabled={!titleValue.trim()}
								onClick={() => {
									if (titleValue.trim()) onChangeTitle(titleValue.trim());
								}}
								className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded text-sm font-medium transition-colors"
							>
								{t("common.save")}
							</button>
						</div>
					</div>
				)}

				{/* Speech-to-text vocabulary. This session's own words lead the bias
				    sent with its transcriptions; the shared glossary follows, so a
				    short list is worth more than a long one. */}
				{onChangeSttPrompt && (
					<div className="mb-4">
						<p className="text-sm text-th-text-secondary mb-2">
							{t("session.sttPrompt")}
						</p>
						<div className="flex gap-2">
							<input
								type="text"
								value={sttPromptValue}
								onChange={(e) => setSttPromptValue(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										onChangeSttPrompt(sttPromptValue.trim() || null);
									}
								}}
								placeholder={t("session.sttPromptPlaceholder")}
								maxLength={100}
								className="flex-1 bg-th-bg border border-th-border rounded px-2 py-1 text-sm text-th-text placeholder-th-text-muted focus:outline-none focus:border-blue-500"
							/>
							<button
								type="button"
								onClick={() => onChangeSttPrompt(sttPromptValue.trim() || null)}
								className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-medium transition-colors"
							>
								{t("common.save")}
							</button>
						</div>
						<p className="mt-1 text-[11px] text-th-text-muted">
							{t("session.sttPromptHint")}
						</p>
					</div>
				)}

				{/* New tab — always available so a single-tab workspace can grow one */}
				{onCreateTab && (
					<div className="mb-4">
						<button
							type="button"
							onClick={onCreateTab}
							className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-th-surface-active hover:bg-white/[0.08] text-th-text text-sm font-medium transition-colors"
						>
							<Plus className="w-4 h-4" />
							{t("session.newTab")}
						</button>
					</div>
				)}

				{/* Actions */}
				<div className="flex gap-3 justify-between pt-3 border-t border-th-border">
					<button
						type="button"
						onClick={() => setShowDeleteConfirm(true)}
						className="px-4 py-2 bg-red-600/30 hover:bg-red-600/50 text-red-400 rounded font-medium transition-colors"
					>
						{t("common.delete")}
					</button>
					<button
						type="button"
						onClick={onCancel}
						className="px-4 py-2 bg-th-surface-active hover:bg-th-surface-active rounded font-medium transition-colors"
					>
						{t("common.close")}
					</button>
				</div>
			</div>
		</div>
	);
}

// Create session modal with directory picker
function CreateSessionModal({
	onConfirm,
	onCancel,
	existingNames,
	externalError,
	peers,
}: {
	onConfirm: (
		name: string,
		workingDir?: string,
		agent?: AgentProvider,
		peerId?: string,
	) => void;
	onCancel: () => void;
	existingNames: Set<string>;
	externalError?: string | null;
	peers: PeerClientView[];
}) {
	const { t } = useTranslation();
	const [name, setName] = useState("");
	const [agent, setAgent] = useState<AgentProvider>(DEFAULT_AGENT_PROVIDER);
	const [selectedPeerId, setSelectedPeerId] = useState<string>(LOCAL_PEER_ID);
	const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
	const [currentPath, setCurrentPath] = useState<string>("");
	const [directories, setDirectories] = useState<FileInfo[]>([]);
	const [parentPath, setParentPath] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [showNewFolderInput, setShowNewFolderInput] = useState(false);
	const [newFolderName, setNewFolderName] = useState("");
	const [creatingFolder, setCreatingFolder] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const newFolderInputRef = useRef<HTMLInputElement>(null);

	const isRemote = selectedPeerId !== LOCAL_PEER_ID;

	const nameManuallyEditedRef = useRef(nameManuallyEdited);
	nameManuallyEditedRef.current = nameManuallyEdited;
	const existingNamesRef = useRef(existingNames);
	existingNamesRef.current = existingNames;

	const loadDirectory = useCallback(
		async (path: string | undefined, peerId: string) => {
			setIsLoading(true);
			setError(null);
			try {
				const target = peerId === LOCAL_PEER_ID ? undefined : peerId;
				const result = await browseDirectory(path, target);
				setCurrentPath(result.path);
				setDirectories(result.files);
				setParentPath(result.parentPath);

				// Auto-suggest session name from directory name (only if not manually edited)
				if (!nameManuallyEditedRef.current) {
					const dirName = result.path.split("/").pop() || "";
					let suggested = dirName;
					let counter = 1;
					while (existingNamesRef.current.has(suggested)) {
						suggested = `${dirName}-${counter++}`;
					}
					setName(suggested);
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to load directory");
				setDirectories([]);
				setParentPath(null);
			} finally {
				setIsLoading(false);
			}
		},
		[],
	);

	// Initial load, plus a reload whenever the peer changes
	useEffect(() => {
		loadDirectory(undefined, selectedPeerId);
	}, [loadDirectory, selectedPeerId]);

	// Focus new folder input when shown
	useEffect(() => {
		if (showNewFolderInput) {
			newFolderInputRef.current?.focus();
		}
	}, [showNewFolderInput]);

	const handleDirectoryClick = (dir: FileInfo) => {
		loadDirectory(dir.path, selectedPeerId);
	};

	const handleGoUp = () => {
		if (parentPath) {
			loadDirectory(parentPath, selectedPeerId);
		}
	};

	const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		setName(e.target.value);
		setNameManuallyEdited(true);
	};

	const handleSubmit = () => {
		onConfirm(name, currentPath, agent, isRemote ? selectedPeerId : undefined);
	};

	const handleCreateFolder = async () => {
		if (!newFolderName.trim()) return;

		setCreatingFolder(true);
		setError(null);
		try {
			const newPath = `${currentPath}/${newFolderName.trim()}`;
			const target = isRemote ? selectedPeerId : undefined;
			await createDirectory(newPath, target);
			setShowNewFolderInput(false);
			setNewFolderName("");
			// Navigate to the new directory
			loadDirectory(newPath, selectedPeerId);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to create folder");
		} finally {
			setCreatingFolder(false);
		}
	};

	const shortPath = toHomeShortPath(currentPath);

	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center pt-4 bg-[var(--color-overlay)] animate-backdrop-in">
			<div className="bg-th-surface rounded-lg p-4 max-w-md w-full mx-4 shadow-xl max-h-[70vh] flex flex-col animate-modal-in">
				<h3 className="text-lg font-bold text-th-text mb-3">
					{t("session.newSession")}
				</h3>

				{/* Session name input */}
				<label className="mb-3 block">
					<span className="text-xs text-th-text-secondary mb-1 block">
						{t("session.sessionName")}
					</span>
					<input
						ref={inputRef}
						type="text"
						placeholder={t("session.sessionNamePlaceholder")}
						value={name}
						onChange={handleNameChange}
						onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
						className="w-full px-3 py-2 bg-th-bg border border-th-border rounded text-th-text placeholder-th-text-muted focus:outline-none focus:border-blue-500 text-sm"
					/>
				</label>

				{/*
				 * Agent provider. A row of buttons until there were five of them,
				 * at which point the grid wrapped and the odd one sat alone on a
				 * second line - and the list only grows as agents are added. A
				 * select costs one tap more and stays one line however many there
				 * are, which on a phone is the trade worth making.
				 */}
				<label className="mb-3 block">
					<span className="text-xs text-th-text-secondary mb-1 block">
						{t("session.agent")}
					</span>
					<select
						value={agent}
						onChange={(e) => setAgent(e.target.value as AgentProvider)}
						className="w-full px-3 py-2 bg-th-bg border border-th-border rounded text-th-text focus:outline-none focus:border-blue-500 text-sm"
					>
						{AGENT_PROVIDER_IDS.map((option) => (
							<option key={option} value={option}>
								{t(AGENT_PROVIDERS[option].labelKey)}
							</option>
						))}
					</select>
				</label>

				{/* Server (peer) selector - hidden when there is only one */}
				{peers.length > 1 && (
					<div className="mb-3">
						<div className="text-xs text-th-text-secondary mb-1">Server</div>
						<div className="grid grid-cols-2 gap-2">
							{peers.map((peer) => (
								<button
									key={peer.id}
									type="button"
									onClick={() => setSelectedPeerId(peer.id)}
									disabled={peer.id !== LOCAL_PEER_ID && peer.status !== "online"}
									className={`px-3 py-2 rounded border text-sm font-medium transition-colors truncate text-left ${
										selectedPeerId === peer.id
											? "border-blue-500 bg-blue-600/20 text-blue-300"
											: "border-th-border bg-th-bg text-th-text-secondary hover:bg-th-surface-active"
									} disabled:opacity-40 disabled:cursor-not-allowed`}
									style={{
										borderLeftColor: selectedPeerId === peer.id ? undefined : peer.color,
										borderLeftWidth: 3,
									}}
								>
									{peer.nickname}
								</button>
							))}
						</div>
					</div>
				)}

				{/* Directory picker - same for local and remote (remote browses the peer's filesystem) */}
				<div className="flex-1 min-h-0 flex flex-col">
					<div className="flex items-center justify-between mb-2">
						<span className="text-xs text-th-text-secondary">
							{t("session.workingDirectory")}
						</span>
						<button
							type="button"
							onClick={() => setShowNewFolderInput(true)}
							className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
							disabled={showNewFolderInput}
						>
							<Plus className="w-3 h-3" />
							{t("session.newFolder")}
						</button>
					</div>

					{/* Current path display */}
					<div className="text-xs text-th-text-secondary bg-th-bg px-2 py-1.5 rounded mb-2 truncate">
						{shortPath}
					</div>

					{/* New folder input */}
					{showNewFolderInput && (
						<div className="flex gap-2 mb-2">
							<input
								ref={newFolderInputRef}
								type="text"
								placeholder={t("session.folderName")}
								value={newFolderName}
								onChange={(e) => setNewFolderName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleCreateFolder();
									if (e.key === "Escape") {
										setShowNewFolderInput(false);
										setNewFolderName("");
									}
								}}
								className="flex-1 px-2 py-1 bg-th-bg border border-th-border rounded text-th-text placeholder-th-text-muted focus:outline-none focus:border-blue-500 text-sm"
								disabled={creatingFolder}
							/>
							<button
								type="button"
								onClick={handleCreateFolder}
								disabled={creatingFolder || !newFolderName.trim()}
								className="px-2 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-th-surface-active rounded text-sm transition-colors"
							>
								{creatingFolder ? "..." : t("common.create")}
							</button>
							<button
								type="button"
								onClick={() => {
									setShowNewFolderInput(false);
									setNewFolderName("");
								}}
								className="px-2 py-1 bg-th-surface-active hover:bg-th-surface-active rounded text-sm transition-colors"
							>
								×
							</button>
						</div>
					)}

					{/* Error display */}
					{(error || externalError) && (
						<div className="text-xs text-red-400 mb-2">
							{externalError || error}
						</div>
					)}

					{/* Directory list */}
					<div className="flex-1 overflow-y-auto bg-th-bg rounded border border-th-border">
						{isLoading ? (
							<div className="p-4 text-center text-th-text-muted text-sm">
								{t("common.loading")}
							</div>
						) : (
							<div className="divide-y divide-gray-800">
								{/* Parent directory */}
								{parentPath && (
									<button
										type="button"
										onClick={handleGoUp}
										className="w-full px-3 py-2 text-left hover:bg-th-surface flex items-center gap-2 text-sm"
									>
										<Folder className="w-4 h-4 text-th-text-secondary" />
										<span className="text-th-text-secondary">..</span>
									</button>
								)}

								{/* Directories (hide hidden directories) */}
								{directories
									.filter((dir) => !dir.isHidden)
									.map((dir) => (
										<button
											type="button"
											key={dir.path}
											onClick={() => handleDirectoryClick(dir)}
											className="w-full px-3 py-2 text-left hover:bg-th-surface flex items-center gap-2 text-sm"
										>
											<Folder className="w-4 h-4 text-yellow-500" />
											<span
												className={`truncate ${dir.isHidden ? "text-th-text-muted" : "text-th-text"}`}
											>
												{dir.name}
											</span>
										</button>
									))}

								{directories.length === 0 && !parentPath && (
									<div className="p-4 text-center text-th-text-muted text-sm">
										{t("session.noSubdirectories")}
									</div>
								)}
							</div>
						)}
					</div>
				</div>

				{/* Action buttons */}
				<div className="flex gap-3 justify-end mt-3 pt-3 border-t border-th-border">
					<button
						type="button"
						onClick={onCancel}
						className="px-4 py-2 bg-th-surface-active hover:bg-th-surface-active rounded font-medium transition-colors text-sm"
					>
						{t("common.cancel")}
					</button>
					<button
						type="button"
						onClick={handleSubmit}
						className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded font-medium transition-colors text-sm"
					>
						{t("common.create")}
					</button>
				</div>
			</div>
		</div>
	);
}

// Sortable wrapper for SessionItem (drag-to-reorder)
function sessionCompositeKey(session: ExtendedSessionResponse): string {
	return `${session.peerId ?? "local"}:${session.id}`;
}

function SortableSessionItem({
	session,
	index,
	isDraggable,
	...sessionItemProps
}: {
	session: ExtendedSessionResponse;
	index: number;
	isDraggable: boolean;
} & Omit<Parameters<typeof SessionItem>[0], "session">) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: sessionCompositeKey(session),
		disabled: !isDraggable,
	});

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
		zIndex: isDragging ? 10 : undefined,
	};

	return (
		<div
			ref={setNodeRef}
			style={style}
			data-onboarding={index === 0 ? "session-item" : undefined}
		>
			<div className="flex items-stretch">
				{isDraggable && (
					<button
						type="button"
						className="flex items-center px-1 text-zinc-600 hover:text-zinc-400 touch-none cursor-grab active:cursor-grabbing"
						{...attributes}
						{...listeners}
					>
						<GripVertical className="w-4 h-4" />
					</button>
				)}
				<div className="flex-1 min-w-0">
					<SessionItem session={session} {...sessionItemProps} />
				</div>
			</div>
		</div>
	);
}

const AGENT_NAME_COLORS: Record<string, string> = {
	red: "text-red-300",
	orange: "text-orange-300",
	amber: "text-amber-300",
	green: "text-green-300",
	teal: "text-teal-300",
	blue: "text-blue-300",
	cyan: "text-cyan-300",
	indigo: "text-indigo-300",
	purple: "text-purple-300",
	pink: "text-pink-300",
};

/**
 * Long-press (600ms) handlers shared by the tab / pane rows. The timer lives in
 * a ref because the session list re-renders on every 5s server push: a render
 * mid-press would hand the DOM fresh handlers whose local timer is null, so the
 * pending close would never be cancelled on release.
 */
function useRowLongPress(onLongPress: (() => void) | undefined) {
	const timerRef = useRef<number | null>(null);
	const firedRef = useRef(false);

	const cancel = () => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	};

	return {
		/** True when the press already fired as a long press — the click is a no-op. */
		consumeLongPress: () => {
			if (!firedRef.current) return false;
			firedRef.current = false;
			return true;
		},
		handlers: {
			onTouchStart: () => {
				firedRef.current = false;
				if (!onLongPress) return;
				timerRef.current = window.setTimeout(() => {
					timerRef.current = null;
					firedRef.current = true;
					onLongPress();
				}, 600);
			},
			onTouchEnd: cancel,
			onTouchMove: cancel,
			onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
		},
	};
}

/**
 * A name the user typed outranks one we derived: `herdr pane rename` is them
 * saying what the pane is for, where `claude` only says what is running.
 */
function paneDisplayName(pane: PaneInfo): string {
	return pane.label || pane.agentName || pane.currentCommand || "shell";
}

function paneNameColorClass(pane: PaneInfo): string {
	if (pane.agentColor && AGENT_NAME_COLORS[pane.agentColor]) {
		return AGENT_NAME_COLORS[pane.agentColor];
	}
	const isAgentPane =
		isAgentProvider(pane.currentCommand ?? "") || !!pane.agentName;
	return isAgentPane ? "text-green-300" : "text-zinc-300";
}

function paneDotClass(state: IndicatorState | undefined): string {
	return state === "processing"
		? "bg-blue-400"
		: state === "waiting_input"
			? "bg-yellow-400 animate-pulse"
			: "bg-zinc-600";
}

/**
 * herdr labels a tab with its number until it is renamed. "Tab 3" reads better
 * than a bare "3", but a renamed tab ("Recipes") wants no prefix.
 */
function tabDisplayLabel(label: string, t: TFunction): string {
	return /^\d+$/.test(label) ? `${t("session.tab")} ${label}` : label;
}

/**
 * The pane a collapsed card speaks for. Priority is what the user would have to
 * act on: a pane waiting on them, then one still working, then whichever spoke
 * most recently.
 */
function pickLeadPane(panes: PaneInfo[]): PaneInfo | undefined {
	const rank = (p: PaneInfo) =>
		p.indicatorState === "waiting_input"
			? 0
			: p.indicatorState === "processing"
				? 1
				: 2;
	const spokeAt = (p: PaneInfo) => (p.recapAt ? Date.parse(p.recapAt) : 0);
	// sort() is stable, so panes that tie on every key keep herdr's order.
	return [...panes].sort(
		(a, b) =>
			rank(a) - rank(b) ||
			spokeAt(b) - spokeAt(a) ||
			Number(b.isActive) - Number(a.isActive),
	)[0];
}

/**
 * Context-window gauge. The card header, the pane rows and the collapsed
 * summary all draw the same one — the color thresholds are what make it
 * readable at a glance, so they live in a single place.
 */
function ContextMeter({ metrics }: { metrics: SessionMetrics }) {
	if (typeof metrics.contextPercent !== "number") return null;
	const percent = metrics.contextPercent;
	return (
		<div
			className="inline-flex items-center gap-1.5"
			title={`${formatTokenCount(metrics.contextTokens ?? 0)} / ${formatTokenCount(metrics.contextMaxTokens ?? 0)}`}
		>
			<span className="text-zinc-600">ctx</span>
			<div className="w-14 h-1 bg-white/10 rounded-full overflow-hidden">
				<div
					className={`h-full transition-all ${
						percent >= 80
							? "bg-red-500"
							: percent >= 60
								? "bg-amber-500"
								: "bg-emerald-500"
					}`}
					style={{ width: `${Math.max(2, percent)}%` }}
				/>
			</div>
			<span className="font-mono tabular-nums">{percent.toFixed(1)}%</span>
		</div>
	);
}

function MemoryLabel({ bytes }: { bytes?: number }) {
	if (typeof bytes !== "number" || bytes <= 0) return null;
	return (
		<span className="font-mono tabular-nums" title={`${bytes} bytes`}>
			<span className="text-zinc-600">mem</span> {formatBytes(bytes)}
		</span>
	);
}

/**
 * What a multi-pane / multi-tab workspace says while collapsed.
 *
 * Model, ctx and recap live on the pane rows because one card-level number
 * cannot say which pane it describes — but that left the busiest workspaces as
 * the least informative rows in the list: a title, a "3 panes" badge, nothing
 * else. So the pane that most wants attention speaks for the card, and the
 * others shrink to a chip carrying only their state and context use.
 */
function CollapsedWorkspaceSummary({
	lead,
	panes,
	tabs,
}: {
	lead: PaneInfo;
	panes: PaneInfo[];
	tabs?: TabInfo[];
}) {
	const { t, i18n } = useTranslation();
	const rest = panes.filter((p) => p.paneId !== lead.paneId);
	const leadTab =
		tabs && tabs.length > 1
			? tabs.find((tab) => tab.id === lead.tabId)
			: undefined;

	return (
		<div className="mt-1.5">
			<div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-[11px] text-zinc-500">
				<span className="inline-flex items-center gap-1.5 min-w-0">
					<span
						className={`w-1.5 h-1.5 rounded-full shrink-0 ${paneDotClass(lead.indicatorState)}`}
					/>
					<span
						className={`text-[12px] font-medium truncate ${paneNameColorClass(lead)}`}
					>
						{paneDisplayName(lead)}
					</span>
				</span>
				{leadTab && (
					<span className="text-zinc-600 shrink-0">
						{tabDisplayLabel(leadTab.label, t)}
					</span>
				)}
				{lead.metrics?.model && (
					<span title={lead.metrics.model}>
						{formatModelName(lead.metrics.model)}
					</span>
				)}
				{lead.metrics && <ContextMeter metrics={lead.metrics} />}
				<MemoryLabel bytes={lead.metrics?.memoryRssBytes} />
			</div>
			{lead.recap && (
				<p className="mt-1 text-[12px] text-amber-200 leading-relaxed line-clamp-2">
					{lead.recap}
					{lead.recapAt && (
						<span className="ml-2 text-[10px] text-zinc-500">
							{formatRelativeTime(lead.recapAt, t, i18n.language)}
						</span>
					)}
				</p>
			)}
			{rest.length > 0 && (
				<div className="mt-1 flex items-center gap-x-3 gap-y-1 flex-wrap text-[11px]">
					{rest.map((pane) => (
						<span
							key={pane.paneId}
							className="inline-flex items-center gap-1.5 min-w-0"
						>
							<span
								className={`w-1.5 h-1.5 rounded-full shrink-0 ${paneDotClass(pane.indicatorState)}`}
							/>
							<span className="truncate max-w-[9rem] text-zinc-400">
								{paneDisplayName(pane)}
							</span>
							{typeof pane.metrics?.contextPercent === "number" && (
								<span className="font-mono tabular-nums text-zinc-600 shrink-0">
									{pane.metrics.contextPercent.toFixed(1)}%
								</span>
							)}
						</span>
					))}
				</div>
			)}
		</div>
	);
}

/** One pane of a tab: status dot, agent name, then its metrics and recap. */
function PaneRow({
	session,
	pane,
	bridgePaneId,
	onSelect,
	onSelectPane,
	onClosePane,
	activateTab,
}: {
	session: ExtendedSessionResponse;
	pane: PaneInfo;
	bridgePaneId?: string;
	onSelect: (session: ExtendedSessionResponse) => void;
	onSelectPane?: (session: ExtendedSessionResponse, paneId: string) => void;
	onClosePane?: (sessionId: string, paneId: string, name: string) => void;
	/**
	 * Set only when this pane sits in a tab the workspace is not rendering.
	 * Awaited before opening the pane so the terminal is already on the right
	 * tab by the time it subscribes.
	 */
	activateTab?: () => void | Promise<void>;
}) {
	const { t, i18n } = useTranslation();
	const displayName = paneDisplayName(pane);
	const nameColor = paneNameColorClass(pane);
	const paneIndicator = pane.indicatorState;
	const dotClass = paneDotClass(paneIndicator);

	const { consumeLongPress, handlers } = useRowLongPress(
		onClosePane
			? () => onClosePane(session.id, pane.paneId, displayName)
			: undefined,
	);

	return (
		<div>
			<button
				type="button"
				onClick={async () => {
					if (consumeLongPress()) return;
					// A pane in another tab is only readable from here; the terminal
					// shows one tab at a time. Switch before opening it, or the tap
					// lands on some other tab's pane.
					if (activateTab) await activateTab();
					if (onSelectPane) {
						onSelectPane(session, pane.paneId);
					} else {
						onSelect(session);
					}
				}}
				{...handlers}
				className="w-full min-h-11 flex items-center gap-2 px-3 py-1.5 rounded-md text-left transition-colors hover:bg-white/[0.04]"
			>
				<span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
				<span className={`text-[13px] font-medium truncate ${nameColor}`}>
					{displayName}
				</span>
				{!pane.agentName && <span className="flex-1" />}
				{paneIndicator === "processing" && (
					<span className="text-[10px] text-blue-400 bg-blue-500/15 px-1.5 py-0.5 rounded-full shrink-0">
						{t("session.processing")}
					</span>
				)}
				{pane.isActive && (
					<span className="text-[10px] text-cyan-400 bg-cyan-500/15 px-1.5 py-0.5 rounded-full shrink-0">
						{t("session.paneFocused")}
					</span>
				)}
				<ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
			</button>
			{pane.metrics && (
				<div className="ml-6 flex items-center gap-3 flex-wrap text-[11px] text-zinc-500">
					{pane.metrics.model && (
						<span className="text-zinc-500" title={pane.metrics.model}>
							{formatModelName(pane.metrics.model)}
						</span>
					)}
					<ContextMeter metrics={pane.metrics} />
					<MemoryLabel bytes={pane.metrics.memoryRssBytes} />
				</div>
			)}
			{pane.recap && (
				<p className="ml-6 mt-0.5 mb-1 text-[12px] text-zinc-400 leading-relaxed line-clamp-2">
					{pane.recap}
					{pane.recapAt && (
						<span className="ml-2 text-[10px] text-zinc-600">
							{formatRelativeTime(pane.recapAt, t, i18n.language)}
						</span>
					)}
				</p>
			)}
			{pane.paneId === bridgePaneId && (
				<button
					type="button"
					onClick={() => {
						const bridgeId = session.bridgeSessionId;
						if (!bridgeId) return;
						openClaudeAppSession(bridgeId);
					}}
					className="ml-6 mt-1 mb-1 inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px] text-violet-200 bg-violet-500/15 hover:bg-violet-500/25 transition-colors"
				>
					<ExternalLink className="w-3.5 h-3.5" />
					{t("session.openInClaudeApp")}
				</button>
			)}
		</div>
	);
}

/**
 * The heading a tab's panes sit under. Every tab lists its panes, so there is
 * nothing here to open or expand — tapping a pane is what switches the
 * workspace to the tab that owns it. The highlight marks the tab the terminal
 * is currently rendering; the row itself only closes (long press, or the ✕ on
 * hover for desktop, which has no long press).
 */
function TabRow({
	session,
	tab,
	isActive,
	canClose,
	onCloseTab,
}: {
	session: ExtendedSessionResponse;
	tab: TabInfo;
	isActive: boolean;
	canClose: boolean;
	onCloseTab?: (
		session: ExtendedSessionResponse,
		tabId: string,
		label: string,
	) => void;
}) {
	const { t } = useTranslation();
	const label = tabDisplayLabel(tab.label, t);

	const closeTab =
		canClose && onCloseTab
			? () => onCloseTab(session, tab.id, tab.label)
			: undefined;
	const { handlers } = useRowLongPress(closeTab);

	return (
		<div className="group/tab flex items-center gap-1">
			<div
				{...handlers}
				className={`flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-md ${
					isActive ? "bg-cyan-500/10" : ""
				}`}
			>
				<span
					className={`text-[13px] font-medium truncate ${
						isActive ? "text-cyan-200" : "text-zinc-400"
					}`}
				>
					{label}
				</span>
				<span className="flex-1" />
				<span className="text-[11px] text-zinc-600 shrink-0">
					{t("session.panes", { count: tab.paneCount })}
				</span>
			</div>
			{/* Desktop only. opacity-0 still takes hit tests, so on a phone — where
			    the hover that reveals it never happens — this left an invisible
			    26px "close tab" target at the row's edge. Touch closes by long
			    press instead. */}
			{closeTab && (
				<button
					type="button"
					onClick={closeTab}
					title={t("session.closeTabTitle")}
					aria-label={t("session.closeTabTitle")}
					className="hidden [@media(hover:hover)]:flex shrink-0 min-h-11 px-2.5 items-center justify-center rounded-md text-zinc-600 opacity-0 transition-opacity hover:text-red-400 hover:bg-red-500/10 group-hover/tab:opacity-100 focus-visible:opacity-100"
				>
					<X className="w-3.5 h-3.5" />
				</button>
			)}
		</div>
	);
}

// Session item with long press to show menu
function SessionItem({
	session,
	onSelect,
	onSelectPane,
	onShowMenu,
	onResume,
	onDelete,
	onClosePane,
	onSelectTab,
	onCreateTab,
	onCloseTab,
}: {
	session: ExtendedSessionResponse;
	onSelect: (session: ExtendedSessionResponse) => void;
	onSelectPane?: (session: ExtendedSessionResponse, paneId: string) => void;
	onShowMenu: (session: ExtendedSessionResponse) => void;
	onResume?: (sessionId: string, ccSessionId?: string) => void;
	onDelete?: (sessionId: string, peerId?: string) => void;
	onShowConversation?: (
		ccSessionId: string,
		title: string,
		subtitle: string,
		isActive: boolean,
	) => void;
	onPaneAction?: (
		sessionId: string,
		action: "focus" | "close" | "split",
		paneId: string,
		direction?: "h" | "v",
	) => void;
	onClosePane?: (sessionId: string, paneId: string, name: string) => void;
	/** Switch the workspace to a tab. Awaited before opening a pane it owns. */
	onSelectTab?: (
		session: ExtendedSessionResponse,
		tabId: string,
	) => void | Promise<void>;
	onCreateTab?: (session: ExtendedSessionResponse) => void;
	onCloseTab?: (session: ExtendedSessionResponse, tabId: string, label: string) => void;
}) {
	const { t, i18n } = useTranslation();
	const longPressTimerRef = useRef<number | null>(null);
	const longPressFiredRef = useRef(false);

	const startLongPress = () => {
		longPressFiredRef.current = false;
		longPressTimerRef.current = window.setTimeout(() => {
			longPressFiredRef.current = true;
			onShowMenu(session);
		}, 600);
	};

	const cancelLongPress = () => {
		if (longPressTimerRef.current) {
			clearTimeout(longPressTimerRef.current);
			longPressTimerRef.current = null;
		}
	};

	const handleTouchStart = () => {
		startLongPress();
	};

	const handleMouseDown = (e: React.MouseEvent) => {
		// Only handle left click
		if (e.button !== 0) return;
		startLongPress();
	};

	const handleContextMenu = (e: React.MouseEvent) => {
		// Prevent browser context menu on long press
		e.preventDefault();
	};

	const handleTouchEnd = () => {
		cancelLongPress();
	};

	const handleMouseUp = () => {
		cancelLongPress();
	};

	const handleMouseLeave = () => {
		// Cancel long press when mouse leaves the element
		cancelLongPress();
	};

	const handleTouchMove = () => {
		// Cancel long press when touch moves (scrolling)
		cancelLongPress();
	};

	const handleTouchCancel = () => {
		cancelLongPress();
		longPressFiredRef.current = false;
	};

	const [panesExpanded, setPanesExpanded] = useState(false);
	const [showJumpMenu, setShowJumpMenu] = useState(false);

	const handleClick = () => {
		if (longPressFiredRef.current) {
			longPressFiredRef.current = false;
			return;
		}
		longPressFiredRef.current = false;

		// Remote Control session: let the user choose between jumping to the Hrdle
		// terminal and opening the matching session in the Claude app.
		// Multi-pane sessions skip the session-level jump menu — "go to terminal"
		// is ambiguous there, so the actions live on the pane rows instead (row
		// tap navigates; the Claude-app link nests under the bridge pane).
		// Expandable when there is more than one pane OR more than one tab — the
		// expanded area lists both so the user can switch tabs / panes from here.
		const canExpand =
			(session.panes && session.panes.length > 1) ||
			(session.tabs && session.tabs.length > 1);

		if (session.bridgeSessionId) {
			if (canExpand) {
				setPanesExpanded((prev) => !prev);
			} else {
				setShowJumpMenu((prev) => !prev);
			}
			return;
		}

		// Multi-pane / multi-tab session: toggle the list to show tabs + panes
		if (canExpand) {
			setPanesExpanded((prev) => !prev);
			return;
		}

		onSelect(session);
	};

	const extSession = session;
	const agent = extSession.agent ?? extSession.currentCommand;
	// Multi-pane Remote Control: the Claude-app link belongs to the pane running
	// the session's agent (same detection as the backend's isClaudeOnPane), so
	// nest it under that row instead of the session-level jump menu.
	const bridgePaneId =
		extSession.bridgeSessionId && extSession.panes
			? extSession.panes.find((p) => p.currentCommand === agent)?.paneId
			: undefined;
	const supportsConversationMetadata = agentSupportsConversationMetadata(agent);
	const agentLabel =
		agent && isAgentProvider(agent)
			? t(AGENT_PROVIDERS[agent].labelKey)
			: undefined;
	// Multi-pane / multi-tab workspace: a single card-header summary of
	// model/ctx/mem would be ambiguous, so those move to the per-pane rows.
	const isMultiWorkspace =
		(extSession.panes?.length ?? 0) > 1 || (extSession.tabs?.length ?? 0) > 1;
	// A single-tab workspace has no hierarchy worth drawing — its panes are
	// listed flat, with the "new tab" action still available underneath.
	const hasTabTree = (extSession.tabs?.length ?? 0) > 1;
	// ...but a collapsed card would then carry nothing but its badges, so one
	// pane stands in for the workspace until the rows themselves are on screen.
	const collapsedLead =
		isMultiWorkspace && !panesExpanded
			? pickLeadPane(extSession.panes ?? [])
			: undefined;
	// Derive card-level indicatorState from panes (priority: waiting_input > processing > idle)
	const cardIndicator: IndicatorState | undefined = (() => {
		if (extSession.panes && extSession.panes.length > 0) {
			if (extSession.panes.some((p) => p.indicatorState === "waiting_input"))
				return "waiting_input";
			if (extSession.panes.some((p) => p.indicatorState === "processing"))
				return "processing";
		}
		// Fallback to session-level indicatorState
		return extSession.indicatorState;
	})();

	// Use indicatorState (not waitingForInput) to determine badge display
	const isWaiting = cardIndicator === "waiting_input";
	const hasWaitingTool =
		!!extSession.waitingToolName && extSession.waitingToolName !== "UserInput";
	const waitingLabel =
		extSession.waitingToolName === "AskUserQuestion"
			? t("session.waitingQuestion")
			: extSession.waitingToolName === "EnterPlanMode"
				? t("session.waitingPlan")
				: extSession.waitingToolName === "ExitPlanMode"
					? t("session.waitingPlan")
					: extSession.waitingToolName === "UserInput"
						? t("session.waitingInput")
						: t("session.waitingPermission");
	const shortPath = toHomeShortPath(extSession.currentPath);

	// Use customTitle if set, otherwise use session name
	const displayTitle = session.customTitle ? session.customTitle : session.name;
	const stewardLine = useContext(StewardLinesContext).get(session.id);

	// Show resume button only when no agent is currently running and we have a
	// conversation id we can resume from (Claude → ccSessionId, Codex → agentSessionId).
	const isAgentRunning = !!extSession.agent;
	const showResumeButton =
		!isAgentRunning && (extSession.ccSessionId || extSession.agentSessionId);

	const handleResume = (e: React.MouseEvent) => {
		e.stopPropagation();
		onResume?.(session.id, extSession.ccSessionId);
	};

	// Show long-press hint only for first few visits
	const hintKey = storageKey("longpress-hint-seen");
	const hintSeen =
		typeof localStorage !== "undefined" && localStorage.getItem(hintKey);
	if (!hintSeen && typeof localStorage !== "undefined") {
		localStorage.setItem(hintKey, "1");
	}

	const isLost = session.state === "lost";
	const isLive =
		!isLost &&
		(cardIndicator === "processing" || cardIndicator === "waiting_input");
	// The peer color ranks below the theme: a peer color only says which server a
	// session lives on, so an explicit theme from the user wins.
	const peerAccentColor =
		extSession.peerId && extSession.peerId !== "local"
			? extSession.peerColor
			: undefined;
	const accentColor = session.theme
		? ACCENT_HEX[session.theme]
		: peerAccentColor;
	const peerBadge =
		extSession.peerNickname && extSession.peerId && extSession.peerId !== "local"
			? { nickname: extSession.peerNickname, color: extSession.peerColor ?? "#64748b" }
			: null;

	// Lost session: show recreate UI
	if (isLost) {
		return (
			<div className="group relative rounded-lg transition-all duration-200 select-none opacity-50 hover:opacity-70">
				{accentColor && (
					<div
						className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full"
						style={{ backgroundColor: accentColor }}
					/>
				)}
				<div className={`px-4 py-3 ${accentColor ? "pl-5" : ""}`}>
					<div className="flex items-center gap-2 mb-1">
						<h3 className="text-[15px] font-medium truncate flex-1 tracking-[-0.01em] text-zinc-500">
							{displayTitle}
						</h3>
						<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-zinc-500/15 text-zinc-500">
							{t("session.lost", "Lost")}
						</span>
					</div>
					{shortPath && (
						<p className="text-[12px] text-zinc-600 truncate mb-1.5">
							{shortPath}
						</p>
					)}
					{agentLabel && (
						<div className="mb-2 flex items-center gap-2 text-[11px] text-zinc-500">
							<span className="inline-flex items-center px-2 py-0.5 rounded-full font-medium bg-zinc-500/15 text-zinc-500">
								{agentLabel}
							</span>
						</div>
					)}
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={() => onResume?.(session.id, extSession.ccSessionId)}
							className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] font-medium bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 transition-colors"
						>
							<Play className="w-3 h-3" />
							{t("session.resume", "Resume")}
						</button>
						<button
							type="button"
							onClick={() => onDelete?.(session.id, extSession.peerId)}
							className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] font-medium bg-zinc-600/20 text-zinc-400 hover:bg-red-600/20 hover:text-red-400 transition-colors"
						>
							<X className="w-3 h-3" />
							{t("common.delete", "Delete")}
						</button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div
			onClick={handleClick}
			onTouchStart={handleTouchStart}
			onTouchMove={handleTouchMove}
			onTouchEnd={handleTouchEnd}
			onTouchCancel={handleTouchCancel}
			onMouseDown={handleMouseDown}
			onMouseUp={handleMouseUp}
			onMouseLeave={handleMouseLeave}
			onContextMenu={handleContextMenu}
			style={{
				touchAction: "pan-y",
				WebkitTouchCallout: "none",
				WebkitUserSelect: "none",
			}}
			className="group relative rounded-lg transition-all duration-200 cursor-pointer select-none hover:bg-white/[0.04] active:bg-white/[0.06]"
		>
			{/* Accent bar */}
			{accentColor && (
				<div
					className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full"
					style={{ backgroundColor: accentColor }}
				/>
			)}

			<div className={`px-4 py-3 ${accentColor ? "pl-5" : ""}`}>
				{/* Top row: title + path + status badges */}
				<div className="flex items-baseline gap-2 mb-1 min-w-0">
					<h3
						className={`text-[15px] font-medium truncate shrink-0 max-w-[55%] tracking-[-0.01em] ${
							isLive
								? "text-white"
								: supportsConversationMetadata
									? "text-zinc-300"
									: "text-zinc-400"
						}`}
					>
						{displayTitle}
					</h3>
					{shortPath && (
						<span className="text-[12px] text-zinc-500 truncate font-mono flex-1 min-w-0">
							{shortPath}
						</span>
					)}

					{/* Status badge - pill style */}
					{isWaiting && hasWaitingTool ? (
						<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/15 text-amber-400">
							<span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
							{waitingLabel}
						</span>
					) : cardIndicator === "processing" ? (
						<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-500/15 text-blue-400">
							<span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
							{t("session.processing")}
						</span>
					) : showResumeButton ? (
						<button
							type="button"
							onClick={handleResume}
							onMouseDown={(e) => e.stopPropagation()}
							onTouchStart={(e) => e.stopPropagation()}
							className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
						>
							<Play className="w-3 h-3" />
							{t("session.resume")}
						</button>
					) : null}

					{/* Secondary badge: pane count (only if > 1) */}
					{extSession.panes && extSession.panes.length > 1 && (
						<span className="text-[11px] px-2 py-0.5 rounded-full shrink-0 text-cyan-400 bg-cyan-500/15">
							{t("session.panes", { count: extSession.panes.length })}
						</span>
					)}

					{/* Secondary badge: tab count (only if the workspace has > 1 tab) */}
					{extSession.tabs && extSession.tabs.length > 1 && (
						<span className="text-[11px] px-2 py-0.5 rounded-full shrink-0 text-violet-300 bg-violet-500/15">
							{t("session.tabsCount", { count: extSession.tabs.length })}
						</span>
					)}
				</div>

				{/* Auto recap (away_summary) — timestamp shown inline at the tail.
				    For a multi-pane/multi-tab workspace it moves to the per-pane
				    rows (like model/ctx/mem), so hide the header copy there. */}
				{!isMultiWorkspace && extSession.ccRecap && (
					<p className="mt-1 text-[12px] text-amber-200 leading-relaxed line-clamp-3">
						{extSession.ccRecap}
						{extSession.ccRecapAt && (
							<span className="ml-2 text-[10px] text-zinc-500">
								{formatRelativeTime(extSession.ccRecapAt, t, i18n.language)}
							</span>
						)}
					</p>
				)}

				{/* Last prompt / summary — hide when a recap is present (the recap
				    already covers it), including the lead pane's own recap below. */}
				{!extSession.ccRecap &&
					!collapsedLead?.recap &&
					(extSession.ccSummary || extSession.ccFirstPrompt) && (
						<p className="mt-1.5 text-[12px] text-zinc-600 leading-relaxed line-clamp-2">
							{extSession.ccSummary || extSession.ccFirstPrompt}
						</p>
					)}

				{/* Metadata row: agent / context / memory / tokens.
				    For a multi-pane/multi-tab workspace, model/ctx/mem move to the
				    per-pane rows (below), so only the peer badge stays here. */}
				{(peerBadge || (!isMultiWorkspace && (agentLabel || extSession.metrics))) && (
					<div className="mt-1.5 flex items-center gap-3 flex-wrap text-[11px] text-zinc-500">
						{peerBadge && (
							<span
								className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium"
								style={{
									backgroundColor: `${peerBadge.color}26`,
									color: peerBadge.color,
								}}
							>
								<span
									className="w-1.5 h-1.5 rounded-full"
									style={{ backgroundColor: peerBadge.color }}
								/>
								{peerBadge.nickname}
							</span>
						)}
						{!isMultiWorkspace && agentLabel && (
							<span className="inline-flex items-center px-2 py-0.5 rounded-full font-medium bg-zinc-500/15 text-zinc-400">
								{agentLabel}
								{extSession.metrics?.model && (
									<span
										className="ml-1.5 text-zinc-500"
										title={extSession.metrics.model}
									>
										{formatModelName(extSession.metrics.model)}
									</span>
								)}
							</span>
						)}
						{!isMultiWorkspace && extSession.metrics && (
							<ContextMeter metrics={extSession.metrics} />
						)}
						{!isMultiWorkspace && (
							<MemoryLabel bytes={extSession.metrics?.memoryRssBytes} />
						)}
					</div>
				)}

				{/* What the steward wrote about this workspace. It speaks for the
				    whole card - the recaps below it are per pane - so it takes the
				    place of the collapsed summary rather than sitting beside it. */}
				{stewardLine ? (
					<p className="mt-1 line-clamp-2 text-[12px] text-sky-200 leading-relaxed">
						{stewardLine}
					</p>
				) : (
					collapsedLead && (
						<CollapsedWorkspaceSummary
							lead={collapsedLead}
							panes={extSession.panes ?? []}
							tabs={extSession.tabs}
						/>
					)
				)}

				{!hintSeen && (
					<div className="text-[11px] text-zinc-700 mt-1">
						{t("session.longPressHint")}
					</div>
				)}
			</div>

			{/* Jump menu (Remote Control): choose Hrdle terminal vs the Claude app.
			    Single-pane only — multi-pane sessions carry these actions per pane. */}
			{showJumpMenu &&
				extSession.bridgeSessionId &&
				(!extSession.panes || extSession.panes.length <= 1) && (
				<div
					className="mx-4 mb-3 pt-2 border-t border-white/[0.06] flex flex-col gap-1"
					onClick={(e) => e.stopPropagation()}
					onMouseDown={(e) => e.stopPropagation()}
					onTouchStart={(e) => e.stopPropagation()}
				>
					<button
						type="button"
						onClick={() => {
							setShowJumpMenu(false);
							onSelect(session);
						}}
						className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-[13px] text-zinc-200 bg-white/[0.04] hover:bg-white/[0.08] transition-colors"
					>
						<ArrowRight className="w-3.5 h-3.5 text-zinc-400" />
						{t("session.goToTerminal")}
					</button>
					<button
						type="button"
						onClick={() => {
							const bridgeId = extSession.bridgeSessionId;
							if (!bridgeId) return;
							setShowJumpMenu(false);
							openClaudeAppSession(bridgeId);
						}}
						className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-[13px] text-violet-200 bg-violet-500/15 hover:bg-violet-500/25 transition-colors"
					>
						<ExternalLink className="w-3.5 h-3.5" />
						{t("session.openInClaudeApp")}
					</button>
				</div>
			)}

			{/* Tab / pane tree (expandable). herdr's model is workspace > tab >
			    pane, so the panes nest under the tab that owns them, every tab
			    showing its own. The terminal still renders one tab at a time, so
			    opening a pane parked in another one switches the workspace over
			    first — the tab row itself has nothing left to select. Long-press a
			    row to close it (tabs also get a hover ✕, since desktop has no long
			    press). */}
			{panesExpanded && (hasTabTree || extSession.panes) && (
				<div
					className="mx-4 mb-3 pt-2 border-t border-white/[0.06]"
					onClick={(e) => e.stopPropagation()}
					onMouseDown={(e) => e.stopPropagation()}
					onTouchStart={(e) => e.stopPropagation()}
				>
					{hasTabTree
						? extSession.tabs?.map((tab) => {
								const isActive =
									tab.active || extSession.activeTabId === tab.id;
								return (
									<div key={tab.id}>
										<TabRow
											session={session}
											tab={tab}
											isActive={isActive}
											canClose={(extSession.tabs?.length ?? 0) > 1}
											onCloseTab={onCloseTab}
										/>
										{/* `panes` spans every tab now, so each tab takes its
                        own. Rendering them all under the active one would
                        claim a pane belongs where it does not. A pane with no
                        tabId predates the field and stays with the active tab,
                        which is where it always appeared. */}
										{extSession.panes && (
											<div className="ml-4 pl-1 border-l border-white/[0.08]">
												{extSession.panes
													.filter((p) =>
														p.tabId ? p.tabId === tab.id : isActive,
													)
													.map((pane) => (
														<PaneRow
															key={pane.paneId}
															session={extSession}
															pane={pane}
															bridgePaneId={bridgePaneId}
															onSelect={onSelect}
															onSelectPane={onSelectPane}
															onClosePane={onClosePane}
															activateTab={
																isActive
																	? undefined
																	: () => onSelectTab?.(session, tab.id)
															}
														/>
													))}
											</div>
										)}
									</div>
								);
							})
						: extSession.panes?.map((pane) => (
								<PaneRow
									key={pane.paneId}
									session={extSession}
									pane={pane}
									bridgePaneId={bridgePaneId}
									onSelect={onSelect}
									onSelectPane={onSelectPane}
									onClosePane={onClosePane}
								/>
							))}
					{onCreateTab && (
						<button
							type="button"
							onClick={() => onCreateTab(session)}
							className="w-full min-h-11 flex items-center gap-2 px-2 rounded-md text-[12px] text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04] transition-colors"
						>
							<Plus className="w-3.5 h-3.5 shrink-0" />
							{t("session.newTab")}
						</button>
					)}
				</div>
			)}

		</div>
	);
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
	onToggleSteward,
	stewardOpen = false,
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
	// Empty unless the steward is on AND this screen is set to show it, so a row
	// falls back to exactly what it rendered before.
	const stewardLines = useStewardLines();

	const [sessionForMenu, setSessionForMenu] = useState<SessionResponse | null>(
		null,
	);
	const [paneToClose, setPaneToClose] = useState<{
		sessionId: string;
		paneId: string;
		name: string;
	} | null>(null);
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
								name: data.tmuxSessionId,
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

	const handleCreateSession = async (
		name: string,
		workingDir?: string,
		agent?: AgentProvider,
		peerId?: string,
	) => {
		setCreateError(null);
		try {
			const session = await createSession(name || undefined, workingDir, agent, peerId);
			if (session) {
				setShowCreateModal(false);
				onSelectSession(session);
			}
		} catch (err) {
			const error = err as Error & {
				data?: { error?: string; existingSession?: string };
			};
			if (error.data?.error === "duplicate_working_dir") {
				setCreateError(
					t("session.duplicateWorkingDir", {
						name: error.data.existingSession || "",
					}),
				);
			} else {
				setCreateError(error.message || t("common.error"));
			}
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

	return (
		<StewardLinesContext.Provider value={stewardLines}>
		<div className="h-full flex flex-col bg-[#0a0a0a] text-white overflow-hidden">
			{/* ─── Header: frosted glass ─── */}
			<div className="shrink-0 px-4 pt-3 pb-2 bg-[#0a0a0a]/80 backdrop-blur-xl border-b border-white/[0.06] sticky top-0 z-10">
				<div className="max-w-lg">
					{/* Top row: tabs + actions. No separate "Sessions" title — the
					    active segmented tab (Workspaces / History) already labels the
					    view, and dropping the title row widens the list area. */}
					<div className="flex items-center justify-between gap-2 mb-2">
						<div className="flex items-center gap-2 min-w-0">
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
									className={`px-5 py-1.5 text-[13px] font-medium rounded-md transition-all duration-200 ${
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
									className={`px-5 py-1.5 text-[13px] font-medium rounded-md transition-all duration-200 ${
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
						<div className="flex items-center gap-1 shrink-0">
							{onToggleSteward && (
								<button
									type="button"
									onClick={onToggleSteward}
									className={`p-2 rounded-lg transition-colors ${
										stewardOpen
											? "text-blue-400 bg-blue-500/20"
											: "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06]"
									}`}
									title={t("steward.title")}
								>
									<MessagesSquare className="w-[18px] h-[18px]" />
								</button>
							)}
							{onToggleDashboard && (
								<button
									type="button"
									onClick={onToggleDashboard}
									className={`p-2 rounded-lg transition-colors ${
										dashboardOpen
											? "text-blue-400 bg-blue-500/20"
											: "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06]"
									}`}
									title={t("dashboard.title")}
								>
									<BarChart3 className="w-[18px] h-[18px]" />
								</button>
							)}
							<button
								type="button"
								onClick={() => setShowSearch(!showSearch)}
								className="p-2 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
							>
								<Search className="w-[18px] h-[18px]" />
							</button>
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

					{/* Search bar (expandable) */}
					{showSearch && (
						<div className="mb-2">
							<div className="relative max-w-sm">
								<Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
								<input
									// biome-ignore lint/a11y/noAutofocus: search input is only mounted on user toggle; immediate focus is expected UX
									autoFocus
									value={searchQuery}
									onChange={(e) => setSearchQuery(e.target.value)}
									placeholder={`${t("session.title")}...`}
									className="w-full pl-9 pr-3 py-2 bg-white/[0.05] border border-white/[0.08] rounded-lg text-[13px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all"
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
						</div>
					)}

				</div>
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
					onClick={() => setPaneToClose(null)}
				>
					<div
						className="bg-th-surface rounded-lg p-6 max-w-sm w-full mx-4 shadow-xl animate-modal-in"
						onClick={(e) => e.stopPropagation()}
					>
						<h3 className="text-lg font-bold text-th-text mb-2">Close Pane</h3>
						<p className="text-th-text-secondary mb-4">
							<span className="font-medium text-th-text">
								{paneToClose.name}
							</span>{" "}
							will be closed. Continue?
						</p>
						<div className="flex gap-3 justify-end">
							<button
								type="button"
								onClick={() => setPaneToClose(null)}
								className="px-4 py-2 bg-th-surface-active hover:bg-th-surface-hover rounded font-medium transition-colors text-th-text"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={async () => {
									try {
										// Route to the owning Hub/peer instead of always the
										// local Hub — otherwise closing a pane on a remote
										// peer's session silently fails (or, on id collision,
										// closes the wrong pane).
										const session = sessions.find(
											(s) => s.id === paneToClose.sessionId,
										);
										await sessionFetch(
											session,
											peers,
											`/api/workspaces/${encodeURIComponent(paneToClose.sessionId)}/panes/close`,
											{
												method: "POST",
												headers: { "Content-Type": "application/json" },
												body: JSON.stringify({ paneId: paneToClose.paneId }),
											},
										);
									} catch {}
									setPaneToClose(null);
								}}
								className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded font-medium transition-colors text-white"
							>
								Close
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
						setShowCreateModal(false);
						setCreateError(null);
					}}
					existingNames={new Set(sessions.map((s) => s.name))}
					externalError={createError}
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
		</StewardLinesContext.Provider>
	);
}
