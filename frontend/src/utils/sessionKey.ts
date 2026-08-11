import { LOCAL_PEER_ID } from "../../../shared/types";

/**
 * Composite session key `peerId:id` — the frontend-only identity of a session.
 *
 * Session ids are herdr workspace labels and can collide across peers,
 * so every piece of frontend state that references a session (pane tree,
 * active session, open sessions, localStorage) stores this key. The bare id is
 * recovered with `parseSessionKey` right before it goes on the wire (WS
 * subscribe / REST paths) — the server protocol never sees composite keys.
 */

export interface SessionKeyTarget {
	peerId: string;
	id: string;
}

// Peer ids are 'local' or `p_<hex>` (backend peer-registry.ts). A workspace
// label may itself contain `:`, so only a peer-id-shaped prefix marks a
// composite key; anything else is read as a bare id owned by the local Hub.
const COMPOSITE_KEY_RE = /^(local|p_[0-9a-f]+):/;

export function makeSessionKey(id: string, peerId?: string | null): string {
	return `${peerId ?? LOCAL_PEER_ID}:${id}`;
}

export function sessionKeyOf(session: {
	id: string;
	peerId?: string | null;
}): string {
	return makeSessionKey(session.id, session.peerId);
}

export function parseSessionKey(key: string): SessionKeyTarget {
	const match = COMPOSITE_KEY_RE.exec(key);
	if (match) {
		return { peerId: match[1], id: key.slice(match[0].length) };
	}
	return { peerId: LOCAL_PEER_ID, id: key };
}
