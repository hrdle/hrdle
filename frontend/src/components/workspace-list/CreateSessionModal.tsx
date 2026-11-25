/** biome-ignore-all lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: legacy click-on-div UI; keyboard navigation provided via main shortcuts */
import { Folder, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AGENT_PROVIDER_IDS, AGENT_PROVIDERS, type AgentProvider, DEFAULT_AGENT_PROVIDER, type FileInfo, LOCAL_PEER_ID, type PeerClientView } from "../../../../shared/types";
import { toHomeShortPath } from "../../utils/path";
import { authFetch } from "../../services/api";

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

// Create session modal with directory picker
export function CreateSessionModal({
	onConfirm,
	onCancel,
	existingNames,
	externalError,
	agentFailure,
	onOpenCreated,
	peers,
}: {
	onConfirm: (
		name: string,
		workingDir?: string,
		agent?: AgentProvider,
		peerId?: string,
	) => Promise<void>;
	onCancel: () => void;
	existingNames: Set<string>;
	externalError?: string | null;
	/** The workspace was created but its agent did not start. */
	agentFailure?: { name: string; agent: AgentProvider; message: string } | null;
	onOpenCreated?: () => void;
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
	const [creating, setCreating] = useState(false);
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

	const handleSubmit = async () => {
		setCreating(true);
		try {
			await onConfirm(name, currentPath, agent, isRemote ? selectedPeerId : undefined);
		} finally {
			setCreating(false);
		}
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
					{agentFailure && (
						<div
							role="alert"
							className="text-xs text-amber-400 mb-2 break-words"
						>
							{t("session.agentStartFailed", {
								name: agentFailure.name,
								agent: t(AGENT_PROVIDERS[agentFailure.agent].labelKey),
								message: agentFailure.message,
							})}
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
					{agentFailure ? (
						// Creating again would make a second workspace beside the one
						// that already exists.
						<button
							type="button"
							onClick={onOpenCreated}
							className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded font-medium transition-colors text-sm"
						>
							{t("session.openWorkspace")}
						</button>
					) : (
						<button
							type="button"
							onClick={handleSubmit}
							disabled={creating}
							className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:hover:bg-blue-600 rounded font-medium transition-colors text-sm"
						>
							{creating ? t("session.startingAgent") : t("common.create")}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
