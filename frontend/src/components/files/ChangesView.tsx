/** biome-ignore-all lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: legacy click-on-div UI; keyboard navigation provided via main shortcuts */
import { ChevronRight, FileText, FolderTree, GitBranch, List } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileChange, GitFileChange } from "../../../../shared/types";
import { stripHomeProjectPrefix, toHomeShortPath } from "../../utils/path";
import { getFileName } from "./file-types";
import { storageKey } from "../../utils/app-storage";

type ChangesSource = "claude" | "git";
type ChangesDisplay = "list" | "tree";

const CHANGES_SOURCE_KEY = storageKey("changes-source");
const CHANGES_DISPLAY_KEY = storageKey("changes-display");

function getStoredChangesSource(): ChangesSource {
	return (localStorage.getItem(CHANGES_SOURCE_KEY) as ChangesSource) || "git";
}

function getStoredChangesDisplay(): ChangesDisplay {
	return (
		(localStorage.getItem(CHANGES_DISPLAY_KEY) as ChangesDisplay) || "list"
	);
}

// Git status label helper
function gitStatusLabel(status: string): {
	label: string;
	color: string;
	dotColor: string;
} {
	switch (status) {
		case "A":
			return {
				label: "Added",
				color: "text-green-400",
				dotColor: "bg-green-500",
			};
		case "D":
			return {
				label: "Deleted",
				color: "text-red-400",
				dotColor: "bg-red-500",
			};
		case "R":
			return {
				label: "Renamed",
				color: "text-blue-400",
				dotColor: "bg-blue-500",
			};
		case "??":
			return {
				label: "Untracked",
				color: "text-th-text-secondary",
				dotColor: "bg-gray-500",
			};
		case "U":
			return {
				label: "Conflict",
				color: "text-orange-400",
				dotColor: "bg-orange-500",
			};
		default:
			return {
				label: "Modified",
				color: "text-yellow-400",
				dotColor: "bg-yellow-500",
			};
	}
}

// Tree node for file tree view
interface TreeNode {
	name: string;
	fullPath: string;
	children: TreeNode[];
	change?: GitFileChange | FileChange;
	isDir: boolean;
}

function buildTree(
	items: { path: string; change: GitFileChange | FileChange }[],
): TreeNode[] {
	const root: TreeNode[] = [];

	for (const item of items) {
		const parts = item.path.split("/");
		let current = root;

		for (let i = 0; i < parts.length; i++) {
			const name = parts[i];
			const isLast = i === parts.length - 1;
			const fullPath = parts.slice(0, i + 1).join("/");

			let existing = current.find((n) => n.name === name);
			if (!existing) {
				existing = { name, fullPath, children: [], isDir: !isLast };
				if (isLast) {
					existing.change = item.change;
				}
				current.push(existing);
			}
			current = existing.children;
		}
	}

	return root;
}

function countLeaves(node: TreeNode): number {
	if (!node.isDir) return 1;
	return node.children.reduce((sum, child) => sum + countLeaves(child), 0);
}

function TreeView({
	nodes,
	depth,
	onSelectGitChange,
	onSelectClaudeChange,
	selectedPath,
}: {
	nodes: TreeNode[];
	depth: number;
	onSelectGitChange?: (change: GitFileChange) => void;
	onSelectClaudeChange?: (change: FileChange) => void;
	selectedPath?: string;
}) {
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

	const toggleDir = (path: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	};

	return (
		<>
			{nodes.map((node) => {
				const isCollapsed = collapsed.has(node.fullPath);

				if (node.isDir) {
					return (
						<div key={node.fullPath}>
							<div
								onClick={() => toggleDir(node.fullPath)}
								className="flex items-center gap-1 px-2 py-1 hover:bg-th-surface cursor-pointer text-sm text-th-text-secondary"
								style={{ paddingLeft: `${depth * 16 + 8}px` }}
							>
								<ChevronRight
									className={`w-3 h-3 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
								/>
								<span className="truncate">{node.name}</span>
								<span className="text-xs text-th-text-muted ml-auto shrink-0">
									{countLeaves(node)}
								</span>
							</div>
							{!isCollapsed && (
								<TreeView
									nodes={node.children}
									depth={depth + 1}
									onSelectGitChange={onSelectGitChange}
									onSelectClaudeChange={onSelectClaudeChange}
									selectedPath={selectedPath}
								/>
							)}
						</div>
					);
				}

				// Leaf node (file)
				const isGitChange = node.change && "status" in node.change;
				const statusInfo = isGitChange
					? gitStatusLabel((node.change as GitFileChange).status)
					: null;
				const isClaudeChange = node.change && "toolName" in node.change;

				return (
					<div
						key={node.fullPath}
						onClick={() => {
							if (isGitChange && onSelectGitChange) {
								onSelectGitChange(node.change as GitFileChange);
							} else if (isClaudeChange && onSelectClaudeChange) {
								onSelectClaudeChange(node.change as FileChange);
							}
						}}
						className={`flex items-center gap-2 px-2 py-1 hover:bg-th-surface active:bg-th-surface-hover cursor-pointer transition-colors ${
							selectedPath === node.fullPath ? "bg-th-surface" : ""
						}`}
						style={{ paddingLeft: `${depth * 16 + 8}px` }}
					>
						<div
							className={`w-2 h-2 rounded-full shrink-0 ${
								statusInfo
									? statusInfo.dotColor
									: isClaudeChange &&
											(node.change as FileChange).toolName === "Write"
										? "bg-green-500"
										: "bg-yellow-500"
							}`}
						/>
						<span className="text-sm truncate flex-1">{node.name}</span>
						<span
							className={`text-xs shrink-0 ${statusInfo?.color || "text-th-text-muted"}`}
						>
							{statusInfo
								? statusInfo.label
								: isClaudeChange &&
										(node.change as FileChange).toolName === "Write"
									? "Created"
									: "Edited"}
						</span>
					</div>
				);
			})}
		</>
	);
}

// Changes list view with Claude/Git toggle and list/tree display
export function ChangesView({
	claudeChanges,
	gitChanges,
	gitBranch,
	isLoading,
	onSelectClaudeChange,
	onSelectGitChange,
	selectedPath,
}: {
	claudeChanges: FileChange[];
	gitChanges: GitFileChange[];
	gitBranch: string;
	isLoading: boolean;
	onSelectClaudeChange: (change: FileChange) => void;
	onSelectGitChange: (change: GitFileChange) => void;
	selectedPath?: string;
}) {
	const { t } = useTranslation();
	const [source, setSource] = useState<ChangesSource>(getStoredChangesSource);
	const [display, setDisplay] = useState<ChangesDisplay>(
		getStoredChangesDisplay,
	);

	const handleSourceChange = (newSource: ChangesSource) => {
		setSource(newSource);
		localStorage.setItem(CHANGES_SOURCE_KEY, newSource);
	};

	const handleDisplayChange = (newDisplay: ChangesDisplay) => {
		setDisplay(newDisplay);
		localStorage.setItem(CHANGES_DISPLAY_KEY, newDisplay);
	};

	// Deduplicate git changes by path (prefer unstaged)
	const uniqueGitChanges = useMemo(() => {
		const seen = new Map<string, GitFileChange>();
		for (const change of gitChanges) {
			if (!seen.has(change.path) || !change.staged) {
				seen.set(change.path, change);
			}
		}
		return Array.from(seen.values());
	}, [gitChanges]);

	const treeNodes = useMemo(() => {
		if (source === "git") {
			return buildTree(
				uniqueGitChanges.map((c) => ({ path: c.path, change: c })),
			);
		}
		return buildTree(
			claudeChanges.map((c) => ({
				path: stripHomeProjectPrefix(c.path),
				change: c,
			})),
		);
	}, [source, uniqueGitChanges, claudeChanges]);

	const currentChanges = source === "git" ? uniqueGitChanges : claudeChanges;

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-full">
				<div className="text-th-text-muted">{t("common.loading")}</div>
			</div>
		);
	}

	return (
		<div className="h-full flex flex-col overflow-hidden">
			{/* Controls bar */}
			<div className="px-2 py-1.5 border-b border-th-border bg-th-surface/50 flex items-center gap-2 flex-wrap">
				{/* Source toggle: Claude / Git */}
				<div className="flex items-center bg-th-surface-hover rounded p-0.5">
					<button
						type="button"
						onClick={() => handleSourceChange("claude")}
						className={`px-2 py-0.5 text-xs rounded transition-colors ${
							source === "claude"
								? "bg-th-surface-active text-th-text"
								: "text-th-text-secondary hover:text-th-text"
						}`}
					>
						Claude{claudeChanges.length > 0 ? `(${claudeChanges.length})` : ""}
					</button>
					<button
						type="button"
						onClick={() => handleSourceChange("git")}
						className={`px-2 py-0.5 text-xs rounded transition-colors ${
							source === "git"
								? "bg-th-surface-active text-th-text"
								: "text-th-text-secondary hover:text-th-text"
						}`}
					>
						Git
						{uniqueGitChanges.length > 0 ? `(${uniqueGitChanges.length})` : ""}
					</button>
				</div>

				{/* Display toggle: List / Tree */}
				<div className="flex items-center bg-th-surface-hover rounded p-0.5">
					<button
						type="button"
						onClick={() => handleDisplayChange("list")}
						className={`px-1.5 py-0.5 text-xs rounded transition-colors ${
							display === "list"
								? "bg-th-surface-active text-th-text"
								: "text-th-text-secondary hover:text-th-text"
						}`}
						title={t("files.listView")}
					>
						<List className="w-3.5 h-3.5" />
					</button>
					<button
						type="button"
						onClick={() => handleDisplayChange("tree")}
						className={`px-1.5 py-0.5 text-xs rounded transition-colors ${
							display === "tree"
								? "bg-th-surface-active text-th-text"
								: "text-th-text-secondary hover:text-th-text"
						}`}
						title={t("files.treeView")}
					>
						<FolderTree className="w-3.5 h-3.5" />
					</button>
				</div>

				{/* Branch indicator for git */}
				{source === "git" && gitBranch && (
					<span className="text-xs text-th-text-muted truncate ml-auto flex items-center gap-1">
						<GitBranch className="w-3 h-3" />
						{gitBranch}
					</span>
				)}
			</div>

			{/* Content */}
			{currentChanges.length === 0 ? (
				<div className="flex flex-col items-center justify-center flex-1 text-th-text-muted">
					<FileText className="w-12 h-12 mb-2" strokeWidth={1.5} />
					<div>{t("files.noChanges")}</div>
				</div>
			) : display === "tree" ? (
				<div className="flex-1 overflow-y-auto py-1">
					<TreeView
						nodes={treeNodes}
						depth={0}
						onSelectGitChange={source === "git" ? onSelectGitChange : undefined}
						onSelectClaudeChange={
							source === "claude" ? onSelectClaudeChange : undefined
						}
						selectedPath={selectedPath}
					/>
				</div>
			) : (
				<div className="flex-1 overflow-y-auto">
					<div className="divide-y divide-gray-800">
						{source === "git"
							? uniqueGitChanges.map((change, i) => {
									const statusInfo = gitStatusLabel(change.status);
									return (
										<div
											// biome-ignore lint/suspicious/noArrayIndexKey: same path may appear with different statuses; composite key keeps uniqueness
											key={`${change.path}-${i}`}
											onClick={() => onSelectGitChange(change)}
											className={`flex items-center gap-3 px-3 py-2 hover:bg-th-surface active:bg-th-surface-hover cursor-pointer transition-colors ${
												selectedPath === change.path ? "bg-th-surface" : ""
											}`}
										>
											<div
												className={`w-2 h-2 rounded-full shrink-0 ${statusInfo.dotColor}`}
											/>
											<div className="flex-1 min-w-0">
												<div className="text-sm truncate">
													{getFileName(change.path)}
												</div>
												<div className="text-xs text-th-text-muted truncate">
													{change.path}
												</div>
											</div>
											<div className={`text-xs shrink-0 ${statusInfo.color}`}>
												{statusInfo.label}
											</div>
										</div>
									);
								})
							: claudeChanges.map((change, i) => (
									<div
										// biome-ignore lint/suspicious/noArrayIndexKey: same path may appear multiple times; composite key keeps uniqueness
										key={`${change.path}-${i}`}
										onClick={() => onSelectClaudeChange(change)}
										className={`flex items-center gap-3 px-3 py-2 hover:bg-th-surface active:bg-th-surface-hover cursor-pointer transition-colors ${
											selectedPath === change.path ? "bg-th-surface" : ""
										}`}
									>
										<div
											className={`w-2 h-2 rounded-full shrink-0 ${
												change.toolName === "Write"
													? "bg-green-500"
													: "bg-yellow-500"
											}`}
										/>
										<div className="flex-1 min-w-0">
											<div className="text-sm truncate">
												{getFileName(change.path)}
											</div>
											<div className="text-xs text-th-text-muted truncate">
												{toHomeShortPath(change.path)}
											</div>
										</div>
										<div className="text-xs text-th-text-muted shrink-0">
											{change.toolName === "Write"
												? t("files.created")
												: t("files.edited")}
										</div>
									</div>
								))}
					</div>
				</div>
			)}
		</div>
	);
}
