import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LOCAL_PEER_ID } from "../../../../shared/types";
import { authFetch } from "../../services/api";
import { loadInputHistory, pushInputHistory } from "../../utils/input-history";

const API_BASE = import.meta.env.VITE_API_URL || "";

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
 */
export function ChatComposer({ sessionId, paneId, peerId }: ChatComposerProps) {
	const { t } = useTranslation();
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [history, setHistory] = useState<string[]>(loadInputHistory);
	const [showHistory, setShowHistory] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const send = async (raw: string) => {
		const prompt = raw.replace(/\n+$/, "");
		if (!prompt.trim() || sending) return;
		setSending(true);
		setError(null);
		try {
			const res = await authFetch(promptUrl(sessionId, paneId, peerId), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text: prompt }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error || `status ${res.status}`);
			}
			setHistory((prev) => pushInputHistory(prev, prompt));
			setText("");
			setShowHistory(false);
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
			className="shrink-0 border-t border-cv-border bg-cv-bg px-3 pt-2 pb-3"
			data-testid="chat-composer"
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
			<div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-cv-border bg-cv-surface py-1.5 pr-1.5 pl-3">
				<textarea
					ref={textareaRef}
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={onKeyDown}
					rows={Math.min(6, Math.max(1, text.split("\n").length))}
					lang="ja"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					aria-label={t("conversation.composerLabel")}
					placeholder={t("conversation.composerPlaceholder")}
					className="min-h-9 flex-1 resize-none bg-transparent py-1.5 text-cv-text leading-relaxed placeholder:text-cv-text-muted focus:outline-none"
					style={{ fontSize: "16px" }}
				/>
				<button
					type="button"
					onClick={() => {
						setHistory(loadInputHistory());
						setShowHistory((prev) => !prev);
					}}
					aria-label={t("conversation.composerHistory")}
					aria-pressed={showHistory}
					className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
						showHistory
							? "bg-cv-surface-hover text-cv-text"
							: "text-cv-text-muted hover:bg-cv-surface-hover"
					}`}
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
						<path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
						<path d="M3 3v5h5M12 7v5l3 2" />
					</svg>
				</button>
				<button
					type="button"
					onClick={() => void send(text)}
					disabled={sending || !text.trim()}
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
			{error && (
				<div className="mx-auto mt-1.5 max-w-3xl text-xs text-red-400" role="alert">
					{error}
				</div>
			)}
		</div>
	);
}
