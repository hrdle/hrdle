import { FilePlus, FolderPlus, Plus, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface CreateMenuProps {
	placement: "up" | "down";
	uploading: boolean;
	/** Each resolves to an error message, or null once it is done. */
	onNewFile: (name: string) => Promise<string | null>;
	onNewFolder: (name: string) => Promise<string | null>;
	onUpload: () => void;
	size?: "sm" | "md";
}

/** New file, new folder or upload, into the directory on screen. */
export function CreateMenu({
	placement,
	uploading,
	onNewFile,
	onNewFolder,
	onUpload,
	size = "md",
}: CreateMenuProps) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [naming, setNaming] = useState<"file" | "folder" | null>(null);
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [open]);

	const startNaming = (kind: "file" | "folder") => {
		setOpen(false);
		setName("");
		setError(null);
		setNaming(kind);
	};

	const submit = async () => {
		if (!naming || !name.trim()) return;
		setBusy(true);
		setError(null);
		const err = await (naming === "file" ? onNewFile : onNewFolder)(name.trim());
		setBusy(false);
		if (err) setError(err);
		else setNaming(null);
	};

	const item =
		"flex h-11 w-full items-center gap-3 px-4 text-left text-sm text-th-text active:bg-th-surface-hover disabled:opacity-50";
	const iconSize = size === "sm" ? "h-4 w-4" : "h-5 w-5";

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-label={t("files.createMenu")}
				aria-expanded={open}
				className={`${size === "sm" ? "p-1.5" : "p-2.5"} rounded text-zinc-500 transition-colors hover:text-zinc-300`}
			>
				<Plus className={iconSize} />
			</button>
			{open && (
				<div
					className={`absolute right-0 z-20 w-52 overflow-hidden rounded-2xl border border-[#333] bg-[#1a1a1a] py-1 shadow-[0_12px_32px_rgba(0,0,0,0.6)] ${placement === "up" ? "bottom-12" : "top-10"}`}
				>
					<button type="button" className={item} onClick={() => startNaming("file")}>
						<FilePlus className="h-[18px] w-[18px]" />
						{t("files.newFileItem")}
					</button>
					<button type="button" className={item} onClick={() => startNaming("folder")}>
						<FolderPlus className="h-[18px] w-[18px]" />
						{t("files.newFolderItem")}
					</button>
					<button
						type="button"
						className={item}
						disabled={uploading}
						onClick={() => {
							setOpen(false);
							onUpload();
						}}
					>
						<Upload className="h-[18px] w-[18px]" />
						{uploading ? t("files.uploading") : t("files.uploadItem")}
					</button>
				</div>
			)}
			{naming && (
				<div
					className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center"
					onClick={() => setNaming(null)}
					onKeyDown={(e) => e.key === "Escape" && setNaming(null)}
					role="presentation"
				>
					<form
						className="w-full rounded-t-2xl border-t border-th-border bg-th-surface p-5 sm:max-w-sm sm:rounded-2xl sm:border"
						onClick={(e) => e.stopPropagation()}
						onKeyDown={(e) => e.stopPropagation()}
						onSubmit={(e) => {
							e.preventDefault();
							void submit();
						}}
					>
						<label htmlFor="file-create-name" className="mb-2 block text-sm font-semibold text-th-text">
							{naming === "file" ? t("files.newFileItem") : t("files.newFolderItem")}
						</label>
						<input
							id="file-create-name"
							// biome-ignore lint/a11y/noAutofocus: the sheet exists to type this one name
							autoFocus
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder={naming === "file" ? "notes.md" : "drafts"}
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
							className="h-11 w-full rounded-lg border border-th-border bg-th-bg px-3 font-mono text-sm text-th-text outline-none focus:border-blue-500"
						/>
						{error && <div className="mt-2 text-sm text-red-400">{error}</div>}
						<div className="mt-3 flex justify-end gap-2">
							<button type="button" onClick={() => setNaming(null)} className="h-9 rounded-lg border border-th-border px-4 text-sm text-th-text-secondary">
								{t("common.cancel")}
							</button>
							<button type="submit" disabled={busy || !name.trim()} className="h-9 rounded-lg bg-blue-600 px-4 text-sm text-white disabled:opacity-50">
								{t("files.create")}
							</button>
						</div>
					</form>
				</div>
			)}
		</div>
	);
}
