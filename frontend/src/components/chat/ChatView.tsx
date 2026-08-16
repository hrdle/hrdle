import { useTranslation } from "react-i18next";
import type { AgentProvider, IndicatorState } from "../../../../shared/types";
import { useAgentConversation } from "../../hooks/useAgentConversation";
import { useStewardEnabled, useStewardView } from "../../hooks/useSteward";
import { ConversationViewer } from "../ConversationViewer";
import { StewardSessionView } from "./StewardSessionView";

interface ChatViewProps {
	sessionId: string;
	title?: string;
	subtitle?: string;
	inline?: boolean;
	enabled?: boolean;
	/** Provider for the active session. Codex sessions skip the WebSocket stream
	 *  (server-side rollout-tail isn't implemented) and poll the HTTP endpoint. */
	agent?: AgentProvider;
	/** Thread id for thread-based agents, used as the conversation key. */
	agentSessionId?: string | null;
	/** Steward mode on a phone: the composer belongs to the fixed bottom bar,
	 *  which the soft keyboard cannot push off the screen. */
	composerInBar?: boolean;
	/** What the agent in this session is doing, for the steward's chat. */
	agentState?: IndicatorState;
	activity?: { tool: string; target?: string };
}

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
	inline = true,
	enabled = true,
	agent,
	agentSessionId,
	composerInBar,
	agentState,
	activity,
}: ChatViewProps) {
	const { t } = useTranslation();
	const stewardAvailable = useStewardEnabled();
	const [stewardView] = useStewardView();
	// The steward's version replaces the transcript here rather than adding a
	// mode: this is already where someone comes to read what happened, so what
	// changes is the reading, not the navigation.
	const showSteward = stewardAvailable && stewardView;

	const { messages, isReady, conversationId, error } = useAgentConversation({
		agent,
		sessionId,
		agentSessionId,
		enabled: enabled && !showSteward,
	});

	if (showSteward) {
		return (
			<StewardSessionView
				sessionId={sessionId}
				agentSessionId={agentSessionId}
				composerInBar={composerInBar}
				agentState={agentState}
				activity={activity}
			/>
		);
	}

	const resolvedTitle = title ?? t("conversation.claude");
	const resolvedSubtitle =
		subtitle ??
		(conversationId
			? `${agent ?? "agent"}:${conversationId.slice(0, 8)}`
			: undefined);

	if (error) {
		const errorClass = inline ? "h-full" : "fixed inset-0 z-50";
		const errorMessage =
			error === "unsupported-agent"
				? t("conversation.errorUnsupportedAgent", { agent: String(agent) })
				: t("conversation.errorMissingAgent");
		return (
			<div
				className={`${errorClass} flex flex-col items-center justify-center bg-cv-bg px-6 text-center`}
			>
				<div className="mb-2 text-sm font-medium text-red-400">
					{t("conversation.errorTitle")}
				</div>
				<div className="max-w-sm text-xs leading-relaxed text-cv-text-muted">
					{errorMessage}
				</div>
			</div>
		);
	}

	// Avoid showing a "Loading..." flash every time the view opens. Until the
	// initial conversation arrives, render an empty container.
	if (!isReady && messages.length === 0) {
		const emptyClass = inline ? "h-full" : "fixed inset-0 z-50";
		return <div className={`${emptyClass} bg-cv-bg`} />;
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
			inline={inline}
			agent={agent}
		/>
	);
}
