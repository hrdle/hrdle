import { useMemo } from "react";
import {
	type ExtendedSessionResponse,
	LOCAL_PEER_ID,
	type PeerClientView,
} from "../../../shared/types";
import { peerHttpUrlToWsUrl } from "../services/peer-ws";

export interface PeerConnectionInfo {
	peerId: string;
	wsBase: string | null; // null = use Hub default (window.location.host)
	token: string | null;
	apiBase: string; // REST API base URL ("" for Hub, "https://host:port" for remote peer)
}

/**
 * Returns the WS connection info for the peer a session belongs to.
 * - sessionId not found / peerId local or unknown: returns the hub's connection info
 * - peerId remote: derives wsBase + apiBase from peer.url
 * - preferredPeerId: session ids (herdr workspace names) can collide across peers,
 *   so a caller that knows which peer the user picked should pass it. When it is
 *   given, no id lookup over sessions (first match = local wins) happens.
 */
export function usePeerConnection(
	sessionId: string,
	sessions: ExtendedSessionResponse[],
	peers: PeerClientView[],
	preferredPeerId?: string,
): PeerConnectionInfo {
	return useMemo(() => {
		const hubInfo: PeerConnectionInfo = {
			peerId: LOCAL_PEER_ID,
			wsBase: null,
			token: null,
			apiBase: "",
		};

		if (!sessionId) return hubInfo;

		const peerId =
			preferredPeerId ?? sessions.find((s) => s.id === sessionId)?.peerId;
		if (!peerId || peerId === LOCAL_PEER_ID) return hubInfo;

		const peer = peers.find((p) => p.id === peerId);
		if (!peer || peer.url === "self") return hubInfo;

		return {
			peerId,
			wsBase: peerHttpUrlToWsUrl(peer.url),
			token: peer.wsToken ?? null,
			apiBase: peer.url.replace(/\/+$/, ""),
		};
	}, [sessionId, sessions, peers, preferredPeerId]);
}
