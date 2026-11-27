import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	AgentProvider,
	ConversationMessage,
} from "../../../../shared/types";
import { useAgentConversation } from "../../hooks/useAgentConversation";
import type { ConversationStatus } from "../../utils/conversation-status";
import { ConversationViewer } from "../ConversationViewer";
import { ChatComposer } from "./ChatComposer";

interface ChatViewProps {
	sessionId: string;
	title?: string;
	subtitle?: string;
	/** Provider for the active session. Codex sessions skip the WebSocket stream
	 *  (server-side rollout-tail isn't implemented) and poll the HTTP endpoint. */
	agent?: AgentProvider;
	/** Thread id for thread-based agents, used as the conversation key. */
	agentSessionId?: string | null;
	/** The peer the session runs on, when it is not this machine. */
	peerId?: string;
	/** The pane the conversation belongs to; the composer writes to its agent. */
	paneId?: string;
	/** The pane's agent is mid-turn: the composer offers to stop it. */
	working?: boolean;
	/** The pane's agent is waiting on the person: a question may be up. */
	waiting?: boolean;
	/** Text to add to the composer, from the file viewer. */
	insert?: { text: string; id: number } | null;
	onInsertApplied?: (id: number) => void;
}

interface SentPrompt {
	text: string;
	/** The conversation's last message when it was sent. */
	afterId: string | undefined;
	conversationId: string | null;
}

/**
 * Whether the transcript has caught up with a prompt sent from here: a turn of
 * the person's own after the message that was last when it went. Not matched by
 * text, since a slash command comes back reworded and images come back as
 * references.
 */
function hasArrived(sent: SentPrompt, messages: ConversationMessage[]): boolean {
	const from = sent.afterId
		? messages.findIndex((m) => m.id === sent.afterId)
		: -1;
	if (sent.afterId && from < 0) return true;
	return messages
		.slice(from + 1)
		.some((m) => m.role === "user" && !!m.content && !m.toolResult?.length);
}

/** Statuses that are a reason rather than a conversation. */
const REASON_KEYS: Partial<
	Record<ConversationStatus, { title: string; body: string }>
> = {
	"missing-agent": {
		title: "conversation.reasonMissingAgentTitle",
		body: "conversation.reasonMissingAgentBody",
	},
	"unsupported-agent": {
		title: "conversation.errorTitle",
		body: "conversation.errorUnsupportedAgent",
	},
	"no-session-id": {
		title: "conversation.reasonNoSessionIdTitle",
		body: "conversation.reasonNoSessionIdBody",
	},
	"not-found": {
		title: "conversation.reasonNotFoundTitle",
		body: "conversation.reasonNotFoundBody",
	},
	unreachable: {
		title: "conversation.reasonUnreachableTitle",
		body: "conversation.reasonUnreachableBody",
	},
	empty: {
		title: "conversation.reasonEmptyTitle",
		body: "conversation.reasonEmptyBody",
	},
};

/**
 * A pane's conversation, read from the agent's own transcript, with a
 * composer under it.
 *
 * The chat view replaces the terminal rather than sitting beside it, so the
 * composer is the one place on screen to type into that pane. It submits with
 * herdr's `agent.prompt`, which takes no pane control stream: the same pane
 * open in herdr's TUI or another Hrdle keeps rendering while this writes to it.
 */
export function ChatView({
	sessionId,
	title,
	subtitle,
	agent,
	agentSessionId,
	peerId,
	paneId,
	working = false,
	waiting = false,
	insert,
	onInsertApplied,
}: ChatViewProps) {
	const { t } = useTranslation();
	const [followSignal, setFollowSignal] = useState(0);
	const [sent, setSent] = useState<SentPrompt | null>(null);
	const { messages, conversationId, status } = useAgentConversation({
		agent,
		sessionId,
		agentSessionId,
		peerId,
	});
	const pendingPrompt = useMemo(
		() =>
			sent &&
			sent.conversationId === conversationId &&
			!hasArrived(sent, messages)
				? sent.text
				: null,
		[sent, conversationId, messages],
	);

	const resolvedTitle = title ?? t("conversation.claude");
	const resolvedSubtitle =
		subtitle ??
		(conversationId
			? `${agent ?? "agent"}:${conversationId.slice(0, 8)}`
			: undefined);

	const reason = REASON_KEYS[status];
	let content: React.ReactNode;
	if (reason) {
		content = (
			<div
				className="flex h-full flex-col items-center justify-center px-6 text-center"
				data-conversation-status={status}
			>
				<div className="mb-2 text-sm font-medium text-cv-text">
					{t(reason.title)}
				</div>
				<div className="max-w-sm whitespace-pre-line text-xs leading-relaxed text-cv-text-muted">
					{t(reason.body, { agent: agent ?? "" })}
				</div>
			</div>
		);
	} else if (status === "loading") {
		// Avoid showing a "Loading..." flash every time the view opens. Until the
		// initial conversation arrives, render an empty container.
		content = <div className="h-full" data-conversation-status={status} />;
	} else {
		content = (
			<ConversationViewer
				title={resolvedTitle}
				subtitle={resolvedSubtitle}
				messages={messages}
				isLoading={false}
				onClose={() => {
					/* close handled by parent */
				}}
				scrollToBottom
				followSignal={followSignal}
				pendingPrompt={pendingPrompt}
				inline
				agent={agent}
			/>
		);
	}

	// A pane with an agent in it can be written to whatever there is to read:
	// a prompt is how a conversation with nothing in it yet gets its first turn.
	const canPrompt =
		!!paneId && status !== "missing-agent" && status !== "unsupported-agent";

	return (
		<div className="relative flex h-full min-h-0 flex-col bg-cv-bg">
			<div className="min-h-0 flex-1">{content}</div>
			{canPrompt && paneId && (
				<ChatComposer
					sessionId={sessionId}
					paneId={paneId}
					peerId={peerId}
					working={working}
					waiting={waiting}
					showMode={agent === "claude"}
					insert={insert}
					onInsertApplied={onInsertApplied}
					onSent={(prompt) => {
						setSent(
							prompt.trim()
								? {
										text: prompt,
										afterId: messages[messages.length - 1]?.id,
										conversationId,
									}
								: null,
						);
						setFollowSignal((n) => n + 1);
					}}
				/>
			)}
		</div>
	);
}
