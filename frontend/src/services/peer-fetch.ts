/**
 * Multi-server: helper that calls a peer's API directly based on a session's peerId.
 *
 * The hub's REST API (/api/workspaces/:id/theme and friends) only covers local
 * sessions, so a peer's session is fetched from the peer's own URL with the
 * token already stored for it.
 */
import { LOCAL_PEER_ID, type PeerClientView } from "../../../shared/types";
import { authFetch, fetchWithTimeout } from "./api";

interface SessionWithPeer {
	peerId?: string;
}

function resolveSessionApi(
	session: SessionWithPeer | undefined,
	peers: PeerClientView[],
): { apiBase: string; token: string | null; isRemote: boolean } {
	const peerId = session?.peerId;
	if (!peerId || peerId === LOCAL_PEER_ID) {
		return { apiBase: "", token: null, isRemote: false };
	}
	const peer = peers.find((p) => p.id === peerId);
	if (!peer || peer.url === "self") {
		return { apiBase: "", token: null, isRemote: false };
	}
	return {
		apiBase: peer.url.replace(/\/+$/, ""),
		token: peer.wsToken ?? null,
		isRemote: true,
	};
}

/**
 * Fetches from the peer URL with that peer's token when the session belongs to a
 * remote peer, and falls back to authFetch against the hub otherwise.
 */
export async function sessionFetch(
	session: SessionWithPeer | undefined,
	peers: PeerClientView[],
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const { apiBase, token, isRemote } = resolveSessionApi(session, peers);
	if (!isRemote) {
		return authFetch(`${apiBase}${path}`, init);
	}
	const headers = new Headers(init.headers);
	if (token) headers.set("Authorization", `Bearer ${token}`);
	return fetchWithTimeout(`${apiBase}${path}`, { ...init, headers });
}
