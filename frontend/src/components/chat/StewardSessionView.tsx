import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	ConversationMessage,
	IndicatorState,
	StewardTurn,
} from "../../../../shared/types";
import {
	chatFontStyle,
	useChatFontSize,
	usePinchFontSize,
} from "../../hooks/useChatFontSize";
import { useStewardSession } from "../../hooks/useSteward";
import { useStickToBottom } from "../../hooks/useStickToBottom";
import { authFetch } from "../../services/api";
import { ConversationViewer } from "../ConversationViewer";
import { StewardSessionComposer } from "../steward/StewardSessionComposer";
import { speakerSurface } from "../steward/StewardView";
import { TurnBody, TurnTime } from "../steward/TurnBody";
import { TurnImages } from "../steward/TurnImages";

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
	agentState,
	activity,
	agentPaneCount,
	paneId,
}: {
	sessionId: string;
	agentSessionId?: string | null;
	/** The phone puts it in the bottom bar instead. */
	composerInBar?: boolean;
	agentState?: IndicatorState;
	activity?: { tool: string; target?: string };
	/** Agents running in this workspace. Above one, each pane keeps its own
	 *  history. */
	agentPaneCount?: number;
	/** Which pane is picked. Only consulted above one agent. */
	paneId?: string;
}) {
	const { t } = useTranslation();
	// The pane's own history when the workspace runs several agents: two agents
	// in one workspace are two pieces of work, and one history of both read as
	// a conversation that kept changing the subject. One agent names no pane and
	// keeps the workspace's own, which is what it always had.
	const historyPane = (agentPaneCount ?? 0) > 1 ? paneId : undefined;
	const { turns, waiting, thinking } = useStewardSession(sessionId, true, historyPane);
	const [source, setSource] = useState<{ agentSessionId: string; messageId?: string } | null>(null);
	const [sourceMessages, setSourceMessages] = useState<ConversationMessage[]>([]);
	const [sourceLoading, setSourceLoading] = useState(false);
	const scrollerRef = useRef<HTMLDivElement>(null);
	const stick = useStickToBottom(scrollerRef, [turns, thinking]);
	// The same size the conversation viewer uses, and the same pinch: this is
	// the screen someone reads all day, and it had no size of its own at all.
	const chatFont = useChatFontSize();
	usePinchFontSize(scrollerRef, chatFont);

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
			{/* 4xl rather than 2xl: at the app's 14px root, 2xl is 588px, so a
			    tablet gave the conversation just over half its width and the rest
			    to margins. A phone is narrower than either, so nothing moves there. */}
			<div
				ref={scrollerRef}
				className="flex flex-1 flex-col overflow-y-auto px-3 py-3"
				style={chatFontStyle(chatFont.fontSize)}
			>
				{/* Anchored to the bottom: a handful of turns sitting at the top of a
				    tall screen with the composer far below did not read as a
				    conversation. */}
				<div className="mx-auto mt-auto flex w-full max-w-4xl flex-col gap-3">
						{/* Which of the workspace's histories this is.
						    Two agents in one workspace are two pieces of work - on
						    `life` they were a health project and a recipe project - so
						    each pane keeps its own. Said once, at the top, and only
						    where there is more than one to be confused with. */}
						{(agentPaneCount ?? 0) > 1 && (
							<p className="text-[length:var(--cv-fs-meta,12px)] text-cv-text-muted">
								{t("steward.wholeWorkspace", {
									count: agentPaneCount,
									defaultValue:
										"このペインの記録です（このワークスペースにはエージェントが{{count}}つ）",
								})}
							</p>
						)}

					{turns.map((turn) => (
						<TurnCard
							key={turn.id}
							turn={turn}
							fallbackSession={agentSessionId}
							onOpenSource={openSource}
							onGrow={stick}
						/>
					))}

					{/* Nothing written yet: the steward was asked on open, so this is a
					    wait rather than an empty state. */}
					{waiting && (
						<p className="flex items-center gap-2 text-[1em] text-cv-text-muted">
							<span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-cv-text-muted" />
							{t("steward.writingSession", "スチュワードがこのセッションを読んでいます…")}
						</p>
					)}

					{!waiting && turns.length === 0 && (
						<p className="text-[1em] text-cv-text-muted">
							{t("steward.sessionEmpty", "まだ何も書かれていません。")}
						</p>
					)}

				</div>
			</div>

			{/* Talking to the steward about this session, not to the agent. On a
			    phone the composer is in the fixed bottom bar instead, where the soft
			    keyboard cannot push it off - `composerInBar` says which. */}
			{!composerInBar && (
				<StewardSessionComposer
					sessionId={sessionId}
					// The history above, so what is typed lands in the same one.
					paneId={historyPane}
					agentState={agentState}
					activity={activity}
					className="mx-auto w-full max-w-4xl border-cv-border border-t p-2"
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
	onOpenSource,
	onGrow,
}: {
	turn: StewardTurn;
	/** The pane's own agent session, for a turn that named no source of its own. */
	fallbackSession?: string | null;
	onOpenSource: (source: { agentSessionId: string; messageId?: string }) => void;
	/** A picture finishing loading changes the height after the scroll. */
	onGrow: () => void;
}) {
	const { t } = useTranslation();
	const mine = turn.role === "user";
	// Only where the turn names its own source. The pane-level fallback put this
	// on all 60 bubbles of a real session - 32px each, a quarter of the reading
	// area spent on a link that mostly opened the same conversation.
	const sourceSession = turn.source?.agentSessionId ?? null;

	return (
		<div className={mine ? "flex justify-end" : ""}>
			<div className={`max-w-[90%] rounded-xl px-3 py-2 text-[1em] ${speakerSurface(turn.role)}`}>
				{sourceSession && (
					<button
						type="button"
						onClick={() =>
							onOpenSource({ agentSessionId: sourceSession, messageId: turn.source?.messageIds?.[0] })
						}
						aria-label={t("steward.seeOriginal", "元の会話を見る")}
						title={t("steward.seeOriginal", "元の会話を見る")}
						className="-mr-1 float-right ml-2 flex h-8 w-8 items-center justify-center text-cv-text-muted hover:text-cv-text"
					>
						<ExternalLink size={13} />
					</button>
				)}

				<TurnBody text={turn.text} detail={turn.detail} />

					{turn.images && <TurnImages paths={turn.images} onLoad={onGrow} />}

				{turn.refs?.file && (
					<p className="mt-1 font-mono text-[length:var(--cv-fs-meta,12px)] text-cv-text-muted">
						{turn.refs.file}
						{turn.refs.line ? `:${turn.refs.line}` : ""}
					</p>
				)}

				<TurnTime at={turn.at} className={mine ? "text-right" : ""} />

			</div>
		</div>
	);
}
