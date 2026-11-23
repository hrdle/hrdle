/** The parts of a live session that name its conversations. */
export interface ConversationHolder {
	ccSessionId?: string;
	agentSessionId?: string;
	panes?: Array<{ agentSessionId?: string }>;
}

/**
 * Every conversation running right now, by its agent session id, to the
 * workspace it runs in.
 *
 * A workspace's own `ccSessionId` names only one of its conversations - the
 * first agent pane's, and only for Claude. A second agent pane, or any thread
 * agent, is running too, and history offered to resume those as though they
 * had stopped. The panes are where every running conversation is named.
 */
export function liveConversations<T extends ConversationHolder>(
	sessions: T[],
): Map<string, T> {
	const byId = new Map<string, T>();
	for (const s of sessions) {
		for (const id of [
			s.ccSessionId,
			s.agentSessionId,
			...(s.panes ?? []).map((p) => p.agentSessionId),
		]) {
			if (id && !byId.has(id)) byId.set(id, s);
		}
	}
	return byId;
}
