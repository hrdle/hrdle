import { isAgentProvider } from "../../../shared/types";

/**
 * What the chat view can honestly show for a pane.
 *
 * Every state other than `loading` and `ready` is a screen with a reason on
 * it. A blank view used to stand for several different failures at once - no
 * agent, no session id, no transcript - and a person looking at it could not
 * tell which, or whether it was still coming.
 */
export type ConversationStatus =
	| "loading"
	| "ready"
	| "empty"
	| "missing-agent"
	| "unsupported-agent"
	| "no-session-id"
	| "not-found"
	| "unreachable";

export interface ConversationStatusInput {
	agent: string | undefined;
	agentSessionId: string | null | undefined;
	isReady: boolean;
	messageCount: number;
	/**
	 * Whether the reader located a transcript for the id. Only Claude's stream
	 * reports this; a thread agent's reader answers an unknown id with an empty
	 * list, so for those it stays undefined and an empty answer reads as
	 * `empty`.
	 */
	found?: boolean;
	/** The last read failed, so an empty list says nothing about the
	 *  conversation. */
	failed?: boolean;
}

export function conversationStatus({
	agent,
	agentSessionId,
	isReady,
	messageCount,
	found,
	failed,
}: ConversationStatusInput): ConversationStatus {
	if (!agent) return "missing-agent";
	if (!isAgentProvider(agent)) return "unsupported-agent";
	// Without the pane's own id there is no way to name its conversation. The
	// directory is not a substitute: two agents can work in one directory, and
	// the newest transcript there may belong to the other one.
	if (!agentSessionId) return "no-session-id";
	if (!isReady) return messageCount > 0 ? "ready" : "loading";
	if (found === false) return "not-found";
	if (failed && messageCount === 0) return "unreachable";
	return messageCount > 0 ? "ready" : "empty";
}
