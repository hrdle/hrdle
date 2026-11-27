/** biome-ignore-all lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: legacy click-on-div UI; keyboard navigation provided via main shortcuts */
import {
	ArrowDownUp,
	ChevronRight,
	File,
	FileCode,
	FileText,
	Folder,
	FolderOpen,
	Home,
	Image,
	Search,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileInfo } from "../../../../shared/types";
import { authFetch } from "../../services/api";
import { homeOf, pathCrumbs } from "../../utils/file-places";

export type ChangeKind = "created" | "edited";
type SortOrder = "name" | "modified";

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;

interface FileBrowserProps {
	files: FileInfo[];
	currentPath: string;
	sessionWorkingDir: string;
	isLoading: boolean;
	onSelectFile: (file: FileInfo) => void;
	showHidden?: boolean;
	/** Path of the file currently shown in the viewer (highlighted in the tree). */
	selectedPath?: string;
	/**
	 * Bumping this number forces a refetch of every currently-expanded directory
	 * (the in-memory `dirContents` cache is otherwise never invalidated). Wired
	 * to the toolbar reload button so newly created files/dirs appear.
	 */
	refreshSignal?: number;
	/** Files API prefix of the peer that owns the files. */
	filesApiBase: string;
	/** What the agent did to each file it touched, by absolute path. */
	changeKinds?: Map<string, ChangeKind>;
	/** A long press (or right-click) on an entry. */
	onEntryMenu?: (file: FileInfo) => void;
	/** A breadcrumb was tapped. */
	onNavigate?: (path: string) => void;
	/** The "move" button beside the breadcrumbs. */
	onOpenJump?: () => void;
	/** The server's home directory, shown as the first breadcrumb. */
	home?: string | null;
}

function formatRelativeTime(iso: string, lang: string): string {
	const diffSec = (new Date(iso).getTime() - Date.now()) / 1000;
	const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
	const abs = Math.abs(diffSec);
	if (abs < 60) return rtf.format(Math.round(diffSec), "second");
	if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
	if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
	if (abs < 86400 * 7) return rtf.format(Math.round(diffSec / 86400), "day");
	return new Date(iso).toLocaleDateString(lang, { month: "short", day: "numeric" });
}

function changeKindOf(
	file: FileInfo,
	changeKinds: Map<string, ChangeKind> | undefined,
): ChangeKind | null {
	if (!changeKinds || changeKinds.size === 0) return null;
	const own = changeKinds.get(file.path);
	if (own) return own;
	if (file.type !== "directory") return null;
	const prefix = `${file.path}/`;
	for (const [path, kind] of changeKinds) {
		if (path.startsWith(prefix)) return kind === "created" ? "created" : "edited";
	}
	return null;
}

/**
 * Long press without the browser's own menu, text selection or a click after
 * it. A press that moves is a scroll and is let go.
 *
 * The click a finger makes when it lifts arrives after the menu has opened
 * under it, on the menu's backdrop, and would close it again at once - so the
 * one click that follows a long press is swallowed.
 */
function swallowNextClick() {
	const stop = (e: Event) => {
		e.preventDefault();
		e.stopPropagation();
	};
	window.addEventListener("click", stop, { capture: true, once: true });
	window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 600);
}

function useLongPress(onLongPress: () => void) {
	const timer = useRef<number | null>(null);
	const start = useRef<{ x: number; y: number } | null>(null);
	const fired = useRef(false);
	const cancel = () => {
		if (timer.current !== null) window.clearTimeout(timer.current);
		timer.current = null;
		start.current = null;
	};
	return {
		fired,
		handlers: {
			onPointerDown: (e: React.PointerEvent) => {
				fired.current = false;
				if (e.button !== 0) return;
				start.current = { x: e.clientX, y: e.clientY };
				timer.current = window.setTimeout(() => {
					fired.current = true;
					timer.current = null;
					swallowNextClick();
					onLongPress();
				}, LONG_PRESS_MS);
			},
			onPointerMove: (e: React.PointerEvent) => {
				if (!start.current) return;
				if (
					Math.abs(e.clientX - start.current.x) > LONG_PRESS_SLOP_PX ||
					Math.abs(e.clientY - start.current.y) > LONG_PRESS_SLOP_PX
				)
					cancel();
			},
			onPointerUp: cancel,
			onPointerCancel: cancel,
			// A right-click, or the menu a touch browser raises for the same long
			// press the timer already answered.
			onContextMenu: (e: React.MouseEvent) => {
				e.preventDefault();
				cancel();
				if (fired.current) return;
				fired.current = true;
				onLongPress();
			},
		},
	};
}

// File type icons
function FileIcon({
	file,
	isExpanded,
}: {
	file: FileInfo;
	isExpanded?: boolean;
}) {
	if (file.type === "directory") {
		return isExpanded ? (
			<FolderOpen className="w-5 h-5 text-yellow-400" />
		) : (
			<Folder className="w-5 h-5 text-yellow-400" />
		);
	}

	// File type detection
	const ext = file.extension?.toLowerCase();

	// Code files
	if (
		[".ts", ".tsx", ".js", ".jsx", ".json", ".html", ".css", ".scss"].includes(
			ext || "",
		)
	) {
		return <FileCode className="w-5 h-5 text-blue-400" />;
	}

	// Image files
	if (
		[".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico"].includes(
			ext || "",
		)
	) {
		return <Image className="w-5 h-5 text-green-400" />;
	}

	// Markdown/text
	if ([".md", ".txt", ".yaml", ".yml", ".toml"].includes(ext || "")) {
		return <FileText className="w-5 h-5 text-th-text-secondary" />;
	}

	// Default file icon
	return <File className="w-5 h-5 text-th-text-muted" />;
}

function formatFileSize(bytes: number): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

// Chevron icon for expand/collapse
function ChevronIcon({ isExpanded }: { isExpanded: boolean }) {
	return (
		<ChevronRight
			className={`w-4 h-4 text-th-text-muted transition-transform ${isExpanded ? "rotate-90" : ""}`}
		/>
	);
}

interface TreeItemProps {
	file: FileInfo;
	depth: number;
	expandedDirs: Set<string>;
	dirContents: Map<string, FileInfo[]>;
	loadingDirs: Set<string>;
	onToggleDir: (path: string) => void;
	onSelectFile: (file: FileInfo) => void;
	showHidden: boolean;
	selectedPath?: string;
	changeKinds?: Map<string, ChangeKind>;
	onEntryMenu?: (file: FileInfo) => void;
	sortFiles: (files: FileInfo[]) => FileInfo[];
	lang: string;
}

function TreeItem({
	file,
	depth,
	expandedDirs,
	dirContents,
	loadingDirs,
	onToggleDir,
	onSelectFile,
	showHidden,
	selectedPath,
	changeKinds,
	onEntryMenu,
	sortFiles,
	lang,
}: TreeItemProps) {
	const isDirectory = file.type === "directory";
	const isExpanded = expandedDirs.has(file.path);
	const isLoading = loadingDirs.has(file.path);
	const children = dirContents.get(file.path) || [];
	const visibleChildren = sortFiles(
		showHidden ? children : children.filter((f) => !f.isHidden),
	);
	const isSelected = !isDirectory && selectedPath === file.path;
	const kind = changeKindOf(file, changeKinds);
	const longPress = useLongPress(() => onEntryMenu?.(file));

	const handleClick = () => {
		if (longPress.fired.current) {
			longPress.fired.current = false;
			return;
		}
		if (isDirectory) {
			onToggleDir(file.path);
		} else {
			onSelectFile(file);
		}
	};

	return (
		<>
			<div
				onClick={handleClick}
				{...longPress.handlers}
				data-path={file.path}
				className={`flex items-center gap-2 py-2.5 px-2 cursor-pointer select-none [-webkit-touch-callout:none] transition-colors ${
					isSelected
						? "bg-blue-500/15 text-blue-200 border-l-2 border-blue-400"
						: "border-l-2 border-transparent hover:bg-th-surface active:bg-th-surface-hover"
				}`}
				style={{ paddingLeft: `${depth * 20 + 8}px` }}
			>
				{/* Chevron for directories */}
				<div className="w-5 h-5 flex items-center justify-center shrink-0">
					{isDirectory &&
						(isLoading ? (
							<div className="w-4 h-4 border border-gray-500 border-t-transparent rounded-full animate-spin" />
						) : (
							<ChevronIcon isExpanded={isExpanded} />
						))}
				</div>

				{/* Icon */}
				<FileIcon file={file} isExpanded={isExpanded} />

				{/* Name, then what the agent did, when and how big */}
				<div className="flex-1 min-w-0 flex items-center gap-2">
					<span className="text-base truncate">{file.name}</span>
					<span className="ml-auto flex shrink-0 items-center gap-2 pr-1 text-xs text-th-text-muted">
						{kind && (
							<span
								className={`h-[7px] w-[7px] rounded-full ${kind === "created" ? "bg-green-500" : "bg-amber-500"}`}
								data-change-kind={kind}
							/>
						)}
						{!isDirectory && (
							<span>
								{formatRelativeTime(file.modifiedAt, lang)} · {formatFileSize(file.size)}
							</span>
						)}
					</span>
				</div>
			</div>

			{/* Children (if expanded) */}
			{isDirectory && isExpanded && visibleChildren.length > 0 && (
				<div>
					{visibleChildren.map((child) => (
						<TreeItem
							key={child.path}
							file={child}
							depth={depth + 1}
							expandedDirs={expandedDirs}
							dirContents={dirContents}
							loadingDirs={loadingDirs}
							onToggleDir={onToggleDir}
							onSelectFile={onSelectFile}
							showHidden={showHidden}
							selectedPath={selectedPath}
							changeKinds={changeKinds}
							onEntryMenu={onEntryMenu}
							sortFiles={sortFiles}
							lang={lang}
						/>
					))}
				</div>
			)}
		</>
	);
}

export function FileBrowser({
	files,
	currentPath,
	sessionWorkingDir,
	isLoading,
	onSelectFile,
	showHidden = false,
	selectedPath,
	refreshSignal,
	filesApiBase,
	changeKinds,
	onEntryMenu,
	onNavigate,
	onOpenJump,
	home,
}: FileBrowserProps) {
	const { t, i18n } = useTranslation();
	const [filter, setFilter] = useState("");
	const [sortOrder, setSortOrder] = useState<SortOrder>("name");
	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
	const [dirContents, setDirContents] = useState<Map<string, FileInfo[]>>(
		new Map(),
	);
	const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());

	const sortFiles = useCallback(
		(list: FileInfo[]) => {
			if (sortOrder === "name") return list;
			return [...list].sort((a, b) => {
				if (a.type === "directory" && b.type !== "directory") return -1;
				if (a.type !== "directory" && b.type === "directory") return 1;
				return b.modifiedAt.localeCompare(a.modifiedAt);
			});
		},
		[sortOrder],
	);

	// The filter narrows the top level: the tree below an expanded folder is
	// what the person opened on purpose.
	const needle = filter.trim().toLowerCase();
	const visibleFiles = sortFiles(
		(showHidden ? files : files.filter((f) => !f.isHidden)).filter(
			(f) => !needle || f.name.toLowerCase().includes(needle),
		),
	);

	// Load directory contents. `silent` skips the spinner and keeps the existing
	// cached children visible while refetching in the background — used when
	// re-expanding or refreshing a directory that's already been loaded.
	const loadDirContents = useCallback(
		async (path: string, opts?: { silent?: boolean }) => {
			const silent = opts?.silent ?? false;
			if (!silent) setLoadingDirs((prev) => new Set(prev).add(path));

			try {
				const params = new URLSearchParams({ path });
				const response = await authFetch(`${filesApiBase}/list?${params}`);

				if (response.ok) {
					const data = await response.json();
					setDirContents((prev) => new Map(prev).set(path, data.files));
				}
			} catch (err) {
				console.error("Failed to load directory:", err);
			} finally {
				if (!silent)
					setLoadingDirs((prev) => {
						const next = new Set(prev);
						next.delete(path);
						return next;
					});
			}
		},
		[filesApiBase],
	);

	// Toggle directory expand/collapse
	const handleToggleDir = useCallback(
		async (path: string) => {
			if (expandedDirs.has(path)) {
				// Collapse
				setExpandedDirs((prev) => {
					const next = new Set(prev);
					next.delete(path);
					return next;
				});
			} else {
				// Expand
				setExpandedDirs((prev) => new Set(prev).add(path));

				if (!dirContents.has(path)) {
					await loadDirContents(path);
				} else {
					// Cache exists but may be stale (files created after the first
					// expand). Show it immediately and refetch in the background.
					void loadDirContents(path, { silent: true });
				}
			}
		},
		[expandedDirs, dirContents, loadDirContents],
	);

	// When the toolbar reload button bumps `refreshSignal`, refetch every
	// currently-expanded directory so newly created entries become visible
	// without collapsing/re-expanding each one by hand.
	const expandedDirsRef = useRef(expandedDirs);
	expandedDirsRef.current = expandedDirs;
	const prevRefreshRef = useRef(refreshSignal);
	useEffect(() => {
		if (refreshSignal === prevRefreshRef.current) return;
		prevRefreshRef.current = refreshSignal;
		for (const path of expandedDirsRef.current) {
			void loadDirContents(path, { silent: true });
		}
	}, [refreshSignal, loadDirContents]);

	const crumbs = pathCrumbs(currentPath, home ?? homeOf(sessionWorkingDir) ?? homeOf(currentPath));
	const crumbsRef = useRef<HTMLDivElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the end whenever the path changes
	useEffect(() => {
		const el = crumbsRef.current;
		if (el) el.scrollLeft = el.scrollWidth;
	}, [currentPath]);

	// Show the loading placeholder only on the initial directory load (when no
	// files have arrived yet). Once we have a tree, keep it mounted so reading
	// a file's contents doesn't unmount the list and reset the user's scroll
	// position.
	const showLoadingPlaceholder = isLoading && visibleFiles.length === 0;

	return (
		<div className="flex flex-col h-full bg-th-bg text-th-text">
			<div className="flex shrink-0 items-center gap-2 border-b border-[#1a1a1a] px-3 py-2">
				<label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-th-border bg-th-surface px-2.5 text-th-text-muted">
					<Search className="h-4 w-4 shrink-0" />
					<input
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						placeholder={t("files.filterPlaceholder")}
						aria-label={t("files.filterPlaceholder")}
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						className="min-w-0 flex-1 bg-transparent text-sm text-th-text outline-none placeholder:text-th-text-muted"
					/>
				</label>
				<button
					type="button"
					onClick={() => setSortOrder((o) => (o === "name" ? "modified" : "name"))}
					className="flex h-9 shrink-0 items-center gap-1 rounded-lg border border-th-border px-2.5 text-xs text-th-text-secondary"
					aria-label={t("files.sortToggle")}
				>
					<ArrowDownUp className="h-3.5 w-3.5" />
					{sortOrder === "name" ? t("files.sortName") : t("files.sortModified")}
				</button>
			</div>

			{/* File tree */}
			<div className="flex-1 overflow-y-auto">
				{showLoadingPlaceholder ? (
					<div className="flex items-center justify-center h-32">
						<div className="text-th-text-muted">{t("common.loading")}</div>
					</div>
				) : visibleFiles.length === 0 ? (
					<div className="flex items-center justify-center h-32">
						<div className="text-th-text-muted">{t("files.noFiles")}</div>
					</div>
				) : (
					<div className="py-1">
						{visibleFiles.map((file) => (
							<TreeItem
								key={file.path}
								file={file}
								depth={0}
								expandedDirs={expandedDirs}
								dirContents={dirContents}
								loadingDirs={loadingDirs}
								onToggleDir={handleToggleDir}
								onSelectFile={onSelectFile}
								showHidden={showHidden}
								selectedPath={selectedPath}
								changeKinds={changeKinds}
								onEntryMenu={onEntryMenu}
								sortFiles={sortFiles}
								lang={i18n.language}
							/>
						))}
					</div>
				)}
			</div>

			{/* Path bar - at bottom, each step a way back up */}
			<div className="flex h-10 shrink-0 items-center gap-1 border-t border-th-border bg-[#0f0f0f] pl-2 pr-2">
				<div
					ref={crumbsRef}
					className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none]"
					title={currentPath}
				>
					{crumbs.length === 0 && (
						<button type="button" onClick={() => onNavigate?.("/")} className="px-1 py-1.5 font-mono text-[13px] text-th-text">
							/
						</button>
					)}
					{crumbs.map((c, i) => (
						<span key={c.path} className="flex shrink-0 items-center">
							{i > 0 && <span className="px-0.5 text-xs text-zinc-700">/</span>}
							<button
								type="button"
								onClick={() => onNavigate?.(c.path)}
								aria-label={c.isHome ? t("files.home") : undefined}
								className={`flex items-center whitespace-nowrap px-1 py-1.5 font-mono text-[13px] ${i === crumbs.length - 1 ? "font-medium text-th-text" : "text-th-text-secondary"}`}
							>
								{c.isHome ? <Home className="h-[15px] w-[15px]" /> : c.label}
							</button>
						</span>
					))}
				</div>
				{onOpenJump && (
					<button
						type="button"
						onClick={onOpenJump}
						className="h-7 shrink-0 rounded-lg border border-th-border bg-th-surface px-2.5 text-xs text-th-text"
					>
						{t("files.jump")}
					</button>
				)}
			</div>
		</div>
	);
}
