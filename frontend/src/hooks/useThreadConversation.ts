import { useEffect, useState } from "react";
import type { AgentProvider, ConversationMessage } from "../../../shared/types";
import { authFetch } from "../services/api";

const API_BASE = import.meta.env.VITE_API_URL || "";

interface UseThreadConversationOptions {
	/** Thread-based provider (codex, grok, ...) the thread id belongs to. */
	agent: AgentProvider | undefined;
	/** The agent's own session/thread id. */
	threadId: string | undefined | null;
	enabled?: boolean;
	/** Refresh interval in ms. Default 5000. */
	pollIntervalMs?: number;
}

interface UseThreadConversationResult {
	messages: ConversationMessage[];
	isReady: boolean;
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
	enabled = true,
	pollIntervalMs = 5000,
}: UseThreadConversationOptions): UseThreadConversationResult {
	const [messages, setMessages] = useState<ConversationMessage[]>([]);
	const [isReady, setIsReady] = useState(false);

	useEffect(() => {
		// Per-effect cancellation flag. A shared ref would be reset when the
		// next effect run sets it back to false, letting a late response from
		// the previous threadId overwrite the new thread's messages.
		let cancelled = false;
		setMessages([]);
		setIsReady(false);

		if (!enabled || !threadId || !agent) {
			return;
		}

		const fetchOnce = async () => {
			try {
				const url = `${API_BASE}/api/sessions/history/${threadId}/conversation?agent=${agent}`;
				const response = await authFetch(url, { cache: "no-store" });
				if (!response.ok) throw new Error(`status ${response.status}`);
				const data = await response.json();
				if (cancelled) return;
				setMessages(data.messages ?? []);
			} catch (err) {
				if (!cancelled)
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
	}, [agent, threadId, enabled, pollIntervalMs]);

	return { messages, isReady };
}
