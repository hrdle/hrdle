import { useEffect, useState } from "react";
import type { ConversationMessage } from "../../../shared/types";
import {
	subscribeConversation,
	unsubscribeConversation,
} from "./useMultiplexedTerminal";

interface ConversationEventDetail {
	type:
		| "conversation-subscribed"
		| "conversation-unsubscribed"
		| "initial-conversation"
		| "conversation-update";
	sessionId: string;
	agentSessionId?: string;
	ccSessionId?: string | null;
	messages?: ConversationMessage[];
}

interface UseConversationStreamOptions {
	sessionId: string;
	/** The pane's own agent session. Names which conversation of a workspace
	 *  this is — a workspace with two agent panes has two. */
	agentSessionId?: string | null;
	enabled?: boolean;
	token?: string | null;
}

interface UseConversationStreamResult {
	messages: ConversationMessage[];
	isReady: boolean;
	ccSessionId: string | null;
}

export function useConversationStream({
	sessionId,
	agentSessionId,
	enabled = true,
	token,
}: UseConversationStreamOptions): UseConversationStreamResult {
	const [messages, setMessages] = useState<ConversationMessage[]>([]);
	const [isReady, setIsReady] = useState(false);
	const [ccSessionId, setCcSessionId] = useState<string | null>(null);

	useEffect(() => {
		if (!enabled || !sessionId) {
			return;
		}

		setMessages([]);
		setIsReady(false);
		setCcSessionId(null);

		const handler = (ev: Event) => {
			const detail = (ev as CustomEvent<ConversationEventDetail>).detail;
			if (!detail || detail.sessionId !== sessionId) return;
			// Two panes of one workspace share a sessionId, so the pane's agent
			// session is what tells their messages apart. An older server echoes
			// nothing back; then the sessionId is all there is to go on.
			if (
				agentSessionId &&
				detail.agentSessionId &&
				detail.agentSessionId !== agentSessionId
			)
				return;

			switch (detail.type) {
				case "conversation-subscribed":
					setCcSessionId(detail.ccSessionId ?? null);
					break;
				case "conversation-unsubscribed":
					break;
				case "initial-conversation":
					setMessages(detail.messages ?? []);
					setIsReady(true);
					break;
				case "conversation-update":
					if (detail.messages && detail.messages.length > 0) {
						setMessages((prev) => [...prev, ...(detail.messages ?? [])]);
					}
					break;
			}
		};

		window.addEventListener("hrdle-conversation", handler);
		subscribeConversation(sessionId, agentSessionId, token);

		return () => {
			window.removeEventListener("hrdle-conversation", handler);
			unsubscribeConversation(sessionId, agentSessionId);
		};
	}, [sessionId, agentSessionId, enabled, token]);

	return { messages, isReady, ccSessionId };
}
