import { AlertTriangle, Redo2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileContent } from "../../../../shared/types";
import { useViewerSettings } from "../../hooks/useViewerSettings";
import { authFetch } from "../../services/api";
import { DiffViewer } from "./DiffViewer";
import { getFileName } from "./file-types";

interface FileEditorProps {
	/** The file as it was read: utf-8, whole, with its hash. */
	file: FileContent;
	filesApiBase: string;
	/** Told whenever there start or stop being unsaved changes. */
	onDirtyChange?: (dirty: boolean) => void;
	onClose: () => void;
}

/** What is on disk when it is no longer the version being edited. */
interface DiskVersion {
	hash: string | null;
	content: string;
}

const POLL_MS = 4000;

/** Keys a phone keyboard buries behind two or three shifts. */
const KEY_ROW = ["\t", "{", "}", "(", ")", "[", "]", "<", ">", ";", ":", "=", '"', "'", "`", "/", "\\", "|", "&", "!", "-", "_", "$", "#"];

function isCoarsePointer(): boolean {
	try {
		return window.matchMedia("(pointer: coarse)").matches;
	} catch {
		return false;
	}
}

async function readDisk(
	filesApiBase: string,
	path: string,
): Promise<DiskVersion | "unreadable"> {
	const res = await authFetch(
		`${filesApiBase}/read?${new URLSearchParams({ path })}`,
	);
	if (res.status === 404) return { hash: null, content: "" };
	if (!res.ok) return "unreadable";
	const data = (await res.json()) as { file: FileContent };
	if (data.file.encoding !== "utf-8" || !data.file.hash) return "unreadable";
	return { hash: data.file.hash, content: data.file.content };
}

/**
 * A text file being edited, on a phone or a tablet.
 *
 * A plain textarea rather than a code editor library: what is typed here is
 * mostly Japanese through an IME, and a textarea is the one surface every
 * mobile IME composes into without dropped or doubled characters. Line numbers
 * come from a copy of the text laid out behind it at the same width, one row
 * per line, so a wrapped line keeps its number beside its first row.
 *
 * The agent works on the same files. The file is re-read while it is open,
 * and a save carries the hash it was read with, so a change made in between
 * is shown rather than overwritten.
 */
export function FileEditor({
	file,
	filesApiBase,
	onDirtyChange,
	onClose,
}: FileEditorProps) {
	const { t } = useTranslation();
	const fileName = getFileName(file.path);
	const { fontSize, wordWrap } = useViewerSettings(fileName);
	const [original, setOriginal] = useState(file.content);
	const [baseHash, setBaseHash] = useState<string | null>(file.hash ?? null);
	const [content, setContent] = useState(file.content);
	const [caretLine, setCaretLine] = useState(0);
	const [disk, setDisk] = useState<DiskVersion | null>(null);
	const [showDiff, setShowDiff] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const coarse = useMemo(isCoarsePointer, []);

	const dirty = content !== original;
	useEffect(() => {
		onDirtyChange?.(dirty);
	}, [dirty, onDirtyChange]);
	const lines = useMemo(() => content.split("\n"), [content]);
	const lineHeight = Math.round(fontSize * 1.5);
	const gutterWidth = `${String(lines.length).length + 1.5}ch`;

	// Watch the file on disk while it is open.
	useEffect(() => {
		let stopped = false;
		const tick = async () => {
			if (document.visibilityState !== "visible") return;
			try {
				const now = await readDisk(filesApiBase, file.path);
				if (stopped || now === "unreadable") return;
				setDisk(now.hash === baseHash ? null : now);
			} catch {
				/* a missed poll is caught by the next one, or by the save */
			}
		};
		const id = window.setInterval(tick, POLL_MS);
		return () => {
			stopped = true;
			window.clearInterval(id);
		};
	}, [filesApiBase, file.path, baseHash]);

	const updateCaret = useCallback(() => {
		const ta = textareaRef.current;
		if (!ta) return;
		const before = ta.value.slice(0, ta.selectionStart);
		let n = 0;
		for (let i = 0; i < before.length; i++) if (before[i] === "\n") n++;
		setCaretLine(n);
	}, []);

	const save = useCallback(
		async (expectedHash: string | null) => {
			setSaving(true);
			setSaveError(null);
			try {
				const res = await authFetch(`${filesApiBase}/write`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ path: file.path, content, expectedHash }),
				});
				if (res.status === 409) {
					const now = await readDisk(filesApiBase, file.path);
					if (now !== "unreadable") setDisk(now);
					return;
				}
				if (!res.ok) {
					const data = await res.json().catch(() => ({}));
					setSaveError(data.error || res.statusText);
					return;
				}
				const data = (await res.json()) as { hash: string };
				setOriginal(content);
				setBaseHash(data.hash);
				setDisk(null);
				setShowDiff(false);
			} catch (err) {
				setSaveError(err instanceof Error ? err.message : String(err));
			} finally {
				setSaving(false);
			}
		},
		[filesApiBase, file.path, content],
	);

	const takeDisk = useCallback(() => {
		if (!disk) return;
		setOriginal(disk.content);
		setContent(disk.content);
		setBaseHash(disk.hash);
		setDisk(null);
		setShowDiff(false);
	}, [disk]);

	const requestClose = useCallback(() => {
		if (dirty) setConfirmDiscard(true);
		else onClose();
	}, [dirty, onClose]);

	// execCommand keeps the textarea's own undo stack, which setting the value
	// from React would throw away.
	const insert = useCallback((text: string) => {
		textareaRef.current?.focus();
		document.execCommand("insertText", false, text);
	}, []);

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.nativeEvent.isComposing) return;
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
			e.preventDefault();
			if (dirty && !saving) void save(baseHash);
			return;
		}
		if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			insert("\t");
		}
	};

	const textStyle: React.CSSProperties = {
		fontSize: `${fontSize}px`,
		lineHeight: `${lineHeight}px`,
		tabSize: 4,
		whiteSpace: wordWrap ? "pre-wrap" : "pre",
		wordBreak: wordWrap ? "break-all" : "normal",
		overflowWrap: wordWrap ? "anywhere" : "normal",
	};

	return (
		<div className="flex h-full flex-col bg-th-bg" data-testid="file-editor">
			<div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-th-border bg-[#0f0f0f] px-2">
				<button
					type="button"
					onClick={requestClose}
					className="h-9 rounded-lg px-3 text-sm text-th-text-secondary active:bg-th-surface-hover"
				>
					{t("files.editCancel")}
				</button>
				<div className="flex min-w-0 flex-1 flex-col items-center">
					<span className="flex max-w-full items-center gap-1.5 truncate text-sm font-semibold text-th-text">
						<span className="truncate">{fileName}</span>
						{dirty && <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-th-text" />}
					</span>
					<span className="text-[11px] text-th-text-muted">
						{saving
							? t("files.editSaving")
							: dirty
								? t("files.editUnsaved")
								: t("files.editSaved")}
					</span>
				</div>
				<button
					type="button"
					onClick={() => void save(baseHash)}
					disabled={!dirty || saving}
					className="h-9 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white disabled:opacity-40"
				>
					{t("files.editSave")}
				</button>
			</div>

			{confirmDiscard && (
				<div className="flex flex-wrap items-center gap-2 border-b border-th-border bg-th-surface px-3 py-2 text-sm">
					<span className="flex-1 text-th-text">{t("files.editDiscardAsk")}</span>
					<button
						type="button"
						onClick={() => setConfirmDiscard(false)}
						className="h-8 rounded-lg border border-th-border px-3 text-xs text-th-text-secondary"
					>
						{t("files.editKeepEditing")}
					</button>
					<button
						type="button"
						onClick={onClose}
						className="h-8 rounded-lg bg-red-600 px-3 text-xs text-white"
					>
						{t("files.editDiscard")}
					</button>
				</div>
			)}

			{disk && (
				<div
					className="flex flex-wrap items-center gap-2 border-b border-[#3a2a0a] bg-[#1c1405] px-3 py-2"
					data-testid="file-editor-conflict"
				>
					<AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
					<span className="min-w-[12rem] flex-1 text-[13px] font-semibold text-amber-200">
						{disk.hash === null
							? t("files.editConflictDeleted")
							: t("files.editConflict")}
					</span>
					<div className="flex flex-wrap gap-2">
						{disk.hash !== null && (
							<button
								type="button"
								onClick={() => setShowDiff((v) => !v)}
								className="h-8 rounded-lg border border-[#3a2a0a] px-3 text-xs text-amber-300"
							>
								{showDiff ? t("files.editHideDiff") : t("files.editShowDiff")}
							</button>
						)}
						{disk.hash !== null && (
							<button
								type="button"
								onClick={takeDisk}
								className="h-8 rounded-lg border border-[#3a2a0a] px-3 text-xs text-amber-300"
							>
								{t("files.editTakeDisk")}
							</button>
						)}
						<button
							type="button"
							onClick={() => void save(disk.hash)}
							className="h-8 rounded-lg border border-th-border px-3 text-xs text-th-text-secondary"
						>
							{t("files.editOverwrite")}
						</button>
					</div>
				</div>
			)}

			{saveError && (
				<div className="border-b border-red-800 bg-red-900/50 px-3 py-2 text-sm text-red-300">
					{t("files.editSaveFailed", { error: saveError })}
				</div>
			)}

			{showDiff && disk ? (
				<div className="min-h-0 flex-1 overflow-hidden">
					<DiffViewer
						oldContent={disk.content}
						newContent={content}
						fileName={fileName}
						filePath={file.path}
					/>
				</div>
			) : (
				<div className="min-h-0 flex-1 overflow-auto">
					<div className={`relative flex py-2 ${wordWrap ? "" : "min-w-fit"}`}>
						<div
							aria-hidden="true"
							className="shrink-0 select-none text-right font-mono text-[#52525b]"
							style={{ width: gutterWidth, fontSize: `${Math.max(10, fontSize - 2)}px` }}
						/>
						<div className="relative min-w-0 flex-1">
							<div aria-hidden="true" className="font-mono text-transparent">
								{lines.map((line, i) => (
									<div
										// biome-ignore lint/suspicious/noArrayIndexKey: a row is its line number
										key={i}
										className="relative px-2"
										style={{
											...textStyle,
											minHeight: `${lineHeight}px`,
											background: i === caretLine ? "#13233d" : undefined,
										}}
									>
										<span
											className="absolute top-0 select-none pr-2 text-right font-mono"
											style={{
												right: "100%",
												width: gutterWidth,
												color: i === caretLine ? "#a1a1aa" : "#52525b",
												fontSize: `${Math.max(10, fontSize - 2)}px`,
											}}
										>
											{i + 1}
										</span>
										{line || "​"}
									</div>
								))}
							</div>
							<textarea
								ref={textareaRef}
								value={content}
								onChange={(e) => {
									setContent(e.target.value);
									updateCaret();
								}}
								onSelect={updateCaret}
								onKeyDown={onKeyDown}
								spellCheck={false}
								autoCapitalize="off"
								autoCorrect="off"
								autoComplete="off"
								aria-label={fileName}
								className="absolute inset-0 h-full w-full resize-none overflow-hidden bg-transparent px-2 font-mono text-th-text caret-blue-500 outline-none"
								style={textStyle}
							/>
						</div>
					</div>
				</div>
			)}

			{coarse && !showDiff && (
				<div className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-th-border bg-[#111] px-2 py-1.5">
					<button
						type="button"
						aria-label={t("files.editUndo")}
						onPointerDown={(e) => e.preventDefault()}
						onClick={() => {
							textareaRef.current?.focus();
							document.execCommand("undo");
						}}
						className="flex h-9 min-w-10 shrink-0 items-center justify-center rounded-lg border border-[#2a2a2a] bg-[#1a1a1a] text-th-text"
					>
						<Undo2 className="h-4 w-4" />
					</button>
					<button
						type="button"
						aria-label={t("files.editRedo")}
						onPointerDown={(e) => e.preventDefault()}
						onClick={() => {
							textareaRef.current?.focus();
							document.execCommand("redo");
						}}
						className="flex h-9 min-w-10 shrink-0 items-center justify-center rounded-lg border border-[#2a2a2a] bg-[#1a1a1a] text-th-text"
					>
						<Redo2 className="h-4 w-4" />
					</button>
					{KEY_ROW.map((k) => (
						<button
							key={k}
							type="button"
							onPointerDown={(e) => e.preventDefault()}
							onClick={() => insert(k)}
							className="h-9 min-w-10 shrink-0 rounded-lg border border-[#2a2a2a] bg-[#1a1a1a] px-2 font-mono text-sm text-th-text"
						>
							{k === "\t" ? "Tab" : k}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
