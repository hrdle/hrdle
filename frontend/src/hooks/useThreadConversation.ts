import { useEffect, useState } from "react";
import {
	type AgentProvider,
	type ConversationMessage,
	LOCAL_PEER_ID,
} from "../../../shared/types";
import { authFetch } from "../services/api";

const API_BASE = import.meta.env.VITE_API_URL || "";

interface UseThreadConversationOptions {
	/** Thread-based provider (codex, grok, ...) the thread id belongs to. */
	agent: AgentProvider | undefined;
	/** The agent's own session/thread id. */
	threadId: string | undefined | null;
	/** The peer whose agent this is. Its transcript is only on that machine,
	 *  so the request goes through the local hub's peer forwarding. */
	peerId?: string;
	enabled?: boolean;
	/** Refresh interval in ms. Default 5000. */
	pollIntervalMs?: number;
}

interface UseThreadConversationResult {
	messages: ConversationMessage[];
	isReady: boolean;
	/** The last request failed (a peer offline, the server down). An empty
	 *  list then means nothing was read, not that nothing was said. */
	failed: boolean;
}

/**
 * Polling-based conversation reader for thread-based agents (Codex, Grok).
 * These agents don't expose a hook/event stream, so we tail the transcript
 * via the HTTP endpoint at a fixed interval. Only the active thread for a
 * session is fetched.
 */
export function useThreadConversation({
	agent,
	threadId,
	peerId,
	enabled = true,
	pollIntervalMs = 5000,
}: UseThreadConversationOptions): UseThreadConversationResult {
	const [messages, setMessages] = useState<ConversationMessage[]>([]);
	const [isReady, setIsReady] = useState(false);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		// Per-effect cancellation flag. A shared ref would be reset when the
		// next effect run sets it back to false, letting a late response from
		// the previous threadId overwrite the new thread's messages.
		let cancelled = false;
		setMessages([]);
		setIsReady(false);
		setFailed(false);

		if (!enabled || !threadId || !agent) {
			return;
		}

		const fetchOnce = async () => {
			try {
				const path =
					peerId && peerId !== LOCAL_PEER_ID
						? `/api/peers/history/${encodeURIComponent(peerId)}/${encodeURIComponent(threadId)}/conversation`
						: `/api/sessions/history/${encodeURIComponent(threadId)}/conversation`;
				const url = `${API_BASE}${path}?agent=${agent}`;
				const response = await authFetch(url, { cache: "no-store" });
				if (!response.ok) throw new Error(`status ${response.status}`);
				const data = await response.json();
				if (cancelled) return;
				setMessages(data.messages ?? []);
				setFailed(false);
			} catch (err) {
				if (cancelled) return;
				setFailed(true);
				console.error(`Failed to fetch ${agent} conversation:`, err);
			} finally {
				if (!cancelled) setIsReady(true);
			}
		};

		fetchOnce();
		const id = window.setInterval(fetchOnce, pollIntervalMs);

		return () => {
			cancelled = true;
			window.clearInterval(id);
		};
	}, [agent, threadId, peerId, enabled, pollIntervalMs]);

	return { messages, isReady, failed };
}
