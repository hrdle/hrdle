import { useCallback, useEffect, useRef, useState } from "react";
import {
	type AgentProvider,
	DEFAULT_AGENT_PROVIDER,
	type ExtendedSessionResponse,
	type IndicatorState,
	type PeerSession,
	samePeerId,
	type SessionResponse,
	type SessionTheme,
} from "../../../shared/types";
import { isTransientNetworkError } from "../services/api";
import { sessionFetch } from "../services/peer-fetch";
import {
	applyHookIndicatorUpdate,
	usePeerSessionsWatcher,
} from "./usePeerSessionsWatcher";
import { usePeers } from "./usePeers";

// Module-level merged cache produced by the peer sessions watcher.
// Every peer — including the local Hub — pushes `sessions-updated` over its
// own WS, so this is the single source of truth.
let cachedSessions: ExtendedSessionResponse[] = [];

/**
 * Optimistically show a drag reorder before the round-trip completes. The
 * next `sessions-updated` push overwrites this with herdr's order, which is
 * authoritative — so a rejected/failed move self-corrects within one push
 * instead of needing a rollback path.
 */
export function applyLocalSessionReorder(ordered: ExtendedSessionResponse[]) {
	cachedSessions = ordered;
	window.dispatchEvent(new CustomEvent("cchub-sessions-reorder"));
}

/** Updates the indicatorState of a hub-local session as soon as a hook event arrives */
export function updateCachedSessionsByHookEvent(
	event: string,
	ccSessionId?: string,
) {
	const newState = hookEventToIndicatorState(event);
	if (!newState || !ccSessionId) return;
	if (applyHookIndicatorUpdate(ccSessionId, newState)) {
		window.dispatchEvent(new CustomEvent("cchub-hook-event"));
	}
}

function hookEventToIndicatorState(event: string): IndicatorState | null {
	switch (event) {
		case "Stop":
		case "Notification":
		case "SubagentStop":
			return "completed";
		case "PostToolUse":
			return "waiting_input";
		case "PreToolUse":
		case "UserPromptSubmit":
			return "processing";
		default:
			return null;
	}
}

interface UseWorkspacesReturn {
	sessions: ExtendedSessionResponse[];
	isLoading: boolean;
	error: string | null;
	createSession: (
		name?: string,
		workingDir?: string,
		agent?: AgentProvider,
		// Multi-server: creates the session on the given peer (a remote hrdle).
		// Omitted, or 'local', creates it on the hub.
		peerId?: string,
	) => Promise<ExtendedSessionResponse | null>;
	// peerId: session ids (workspace labels) can collide across peers — pass the
	// owning peer so the request doesn't resolve to the local same-name session.
	deleteSession: (id: string, peerId?: string) => Promise<boolean>;
	updateSessionTheme: (
		id: string,
		theme: SessionTheme | null,
		peerId?: string,
	) => Promise<boolean>;
}

/**
 * Session order comes from each peer's herdr workspace order — every peer's
 * `/api/workspaces` already returns its sessions in it — so the merged list only
 * has to concatenate peers in their display order. `sessionsByPeer` is keyed
 * by insertion (whichever watcher delivered first), which isn't stable across
 * reconnects, hence the explicit ordering. Peers missing from `peerOrder`
 * (a watcher outliving a peer removal) trail in map order.
 */
function flattenPeerSessions(
	sessionsByPeer: ReadonlyMap<string, PeerSession[]>,
	peerOrder: string[],
): ExtendedSessionResponse[] {
	const out: ExtendedSessionResponse[] = [];
	const seen = new Set<string>();
	for (const peerId of peerOrder) {
		const list = sessionsByPeer.get(peerId);
		if (!list) continue;
		seen.add(peerId);
		out.push(...list);
	}
	for (const [peerId, list] of sessionsByPeer) {
		if (!seen.has(peerId)) out.push(...list);
	}
	return out;
}

export function useWorkspaces(): UseWorkspacesReturn {
	const { peers } = usePeers();
	const [sessions, setSessions] =
		useState<ExtendedSessionResponse[]>(cachedSessions);
	const [isLoading, setIsLoading] = useState(() => cachedSessions.length === 0);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const hookHandler = () => setSessions(cachedSessions);
		const reorderHandler = () => setSessions(cachedSessions);
		window.addEventListener("cchub-hook-event", hookHandler);
		window.addEventListener("cchub-sessions-reorder", reorderHandler);
		return () => {
			window.removeEventListener("cchub-hook-event", hookHandler);
			window.removeEventListener("cchub-sessions-reorder", reorderHandler);
		};
	}, []);

	// Read through a ref: `usePeers()` hands back a fresh array on every poll,
	// so depending on it directly would re-register the watcher listener (and
	// re-fire it) constantly.
	const peerOrderRef = useRef<string[]>([]);
	peerOrderRef.current = peers.map((p) => p.id);

	// Per-peer WS watcher already dedups by payload before notifying, so a
	// listener firing here implies the data actually changed for some peer.
	const handlePeerSessions = useCallback(
		(sessionsByPeer: ReadonlyMap<string, PeerSession[]>) => {
			cachedSessions = flattenPeerSessions(
				sessionsByPeer,
				peerOrderRef.current,
			);
			setSessions(cachedSessions);
			setIsLoading(false);
		},
		[],
	);
	usePeerSessionsWatcher(peers, handlePeerSessions);

	const createSession = useCallback(
		async (
			name?: string,
			workingDir?: string,
			agent: AgentProvider = DEFAULT_AGENT_PROVIDER,
			peerId?: string,
		): Promise<SessionResponse | null> => {
			setError(null);
			// With a peerId the POST goes to that peer. `sessionFetch` takes a session
			// object, so a stub carrying only peerId is passed in.
			const response = await sessionFetch(
				peerId ? { peerId } : undefined,
				peers,
				"/api/workspaces",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name, workingDir, agent }),
				},
			);

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({}));
				const err = new Error(errorData.error || "Failed to create session");
				(err as Error & { data?: unknown }).data = errorData;
				throw err;
			}

			const session = (await response.json()) as ExtendedSessionResponse;
			// Stamp the peerId when it was created on a peer, so the UI can tell
			const enriched: ExtendedSessionResponse = peerId
				? { ...session, peerId }
				: session;
			setSessions((prev) => [enriched, ...prev]);
			return enriched;
		},
		[peers],
	);

	const deleteSession = useCallback(
		async (id: string, peerId?: string): Promise<boolean> => {
			setError(null);
			try {
				const session =
					peerId !== undefined
						? { peerId }
						: sessions.find((s) => s.id === id);
				const response = await sessionFetch(
					session,
					peers,
					`/api/workspaces/${id}`,
					{ method: "DELETE" },
				);

				if (!response.ok) throw new Error("Failed to delete session");

				setSessions((prev) =>
					prev.filter(
						(s) =>
							s.id !== id ||
							(peerId !== undefined && !samePeerId(s.peerId, peerId)),
					),
				);
				return true;
			} catch (err) {
				if (!isTransientNetworkError(err)) {
					setError(err instanceof Error ? err.message : "Unknown error");
				}
				return false;
			}
		},
		[sessions, peers],
	);

	const updateSessionTheme = useCallback(
		async (
			id: string,
			theme: SessionTheme | null,
			peerId?: string,
		): Promise<boolean> => {
			setError(null);
			try {
				const session =
					peerId !== undefined
						? { peerId }
						: sessions.find((s) => s.id === id);
				const response = await sessionFetch(
					session,
					peers,
					`/api/workspaces/${id}/theme`,
					{
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ theme }),
					},
				);

				if (!response.ok) throw new Error("Failed to update session theme");

				setSessions((prev) =>
					prev.map((s) =>
						s.id === id &&
						(peerId === undefined || samePeerId(s.peerId, peerId))
							? { ...s, theme: theme ?? undefined }
							: s,
					),
				);
				return true;
			} catch (err) {
				if (!isTransientNetworkError(err)) {
					setError(err instanceof Error ? err.message : "Unknown error");
				}
				return false;
			}
		},
		[sessions, peers],
	);

	return {
		sessions,
		isLoading,
		error,
		createSession,
		deleteSession,
		updateSessionTheme,
	};
}
