import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LOCAL_PEER_ID } from "../../../../shared/types";
import { authFetch } from "../../services/api";
import { loadInputHistory, pushInputHistory } from "../../utils/input-history";
import { uploadImage } from "../../utils/upload-image";

const API_BASE = import.meta.env.VITE_API_URL || "";

/** An image picked for the next prompt: shown at once, sent once uploaded. */
interface Attachment {
	key: string;
	previewUrl: string;
	/** Where the upload landed, on the machine the pane is on. */
	path?: string;
	error?: string;
}

const IMAGE_TYPES = "image/png,image/jpeg,image/gif,image/webp";

/**
 * How tall the text may grow before it scrolls inside itself. `--vh` is the
 * visual viewport (main.tsx), so the soft keyboard is already taken out.
 */
const COMPOSER_MAX_HEIGHT = "calc(var(--vh, 100vh) * 0.4)";

interface ChatComposerProps {
	sessionId: string;
	paneId: string;
	peerId?: string;
}

/**
 * Where the chat view's prompt goes: one pane's agent, through herdr's
 * `agent.prompt`. A peer's session is reached through the hub, which forwards
 * the request to the machine the pane is on.
 */
function promptUrl(sessionId: string, paneId: string, peerId?: string): string {
	const target =
		peerId && peerId !== LOCAL_PEER_ID ? `peer:${peerId}:${sessionId}` : sessionId;
	return `${API_BASE}/api/sessions/${encodeURIComponent(target)}/panes/${encodeURIComponent(paneId)}/prompt`;
}

/**
 * The chat view's input. Sends the same way the terminal's input bar does to
 * a person typing - Enter on an empty last line sends, so a newline is one
 * Enter and a send is two, which is what Japanese input needs to confirm a
 * conversion without sending it. Ctrl/Cmd+Enter sends at once.
 *
 * Images upload the moment they are picked or pasted, to the machine the pane
 * is on, and show as thumbnails until the prompt goes; the server pastes each
 * one into the pane ahead of the text.
 */
export function ChatComposer({ sessionId, paneId, peerId }: ChatComposerProps) {
	const { t } = useTranslation();
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [history, setHistory] = useState<string[]>(loadInputHistory);
	const [showHistory, setShowHistory] = useState(false);
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [menuOpen, setMenuOpen] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [canExpand, setCanExpand] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// Object URLs hold the image in memory until revoked.
	const attachmentsRef = useRef(attachments);
	attachmentsRef.current = attachments;
	useEffect(
		() => () => {
			for (const a of attachmentsRef.current) URL.revokeObjectURL(a.previewUrl);
		},
		[],
	);

	// Height follows the text as wrapped, not its count of newlines: one long
	// Japanese line wraps without a single \n in it. `rows` cannot see that;
	// scrollHeight can. The CSS max-height caps it, and past that it scrolls.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measured on every edit of the text
	useLayoutEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		if (expanded) {
			el.style.height = "";
			el.style.overflowY = "";
			return;
		}
		const measure = () => {
			el.style.height = "auto";
			el.style.height = `${el.scrollHeight}px`;
			el.style.overflowY = el.scrollHeight > el.clientHeight ? "auto" : "hidden";
			const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 24;
			setCanExpand(el.scrollHeight > line * 3);
		};
		measure();
		// A narrower pane re-wraps the same text, and the keyboard changes --vh.
		const ro = new ResizeObserver(measure);
		ro.observe(el.parentElement ?? el);
		window.visualViewport?.addEventListener("resize", measure);
		return () => {
			ro.disconnect();
			window.visualViewport?.removeEventListener("resize", measure);
		};
	}, [text, expanded]);

	const attach = (files: Iterable<File>) => {
		for (const file of files) {
			if (!file.type.startsWith("image/")) continue;
			const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
			setAttachments((prev) => [
				...prev,
				{ key, previewUrl: URL.createObjectURL(file) },
			]);
			void uploadImage(file, peerId).then((result) => {
				setAttachments((prev) =>
					prev.map((a) =>
						a.key === key
							? result.ok
								? { ...a, path: result.path }
								: { ...a, error: result.error ?? "upload failed" }
							: a,
					),
				);
			});
		}
	};

	const detach = (key: string) => {
		setAttachments((prev) => {
			const gone = prev.find((a) => a.key === key);
			if (gone) URL.revokeObjectURL(gone.previewUrl);
			return prev.filter((a) => a.key !== key);
		});
	};

	const uploading = attachments.some((a) => !a.path && !a.error);
	const images = attachments.flatMap((a) => (a.path ? [a.path] : []));
	const canSend =
		!sending && !uploading && (text.trim().length > 0 || images.length > 0);

	const send = async (raw: string) => {
		const prompt = raw.replace(/\n+$/, "");
		if (!canSend) return;
		setSending(true);
		setError(null);
		try {
			const res = await authFetch(promptUrl(sessionId, paneId, peerId), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text: prompt, images }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error || `status ${res.status}`);
			}
			if (prompt.trim()) setHistory((prev) => pushInputHistory(prev, prompt));
			setText("");
			for (const a of attachments) URL.revokeObjectURL(a.previewUrl);
			setAttachments([]);
			setShowHistory(false);
			setExpanded(false);
		} catch (err) {
			setError(
				t("conversation.composerSendFailed", {
					reason: err instanceof Error ? err.message : String(err),
				}),
			);
		} finally {
			setSending(false);
			textareaRef.current?.focus();
		}
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Escape" && expanded && !e.nativeEvent.isComposing) {
			e.preventDefault();
			setExpanded(false);
			return;
		}
		if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
		if (e.ctrlKey || e.metaKey) {
			e.preventDefault();
			void send(text);
			return;
		}
		if (text.endsWith("\n")) {
			e.preventDefault();
			void send(text);
		}
	};

	return (
		<div
			className={
				expanded
					? "fixed inset-0 z-40 flex flex-col bg-cv-bg px-3 pt-3 pb-3"
					: "shrink-0 border-t border-cv-border bg-cv-bg px-3 pt-2 pb-3"
			}
			data-testid="chat-composer"
			data-expanded={expanded || undefined}
		>
			{showHistory && history.length > 0 && (
				<div className="mx-auto mb-2 max-h-40 max-w-3xl overflow-y-auto rounded-lg border border-cv-border bg-cv-surface">
					{history.map((item, i) => (
						<button
							type="button"
							// biome-ignore lint/suspicious/noArrayIndexKey: entries are unique, but a key from the text alone can be very long
							key={i}
							onClick={() => {
								setText(item);
								setShowHistory(false);
								textareaRef.current?.focus();
							}}
							className="block w-full truncate border-b border-cv-border/40 px-3 py-2 text-left text-sm text-cv-text last:border-b-0 hover:bg-cv-surface-hover"
						>
							{item}
						</button>
					))}
				</div>
			)}
			{attachments.length > 0 && (
				<div className="mx-auto mb-2 flex max-w-3xl flex-wrap gap-2">
					{attachments.map((a) => (
						<div
							key={a.key}
							className="relative h-16 w-16 overflow-hidden rounded-lg border border-cv-border bg-cv-surface"
						>
							<img
								src={a.previewUrl}
								alt=""
								className={`h-full w-full object-cover ${a.path ? "" : "opacity-50"}`}
							/>
							{!a.path && !a.error && (
								<span className="absolute inset-0 flex items-center justify-center">
									<span className="h-4 w-4 animate-spin rounded-full border-2 border-white/70 border-t-transparent" />
								</span>
							)}
							{a.error && (
								<span
									className="absolute inset-x-0 bottom-0 bg-red-600/90 px-1 text-center text-[10px] text-white"
									title={a.error}
								>
									{t("conversation.composerUploadFailed")}
								</span>
							)}
							<button
								type="button"
								onClick={() => detach(a.key)}
								aria-label={t("conversation.composerRemoveImage")}
								className="absolute top-0.5 right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white"
							>
								<svg
									className="h-3 w-3"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth={2.5}
									strokeLinecap="round"
									aria-hidden="true"
								>
									<path d="M6 6l12 12M18 6L6 18" />
								</svg>
							</button>
						</div>
					))}
				</div>
			)}
			<input
				ref={fileInputRef}
				type="file"
				accept={IMAGE_TYPES}
				multiple
				className="hidden"
				onChange={(e) => {
					if (e.target.files) attach(Array.from(e.target.files));
					e.target.value = "";
				}}
			/>
			{menuOpen && (
				<button
					type="button"
					aria-hidden="true"
					tabIndex={-1}
					onClick={() => setMenuOpen(false)}
					className="fixed inset-0 z-10 cursor-default"
				/>
			)}
			<div
				className={`mx-auto flex w-full max-w-3xl flex-col rounded-xl border border-cv-border bg-cv-surface ${
					expanded ? "min-h-0 flex-1" : ""
				}`}
			>
				<div className={`relative flex ${expanded ? "min-h-0 flex-1" : ""}`}>
					<textarea
						ref={textareaRef}
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={onKeyDown}
						onPaste={(e) => {
							const files = Array.from(e.clipboardData.files).filter((f) =>
								f.type.startsWith("image/"),
							);
							if (files.length === 0) return;
							e.preventDefault();
							attach(files);
						}}
						rows={1}
						lang="ja"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						aria-label={t("conversation.composerLabel")}
						placeholder={t("conversation.composerPlaceholder")}
						className={`block w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-cv-text leading-relaxed placeholder:text-cv-text-muted focus:outline-none ${
							expanded ? "h-full flex-1 overflow-y-auto" : ""
						} ${canExpand || expanded ? "pr-10" : ""}`}
						style={
							expanded
								? { fontSize: "16px" }
								: { fontSize: "16px", maxHeight: COMPOSER_MAX_HEIGHT }
						}
					/>
					{(canExpand || expanded) && (
						<button
							type="button"
							onClick={() => {
								setExpanded((prev) => !prev);
								textareaRef.current?.focus();
							}}
							aria-label={t(
								expanded
									? "conversation.composerCollapse"
									: "conversation.composerExpand",
							)}
							aria-pressed={expanded}
							className="absolute top-1 right-1 flex h-8 w-8 items-center justify-center rounded-lg text-cv-text-muted hover:bg-cv-surface-hover"
						>
							<svg
								className="h-4 w-4"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth={2}
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								{expanded ? (
									<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
								) : (
									<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
								)}
							</svg>
						</button>
					)}
				</div>
				<div className="flex items-center gap-1 px-1.5 pb-1.5">
					<div className="relative">
						<button
							type="button"
							onClick={() => setMenuOpen((prev) => !prev)}
							aria-label={t("conversation.composerMore")}
							aria-haspopup="menu"
							aria-expanded={menuOpen}
							className={`flex h-9 w-9 items-center justify-center rounded-lg ${
								menuOpen
									? "bg-cv-surface-hover text-cv-text"
									: "text-cv-text-muted hover:bg-cv-surface-hover"
							}`}
						>
							<svg
								className="h-5 w-5"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth={2}
								strokeLinecap="round"
								aria-hidden="true"
							>
								<path d="M12 5v14M5 12h14" />
							</svg>
						</button>
						{menuOpen && (
							<div
								role="menu"
								className="absolute bottom-full left-0 z-20 mb-2 w-48 overflow-hidden rounded-lg border border-cv-border bg-cv-surface shadow-lg"
							>
								<button
									type="button"
									role="menuitem"
									onClick={() => {
										setMenuOpen(false);
										fileInputRef.current?.click();
									}}
									className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-cv-text hover:bg-cv-surface-hover"
								>
									<svg
										className="h-4 w-4 text-cv-text-muted"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth={2}
										strokeLinecap="round"
										strokeLinejoin="round"
										aria-hidden="true"
									>
										<rect x="3" y="5" width="18" height="14" rx="2" />
										<circle cx="9" cy="10" r="1.5" />
										<path d="M21 16l-5-5-8 8" />
									</svg>
									{t("conversation.composerAttachImage")}
								</button>
								<button
									type="button"
									role="menuitem"
									onClick={() => {
										setMenuOpen(false);
										setHistory(loadInputHistory());
										setShowHistory((prev) => !prev);
									}}
									className="flex w-full items-center gap-2.5 border-t border-cv-border/40 px-3 py-2.5 text-left text-sm text-cv-text hover:bg-cv-surface-hover"
								>
									<svg
										className="h-4 w-4 text-cv-text-muted"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth={2}
										strokeLinecap="round"
										strokeLinejoin="round"
										aria-hidden="true"
									>
										<path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
										<path d="M3 3v5h5M12 7v5l3 2" />
									</svg>
									{t("conversation.composerHistory")}
								</button>
							</div>
						)}
					</div>
					<div className="flex-1" />
					<button
						type="button"
						onClick={() => void send(text)}
						disabled={!canSend}
						aria-label={t("conversation.composerSend")}
						className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cv-accent text-white disabled:opacity-40"
					>
						<svg
							className="h-4 w-4"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth={2.2}
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<path d="M12 19V5M5 12l7-7 7 7" />
						</svg>
					</button>
				</div>
			</div>
			{error && (
				<div className="mx-auto mt-1.5 max-w-3xl text-xs text-red-400" role="alert">
					{error}
				</div>
			)}
		</div>
	);
}
