import { useTranslation } from "react-i18next";
import type { AgentProvider } from "../../../../shared/types";
import { useAgentConversation } from "../../hooks/useAgentConversation";
import type { ConversationStatus } from "../../utils/conversation-status";
import { ConversationViewer } from "../ConversationViewer";

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
 * Read-only view of a session's conversation.
 *
 * There is no composer: input goes to the pane through the terminal, and a
 * second place to type only made it ambiguous which one was listening.
 */
export function ChatView({
	sessionId,
	title,
	subtitle,
	agent,
	agentSessionId,
	peerId,
}: ChatViewProps) {
	const { t } = useTranslation();
	const { messages, conversationId, status } = useAgentConversation({
		agent,
		sessionId,
		agentSessionId,
		peerId,
	});

	const resolvedTitle = title ?? t("conversation.claude");
	const resolvedSubtitle =
		subtitle ??
		(conversationId
			? `${agent ?? "agent"}:${conversationId.slice(0, 8)}`
			: undefined);

	const reason = REASON_KEYS[status];
	if (reason) {
		return (
			<div
				className="flex h-full flex-col items-center justify-center bg-cv-bg px-6 text-center"
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
	}

	// Avoid showing a "Loading..." flash every time the view opens. Until the
	// initial conversation arrives, render an empty container.
	if (status === "loading") {
		return (
			<div
				className="flex h-full min-h-0 flex-col bg-cv-bg"
				data-conversation-status={status}
			/>
		);
	}

	return (
		<ConversationViewer
			title={resolvedTitle}
			subtitle={resolvedSubtitle}
			messages={messages}
			isLoading={false}
			onClose={() => {
				/* close handled by parent */
			}}
			scrollToBottom
			inline
			agent={agent}
		/>
	);
}
