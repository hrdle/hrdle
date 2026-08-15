import { ArrowLeft, CornerDownLeft, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	ConversationMessage,
	StewardAsk,
	StewardThreadItem,
} from "../../../../shared/types";
import { useSteward } from "../../hooks/useSteward";
import { authFetch } from "../../services/api";
import { ConversationViewer, Markdown } from "../ConversationViewer";

const API_BASE = import.meta.env.VITE_API_URL || "";

/** Where a turn was summarised from, once someone asks to see it. */
interface OpenSource {
	agentSessionId: string;
	messageId?: string;
}

/**
 * The steward's own conversation, on a screen wide enough to show what the
 * glasses cannot.
 *
 * Unlike `ChatView` this has a composer. That one is read-only because a pane
 * with two input fields makes it ambiguous which is listening; here the thread
 * is the only place to type, so the ambiguity does not arise - and an `ask`
 * with nowhere to answer would be a question the steward can never resolve.
 */
export function StewardView({ onClose }: { onClose: () => void }) {
	const { t } = useTranslation();
	const { thread, isLoading, error, reply } = useSteward(true);
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState<string | null>(null);
	const endRef = useRef<HTMLDivElement>(null);

	// Reading the original is part of reading the summary, so it opens from
	// here rather than being handed up to the app: nothing above this view
	// needs to know a steward turn can be traced back.
	const [source, setSource] = useState<OpenSource | null>(null);
	const [sourceMessages, setSourceMessages] = useState<ConversationMessage[]>([]);
	const [sourceLoading, setSourceLoading] = useState(false);

	const openSource = useCallback(async (next: OpenSource) => {
		setSource(next);
		setSourceMessages([]);
		setSourceLoading(true);
		try {
			const res = await authFetch(
				`${API_BASE}/api/sessions/history/${encodeURIComponent(next.agentSessionId)}/conversation`,
				{ cache: "no-store" },
			);
			const body = res.ok ? ((await res.json()) as { messages?: ConversationMessage[] }) : null;
			setSourceMessages(body?.messages ?? []);
		} finally {
			setSourceLoading(false);
		}
	}, []);

	// The newest exchange is the one being read; a thread that opens at the top
	// makes someone scroll past everything they have already answered.
	useEffect(() => {
		endRef.current?.scrollIntoView({ block: "end" });
	}, []);

	const send = async (input: Parameters<typeof reply>[0]) => {
		setSending(true);
		setSendError(null);
		try {
			await reply(input);
			setDraft("");
		} catch (err) {
			setSendError(err instanceof Error ? err.message : String(err));
		} finally {
			setSending(false);
		}
	};

	return (
		<div className="fixed inset-0 z-[70] flex flex-col bg-cv-bg text-cv-text">
			<header className="flex items-center gap-2 border-cv-border border-b px-3 py-2">
				<button
					type="button"
					onClick={onClose}
					className="rounded p-2 hover:bg-cv-surface-hover"
					aria-label={t("common.back", "Back")}
				>
					<ArrowLeft size={18} />
				</button>
				<h2 className="font-medium text-sm">{t("steward.title", "Steward")}</h2>
			</header>

			<div className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto px-3 py-3">
				{isLoading && <p className="text-cv-text-muted text-sm">{t("common.loading", "Loading...")}</p>}
				{error && <p className="text-sm text-red-400">{error}</p>}
				{!isLoading && !error && thread.length === 0 && (
					<p className="text-cv-text-muted text-sm">
						{t("steward.empty", "Nothing yet. The steward writes here when something needs you.")}
					</p>
				)}

				<ul className="flex flex-col gap-3">
					{thread.map((item) => (
						<li key={item.id}>
							<ThreadItem item={item} onAnswer={send} onOpenSource={openSource} />
						</li>
					))}
				</ul>
				<div ref={endRef} />
			</div>

			{sendError && <p className="px-3 pb-1 text-red-400 text-xs">{sendError}</p>}

			<form
				className="mx-auto flex w-full max-w-2xl items-end gap-2 border-cv-border border-t p-2"
				onSubmit={(e) => {
					e.preventDefault();
					const text = draft.trim();
					if (text) void send({ text });
				}}
			>
				<textarea
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					rows={1}
					placeholder={t("steward.placeholder", "Say something to the steward")}
					className="min-h-[40px] flex-1 resize-none rounded-lg bg-cv-surface px-3 py-2 text-sm outline-none"
				/>
				<button
					type="submit"
					disabled={sending || !draft.trim()}
					className="rounded-lg bg-cv-surface px-3 py-2 disabled:opacity-40"
					aria-label={t("common.send", "Send")}
				>
					<CornerDownLeft size={18} />
				</button>
			</form>

			{source && (
				<ConversationViewer
					title={t("steward.originalTitle", "The original")}
					messages={sourceMessages}
					isLoading={sourceLoading}
					onClose={() => setSource(null)}
					anchorId={source.messageId}
				/>
			)}
		</div>
	);
}

function ThreadItem({
	item,
	onAnswer,
	onOpenSource,
}: {
	item: StewardThreadItem;
	onAnswer: (input: { text?: string; askId?: string; answer?: { kind: "choice"; indices: number[] } | { kind: "dismissed" } }) => void;
	onOpenSource: (source: OpenSource) => void;
}) {
	const { t } = useTranslation();
	const mine = item.role === "user";

	return (
		<div className={mine ? "flex justify-end" : ""}>
			<div
				className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
					mine ? "bg-cv-bubble" : "bg-cv-surface"
				}`}
			>
				<p className="whitespace-pre-wrap">{item.text}</p>

				{item.kind === "report" && item.rows.length > 0 && (
					<ul className="mt-2 flex flex-col gap-0.5 font-mono text-cv-text-secondary text-xs">
						{item.rows.map((row) => (
							<li key={row}>{row}</li>
						))}
					</ul>
				)}

				{/* The half the glasses could not carry. */}
				{item.detail && (
					<div className="mt-2 border-cv-border border-t pt-2 text-cv-text-secondary">
						<Markdown content={item.detail} />
					</div>
				)}

				{item.kind === "ask" && <AskControls ask={item.ask} onAnswer={onAnswer} />}

				{item.source && (
					<button
						type="button"
						onClick={() =>
							onOpenSource({
								agentSessionId: item.source?.agentSessionId ?? "",
								messageId: item.source?.messageIds?.[0],
							})
						}
						className="mt-2 flex min-h-[32px] items-center gap-1 text-cv-text-muted text-xs hover:text-cv-text"
					>
						<ExternalLink size={12} />
						{t("steward.seeOriginal", "See the original")}
					</button>
				)}
			</div>
		</div>
	);
}

/**
 * The answer controls for a question.
 *
 * Once answered they become the record of what was chosen rather than
 * disappearing: the thread is read back later to see what was decided.
 */
function AskControls({
	ask,
	onAnswer,
}: {
	ask: StewardAsk;
	onAnswer: (input: { askId: string; answer: { kind: "choice"; indices: number[] } | { kind: "dismissed" } }) => void;
}) {
	const { t } = useTranslation();
	const [picked, setPicked] = useState<number[]>([]);

	if (ask.answer) {
		const said =
			ask.answer.kind === "choice"
				? ask.answer.indices.map((i) => ask.choices[i] ?? `#${i}`).join(", ")
				: ask.answer.kind === "text"
					? ask.answer.text
					: t("steward.dismissed", "dismissed");
		return <p className="mt-2 text-cv-text-muted text-xs">{t("steward.answered", "Answered")}: {said}</p>;
	}

	const multi = ask.mode === "multi";

	return (
		<div className="mt-2 flex flex-col gap-1">
			{ask.step && (
				<p className="text-cv-text-muted text-xs">
					{ask.step.index} / {ask.step.total}
				</p>
			)}
			{ask.choices.map((choice, index) => {
				const on = picked.includes(index);
				return (
					<button
						key={choice}
						type="button"
						onClick={() => {
							if (!multi) {
								onAnswer({ askId: ask.id, answer: { kind: "choice", indices: [index] } });
								return;
							}
							setPicked((prev) => (on ? prev.filter((i) => i !== index) : [...prev, index]));
						}}
						className={`rounded-lg px-3 py-2 text-left text-sm ${
							on ? "bg-cv-surface-hover" : "bg-cv-bg hover:bg-cv-surface-hover"
						}`}
					>
						{choice}
					</button>
				);
			})}
			<div className="flex gap-2">
				{multi && (
					<button
						type="button"
						disabled={picked.length === 0}
						onClick={() => onAnswer({ askId: ask.id, answer: { kind: "choice", indices: picked } })}
						className="min-h-[32px] rounded-lg bg-cv-surface-hover px-3 py-1.5 text-xs disabled:opacity-40"
					>
						{t("common.send", "Send")}
					</button>
				)}
				{/* Walking away is an answer: without it the steward waits forever. */}
				<button
					type="button"
					onClick={() => onAnswer({ askId: ask.id, answer: { kind: "dismissed" } })}
					className="min-h-[32px] rounded-lg px-3 py-1.5 text-cv-text-muted text-xs hover:text-cv-text"
				>
					{t("steward.dismiss", "Not now")}
				</button>
			</div>
		</div>
	);
}
