/** biome-ignore-all lint/correctness/useExhaustiveDependencies: depends on refs and setters that React guarantees stable; adding them would cause unintended re-runs */
/** biome-ignore-all lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: legacy click-on-div UI; keyboard navigation provided via main shortcuts */
import {
	ArrowLeft,
	BarChart3,
	ChevronDown,
	Download,
	Eye,
	EyeOff,
	FileText,
	MessageSquare,
	MoreHorizontal,
	Pencil,
	RotateCw,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	FileChange,
	FileContent,
	FileInfo,
	GitFileChange,
} from "../../../../shared/types";
import { useAuthBlobUrl } from "../../hooks/useAuthBlobUrl";
import { useFileViewer } from "../../hooks/useFileViewer";
import {
	type ListMode,
	type SelectedGitDiff,
	useViewHistory,
	type ViewMode,
} from "../../hooks/useViewHistory";
import { authFetch } from "../../services/api";
import {
	addRecentDir,
	expandPath,
	getBookmarks,
	getRecentDirs,
	homeOf,
	promptPathFor,
	toggleBookmark,
} from "../../utils/file-places";
import { toHomeShortPath } from "../../utils/path";
import { ChangesView } from "./ChangesView";
import { CreateMenu } from "./CreateMenu";
import { FileActionsSheet } from "./FileActionsSheet";
import { type ChangeKind, FileBrowser } from "./FileBrowser";
import { FileContentView } from "./FileContentView";
import { FileEditor } from "./FileEditor";
import { JumpSheet, type SessionPlace } from "./JumpSheet";
import { ViewerSettingsMenu } from "./ViewerSettingsMenu";
import {
	getFileName,
	isHtmlFile,
	isImageFile,
	isMarkdownFile,
	isMediaFile,
	isModelFile,
} from "./file-types";

interface FileViewerProps {
	sessionWorkingDir: string;
	/** Peer that owns the files on disk. Unset / "local" → the Hub. */
	peerId?: string;
	/** The focused pane's Claude session, whose edits the changes list shows. */
	claudeSessionId?: string;
	onClose: () => void;
	initialPath?: string;
	onCopyPrompt?: (text: string) => void;
	hidden?: boolean;
	onShowSessions?: () => void;
	// Terminal-style toolbar props
	sessionName?: string;
	sessionStatus?:
		| "working"
		| "waiting_input"
		| "waiting_permission"
		| "idle"
		| "disconnected"
		| "lost";
	onShowConversation?: () => void;
	onShowDashboard?: () => void;
	/** The other sessions' directories on the same machine, offered as places to go. */
	sessionPlaces?: SessionPlace[];
}

/** A text file read whole, which the editor can save back. */
function isEditable(file: FileContent | null): file is FileContent {
	return (
		!!file &&
		file.encoding === "utf-8" &&
		!file.truncated &&
		!!file.hash &&
		!isImageFile(file.path) &&
		!isMediaFile(file.path) &&
		!isModelFile(file.path)
	);
}

function asFileInfo(file: FileContent): FileInfo {
	const name = getFileName(file.path);
	const dot = name.lastIndexOf(".");
	return {
		name,
		path: file.path,
		type: "file",
		size: file.size,
		modifiedAt: new Date().toISOString(),
		isHidden: name.startsWith("."),
		extension: dot > 0 ? name.slice(dot) : undefined,
	};
}

export function FileViewer({
	sessionWorkingDir,
	peerId,
	claudeSessionId,
	onClose,
	initialPath,
	onCopyPrompt,
	hidden,
	onShowSessions,
	sessionName,
	sessionStatus,
	onShowConversation,
	onShowDashboard,
	sessionPlaces = [],
}: FileViewerProps) {
	const { t, i18n } = useTranslation();
	const {
		currentPath,
		files,
		selectedFile,
		changes,
		gitChanges,
		gitBranch,
		isLoading,
		error,
		listDirectory,
		readFile,
		getChanges,
		getGitChanges,
		getGitDiff,
	} = useFileViewer(sessionWorkingDir, peerId, claudeSessionId);

	// Files API prefix that matches the peer (`/api/files` for local, the
	// `/api/peers/<id>/files` proxy for remote). Used for upload/download/raw
	// URLs that don't go through useFileViewer.
	const filesApiBase =
		peerId && peerId !== "local" ? `/api/peers/${peerId}/files` : "/api/files";

	const [viewMode, setViewMode] = useState<ViewMode>("browser");
	const [listMode, setListMode] = useState<ListMode>("browser");
	// Bumped by the reload button to force FileBrowser to refetch its
	// already-expanded subtrees (whose contents are otherwise cached forever).
	const [browserRefresh, setBrowserRefresh] = useState(0);
	const [previewMode, setPreviewMode] = useState(false);
	const [showHidden, setShowHidden] = useState(false);
	const [selectedChange, setSelectedChange] = useState<FileChange | null>(null);
	const [selectedGitDiff, setSelectedGitDiff] =
		useState<SelectedGitDiff | null>(null);
	const [uploading, setUploading] = useState(false);
	const [uploadMessage, setUploadMessage] = useState<{
		text: string;
		isError: boolean;
	} | null>(null);
	const uploadInputRef = useRef<HTMLInputElement>(null);

	// `<img src>` / `<video src>` / `<audio src>` cannot send the Bearer auth
	// header, so /files/raw 401s when HRDLE_PASSWORD is set. Fetch the bytes via
	// authFetch and present them as a same-origin blob: URL instead. The STL
	// viewer reads the same blob rather than the URL, for the same reason.
	const rawUrl =
		selectedFile &&
		(isImageFile(selectedFile.path) ||
			isMediaFile(selectedFile.path) ||
			isModelFile(selectedFile.path))
			? `${filesApiBase}/raw?path=${encodeURIComponent(selectedFile.path)}&sessionWorkingDir=${encodeURIComponent(sessionWorkingDir)}`
			: null;
	const rawBlobUrl = useAuthBlobUrl(rawUrl);

	// Scroll ratio to preserve scroll position across preview/source toggle
	const scrollRatioRef = useRef(0);
	const handleScrollRatioChange = useCallback((ratio: number) => {
		scrollRatioRef.current = ratio;
	}, []);
	const togglePreviewMode = useCallback(() => {
		setPreviewMode((prev) => !prev);
	}, []);
	const enablePreviewMode = useCallback(() => {
		setPreviewMode(true);
	}, []);

	// Back-navigation (history stack synced with window.history + Escape).
	const { pushToHistory, handleBack } = useViewHistory({
		onRestore: (prev) => {
			setViewMode(prev.viewMode);
			setListMode(prev.listMode);
			setSelectedChange(prev.selectedChange);
			setSelectedGitDiff(prev.selectedGitDiff);
			// Keep selectedFile around even when returning to browser view so the
			// FileBrowser can highlight the most recently opened file.
		},
		onClose,
	});

	const handleUploadClick = useCallback(() => {
		uploadInputRef.current?.click();
	}, []);

	const handleUploadFiles = useCallback(
		async (e: React.ChangeEvent<HTMLInputElement>) => {
			const fileList = e.target.files;
			console.log(`[upload] files selected: ${fileList?.length ?? 0}`);
			if (!fileList || fileList.length === 0) return;

			setUploading(true);
			for (const f of Array.from(fileList)) {
				console.log(`[upload] ${f.name} (${f.size}B, ${f.type})`);
			}

			try {
				const formData = new FormData();
				formData.append("path", currentPath);
				formData.append("sessionWorkingDir", sessionWorkingDir);
				// Read files into Blobs first — on some mobile PWAs, the File reference
				// from input[type=file] goes stale before fetch can read it.
				for (const f of Array.from(fileList)) {
					const buf = await f.arrayBuffer();
					formData.append(
						"file",
						new Blob([buf], { type: f.type || "application/octet-stream" }),
						f.name,
					);
				}
				console.log("[upload] sending POST /api/files/upload");
				// authFetch attaches the Bearer token while letting the browser set
				// the multipart Content-Type itself. Plain fetch() would 401 whenever
				// HRDLE_PASSWORD is set.
				const res = await authFetch(
					`${filesApiBase}/upload`,
					{ method: "POST", body: formData },
					300_000,
				);
				console.log(`[upload] response: ${res.status}`);
				if (!res.ok) {
					const err = await res
						.json()
						.catch(() => ({ error: `${res.status}` }));
					setUploadMessage({
						text: t("files.uploadFailed", {
						error: err.error || res.statusText,
					}),
						isError: true,
					});
					return;
				}
				const result = await res.json().catch(() => null);
				const names =
					result?.files?.map((f: { name: string }) => f.name).join(", ") || "";
				setUploadMessage({
				text: t("files.uploaded", { names }),
				isError: false,
			});
				await listDirectory(currentPath);
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Unknown error";
				console.error(`[upload] error: ${msg}`, err);
				setUploadMessage({
				text: t("files.uploadFailed", { error: msg }),
				isError: true,
			});
			} finally {
				setUploading(false);
				if (uploadInputRef.current) uploadInputRef.current.value = "";
				// Auto-dismiss toast after 4s
				setTimeout(() => setUploadMessage(null), 4000);
			}
		},
		[currentPath, sessionWorkingDir, listDirectory],
	);

	const downloadPath = useCallback(async (path: string) => {
		const url = `${filesApiBase}/download?path=${encodeURIComponent(path)}&sessionWorkingDir=${encodeURIComponent(sessionWorkingDir)}`;
		// <a href> cannot send the Bearer header, so /files/download 401s when
		// HRDLE_PASSWORD is set. Fetch via authFetch, materialise into a blob,
		// and trigger the anchor against the object URL.
		try {
			const res = await authFetch(url, {}, 300_000);
			if (!res.ok) return;
			const cd = res.headers.get("content-disposition") ?? "";
			const dispMatch = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)"?/i);
			const fallback = path.split("/").pop() ?? "download";
			let filename = fallback;
			if (dispMatch?.[1]) {
				try {
					filename = decodeURIComponent(dispMatch[1]);
				} catch {
					filename = dispMatch[1];
				}
			}
			const blob = await res.blob();
			const objectUrl = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = objectUrl;
			a.download = filename;
			a.rel = "noopener";
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
		} catch {
			// best-effort download — surface nothing extra to the user
		}
	}, [sessionWorkingDir, filesApiBase]);
	const handleDownloadFile = useCallback(() => {
		if (selectedFile) void downloadPath(selectedFile.path);
	}, [selectedFile, downloadPath]);

	// Detect wide screen for two-pane layout
	const [isWideScreen, setIsWideScreen] = useState(
		() => window.innerWidth >= 768,
	);

	// Resizable left pane
	const [leftPaneWidth, setLeftPaneWidth] = useState(300);
	const isResizing = useRef(false);
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const handleResize = () => setIsWideScreen(window.innerWidth >= 768);
		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, []);

	// Handle pane resize
	const handleResizeStart = useCallback(
		(e: React.MouseEvent | React.TouchEvent) => {
			e.preventDefault();
			isResizing.current = true;
			document.body.style.cursor = "col-resize";
			document.body.style.userSelect = "none";
		},
		[],
	);

	useEffect(() => {
		const handleResizeMove = (e: MouseEvent | TouchEvent) => {
			if (!isResizing.current || !containerRef.current) return;

			const containerRect = containerRef.current.getBoundingClientRect();
			const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
			const newWidth = clientX - containerRect.left;

			// Clamp between min and max
			const clampedWidth = Math.max(
				200,
				Math.min(newWidth, containerRect.width - 300),
			);
			setLeftPaneWidth(clampedWidth);
		};

		const handleResizeEnd = () => {
			if (isResizing.current) {
				isResizing.current = false;
				document.body.style.cursor = "";
				document.body.style.userSelect = "";
			}
		};

		document.addEventListener("mousemove", handleResizeMove);
		document.addEventListener("mouseup", handleResizeEnd);
		document.addEventListener("touchmove", handleResizeMove);
		document.addEventListener("touchend", handleResizeEnd);

		return () => {
			document.removeEventListener("mousemove", handleResizeMove);
			document.removeEventListener("mouseup", handleResizeEnd);
			document.removeEventListener("touchmove", handleResizeMove);
			document.removeEventListener("touchend", handleResizeEnd);
		};
	}, []);

	// The server's home directory, which `~` stands for. Asked rather than read
	// off a path: a session may live outside home (`/tmp`), and a peer's home is
	// not this browser's to guess.
	const [serverHome, setServerHome] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		authFetch(`${filesApiBase}/browse`)
			.then((res) => (res.ok ? res.json() : null))
			.then((data: { path?: string } | null) => {
				if (!cancelled && data?.path) setServerHome(data.path);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [filesApiBase]);
	const home = serverHome ?? homeOf(sessionWorkingDir) ?? homeOf(currentPath);
	const uniqueSessionPlaces = useMemo(() => {
		const seen = new Set<string>();
		return sessionPlaces.filter((p) => !seen.has(p.path) && seen.add(p.path));
	}, [sessionPlaces]);
	const [editing, setEditing] = useState(false);
	const editorDirtyRef = useRef(false);
	const [jumpOpen, setJumpOpen] = useState(false);
	const [menuTarget, setMenuTarget] = useState<FileInfo | null>(null);
	const [bookmarks, setBookmarks] = useState(getBookmarks);
	const [recentDirs, setRecentDirs] = useState(getRecentDirs);

	const showNotice = useCallback((text: string, isError = false) => {
		setUploadMessage({ text, isError });
		window.setTimeout(() => setUploadMessage(null), 4000);
	}, []);

	// What the agent did to each file, newest change per path. Read when the
	// viewer opens, not only on the changes tab, because the browser marks them.
	const latestChange = useMemo(() => {
		const map = new Map<string, FileChange>();
		for (const c of changes) {
			const prev = map.get(c.path);
			if (!prev || prev.timestamp < c.timestamp) map.set(c.path, c);
		}
		return map;
	}, [changes]);
	const changeKinds = useMemo(() => {
		const map = new Map<string, ChangeKind>();
		for (const c of changes) {
			if (c.toolName === "Write" && !map.has(c.path)) map.set(c.path, "created");
			else if (c.toolName === "Edit") map.set(c.path, "edited");
		}
		return map;
	}, [changes]);
	// The viewer stays mounted while hidden, so this runs each time it is shown.
	useEffect(() => {
		if (!hidden) void getChanges();
	}, [getChanges, hidden]);

	const refresh = useCallback(() => {
		void listDirectory(currentPath);
		void getChanges();
		setBrowserRefresh((n) => n + 1);
	}, [listDirectory, currentPath, getChanges]);

	const navigate = useCallback(
		async (path: string) => {
			setJumpOpen(false);
			setListMode("browser");
			setViewMode("browser");
			await listDirectory(path);
			setRecentDirs(addRecentDir(path));
		},
		[listDirectory],
	);

	const postJson = useCallback(
		async (endpoint: string, body: unknown): Promise<string | null> => {
			try {
				const res = await authFetch(`${filesApiBase}/${endpoint}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				if (res.ok) return null;
				const data = await res.json().catch(() => ({}));
				if (res.status === 409) return t("files.alreadyExistsOrNotEmpty");
				return data.error || res.statusText;
			} catch (err) {
				return err instanceof Error ? err.message : String(err);
			}
		},
		[filesApiBase, t],
	);

	const renameEntry = useCallback(
		async (target: FileInfo, newName: string) => {
			const parent = target.path.slice(0, target.path.lastIndexOf("/")) || "/";
			const to = expandPath(newName, home, parent);
			const err = await postJson("rename", { from: target.path, to });
			if (err) return err;
			refresh();
			if (selectedFile?.path === target.path) void readFile(to);
			return null;
		},
		[home, postJson, refresh, selectedFile, readFile],
	);

	const deleteEntry = useCallback(
		async (target: FileInfo) => {
			const err = await postJson("delete", { path: target.path });
			if (err) return err;
			refresh();
			if (selectedFile?.path === target.path) {
				setEditing(false);
				setViewMode("browser");
			}
			return null;
		},
		[postJson, refresh, selectedFile],
	);

	const copyPath = useCallback(
		async (path: string) => {
			try {
				await navigator.clipboard.writeText(path);
				showNotice(t("files.pathCopied"));
			} catch {
				showNotice(t("files.copyFailed"), true);
			}
		},
		[showNotice, t],
	);

	const attachToChat = useCallback(
		(path: string) => onCopyPrompt?.(`${promptPathFor(path, sessionWorkingDir)} `),
		[onCopyPrompt, sessionWorkingDir],
	);

	const closeEditor = useCallback(() => {
		setEditing(false);
		editorDirtyRef.current = false;
		if (selectedFile) void readFile(selectedFile.path);
	}, [selectedFile, readFile]);

	// A file opened for editing that turns out not to be editable text.
	useEffect(() => {
		if (editing && selectedFile && !isLoading && !isEditable(selectedFile)) {
			setEditing(false);
			showNotice(t("files.notEditable"), true);
		}
	}, [editing, selectedFile, isLoading, showNotice, t]);

	// Initialize
	useEffect(() => {
		const initPath = initialPath || sessionWorkingDir;
		listDirectory(initPath);
	}, [initialPath, sessionWorkingDir, listDirectory]);

	// Handle file selection
	const handleSelectFile = useCallback(
		async (file: FileInfo) => {
			if (editing) {
				if (editorDirtyRef.current) {
					showNotice(t("files.saveFirst"), true);
					return;
				}
				setEditing(false);
			}
			pushToHistory({ viewMode, listMode, selectedChange, selectedGitDiff });
			await readFile(file.path);
			setViewMode("file");
			setPreviewMode(false);
			scrollRatioRef.current = 0;
		},
		[
			readFile,
			viewMode,
			listMode,
			selectedChange,
			selectedGitDiff,
			editing,
			showNotice,
			t,
		],
	);

	const editFile = useCallback(
		async (file: FileInfo) => {
			if (selectedFile?.path !== file.path || viewMode !== "file") {
				await handleSelectFile(file);
			}
			setEditing(true);
		},
		[selectedFile, viewMode, handleSelectFile],
	);

	const createFile = useCallback(
		async (name: string) => {
			const path = expandPath(name, home, currentPath);
			const err = await postJson("write", { path, content: "", expectedHash: null });
			if (err) return err;
			refresh();
			await editFile({
				name: getFileName(path),
				path,
				type: "file",
				size: 0,
				modifiedAt: new Date().toISOString(),
				isHidden: getFileName(path).startsWith("."),
			});
			return null;
		},
		[home, currentPath, postJson, refresh, editFile],
	);

	const createFolder = useCallback(
		async (name: string) => {
			const err = await postJson("mkdir", { path: expandPath(name, home, currentPath) });
			if (err) return err;
			refresh();
			return null;
		},
		[home, currentPath, postJson, refresh],
	);

	// Handle changes tab - fetch both Claude and Git changes
	const handleShowChanges = useCallback(async () => {
		pushToHistory({ viewMode, listMode, selectedChange, selectedGitDiff });
		await Promise.all([getChanges(), getGitChanges()]);
		setListMode("changes");
		if (!isWideScreen) {
			setViewMode("changes");
		}
	}, [
		getChanges,
		getGitChanges,
		isWideScreen,
		viewMode,
		listMode,
		selectedChange,
		selectedGitDiff,
	]);

	// Handle browser tab
	const handleShowBrowser = useCallback(() => {
		pushToHistory({ viewMode, listMode, selectedChange, selectedGitDiff });
		setListMode("browser");
		if (!isWideScreen) {
			setViewMode("browser");
		}
	}, [isWideScreen, viewMode, listMode, selectedChange, selectedGitDiff]);

	// Handle change file click - show diff view (Claude changes)
	const handleChangeFileClick = useCallback(
		(change: FileChange) => {
			pushToHistory({ viewMode, listMode, selectedChange, selectedGitDiff });
			setSelectedChange(change);
			setSelectedGitDiff(null);
			setViewMode("diff");
		},
		[viewMode, listMode, selectedChange, selectedGitDiff],
	);

	// Handle git file click - fetch diff and show
	const handleGitFileClick = useCallback(
		async (change: GitFileChange) => {
			pushToHistory({ viewMode, listMode, selectedChange, selectedGitDiff });
			const diff = await getGitDiff(change.path, change.staged);
			setSelectedGitDiff({ path: change.path, diff });
			setSelectedChange(null);
			setViewMode("diff");
		},
		[getGitDiff, viewMode, listMode, selectedChange, selectedGitDiff],
	);

	// Handle open file from diff (wide screen)
	const handleOpenFileFromDiff = useCallback(async () => {
		const filePath =
			selectedChange?.path ||
			(selectedGitDiff ? `${sessionWorkingDir}/${selectedGitDiff.path}` : null);
		if (filePath) {
			pushToHistory({ viewMode, listMode, selectedChange, selectedGitDiff });
			await readFile(filePath);
			setSelectedChange(null);
			setSelectedGitDiff(null);
			setViewMode("file");
			setPreviewMode(false);
		}
	}, [
		selectedChange,
		selectedGitDiff,
		readFile,
		sessionWorkingDir,
		viewMode,
		listMode,
	]);

	// Current diff display name
	const currentDiffFileName =
		viewMode === "diff"
			? selectedChange
				? getFileName(selectedChange.path)
				: selectedGitDiff
					? getFileName(selectedGitDiff.path)
					: ""
			: "";

	// Check if content is showing
	const hasContent = viewMode === "file" || viewMode === "diff";

	const editingNow = editing && isEditable(selectedFile);

	const sheets = (
		<>
			{jumpOpen && (
				<JumpSheet
					currentPath={currentPath}
					workingDir={sessionWorkingDir}
					otherSessions={uniqueSessionPlaces}
					home={home}
					bookmarks={bookmarks}
					recent={recentDirs}
					filesApiBase={filesApiBase}
					onNavigate={(path) => void navigate(path)}
					onClose={() => setJumpOpen(false)}
				/>
			)}
			{menuTarget && (
				<FileActionsSheet
					target={menuTarget}
					editable={
						menuTarget.type !== "directory" &&
						!isImageFile(menuTarget.path) &&
						!isMediaFile(menuTarget.path) &&
						!isModelFile(menuTarget.path)
					}
					bookmarked={bookmarks.includes(menuTarget.path)}
					onAttach={onCopyPrompt ? () => attachToChat(menuTarget.path) : undefined}
					onEdit={() => void editFile(menuTarget)}
					onOpenDir={() => void navigate(menuTarget.path)}
					onCopyPath={() => void copyPath(menuTarget.path)}
					onDownload={() => void downloadPath(menuTarget.path)}
					onToggleBookmark={() => setBookmarks(toggleBookmark(menuTarget.path))}
					onRename={(name) => renameEntry(menuTarget, name)}
					onDelete={() => deleteEntry(menuTarget)}
					onClose={() => setMenuTarget(null)}
				/>
			)}
		</>
	);

	// Two-pane layout for wide screens
	if (isWideScreen) {
		return (
			<div
				className={`fixed inset-0 z-50 flex items-center justify-center ${hidden ? "hidden" : ""}`}
			>
				<div className="bg-[#0a0a0a] w-full h-full overflow-hidden flex flex-col">
					{/* Header - 2 rows: session bar on top, file controls below */}
					<div className="border-b border-white/[0.06]">
						{/* Row 1: Session bar (same as terminal toolbar) */}
						<div className="flex items-center gap-2 px-3 py-1.5">
							<button
								type="button"
								onClick={onShowSessions}
								className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-white/[0.06] transition-colors"
							>
								<div
									className={`w-2 h-2 rounded-full ${
										sessionStatus === "working"
											? "bg-blue-500"
											: (
														sessionStatus === "waiting_input" ||
															sessionStatus === "waiting_permission"
													)
												? "bg-amber-400 animate-pulse"
												: "bg-zinc-600"
									}`}
								/>
								<span className="text-[13px] font-medium text-white truncate max-w-[200px]">
									{sessionName || "-"}
								</span>
								<ChevronDown className="w-3 h-3 text-zinc-500" />
							</button>

							<div className="flex-1" />

							<div className="flex items-center gap-0.5">
								<button
									type="button"
									onClick={onClose}
									className="p-2 text-zinc-300 transition-colors"
									title={t("files.file")}
								>
									<FileText className="w-[18px] h-[18px]" />
								</button>
								{onShowDashboard && (
									<button
										type="button"
										onClick={onShowDashboard}
										className="p-2 text-zinc-500 hover:text-zinc-300 active:text-zinc-200 transition-colors"
										title={t("dashboard.title")}
									>
										<BarChart3 className="w-[18px] h-[18px]" />
									</button>
								)}
								<button
									type="button"
									onClick={refresh}
									className="p-2 text-zinc-500 hover:text-zinc-300 active:text-zinc-200 transition-colors"
									title={t("files.reload")}
								>
									<RotateCw className="w-[18px] h-[18px]" />
								</button>
							</div>
						</div>

						{/* Row 2: File controls */}
						<div className="flex items-center justify-between px-3 py-1.5">
							<div className="flex items-center gap-2">
								<button
									type="button"
									onClick={handleBack}
									className="p-1 text-zinc-500 hover:text-zinc-300 active:text-zinc-200 rounded transition-colors"
								>
									<ArrowLeft className="w-4 h-4" />
								</button>
								<h2 className="text-[13px] font-medium text-zinc-300">
									{t("files.title")}
								</h2>
							</div>

							<div className="flex items-center gap-1.5">
								<div className="inline-flex items-center bg-white/[0.04] rounded-md p-0.5">
									<button
										type="button"
										onClick={handleShowBrowser}
										className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
											listMode === "browser"
												? "bg-white/[0.08] text-zinc-300"
												: "text-zinc-600 hover:text-zinc-400"
										}`}
									>
										{t("files.browser")}
									</button>
									<button
										type="button"
										onClick={handleShowChanges}
										className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
											listMode === "changes"
												? "bg-white/[0.08] text-zinc-300"
												: "text-zinc-600 hover:text-zinc-400"
										}`}
									>
										{t("files.changes")}
									</button>
								</div>
								{listMode === "browser" && (
									<>
										<CreateMenu
											placement="down"
											size="sm"
											uploading={uploading}
											onNewFile={createFile}
											onNewFolder={createFolder}
											onUpload={handleUploadClick}
										/>
										<input
											ref={uploadInputRef}
											type="file"
											multiple
											className="hidden"
											onChange={handleUploadFiles}
										/>
										<button
											type="button"
											onClick={() => setShowHidden(!showHidden)}
											className={`p-1.5 rounded transition-colors ${showHidden ? "bg-blue-600 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
											title={t("files.showHidden")}
										>
											{showHidden ? (
												<Eye className="w-4 h-4" />
											) : (
												<EyeOff className="w-4 h-4" />
											)}
										</button>
									</>
								)}
								<button
									type="button"
									onClick={onClose}
									className="p-1.5 text-zinc-500 hover:text-zinc-300 active:text-zinc-200 transition-colors"
								>
									<X className="w-4 h-4" />
								</button>
							</div>
						</div>
					</div>

					{/* Error */}
					{error && (
						<div className="px-3 py-2 bg-red-900/50 text-red-300 text-sm border-b border-red-800">
							{error}
						</div>
					)}

					{/* Upload toast */}
					{uploadMessage && (
						<div
							className={`px-3 py-2 text-sm border-b ${uploadMessage.isError ? "bg-red-900/50 text-red-300 border-red-800" : "bg-green-900/50 text-green-300 border-green-800"}`}
						>
							{uploadMessage.text}
						</div>
					)}

					{/* Two-pane content */}
					<div ref={containerRef} className="flex-1 flex overflow-hidden">
						{/* Left pane: File list or Changes */}
						<div
							className="overflow-hidden flex flex-col shrink-0"
							style={{ width: leftPaneWidth }}
						>
							{listMode === "browser" ? (
								<FileBrowser
									files={files}
									currentPath={currentPath}
									sessionWorkingDir={sessionWorkingDir}
									isLoading={isLoading}
									onSelectFile={handleSelectFile}
									showHidden={showHidden}
									selectedPath={selectedFile?.path}
									refreshSignal={browserRefresh}
									filesApiBase={filesApiBase}
									changeKinds={changeKinds}
									onEntryMenu={setMenuTarget}
									onNavigate={(path) => void navigate(path)}
									onOpenJump={() => setJumpOpen(true)}
									home={home}
								/>
							) : (
								<ChangesView
									claudeChanges={changes}
									gitChanges={gitChanges}
									gitBranch={gitBranch}
									isLoading={isLoading}
									onSelectClaudeChange={handleChangeFileClick}
									onSelectGitChange={handleGitFileClick}
									selectedPath={selectedChange?.path || selectedGitDiff?.path}
								/>
							)}
						</div>

						{/* Resize handle */}
						<div
							className="w-1 bg-th-surface-hover hover:bg-blue-500 cursor-col-resize transition-colors shrink-0 touch-none"
							onMouseDown={handleResizeStart}
							onTouchStart={handleResizeStart}
						/>

						{/* Right pane: Content */}
						<div className="flex-1 overflow-hidden flex flex-col">
							{editing && isEditable(selectedFile) ? (
								<FileEditor
									key={selectedFile.path}
									file={selectedFile}
									filesApiBase={filesApiBase}
									onDirtyChange={(dirty) => {
										editorDirtyRef.current = dirty;
									}}
									onClose={closeEditor}
								/>
							) : hasContent ? (
								<>
									{/* Content header */}
									<div className="flex items-center gap-2 border-b border-th-border bg-th-surface/50 py-1 pl-3 pr-1.5">
										<div className="flex min-w-0 flex-1 flex-col">
											<span className="truncate text-sm text-th-text">
												{viewMode === "diff"
													? currentDiffFileName
													: selectedFile
														? getFileName(selectedFile.path)
														: ""}
											</span>
											{viewMode === "file" && selectedFile && (
												<span className="truncate font-mono text-[11px] text-th-text-muted">
													{toHomeShortPath(selectedFile.path)}
												</span>
											)}
										</div>
										{viewMode === "file" && selectedFile && (
											<AgentChangeChip change={latestChange.get(selectedFile.path)} lang={i18n.language} />
										)}
										{viewMode === "file" &&
											selectedFile &&
											(isMarkdownFile(selectedFile.path) ||
												isHtmlFile(selectedFile.path)) && (
												<PreviewSourceToggle previewMode={previewMode} onChange={setPreviewMode} />
											)}
										{viewMode === "file" && selectedFile && (
											<ViewerSettingsMenu fileName={getFileName(selectedFile.path)} placement="down" />
										)}
										{viewMode === "file" && isEditable(selectedFile) && (
											<button
												type="button"
												onClick={() => setEditing(true)}
												className="flex h-8 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs text-white"
											>
												<Pencil className="h-3.5 w-3.5" />
												{t("files.edit")}
											</button>
										)}
										{viewMode === "file" && selectedFile && (
											<button
												type="button"
												onClick={() => setMenuTarget(asFileInfo(selectedFile))}
												aria-label={t("files.moreActions")}
												className="flex h-10 w-10 items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-300"
											>
												<MoreHorizontal className="h-5 w-5" />
											</button>
										)}
										{viewMode === "diff" && (
											<button
												type="button"
												onClick={handleOpenFileFromDiff}
												className="px-2 py-1 text-xs bg-th-surface-hover hover:bg-th-surface-active rounded transition-colors"
											>
												{t("files.openFile")}
											</button>
										)}
									</div>
									{/* Content body */}
									<div className="flex-1 overflow-hidden">
										<FileContentView
											viewMode={viewMode}
											selectedFile={selectedFile}
											selectedChange={selectedChange}
											selectedGitDiff={selectedGitDiff}
											previewMode={previewMode}
											rawBlobUrl={rawBlobUrl}
											scrollRatio={scrollRatioRef.current}
											onScrollRatioChange={handleScrollRatioChange}
											onCopyPrompt={onCopyPrompt}
											onEnablePreview={enablePreviewMode}
											sessionWorkingDir={sessionWorkingDir}
											filesApiBase={filesApiBase}
											onDownload={handleDownloadFile}
										/>
									</div>
								</>
							) : (
								<div className="flex-1 flex items-center justify-center text-th-text-muted">
									<div className="text-center">
										<FileText
											className="w-12 h-12 mx-auto mb-2"
											strokeWidth={1.5}
										/>
										<div>{t("files.selectFile")}</div>
									</div>
								</div>
							)}
						</div>
					</div>
				</div>
				{sheets}
			</div>
		);
	}

	// Single-pane layout for narrow screens (mobile)
	return (
		<div
			className={`fixed inset-0 z-50 bg-[var(--color-overlay)] flex items-center justify-center ${hidden ? "hidden" : ""}`}
		>
			<div className="bg-th-bg w-full h-full overflow-hidden flex flex-col">
				{/* Error */}
				{error && (
					<div className="px-3 py-2 bg-red-900/50 text-red-300 text-sm border-b border-red-800">
						{error}
					</div>
				)}

				{/* Upload toast */}
				{uploadMessage && (
					<div
						className={`px-3 py-2 text-sm border-b ${uploadMessage.isError ? "bg-red-900/50 text-red-300 border-red-800" : "bg-green-900/50 text-green-300 border-green-800"}`}
					>
						{uploadMessage.text}
					</div>
				)}

				{/* Content */}
				<div className="flex-1 overflow-hidden">
					{editingNow && (
						<FileEditor
							key={selectedFile.path}
							file={selectedFile}
							filesApiBase={filesApiBase}
							onDirtyChange={(dirty) => {
								editorDirtyRef.current = dirty;
							}}
							onClose={closeEditor}
						/>
					)}
					<div className={editingNow ? "hidden" : "h-full flex flex-col"}>
					{/* Keep FileBrowser mounted across viewMode changes so its scroll
              position survives switching to a file view and back. */}
					<div className={viewMode === "browser" ? "min-h-0 flex-1" : "hidden"}>
						<FileBrowser
							files={files}
							currentPath={currentPath}
							sessionWorkingDir={sessionWorkingDir}
							isLoading={isLoading}
							onSelectFile={handleSelectFile}
							showHidden={showHidden}
							selectedPath={selectedFile?.path}
							refreshSignal={browserRefresh}
							filesApiBase={filesApiBase}
							changeKinds={changeKinds}
							onEntryMenu={setMenuTarget}
							onNavigate={(path) => void navigate(path)}
							onOpenJump={() => setJumpOpen(true)}
							home={home}
						/>
					</div>

					{viewMode === "file" && selectedFile && (
						<div className="flex shrink-0 items-center gap-2.5 border-b border-[#1a1a1a] bg-[#0f0f0f] px-4 py-2">
							<FileText className="h-[18px] w-[18px] shrink-0 text-th-text-secondary" />
							<div className="flex min-w-0 flex-col">
								<span className="truncate text-sm font-semibold">
									{getFileName(selectedFile.path)}
								</span>
								<span className="truncate font-mono text-[11px] text-th-text-muted">
									{toHomeShortPath(selectedFile.path.slice(0, selectedFile.path.lastIndexOf("/")))}
								</span>
							</div>
							<span className="ml-auto" />
							<AgentChangeChip change={latestChange.get(selectedFile.path)} lang={i18n.language} />
						</div>
					)}
					{(viewMode === "file" || viewMode === "diff") && (
						<div className="min-h-0 flex-1">
						<FileContentView
							viewMode={viewMode}
							selectedFile={selectedFile}
							selectedChange={selectedChange}
							selectedGitDiff={selectedGitDiff}
							previewMode={previewMode}
							rawBlobUrl={rawBlobUrl}
							scrollRatio={scrollRatioRef.current}
							onScrollRatioChange={handleScrollRatioChange}
							onCopyPrompt={onCopyPrompt}
							onEnablePreview={enablePreviewMode}
							sessionWorkingDir={sessionWorkingDir}
							filesApiBase={filesApiBase}
							onDownload={handleDownloadFile}
						/>
						</div>
					)}

					{viewMode === "changes" && (
						<ChangesView
							claudeChanges={changes}
							gitChanges={gitChanges}
							gitBranch={gitBranch}
							isLoading={isLoading}
							onSelectClaudeChange={handleChangeFileClick}
							onSelectGitChange={handleGitFileClick}
						/>
					)}
					</div>
				</div>

				{/* Footer controls - 2 rows for consistency with terminal toolbar */}
				{!editingNow && (
				<div className="border-t border-white/[0.06] bg-[#0a0a0a]">
					{/* Row 1: File viewer controls */}
					<div className="flex items-center gap-1 border-b border-white/[0.06] px-1.5 py-1">
						<button
							type="button"
							onClick={handleBack}
							aria-label={t("common.back")}
							className="p-2.5 text-zinc-500 hover:text-zinc-300 active:text-zinc-200 rounded transition-colors"
						>
							<ArrowLeft className="w-5 h-5" />
						</button>

						{viewMode === "file" && selectedFile ? (
							<>
								{(isMarkdownFile(selectedFile.path) || isHtmlFile(selectedFile.path)) && (
									<PreviewSourceToggle previewMode={previewMode} onChange={setPreviewMode} />
								)}
								<div className="flex-1" />
								<ViewerSettingsMenu fileName={getFileName(selectedFile.path)} placement="up" />
								{isEditable(selectedFile) && (
									<button
										type="button"
										onClick={() => setEditing(true)}
										className="flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-[13px] text-white"
									>
										<Pencil className="h-[15px] w-[15px]" />
										{t("files.edit")}
									</button>
								)}
								<button
									type="button"
									onClick={() => setMenuTarget(asFileInfo(selectedFile))}
									aria-label={t("files.moreActions")}
									className="p-2.5 text-zinc-500 hover:text-zinc-300"
								>
									<MoreHorizontal className="w-5 h-5" />
								</button>
							</>
						) : (
							<>
								<div className="inline-flex shrink-0 items-center rounded-lg border border-th-border bg-th-surface p-[3px]">
									<button
										type="button"
										onClick={handleShowBrowser}
										className={`h-8 whitespace-nowrap rounded-md px-3.5 text-[13px] transition-colors ${
											viewMode === "browser" ? "bg-th-surface-active text-th-text" : "text-th-text-secondary"
										}`}
									>
										{t("files.browser")}
									</button>
									<button
										type="button"
										onClick={handleShowChanges}
										className={`flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-3.5 text-[13px] transition-colors ${
											viewMode === "changes" || viewMode === "diff" ? "bg-th-surface-active text-th-text" : "text-th-text-secondary"
										}`}
									>
										{t("files.changes")}
										{latestChange.size > 0 && (
											<span className="text-[11px] text-amber-500">{latestChange.size}</span>
										)}
									</button>
								</div>
								{viewMode === "diff" && (
									<span className="ml-1 min-w-0 truncate text-[13px] text-th-text-secondary">
										{currentDiffFileName}
									</span>
								)}
								<div className="flex-1" />
								{viewMode === "browser" && (
									<>
										<CreateMenu
											placement="up"
											uploading={uploading}
											onNewFile={createFile}
											onNewFolder={createFolder}
											onUpload={handleUploadClick}
										/>
										<input
											ref={uploadInputRef}
											type="file"
											multiple
											className="hidden"
											onChange={handleUploadFiles}
										/>
										<button
											type="button"
											onClick={() => setShowHidden(!showHidden)}
											className={`p-2.5 rounded transition-colors ${showHidden ? "bg-blue-600 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
											title={t("files.showHidden")}
											aria-label={t("files.showHidden")}
										>
											{showHidden ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
										</button>
									</>
								)}
								<button
									type="button"
									onClick={onClose}
									aria-label={t("common.close")}
									className="p-2.5 text-zinc-500 hover:text-zinc-300 active:text-zinc-200 transition-colors"
								>
									<X className="w-5 h-5" />
								</button>
							</>
						)}
					</div>

					{/* Row 2: Terminal-style session bar (same as terminal toolbar) */}
					<div className="flex items-center gap-2 px-3 py-1.5">
						{/* Session selector */}
						<button
							type="button"
							onClick={onShowSessions}
							className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-white/[0.06] transition-colors"
						>
							<div
								className={`w-2 h-2 rounded-full ${
									sessionStatus === "working"
										? "bg-blue-500"
										: (
													sessionStatus === "waiting_input" ||
														sessionStatus === "waiting_permission"
												)
											? "bg-amber-400 animate-pulse"
											: "bg-zinc-600"
								}`}
							/>
							<span className="text-[13px] font-medium text-white truncate max-w-[140px]">
								{sessionName || "-"}
							</span>
							<ChevronDown className="w-3 h-3 text-zinc-500" />
						</button>

						<div className="flex-1" />

						{/* Same icons as terminal toolbar */}
						<div className="flex items-center gap-1">
							{onShowConversation && (
								<button
									type="button"
									onClick={onShowConversation}
									className="p-2.5 text-zinc-500 hover:text-zinc-300 active:text-zinc-200 transition-colors"
								>
									<MessageSquare className="w-5 h-5" />
								</button>
							)}
							<button
								type="button"
								onClick={onClose}
								className="p-2.5 text-zinc-500 hover:text-zinc-300 active:text-zinc-200 transition-colors"
								title={t("files.file")}
							>
								<FileText className="w-5 h-5 text-zinc-300" />
							</button>
							{onShowDashboard && (
								<button
									type="button"
									onClick={onShowDashboard}
									className="p-2.5 text-zinc-500 hover:text-zinc-300 active:text-zinc-200 transition-colors"
								>
									<BarChart3 className="w-5 h-5" />
								</button>
							)}
							<button
								type="button"
								onClick={refresh}
								className="p-2.5 text-zinc-500 hover:text-zinc-300 active:text-zinc-200 transition-colors"
								title={t("files.reload")}
							>
								<RotateCw className="w-5 h-5" />
							</button>
						</div>
					</div>
				</div>
				)}
			</div>
			{sheets}
		</div>
	);
}

function AgentChangeChip({
	change,
	lang,
}: {
	change: FileChange | undefined;
	lang: string;
}) {
	const { t } = useTranslation();
	if (!change) return null;
	const minutes = Math.round((Date.now() - new Date(change.timestamp).getTime()) / 60000);
	const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
	const when =
		minutes < 60
			? rtf.format(-minutes, "minute")
			: minutes < 60 * 24
				? rtf.format(-Math.round(minutes / 60), "hour")
				: rtf.format(-Math.round(minutes / 1440), "day");
	const created = change.toolName === "Write";
	return (
		<span
			className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] ${created ? "border-green-900 bg-green-950/60 text-green-400" : "border-[#3a2a0a] bg-[#1c1405] text-amber-500"}`}
			data-testid="agent-change-chip"
		>
			<span className={`h-[7px] w-[7px] rounded-full ${created ? "bg-green-500" : "bg-amber-500"}`} />
			{created
				? t("files.agentCreatedAt", { when })
				: t("files.agentEditedAt", { when })}
		</span>
	);
}

function PreviewSourceToggle({
	previewMode,
	onChange,
}: {
	previewMode: boolean;
	onChange: (preview: boolean) => void;
}) {
	const { t } = useTranslation();
	const seg = (active: boolean) =>
		`h-8 whitespace-nowrap rounded-md px-3 text-[13px] transition-colors ${active ? "bg-th-surface-active text-th-text" : "text-th-text-secondary"}`;
	return (
		<div className="flex shrink-0 rounded-lg border border-th-border bg-th-surface p-[3px]">
			<button type="button" className={seg(previewMode)} onClick={() => onChange(true)}>
				{t("files.preview")}
			</button>
			<button type="button" className={seg(!previewMode)} onClick={() => onChange(false)}>
				{t("files.source")}
			</button>
		</div>
	);
}
