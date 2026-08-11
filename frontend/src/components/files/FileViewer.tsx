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
	RotateCw,
	Upload,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	FileChange,
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
import { ChangesView } from "./ChangesView";
import { FileBrowser } from "./FileBrowser";
import { FileContentView } from "./FileContentView";
import {
	getFileName,
	isHtmlFile,
	isImageFile,
	isMarkdownFile,
	isMediaFile,
} from "./file-types";

interface FileViewerProps {
	sessionWorkingDir: string;
	/** Peer that owns the files on disk. Unset / "local" → the Hub. */
	peerId?: string;
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
}

export function FileViewer({
	sessionWorkingDir,
	peerId,
	onClose,
	initialPath,
	onCopyPrompt,
	hidden,
	onShowSessions,
	sessionName,
	sessionStatus,
	onShowConversation,
	onShowDashboard,
}: FileViewerProps) {
	const { t } = useTranslation();
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
	} = useFileViewer(sessionWorkingDir, peerId);

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
	// authFetch and present them as a same-origin blob: URL instead.
	const rawUrl =
		selectedFile &&
		(isImageFile(selectedFile.path) || isMediaFile(selectedFile.path))
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

	const handleDownloadFile = useCallback(async () => {
		if (!selectedFile) return;
		const url = `${filesApiBase}/download?path=${encodeURIComponent(selectedFile.path)}&sessionWorkingDir=${encodeURIComponent(sessionWorkingDir)}`;
		// <a href> cannot send the Bearer header, so /files/download 401s when
		// HRDLE_PASSWORD is set. Fetch via authFetch, materialise into a blob,
		// and trigger the anchor against the object URL.
		try {
			const res = await authFetch(url, {}, 300_000);
			if (!res.ok) return;
			const cd = res.headers.get("content-disposition") ?? "";
			const dispMatch = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)"?/i);
			const fallback = selectedFile.path.split("/").pop() ?? "download";
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
	}, [selectedFile, sessionWorkingDir, filesApiBase]);

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

	// Initialize
	useEffect(() => {
		const initPath = initialPath || sessionWorkingDir;
		listDirectory(initPath);
	}, [initialPath, sessionWorkingDir, listDirectory]);

	// Handle file selection
	const handleSelectFile = useCallback(
		async (file: FileInfo) => {
			pushToHistory({ viewMode, listMode, selectedChange, selectedGitDiff });
			await readFile(file.path);
			setViewMode("file");
			setPreviewMode(false);
			scrollRatioRef.current = 0;
		},
		[readFile, viewMode, listMode, selectedChange, selectedGitDiff],
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
									onClick={() => {
										listDirectory(currentPath);
										setBrowserRefresh((n) => n + 1);
									}}
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
										<button
											type="button"
											onClick={handleUploadClick}
											disabled={uploading}
											className="p-1.5 rounded text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50"
											title={
												uploading
												? t("files.uploading")
												: t("files.uploadTo", { path: currentPath })
											}
										>
											<Upload className="w-4 h-4" />
										</button>
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
							{hasContent ? (
								<>
									{/* Content header */}
									<div className="flex items-center gap-2 px-3 py-2 border-b border-th-border bg-th-surface/50">
										<span className="text-sm text-th-text-secondary truncate flex-1">
											{viewMode === "diff"
												? currentDiffFileName
												: selectedFile
													? getFileName(selectedFile.path)
													: ""}
										</span>
										{viewMode === "file" &&
											selectedFile &&
											(isMarkdownFile(selectedFile.path) ||
												isHtmlFile(selectedFile.path)) && (
												<button
													type="button"
													onClick={togglePreviewMode}
													className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${previewMode ? "bg-blue-600 text-white" : "bg-white/[0.04] hover:bg-white/[0.08] text-zinc-500"}`}
												>
													{previewMode ? t("files.source") : t("files.preview")}
												</button>
											)}
										{viewMode === "file" && selectedFile && (
											<button
												type="button"
												onClick={handleDownloadFile}
												className="p-1.5 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
												title={t("files.downloadFile")}
											>
												<Download className="w-4 h-4" />
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
					{/* Keep FileBrowser mounted across viewMode changes so its scroll
              position survives switching to a file view and back. */}
					<div className={viewMode === "browser" ? "h-full" : "hidden"}>
						<FileBrowser
							files={files}
							currentPath={currentPath}
							sessionWorkingDir={sessionWorkingDir}
							isLoading={isLoading}
							onSelectFile={handleSelectFile}
							showHidden={showHidden}
							selectedPath={selectedFile?.path}
						/>
					</div>

					{(viewMode === "file" || viewMode === "diff") && (
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

				{/* Footer controls - 2 rows for consistency with terminal toolbar */}
				<div className="border-t border-white/[0.06] bg-[#0a0a0a]">
					{/* Row 1: File viewer controls */}
					<div className="flex items-center justify-between px-3 py-1.5 border-b border-white/[0.06]">
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={handleBack}
								className="p-2.5 text-zinc-500 hover:text-zinc-300 active:text-zinc-200 rounded transition-colors"
							>
								<ArrowLeft className="w-5 h-5" />
							</button>
							<h2 className="text-[13px] font-medium text-zinc-300 truncate max-w-[84px]">
								{viewMode === "browser"
									? t("files.title")
									: viewMode === "changes"
										? t("files.changes")
										: viewMode === "diff"
											? currentDiffFileName
											: selectedFile
												? getFileName(selectedFile.path)
												: t("files.title")}
							</h2>
						</div>

						<div className="flex items-center gap-1.5">
							{/* Tab buttons */}
							<div className="inline-flex items-center bg-white/[0.04] rounded-md p-0.5">
								<button
									type="button"
									onClick={handleShowBrowser}
									className={`px-2.5 py-1.5 text-sm rounded font-medium transition-colors ${
										viewMode === "browser" || viewMode === "file"
											? "bg-white/[0.08] text-zinc-300"
											: "text-zinc-600 hover:text-zinc-400"
									}`}
								>
									{t("files.browser")}
								</button>
								<button
									type="button"
									onClick={handleShowChanges}
									className={`px-2.5 py-1.5 text-sm rounded font-medium transition-colors ${
										viewMode === "changes" || viewMode === "diff"
											? "bg-white/[0.08] text-zinc-300"
											: "text-zinc-600 hover:text-zinc-400"
									}`}
								>
									{t("files.changes")}
								</button>
							</div>

							{/* Preview/Source toggle */}
							{viewMode === "file" &&
								selectedFile &&
								(isMarkdownFile(selectedFile.path) ||
									isHtmlFile(selectedFile.path)) && (
									<button
										type="button"
										onClick={togglePreviewMode}
										className={`px-2.5 py-1.5 text-sm rounded font-medium transition-colors ${previewMode ? "bg-blue-600 text-white" : "bg-white/[0.04] hover:bg-white/[0.08] text-zinc-500"}`}
									>
										{previewMode ? t("files.source") : t("files.preview")}
									</button>
								)}

							{/* Upload + Hidden toggle (browser mode) */}
							{viewMode === "browser" && (
								<>
									<button
										type="button"
										onClick={handleUploadClick}
										disabled={uploading}
										className="p-2.5 rounded text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50"
										title={
											uploading
												? t("files.uploading")
												: t("files.uploadTo", { path: currentPath })
										}
									>
										<Upload className="w-5 h-5" />
									</button>
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
									>
										{showHidden ? (
											<Eye className="w-5 h-5" />
										) : (
											<EyeOff className="w-5 h-5" />
										)}
									</button>
								</>
							)}

							{/* Download button (file view mode) */}
							{viewMode === "file" && selectedFile && (
								<button
									type="button"
									onClick={handleDownloadFile}
									className="p-2.5 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
									title={t("files.download")}
								>
									<Download className="w-5 h-5" />
								</button>
							)}

							{/* Close file viewer */}
							<button
								type="button"
								onClick={onClose}
								className="p-2.5 text-zinc-500 hover:text-zinc-300 active:text-zinc-200 transition-colors"
							>
								<X className="w-5 h-5" />
							</button>
						</div>
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
								onClick={() => listDirectory(currentPath)}
								className="p-2.5 text-zinc-500 hover:text-zinc-300 active:text-zinc-200 transition-colors"
								title={t("files.reload")}
							>
								<RotateCw className="w-5 h-5" />
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
