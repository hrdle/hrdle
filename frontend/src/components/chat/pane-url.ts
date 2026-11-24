import { LOCAL_PEER_ID } from "../../../../shared/types";

const API_BASE = import.meta.env.VITE_API_URL || "";

/**
 * One pane's endpoint. A peer's session is reached through the hub, which
 * forwards the request to the machine the pane is on.
 */
export function paneUrl(
	sessionId: string,
	paneId: string,
	peerId: string | undefined,
	action: "prompt" | "keys" | "question" | "answer" | "mode" | "commands",
): string {
	const target =
		peerId && peerId !== LOCAL_PEER_ID ? `peer:${peerId}:${sessionId}` : sessionId;
	return `${API_BASE}/api/sessions/${encodeURIComponent(target)}/panes/${encodeURIComponent(paneId)}/${action}`;
}
