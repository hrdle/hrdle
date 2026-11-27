import {
	Copy,
	Download,
	FolderOpen,
	MessageSquarePlus,
	Pencil,
	Star,
	TextCursorInput,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileInfo } from "../../../../shared/types";
import { toHomeShortPath } from "../../utils/path";

interface FileActionsSheetProps {
	target: FileInfo;
	/** The target is a text file that can be opened in the editor. */
	editable: boolean;
	bookmarked: boolean;
	onAttach?: () => void;
	onEdit: () => void;
	onOpenDir: () => void;
	onCopyPath: () => void;
	onDownload: () => void;
	onToggleBookmark: () => void;
	/** Resolves to an error message, or null when the rename went through. */
	onRename: (newName: string) => Promise<string | null>;
	onDelete: () => Promise<string | null>;
	onClose: () => void;
}

/**
 * What can be done to one entry, opened by a long press. On a phone there is
 * no right-click and no room for a row of buttons on every line, so the rarer
 * actions - rename, delete, bookmark - live here rather than in a toolbar.
 */
export function FileActionsSheet({
	target,
	editable,
	bookmarked,
	onAttach,
	onEdit,
	onOpenDir,
	onCopyPath,
	onDownload,
	onToggleBookmark,
	onRename,
	onDelete,
	onClose,
}: FileActionsSheetProps) {
	const { t } = useTranslation();
	const isDir = target.type === "directory";
	const [mode, setMode] = useState<"menu" | "rename" | "delete">("menu");
	const [name, setName] = useState(target.name);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const act =
		"flex h-[50px] w-full items-center gap-3.5 px-5 text-left text-[15px] text-th-text active:bg-th-surface-hover";
	const icon = "h-5 w-5 shrink-0";

	const run = async (fn: () => Promise<string | null>) => {
		setBusy(true);
		setError(null);
		const err = await fn();
		setBusy(false);
		if (err) setError(err);
		else onClose();
	};

	return (
		<div
			className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center"
			onClick={onClose}
			onKeyDown={(e) => e.key === "Escape" && onClose()}
			role="presentation"
		>
			<div
				className="w-full overflow-hidden rounded-t-2xl border-t border-th-border bg-th-surface pb-4 sm:max-w-sm sm:rounded-2xl sm:border sm:pb-2"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => e.stopPropagation()}
				role="dialog"
				aria-label={target.name}
			>
				<div className="mx-auto mb-1.5 mt-2 h-1 w-10 rounded bg-zinc-700 sm:hidden" />
				<div className="flex flex-col px-5 pb-3.5 pt-2">
					<span className="truncate text-[15px] font-semibold">{target.name}</span>
					<span className="truncate font-mono text-[11px] text-th-text-muted">
						{toHomeShortPath(target.path)}
					</span>
				</div>

				{mode === "rename" && (
					<form
						className="border-t border-[#222] px-5 py-3"
						onSubmit={(e) => {
							e.preventDefault();
							if (name.trim() && name !== target.name) void run(() => onRename(name.trim()));
						}}
					>
						<label htmlFor="file-rename" className="mb-1.5 block text-xs text-th-text-secondary">
							{t("files.renameLabel")}
						</label>
						<input
							id="file-rename"
							value={name}
							onChange={(e) => setName(e.target.value)}
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
							className="h-11 w-full rounded-lg border border-th-border bg-th-bg px-3 font-mono text-sm text-th-text outline-none focus:border-blue-500"
						/>
						<div className="mt-3 flex justify-end gap-2">
							<button type="button" onClick={() => setMode("menu")} className="h-9 rounded-lg border border-th-border px-4 text-sm text-th-text-secondary">
								{t("common.cancel")}
							</button>
							<button type="submit" disabled={busy} className="h-9 rounded-lg bg-blue-600 px-4 text-sm text-white disabled:opacity-50">
								{t("files.renameApply")}
							</button>
						</div>
					</form>
				)}

				{mode === "delete" && (
					<div className="border-t border-[#222] px-5 py-3">
						<p className="m-0 text-sm text-th-text">
							{isDir ? t("files.deleteDirAsk") : t("files.deleteFileAsk")}
						</p>
						<div className="mt-3 flex justify-end gap-2">
							<button type="button" onClick={() => setMode("menu")} className="h-9 rounded-lg border border-th-border px-4 text-sm text-th-text-secondary">
								{t("common.cancel")}
							</button>
							<button type="button" disabled={busy} onClick={() => void run(onDelete)} className="h-9 rounded-lg bg-red-600 px-4 text-sm text-white disabled:opacity-50">
								{t("files.delete")}
							</button>
						</div>
					</div>
				)}

				{error && <div className="px-5 pb-2 text-sm text-red-400">{error}</div>}

				{mode === "menu" && (
					<>
						<div className="border-t border-[#222]">
							{onAttach && (
								<button type="button" className={`${act} text-blue-300`} onClick={() => { onAttach(); onClose(); }}>
									<MessageSquarePlus className={icon} />
									{t("files.attachToChat")}
								</button>
							)}
							{isDir ? (
								<button type="button" className={act} onClick={() => { onOpenDir(); onClose(); }}>
									<FolderOpen className={icon} />
									{t("files.openHere")}
								</button>
							) : (
								editable && (
									<button type="button" className={act} onClick={() => { onEdit(); onClose(); }}>
										<Pencil className={icon} />
										{t("files.edit")}
									</button>
								)
							)}
						</div>
						<div className="border-t border-[#222]">
							<button type="button" className={act} onClick={() => { onCopyPath(); onClose(); }}>
								<Copy className={icon} />
								{t("files.copyPath")}
							</button>
							{!isDir && (
								<button type="button" className={act} onClick={() => { onDownload(); onClose(); }}>
									<Download className={icon} />
									{t("files.download")}
								</button>
							)}
							<button type="button" className={act} onClick={() => setMode("rename")}>
								<TextCursorInput className={icon} />
								{t("files.rename")}
							</button>
							{isDir && (
								<button type="button" className={act} onClick={() => { onToggleBookmark(); onClose(); }}>
									<Star className={`${icon} ${bookmarked ? "fill-amber-500 text-amber-500" : ""}`} />
									{bookmarked ? t("files.unbookmark") : t("files.bookmark")}
								</button>
							)}
						</div>
						<div className="border-t border-[#222]">
							<button type="button" className={`${act} text-red-400`} onClick={() => setMode("delete")}>
								<Trash2 className={icon} />
								{t("files.delete")}
								{isDir && (
									<span className="ml-auto text-xs text-th-text-muted">{t("files.deleteEmptyOnly")}</span>
								)}
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
