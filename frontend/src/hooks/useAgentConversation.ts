import {
	type AgentProvider,
	type ConversationMessage,
	agentSupportsConversationMetadata,
	threadAgentOf,
} from "../../../shared/types";
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
	enabled?: boolean;
}

type AgentConversationError = "missing-agent" | "unsupported-agent";

export interface UseAgentConversationResult {
	messages: ConversationMessage[];
	isReady: boolean;
	/**
	 * Identifier shown in the conversation header subtitle (e.g. last 8 chars).
	 * Claude → ccSessionId resolved over the WebSocket; Codex → the rollout
	 * thread id; null otherwise.
	 */
	conversationId: string | null;
	/**
	 * Set when no provider is wired for the requested `agent` value. Consumers
	 * should render an inline error rather than a blank conversation.
	 */
	error: AgentConversationError | null;
}

/**
 * Single entry point ChatView uses to read a session's conversation.
 *
 * Delivery is chosen from the shared registry: Claude-style agents
 * (`supportsConversationMetadata`) stream over the WebSocket; thread agents
 * (Codex, Grok, ...) poll their transcript over HTTP. Adding a provider to
 * `AGENT_PROVIDERS` wires it up here with no further edits.
 */
export function useAgentConversation({
	agent,
	sessionId,
	agentSessionId,
	enabled = true,
}: UseAgentConversationOptions): UseAgentConversationResult {
	const isStream = agentSupportsConversationMetadata(agent);
	const threadAgent = threadAgentOf(agent);
	const claude = useConversationStream({
		sessionId,
		agentSessionId,
		enabled: enabled && isStream,
	});
	const thread = useThreadConversation({
		agent: threadAgent,
		threadId: agentSessionId,
		enabled: enabled && !!threadAgent,
	});

	if (isStream) {
		return {
			messages: claude.messages,
			isReady: claude.isReady,
			conversationId: claude.ccSessionId,
			error: null,
		};
	}
	if (threadAgent) {
		return {
			messages: thread.messages,
			isReady: thread.isReady,
			conversationId: agentSessionId ?? null,
			error: null,
		};
	}
	// `isReady=true` so consumers fall through to their error state instead
	// of showing a loading skeleton that would never resolve.
	return {
		messages: [],
		isReady: true,
		conversationId: null,
		error: agent === undefined ? "missing-agent" : "unsupported-agent",
	};
}
