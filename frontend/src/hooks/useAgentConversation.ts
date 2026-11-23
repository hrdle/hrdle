import {
	type AgentProvider,
	type ConversationMessage,
	agentSupportsConversationMetadata,
	threadAgentOf,
} from "../../../shared/types";
import {
	type ConversationStatus,
	conversationStatus,
} from "../utils/conversation-status";
import { useConversationStream } from "./useConversationStream";
import { useThreadConversation } from "./useThreadConversation";

export interface UseAgentConversationOptions {
	/** Provider for the active session. Drives which underlying source is read. */
	agent: AgentProvider | undefined;
	/** Workspace id (used by the Claude WebSocket subscription). */
	sessionId: string;
	/**
	 * The pane's own agent session id: the thread for a thread agent, the
	 * Claude session for Claude. Both need it — a workspace can hold two agent
	 * panes, and then the workspace id alone names two conversations.
	 */
	agentSessionId: string | null | undefined;
	/** The peer the session runs on, when it is not this machine. */
	peerId?: string;
}

export interface UseAgentConversationResult {
	messages: ConversationMessage[];
	/**
	 * Identifier shown in the conversation header subtitle (e.g. last 8 chars).
	 * Claude → ccSessionId resolved over the WebSocket; Codex → the rollout
	 * thread id; null otherwise.
	 */
	conversationId: string | null;
	/** What the view can show; anything but loading/ready carries a reason. */
	status: ConversationStatus;
}

/**
 * Single entry point ChatView uses to read a session's conversation.
 *
 * Delivery is chosen from the shared registry: Claude-style agents
 * (`supportsConversationMetadata`) stream over the WebSocket; thread agents
 * (Codex, Grok, ...) poll their transcript over HTTP. Adding a provider to
 * `AGENT_PROVIDERS` wires it up here with no further edits.
 *
 * Neither reader is started without the pane's agent session id: the server
 * has nothing to name the conversation by, and the view says so instead.
 */
export function useAgentConversation({
	agent,
	sessionId,
	agentSessionId,
	peerId,
}: UseAgentConversationOptions): UseAgentConversationResult {
	const isStream = agentSupportsConversationMetadata(agent);
	const threadAgent = threadAgentOf(agent);
	const hasId = !!agentSessionId;
	const claude = useConversationStream({
		sessionId,
		agentSessionId,
		enabled: isStream && hasId,
	});
	const thread = useThreadConversation({
		agent: threadAgent,
		threadId: agentSessionId,
		peerId,
		enabled: !!threadAgent && hasId,
	});

	if (isStream) {
		return {
			messages: claude.messages,
			conversationId: claude.ccSessionId,
			status: conversationStatus({
				agent,
				agentSessionId,
				isReady: claude.isReady,
				messageCount: claude.messages.length,
				found: claude.isReady ? claude.ccSessionId !== null : undefined,
			}),
		};
	}
	if (threadAgent) {
		return {
			messages: thread.messages,
			conversationId: agentSessionId ?? null,
			status: conversationStatus({
				agent,
				agentSessionId,
				isReady: thread.isReady,
				messageCount: thread.messages.length,
				failed: thread.failed,
			}),
		};
	}
	return {
		messages: [],
		conversationId: null,
		status: conversationStatus({
			agent,
			agentSessionId,
			isReady: true,
			messageCount: 0,
		}),
	};
}
