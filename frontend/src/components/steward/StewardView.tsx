import { ArrowLeft, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	ConversationMessage,
	StewardThreadItem,
} from "../../../../shared/types";
import { useSteward } from "../../hooks/useSteward";
import { authFetch } from "../../services/api";
import { ConversationViewer } from "../ConversationViewer";
import { AskControls } from "./AskControls";
import { StewardSessionComposer } from "./StewardSessionComposer";
import { Linkified } from "./Linkified";
import { TurnDetail } from "./TurnDetail";
import { TurnImages } from "./TurnImages";

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
	const { thread, isLoading, error, thinking, reply } = useSteward(true);
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

	/**
	 * The overview conversation, not every entry the steward has written.
	 *
	 * What is about one session belongs to that session: its row carries the
	 * current state and its chat carries the history, so a third copy here
	 * turned this screen into a feed of everything at once - the reason it read
	 * as a raw log rather than a conversation with anybody.
	 *
	 * A question still waiting is the exception, wherever it came from. It is
	 * answered here because this is where the controls are, and one that is
	 * only findable by opening the right session is one nobody answers.
	 */
	const shown = useMemo(
		() =>
			thread.filter(
				(item) =>
					!item.sessionId || (item.kind === "ask" && !item.ask.answer),
			),
		[thread],
	);

	// The newest exchange is the one being read - on open, and again whenever
	// something arrives or the steward starts thinking.
	// biome-ignore lint/correctness/useExhaustiveDependencies: neither value is read here; their change is the cue to scroll.
	useEffect(() => {
		endRef.current?.scrollIntoView({ block: "end" });
	}, [shown.length, thinking]);


	// Answering an ask, which the composer cannot express.
	const send = async (input: Parameters<typeof reply>[0]) => {
		setSendError(null);
		try {
			await reply(input);
		} catch (err) {
			setSendError(err instanceof Error ? err.message : String(err));
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

			<div className="mx-auto flex w-full max-w-4xl flex-1 flex-col overflow-y-auto px-3 py-3">
				{isLoading && <p className="text-cv-text-muted text-sm">{t("common.loading", "Loading...")}</p>}
				{error && <p className="text-sm text-red-400">{error}</p>}
				{!isLoading && !error && shown.length === 0 && (
					<p className="text-cv-text-muted text-sm">
						{t("steward.emptyOverview", "セッションを横断する相談はここに。個々のセッションの話は、そのセッションを開いてください。")}
					</p>
				)}

				<ul className="mt-auto flex flex-col gap-3">
					{shown.map((item) => (
						<li key={item.id}>
							<ThreadItem item={item} onAnswer={send} onOpenSource={openSource} />
						</li>
					))}
				</ul>

				<div ref={endRef} />
			</div>

			{sendError && <p className="px-3 pb-1 text-red-400 text-xs">{sendError}</p>}

			{/* The same composer the session screens use, so an image can be
			    attached here too and there is one place that knows how. */}
			<StewardSessionComposer className="mx-auto w-full max-w-4xl border-cv-border border-t p-2" />

			{source && (
				<ConversationViewer
					title={t("steward.originalTitle", "The original")}
					messages={sourceMessages}
					isLoading={sourceLoading}
					onClose={() => setSource(null)}
					anchorId={source.messageId}
					// No anchor means "show me this session's real conversation", and
					// the top of it is a /clear from days ago - which is what "the link
					// is not connected" looked like.
					scrollToBottom={!source.messageId}
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
				className={`max-w-[90%] rounded-xl px-3 py-2 text-sm ${
					mine ? "bg-cv-bubble" : "bg-cv-surface"
				}`}
			>
				{/* Which session this is about. The thread is global and read out of
				    context, and the steward used to spend page budget writing the id
				    into the sentence. Not on the person's own words: they know what
				    they just said and where, and the label there only read as noise. */}
				{item.sessionId && !mine && (
					<p className="mb-1 font-medium text-[11px] text-cv-text-muted">{item.sessionId}</p>
				)}

				{item.source && (
					<button
						type="button"
						onClick={() =>
							onOpenSource({
								agentSessionId: item.source?.agentSessionId ?? "",
								messageId: item.source?.messageIds?.[0],
							})
						}
						aria-label={t("steward.seeOriginal", "元の会話を見る")}
						title={t("steward.seeOriginal", "元の会話を見る")}
						className="-mr-1 float-right ml-2 flex h-8 w-8 items-center justify-center text-cv-text-muted hover:text-cv-text"
					>
						<ExternalLink size={13} />
					</button>
				)}

				<p className="whitespace-pre-wrap break-words">
					<Linkified text={item.text} />
				</p>

					{item.images && <TurnImages paths={item.images} />}

				{item.kind === "report" && item.rows.length > 0 && (
					<ul className="mt-2 flex flex-col gap-0.5 font-mono text-cv-text-secondary text-xs">
						{item.rows.map((row) => (
							<li key={row}>{row}</li>
						))}
					</ul>
				)}

				{item.detail && <TurnDetail detail={item.detail} />}

				{item.kind === "ask" && <AskControls ask={item.ask} onAnswer={onAnswer} />}
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
