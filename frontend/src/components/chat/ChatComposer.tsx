import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { authFetch } from "../../services/api";
import { loadInputHistory, pushInputHistory } from "../../utils/input-history";
import { uploadImage } from "../../utils/upload-image";
import { paneUrl } from "./pane-url";
import { QuestionCard } from "./QuestionCard";
import { usePaneQuestion } from "./usePaneQuestion";

/** An image picked for the next prompt: shown at once, sent once uploaded. */
interface Attachment {
	key: string;
	previewUrl: string;
	/** Where the upload landed, on the machine the pane is on. */
	path?: string;
	error?: string;
}

const IMAGE_TYPES = "image/png,image/jpeg,image/gif,image/webp";

/** How much of the visible height the text may take before it scrolls inside. */
const MAX_TEXT_SHARE = 0.4;

/** The visible height: the layout viewport keeps its height under the soft keyboard. */
function visibleHeight(): number {
	return window.visualViewport?.height ?? window.innerHeight;
}

interface ChatComposerProps {
	sessionId: string;
	paneId: string;
	peerId?: string;
	/** The pane's agent is mid-turn. */
	working?: boolean;
	/** The pane's agent is waiting on the person. */
	waiting?: boolean;
}

/** How long a stop stays pending when the status does not come back to say it worked. */
const STOP_PENDING_MS = 4000;

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
export function ChatComposer({
	sessionId,
	paneId,
	peerId,
	working = false,
	waiting = false,
}: ChatComposerProps) {
	const { t } = useTranslation();
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [history, setHistory] = useState<string[]>(loadInputHistory);
	const [showHistory, setShowHistory] = useState(false);
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [tall, setTall] = useState(false);
	const [viewHeight, setViewHeight] = useState(visibleHeight);
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!menuOpen) return;
		const close = (e: PointerEvent) => {
			if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
		};
		document.addEventListener("pointerdown", close);
		return () => document.removeEventListener("pointerdown", close);
	}, [menuOpen]);

	useEffect(() => {
		const update = () => setViewHeight(visibleHeight());
		window.visualViewport?.addEventListener("resize", update);
		window.addEventListener("resize", update);
		return () => {
			window.visualViewport?.removeEventListener("resize", update);
			window.removeEventListener("resize", update);
		};
	}, []);

	// Sized from what the text measures as wrapped: Japanese is mostly written
	// without newlines, so a row count taken from them leaves a long prompt one
	// line tall with its start scrolled out of sight.
	useLayoutEffect(() => {
		const ta = textareaRef.current;
		if (!ta) return;
		if (expanded) {
			ta.style.height = "";
			return;
		}
		ta.style.height = "auto";
		const full = ta.scrollHeight;
		ta.style.height = `${Math.min(full, Math.round(viewHeight * MAX_TEXT_SHARE))}px`;
		const lineHeight = Number.parseFloat(getComputedStyle(ta).lineHeight) || 26;
		setTall(full > lineHeight * 3.5);
		// `tall` is a dependency because the expand control it brings in narrows
		// the text, which wraps it onto more lines than were just measured.
	}, [text, expanded, viewHeight, tall]);

	// Object URLs hold the image in memory until revoked.
	const attachmentsRef = useRef(attachments);
	attachmentsRef.current = attachments;
	useEffect(
		() => () => {
			for (const a of attachmentsRef.current) URL.revokeObjectURL(a.previewUrl);
		},
		[],
	);

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

	const {
		question,
		answer,
		busy: answering,
		error: answerError,
	} = usePaneQuestion(sessionId, paneId, peerId, waiting);
	// While a single-choice question with a free-text row is up, what is
	// written answers it rather than going in as a prompt: typed into the
	// picker, a prompt's keys would move the selection instead.
	const freeTextOption =
		question && !question.multiSelect
			? question.options.find((o) => o.freeText)
			: undefined;

	const uploading = attachments.some((a) => !a.path && !a.error);
	const images = attachments.flatMap((a) => (a.path ? [a.path] : []));
	const canSend =
		!sending && !uploading && (text.trim().length > 0 || images.length > 0);
	// Something written while the agent works is sent, and Claude Code queues
	// it; only an empty composer turns send into stop.
	const showStop = working && text.length === 0 && attachments.length === 0;
	const [stopping, setStopping] = useState(false);

	useEffect(() => {
		if (!stopping) return;
		if (!working) {
			setStopping(false);
			return;
		}
		const timer = setTimeout(() => setStopping(false), STOP_PENDING_MS);
		return () => clearTimeout(timer);
	}, [stopping, working]);

	const stop = async () => {
		setStopping(true);
		setError(null);
		try {
			const res = await authFetch(paneUrl(sessionId, paneId, peerId, "keys"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ keys: ["esc"] }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error || `status ${res.status}`);
			}
		} catch (err) {
			setStopping(false);
			setError(
				t("conversation.composerStopFailed", {
					reason: err instanceof Error ? err.message : String(err),
				}),
			);
		}
	};

	const send = async (raw: string) => {
		const prompt = raw.replace(/\n+$/, "");
		if (!canSend) return;
		if (freeTextOption && prompt.trim() && images.length === 0) {
			setSending(true);
			const ok = await answer([freeTextOption.index], prompt);
			setSending(false);
			if (ok) {
				setHistory((prev) => pushInputHistory(prev, prompt));
				setText("");
				setExpanded(false);
			}
			return;
		}
		setSending(true);
		setError(null);
		try {
			const res = await authFetch(paneUrl(sessionId, paneId, peerId, "prompt"), {
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
			// Expanded, it covers the chat view and nothing outside it, so the
			// bars around the view stay where they are.
			className={
				expanded
					? "absolute inset-0 z-40 flex flex-col bg-cv-bg px-3 pt-3 pb-3"
					: "shrink-0 border-t border-cv-border bg-cv-bg px-3 pt-2 pb-3"
			}
			data-testid="chat-composer"
		>
			{question && !expanded && (
				<QuestionCard
					question={question}
					busy={answering}
					error={answerError}
					onAnswer={(choices, text) => void answer(choices, text)}
					onWrite={() => textareaRef.current?.focus()}
				/>
			)}
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
			<div
				className={`mx-auto flex max-w-3xl flex-col gap-1 rounded-2xl border border-cv-border bg-cv-surface pt-2 pr-2 pb-2 pl-3.5 focus-within:border-cv-text-muted/60 ${
					expanded ? "min-h-0 w-full flex-1" : ""
				}`}
			>
				<div
					className={`flex gap-1 ${expanded ? "min-h-0 flex-1 items-stretch" : "items-start"}`}
				>
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
						placeholder={t(
							freeTextOption
								? "conversation.questionWriteAnswer"
								: "conversation.composerPlaceholder",
						)}
						className="min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-0.5 text-cv-text leading-relaxed placeholder:text-cv-text-muted focus:outline-none"
						style={{ fontSize: "16px" }}
					/>
					{(tall || expanded) && (
						<button
							type="button"
							onClick={() => {
								setExpanded((prev) => !prev);
								textareaRef.current?.focus();
							}}
							aria-label={t(
								expanded ? "conversation.composerCollapse" : "conversation.composerExpand",
							)}
							aria-pressed={expanded}
							className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-cv-text-muted hover:bg-cv-surface-hover"
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
				<div className="flex items-center gap-2">
					<div ref={menuRef} className="relative">
					<button
						type="button"
						onClick={() => setMenuOpen((prev) => !prev)}
						aria-label={t("conversation.composerMore")}
						aria-expanded={menuOpen}
						className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-cv-border ${
							menuOpen
								? "bg-cv-surface-hover text-cv-text"
								: "text-cv-text-secondary hover:bg-cv-surface-hover"
						}`}
					>
						<svg
							className="h-[18px] w-[18px]"
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
							className="absolute bottom-11 left-0 z-10 w-56 overflow-hidden rounded-xl border border-cv-border bg-cv-surface shadow-lg shadow-black/30"
						>
							<button
								type="button"
								role="menuitem"
								onClick={() => {
									setMenuOpen(false);
									fileInputRef.current?.click();
								}}
								className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-cv-text text-sm hover:bg-cv-surface-hover"
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
								className="flex w-full items-center gap-3 border-cv-border border-t px-3.5 py-2.5 text-left text-cv-text text-sm hover:bg-cv-surface-hover"
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
					<span className="flex-1" />
					{showStop ? (
						<button
							type="button"
							onClick={() => void stop()}
							disabled={stopping}
							aria-label={t("conversation.composerStop")}
							className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cv-text disabled:opacity-50"
						>
							<span className="h-3 w-3 rounded-[2px] bg-cv-bg" />
						</button>
					) : (
						<button
							type="button"
							onClick={() => void send(text)}
							disabled={!canSend}
							aria-label={t("conversation.composerSend")}
							className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cv-accent text-white disabled:opacity-40"
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
					)}
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
