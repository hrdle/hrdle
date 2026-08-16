import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConversationMessage, StewardTurn } from "../../../../shared/types";
import { useStewardSession } from "../../hooks/useSteward";
import { authFetch } from "../../services/api";
import { ConversationViewer } from "../ConversationViewer";
import { StewardSessionComposer } from "../steward/StewardSessionComposer";
import { TurnDetail } from "../steward/TurnDetail";

const API_BASE = import.meta.env.VITE_API_URL || "";

/**
 * A session as the steward wrote it, in the place the raw transcript used to be.
 *
 * Summary first, the real thing behind it - the same order the glasses session
 * screen uses, and the reason a mode was not added for this: Chat is where
 * someone already goes to read what happened, so it is the reading that
 * changes, not the navigation.
 */
export function StewardSessionView({
	sessionId,
	agentSessionId,
	composerInBar = false,
}: {
	sessionId: string;
	agentSessionId?: string | null;
	/** The phone puts it in the bottom bar instead. */
	composerInBar?: boolean;
}) {
	const { t } = useTranslation();
	const { turns, waiting, thinking } = useStewardSession(sessionId, true);
	const [source, setSource] = useState<{ agentSessionId: string; messageId?: string } | null>(null);
	const [sourceMessages, setSourceMessages] = useState<ConversationMessage[]>([]);
	const [sourceLoading, setSourceLoading] = useState(false);
	const endRef = useRef<HTMLDivElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: neither value is read here; their change is the cue to scroll.
	useEffect(() => {
		endRef.current?.scrollIntoView({ block: "end" });
	}, [turns.length, thinking]);

	const openSource = async (next: { agentSessionId: string; messageId?: string }) => {
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
	};

	return (
		<div className="flex h-full flex-col bg-cv-bg text-cv-text">
			<div className="flex-1 overflow-y-auto px-3 py-3">
				<div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
					{turns.map((turn) => (
						<TurnCard key={turn.id} turn={turn} fallbackSession={agentSessionId} onOpenSource={openSource} />
					))}

					{/* Nothing written yet: the steward was asked on open, so this is a
					    wait rather than an empty state. */}
					{waiting && (
						<p className="flex items-center gap-2 text-cv-text-muted text-sm">
							<span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-cv-text-muted" />
							{t("steward.writingSession", "スチュワードがこのセッションを読んでいます…")}
						</p>
					)}

					{thinking && (
						<p className="flex items-center gap-2 text-cv-text-muted text-sm">
							<span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-cv-text-muted" />
							{t("steward.thinking", "考えています…")}
						</p>
					)}

					{!waiting && turns.length === 0 && (
						<p className="text-cv-text-muted text-sm">
							{t("steward.sessionEmpty", "まだ何も書かれていません。")}
						</p>
					)}

					<div ref={endRef} />
				</div>
			</div>

			{/* Talking to the steward about this session, not to the agent. On a
			    phone the composer is in the fixed bottom bar instead, where the soft
			    keyboard cannot push it off - `composerInBar` says which. */}
			{!composerInBar && (
				<StewardSessionComposer
					sessionId={sessionId}
					className="mx-auto flex w-full max-w-2xl items-end gap-2 border-cv-border border-t p-2"
				/>
			)}

			{source && (
				<ConversationViewer
					title={t("steward.originalTitle", "元の会話")}
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

function TurnCard({
	turn,
	fallbackSession,
	onOpenSource,
}: {
	turn: StewardTurn;
	/** The pane's own agent session, for a turn that named no source of its own. */
	fallbackSession?: string | null;
	onOpenSource: (source: { agentSessionId: string; messageId?: string }) => void;
}) {
	const { t } = useTranslation();
	const mine = turn.role === "user";
	const sourceSession = turn.source?.agentSessionId ?? fallbackSession ?? null;

	return (
		<div className={mine ? "flex justify-end" : ""}>
			<div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${mine ? "bg-cv-bubble" : "bg-cv-surface"}`}>
				<p className="whitespace-pre-wrap">{turn.text}</p>

				{turn.detail && <TurnDetail detail={turn.detail} />}

				{turn.refs?.file && (
					<p className="mt-1 font-mono text-cv-text-muted text-xs">
						{turn.refs.file}
						{turn.refs.line ? `:${turn.refs.line}` : ""}
					</p>
				)}

				{sourceSession && (
					<button
						type="button"
						onClick={() =>
							onOpenSource({ agentSessionId: sourceSession, messageId: turn.source?.messageIds?.[0] })
						}
						className="mt-2 flex min-h-[32px] items-center gap-1 text-cv-text-muted text-xs hover:text-cv-text"
					>
						<ExternalLink size={12} />
						{t("steward.seeOriginal", "元の会話を見る")}
					</button>
				)}
			</div>
		</div>
	);
}
